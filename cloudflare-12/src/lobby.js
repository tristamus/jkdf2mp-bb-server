// The lobby, WebRTC signaling and fallback relay for OpenJKDF2's browser
// build, on Cloudflare Workers: the same protocol as relay/relay.py (described
// at the top of that file), in a Durable Object so every player reaches the
// same lobby. The page and engine are served as static assets from public/.
//
// The object uses the WebSocket Hibernation API, so it isn't billed or kept in
// memory while players sit in the lobby. Waking up rebuilds the rooms from
// each socket's attachment ({room, id}) and the room entries in storage.
//
// Like relay.py, this never serves or stores game files: players pick their
// own install in the page, and it stays in their browser.

import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE = 64 * 1024;
const MAX_ENTRY_HEX = 2048;
const MAX_SIGNAL_B64 = 16384;
const FIRST_PEER_ID = 2;
const LAST_PEER_ID = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[0-9]{1,9}$/;
// How often to log message counts, to see a match against the free plan's
// daily request limit (incoming WebSocket messages count 20 to a request).
const STATS_MS = 60 * 1000;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/relay") {
            if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
                return new Response("Expected a WebSocket upgrade", { status: 426 });
            const lobby = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
            return lobby.fetch(request);
        }
        return env.ASSETS.fetch(request);
    },
};

function validEntry(text) {
    return text.length <= MAX_ENTRY_HEX && HEX_RE.test(text);
}

function validSignal(text) {
    return text.length <= MAX_SIGNAL_B64 && B64_RE.test(text);
}

function iceMessage(env) {
    // STUN lets most players link directly over WebRTC, which keeps game
    // packets (and request counts) off the relay.
    const stun = (env.STUN || "").split(/[\s,]+/).filter(Boolean);
    if (!stun.length)
        return null;
    return "ice " + btoa(JSON.stringify([{ urls: stun }]));
}

