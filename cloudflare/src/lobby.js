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
//
// It also keeps the live counts the landing page shows: each running game
// says its player's name (hello), and every page watching the lobby (watch)
// gets a fresh status whenever someone comes, goes, hosts or joins.

import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE = 64 * 1024;
const MAX_ENTRY_HEX = 2048;
const MAX_SIGNAL_B64 = 16384;
const FIRST_PEER_ID = 2;
const LAST_PEER_ID = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[0-9]{1,9}$/;
// A jkMultiEntry (types.h in the OpenJKDF2 fork) in hex. Anything after it is
// the host's mod tail (packaging/wasm/mods.js).
const ENTRY_HEX = 240 * 2;
const GAMES = ["jk1", "mots"];
const MAX_NAME_B64 = 128;
// The game sends 15 characters of a player's name to the others.
const MAX_NAME = 15;
const MAX_STATUS_GAMES = 64;
const MAX_STATUS_NAMES = 64;
// Control and invisible characters (bidi overrides among them) never reach a page.
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
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

function hexBytes(hex) {
    const b = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < b.length; i++)
        b[i] = parseInt(hex.substr(i * 2, 2), 16);
    return b;
}

function cleanText(text, max) {
    return Array.from(text.replace(HIDDEN_RE, "").trim()).slice(0, max).join("").trim();
}

// A C string of up to n bytes, printable ASCII only.
function ascii(b, at, n) {
    let s = "";
    for (let i = at; i < Math.min(at + n, b.length) && b[i]; i++)
        s += b[i] >= 0x20 && b[i] < 0x7f ? String.fromCharCode(b[i]) : "?";
    return s;
}

function utf16(b, at, n) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let s = "";
    for (let i = 0; i < n; i++) {
        const ch = v.getUint16(at + i * 2, true);
        if (!ch)
            break;
        s += String.fromCharCode(ch);
    }
    return cleanText(s, 32);
}

// The mod named in a host's tail: "JKMD", version 2, flags (1 a mod, 2 the
// MotS Remastered pack), the name's length, the mod's 32-byte and the pack's
// 16-byte fingerprints when there, then the name. As mods.js writes it.
function modName(hex) {
    const b = hexBytes(hex);
    if (b.length < 7 || b[0] !== 0x4a || b[1] !== 0x4b || b[2] !== 0x4d || b[3] !== 0x44 || b[4] !== 2)
        return "";
    const flags = b[5];
    const name = flags & 1 ? ascii(b, 7 + 32 + (flags & 2 ? 16 : 0), b[6]) : "";
    if (flags & 2)
        return name ? name + ", Remastered pack" : "Remastered pack";
    return name;
}

// What the page shows of a hosted game: never its password, only whether it
// has one. null for an entry that isn't a game's.
function readEntry(hex) {
    if (hex.length < ENTRY_HEX)
        return null;
    const b = hexBytes(hex.slice(0, ENTRY_HEX));
    const v = new DataView(b.buffer);
    const max = v.getInt32(16, true);
    return {
        max: max > 0 && max <= LAST_PEER_ID ? max : 0,
        name: utf16(b, 24, 32),
        episode: ascii(b, 88, 32),
        map: ascii(b, 120, 32),
        locked: v.getUint16(152, true) !== 0,
        mod: modName(hex.slice(ENTRY_HEX)),
    };
}

// hello's base64 UTF-8 name, cleaned, or null if it isn't one.
function playerName(b64) {
    if (b64.length > MAX_NAME_B64 || !B64_RE.test(b64))
        return null;
    let bin;
    try {
        bin = atob(b64);
    } catch (e) {
        return null;
    }
    return cleanText(new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))), MAX_NAME);
}