export class Lobby extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.rooms = new Map();   // room id -> {id, host, entry, peers: Map(id -> ws)}
        this.conns = new Map();   // ws -> {room, id}, the room id and player id
        this.nextRoom = 1;
        this.stats = { since: Date.now(), text: 0, packets: 0, bytes: 0 };
        // Pages send "ping" every 25 s so proxies keep the socket open. Cloudflare
        // answers it without waking the object; the page ignores the "pong".
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
        ctx.blockConcurrencyWhile(() => this.restore());
    }

    async restore() {
        this.nextRoom = (await this.ctx.storage.get("nextRoom")) || 1;
        const entries = await this.ctx.storage.list({ prefix: "room:" });
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() || { room: 0, id: 0 };
            this.conns.set(ws, att);
            if (!att.room)
                continue;
            let room = this.rooms.get(att.room);
            if (!room) {
                room = { id: att.room, host: null, entry: entries.get("room:" + att.room) || "", peers: new Map() };
                this.rooms.set(att.room, room);
            }
            if (att.id === 1)
                room.host = ws;
            else
                room.peers.set(att.id, ws);
        }
        // A room whose host is gone can't go on (its close should have ended
        // it, but never leave players waiting on one).
        for (const room of this.rooms.values()) {
            if (!room.host) {
                for (const peer of room.peers.values()) {
                    this.setConn(peer, 0, 0);
                    this.send(peer, "host-left");
                }
                this.rooms.delete(room.id);
            }
        }
        for (const key of entries.keys()) {
            if (!this.rooms.has(Number(key.slice(5))))
                this.ctx.storage.delete(key);
        }
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        this.setConn(server, 0, 0);
        const ice = iceMessage(this.env);
        if (ice)
            this.send(server, ice);
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        const size = typeof message === "string" ? message.length : message.byteLength;
        if (size > MAX_MESSAGE) {
            ws.close(1009, "message too big");
            this.leave(ws);
            return;
        }
        this.count(typeof message === "string", size);
        if (typeof message === "string")
            this.onText(ws, message);
        else
            this.onBinary(ws, message);
    }

    async webSocketClose(ws, code, reason, wasClean) {
        this.leave(ws);
        this.conns.delete(ws);
        try { ws.close(1000, "bye"); } catch (e) {}
    }

    async webSocketError(ws, error) {
        this.leave(ws);
        this.conns.delete(ws);
    }

    conn(ws) {
        let c = this.conns.get(ws);
        if (!c) {
            c = ws.deserializeAttachment() || { room: 0, id: 0 };
            this.conns.set(ws, c);
        }
        return c;
    }

    setConn(ws, room, id) {
        const c = { room, id };
        this.conns.set(ws, c);
        try {
            ws.serializeAttachment(c);
        } catch (e) {
            // Already closed.
        }
    }

    send(ws, data) {
        try {
            ws.send(data);
        } catch (e) {
            // Closed: its close event cleans up.
        }
    }

    count(isText, size) {
        const s = this.stats;
        if (isText)
            s.text++;
        else
            s.packets++;
        s.bytes += size;
        const now = Date.now();
        if (now - s.since >= STATS_MS) {
            console.log(`relay: ${s.text + s.packets} messages in ${Math.round((now - s.since) / 1000)} s ` +
                `(${s.packets} game packets, ${s.bytes} bytes), ${this.conns.size} connected`);
            this.stats = { since: now, text: 0, packets: 0, bytes: 0 };
        }
    }

    onText(ws, line) {
        const parts = line.trim().split(/\s+/);
        if (!parts[0])
            return;
        const [op, ...args] = parts;
        if (op === "ping")
            return;
        const c = this.conn(ws);
        if (op === "list") {
            const games = [...this.rooms.values()].map(r => `${r.id} ${1 + r.peers.size} ${r.entry}`);
            this.send(ws, ["list", ...games].join(" "));
        } else if (op === "host" && args.length === 1 && validEntry(args[0])) {
            this.leave(ws);
            const room = { id: this.nextRoom++, host: ws, entry: args[0], peers: new Map() };
            this.ctx.storage.put({ nextRoom: this.nextRoom, ["room:" + room.id]: room.entry });
            this.rooms.set(room.id, room);
            this.setConn(ws, room.id, 1);
            this.send(ws, `hosted ${room.id}`);
            console.log(`relay: room ${room.id} opened`);
        } else if (op === "update" && args.length === 1 && validEntry(args[0])) {
            const room = this.rooms.get(c.room);
            if (room && room.host === ws && room.entry !== args[0]) {
                room.entry = args[0];
                this.ctx.storage.put("room:" + room.id, room.entry);
            }
        } else if (op === "join" && args.length === 1 && ID_RE.test(args[0])) {
            this.leave(ws);
            const room = this.rooms.get(Number(args[0]));
            if (!room) {
                this.send(ws, "error no-room");
                return;
            }
            let peerId = 0;
            for (let i = FIRST_PEER_ID; i <= LAST_PEER_ID; i++) {
                if (!room.peers.has(i)) {
                    peerId = i;
                    break;
                }
            }
            if (!peerId) {
                this.send(ws, "error full");
                return;
            }
            room.peers.set(peerId, ws);
            this.setConn(ws, room.id, peerId);
            this.send(room.host, `peer-joined ${peerId}`);
            console.log(`relay: room ${room.id}: player joined as id ${peerId}`);
        } else if (op === "welcome" && args.length === 2 && ID_RE.test(args[0]) && validEntry(args[1])) {
            const room = this.rooms.get(c.room);
            if (room && room.host === ws) {
                const peer = room.peers.get(Number(args[0]));
                if (peer)
                    this.send(peer, `welcome ${args[0]} ${args[1]}`);
            }
        } else if (op === "signal" && args.length === 2 && ID_RE.test(args[0]) && validSignal(args[1])) {
            // Signaling only runs between a host and its own clients.
            const room = this.rooms.get(c.room);
            if (room) {
                const to = Number(args[0]);
                const target = room.host === ws ? room.peers.get(to) : (to === 1 ? room.host : null);
                if (target)
                    this.send(target, `signal ${c.id} ${args[1]}`);
            }
        } else if (op === "leave") {
            this.leave(ws);
        } else {
            this.send(ws, "error bad-request");
        }
    }

    onBinary(ws, data) {
        if (data.byteLength < 8)
            return;
        const c = this.conn(ws);
        const room = this.rooms.get(c.room);
        if (!room)
            return;
        const view = new DataView(data);
        const idTo = view.getUint32(4, true);
        const target = (room.host === ws || (idTo !== 0 && idTo !== 1)) ? room.peers.get(idTo) : room.host;
        // The relay stamps a client's real id; the host's is kept, because a
        // host forwards packets for clients it reaches over WebRTC.
        if (room.host !== ws)
            view.setUint32(0, c.id, true);
        if (target && target !== ws)
            this.send(target, data);
    }

    leave(ws) {
        const c = this.conn(ws);
        const room = this.rooms.get(c.room);
        if (!room) {
            if (c.room)
                this.setConn(ws, 0, 0);
            return;
        }
        if (room.host === ws) {
            this.rooms.delete(room.id);
            this.ctx.storage.delete("room:" + room.id);
            for (const peer of room.peers.values()) {
                this.setConn(peer, 0, 0);
                this.send(peer, "host-left");
            }
            console.log(`relay: room ${room.id} closed`);
        } else if (room.peers.get(c.id) === ws) {
            room.peers.delete(c.id);
            this.send(room.host, `peer-left ${c.id}`);
            console.log(`relay: room ${room.id}: id ${c.id} left`);
        }
        this.setConn(ws, 0, 0);
    }
}