function base64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
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
        // ws -> {room, id, name, game, watch}: the room id and player id, the
        // player's name and game from hello (name null until then), and
        // whether it's a page watching the counts.
        this.conns = new Map();
        this.nextRoom = 1;
        this.lastStatus = null;   // the status the watchers have
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
        this.saveConn(server, { room: 0, id: 0, name: null, game: "", watch: false });
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
            this.statusChanged();
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
        this.statusChanged();
        try { ws.close(1000, "bye"); } catch (e) {}
    }

    async webSocketError(ws, error) {
        this.leave(ws);
        this.conns.delete(ws);
        this.statusChanged();
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
        this.saveConn(ws, { ...this.conn(ws), room, id });
    }

    saveConn(ws, c) {
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
            let watching = 0;
            for (const c of this.conns.values())
                watching += c.watch ? 1 : 0;
            console.log(`relay: ${s.text + s.packets} messages in ${Math.round((now - s.since) / 1000)} s ` +
                `(${s.packets} game packets, ${s.bytes} bytes), ${this.conns.size - watching} connected, ` +
                `${watching} watching`);
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
            this.statusChanged();
        } else if (op === "update" && args.length === 1 && validEntry(args[0])) {
            const room = this.rooms.get(c.room);
            if (room && room.host === ws && room.entry !== args[0]) {
                room.entry = args[0];
                this.ctx.storage.put("room:" + room.id, room.entry);
                this.statusChanged();
            }
        } else if (op === "join" && args.length === 1 && ID_RE.test(args[0])) {
            this.leave(ws);
            const room = this.rooms.get(Number(args[0]));
            if (!room) {
                this.send(ws, "error no-room");
                this.statusChanged();
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
                this.statusChanged();
                return;
            }
            room.peers.set(peerId, ws);
            this.setConn(ws, room.id, peerId);
            this.send(room.host, `peer-joined ${peerId}`);
            console.log(`relay: room ${room.id}: player joined as id ${peerId}`);
            this.statusChanged();
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
            this.statusChanged();
        } else if (op === "hello" && args.length === 2 && GAMES.includes(args[0]) && playerName(args[1]) !== null) {
            this.saveConn(ws, { ...c, name: playerName(args[1]), game: args[0] });
            this.statusChanged();
        } else if (op === "watch" && !args.length) {
            this.saveConn(ws, { ...c, watch: true });
            this.watch(ws);
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

    // The landing page's live counts: who's on and the games they're in. A
    // player is a game that said hello or is in a room; watching pages aren't.
    status() {
        const lobby = [];
        for (const c of this.conns.values()) {
            if (!c.room && c.name != null)
                lobby.push(c.name);
        }
        lobby.sort((a, b) => a.localeCompare(b));
        const games = [];
        let online = lobby.length;
        for (const room of [...this.rooms.values()].sort((a, b) => a.id - b.id)) {
            const info = readEntry(room.entry);
            if (!info)
                continue;
            const host = this.conn(room.host);
            const peers = [...room.peers.entries()].sort((a, b) => a[0] - b[0]);
            const names = [host.name || "", ...peers.map(([, ws]) => this.conn(ws).name || "")];
            online += names.length;
            games.push({
                id: room.id, name: info.name, game: host.game || (/\.goo$/i.test(info.episode) ? "mots" : "jk1"),
                map: info.map, episode: info.episode, mod: info.mod, locked: info.locked,
                players: names.length, max: info.max, names: names.slice(0, MAX_STATUS_NAMES),
            });
        }
        return "status " + base64Utf8(JSON.stringify({
            online, lobby: lobby.slice(0, MAX_STATUS_NAMES), games: games.slice(0, MAX_STATUS_GAMES),
        }));
    }

    watchers() {
        return [...this.conns.entries()].filter(([, c]) => c.watch).map(([ws]) => ws);
    }

    // After anything that can change the counts: tells the watching pages,
    // unless they already have this status.
    statusChanged() {
        const watchers = this.watchers();
        if (!watchers.length) {
            this.lastStatus = null;
            return;
        }
        const status = this.status();
        if (status === this.lastStatus)
            return;
        this.lastStatus = status;
        for (const w of watchers)
            this.send(w, status);
    }

    watch(ws) {
        const status = this.status();
        if (status === this.lastStatus) {
            this.send(ws, status);
            return;
        }
        // A new status here means the lobby just woke up or this is the first
        // page watching: any others may not have it either.
        this.lastStatus = status;
        for (const w of this.watchers())
            this.send(w, status);
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
