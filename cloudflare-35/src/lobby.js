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
//
// Game packets go over WebRTC once a player's link is up, so a socket that
// drops mid-game (a network blip, or every socket when the lobby is updated)
// doesn't end the match: each seat in a room has a key, sent to its player
// with seat, and a seat whose socket closed without leave is held for HOLD_MS.
// The room hears peer-lost or host-lost, and peer-back or host-back when the
// player takes the seat back with rejoin or rehost. A seat nobody takes back
// ends as before, with peer-left, or host-left for the whole room. Seats are
// kept in storage, so they last through the lobby restarting.

import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE = 64 * 1024;
const MAX_ENTRY_HEX = 2048;
const MAX_SIGNAL_B64 = 16384;
const FIRST_PEER_ID = 2;
const LAST_PEER_ID = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[0-9]{1,9}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
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
// The game and the page send "ping" every 25 s. A connection that has sent
// nothing for this long is gone without having closed (a tab or browser that
// was killed, a computer that went to sleep, a network that dropped), and its
// player and game come off the lists. Background tabs may only ping once a
// minute.
const QUIET_MS = 2 * 60 * 1000;
// How often to look for them while anyone is connected.
const SWEEP_MS = 60 * 1000;
// How long a dropped player's seat waits for them to take it back. The game
// reconnects after 1 s, then 2, 4 and every 5 s. The HOLD_MS var overrides
// it, for tests.
const HOLD_MS = 60 * 1000;

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
// For a host that didn't say hello: the retail Mysteries of the Sith episodes
// all start with JKM (JKM, JKM_KFY, JKM_MP, JKM_SABER). Episode names have no
// extension.
function guessGame(episode) {
    return /^jkm/i.test(episode) ? "mots" : "jk1";
}

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

function newKey() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
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
        // room id -> {id, host, entry, peers: Map(id -> ws), seats}, where
        // seats is Map(id -> {key, until, name, game}) for the host (1) and
        // each peer: until, name and game only while the seat is held.
        this.rooms = new Map();
        this.holdMs = Number(env.HOLD_MS) || HOLD_MS;
        // ws -> {room, id, name, game, watch, since}: the room id and player
        // id, the player's name and game from hello (name null until then),
        // whether it's a page watching the counts, and when it connected.
        this.conns = new Map();
        this.heard = new Map();   // ws -> when its last message came (not its pings)
        this.alarmAt = null;      // when the next sweep for quiet connections runs
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
        this.alarmAt = await this.ctx.storage.getAlarm();
        const entries = await this.ctx.storage.list({ prefix: "room:" });
        const seats = await this.ctx.storage.list({ prefix: "seats:" });
        for (const [key, entry] of entries)
            this.rooms.set(Number(key.slice(5)), this.newRoom(Number(key.slice(5)), entry, seats.get("seats:" + key.slice(5))));
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() || { room: 0, id: 0 };
            this.conns.set(ws, att);
            if (!att.room)
                continue;
            let room = this.rooms.get(att.room);
            if (!room) {
                room = this.newRoom(att.room, "", null);
                this.rooms.set(att.room, room);
            }
            if (att.id === 1)
                room.host = ws;
            else
                room.peers.set(att.id, ws);
        }
        const now = Date.now();
        for (const room of [...this.rooms.values()]) {
            // A seat whose socket went without a close (all of them, when the
            // lobby restarts for an update) is held like any dropped one.
            let changed = false;
            for (const [id, seat] of room.seats) {
                const live = id === 1 ? room.host : room.peers.get(id);
                if (live && seat.until) {
                    delete seat.until;
                    changed = true;
                } else if (!live && !seat.until) {
                    seat.until = now + this.holdMs;
                    changed = true;
                }
            }
            // A room whose host is gone with no seat to come back to can't go
            // on (its close should have ended it, but never leave players
            // waiting on one).
            if (!room.host && !room.seats.has(1)) {
                this.endRoom(room);
                continue;
            }
            if (changed)
                this.saveSeats(room);
        }
        for (const key of entries.keys()) {
            if (!this.rooms.has(Number(key.slice(5))))
                this.ctx.storage.delete(key);
        }
        for (const key of seats.keys()) {
            if (!this.rooms.has(Number(key.slice(6))))
                this.ctx.storage.delete(key);
        }
        if (this.conns.size)
            this.sweepLater();
        if (this.nextExpiry())
            this.sweepLater(this.nextExpiry());
    }

    newRoom(id, entry, seats) {
        return {
            id, host: null, entry, peers: new Map(),
            seats: new Map(Object.entries(seats || {}).map(([k, v]) => [Number(k), v])),
        };
    }

    saveSeats(room) {
        this.ctx.storage.put("seats:" + room.id, Object.fromEntries(room.seats));
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        this.saveConn(server, { room: 0, id: 0, name: null, game: "", watch: false, since: Date.now() });
        this.sweepLater();
        const ice = iceMessage(this.env);
        if (ice)
            this.send(server, ice);
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        this.heard.set(ws, Date.now());
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
        this.drop(ws);
        this.conns.delete(ws);
        this.heard.delete(ws);
        this.statusChanged();
        try { ws.close(1000, "bye"); } catch (e) {}
    }

    async webSocketError(ws, error) {
        this.drop(ws);
        this.conns.delete(ws);
        this.heard.delete(ws);
        this.statusChanged();
    }

    async alarm() {
        this.alarmAt = null;
        this.sweep();
        if (this.conns.size)
            this.sweepLater();
        if (this.nextExpiry())
            this.sweepLater(this.nextExpiry());
    }

    // Looks for quiet connections and held seats that ran out at the time
    // given (in SWEEP_MS by default), unless a look comes sooner.
    sweepLater(at = Date.now() + SWEEP_MS) {
        if (this.alarmAt && this.alarmAt <= at)
            return;
        this.alarmAt = at;
        this.ctx.storage.setAlarm(at);
    }

    // When the first held seat runs out, 0 for none.
    nextExpiry() {
        let at = 0;
        for (const room of this.rooms.values()) {
            for (const seat of room.seats.values()) {
                if (seat.until && (!at || seat.until < at))
                    at = seat.until;
            }
        }
        return at;
    }

    // Ends the connections that have sent nothing, not even a ping, for
    // QUIET_MS: as if they had closed, so a game whose host is gone ends once
    // its seat runs out. Then ends the held seats nobody took back in time.
    sweep() {
        const now = Date.now();
        let quiet = 0;
        for (const [ws, c] of [...this.conns]) {
            const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws);
            const last = Math.max(c.since || 0, ping ? ping.getTime() : 0, this.heard.get(ws) || 0);
            if (now - last < QUIET_MS)
                continue;
            this.drop(ws);
            // Counted nowhere if the object wakes up before the socket is gone.
            this.saveConn(ws, { room: 0, id: 0, name: null, game: "", watch: false, since: 0 });
            this.conns.delete(ws);
            this.heard.delete(ws);
            try { ws.close(4000, "quiet"); } catch (e) {}
            quiet++;
        }
        if (quiet)
            console.log(`relay: ended ${quiet} quiet connection(s)`);
        let ended = 0;
        for (const room of [...this.rooms.values()]) {
            for (const [id, seat] of [...room.seats]) {
                if (!seat.until || seat.until > now)
                    continue;
                ended++;
                if (id === 1) {
                    console.log(`relay: room ${room.id}: the host didn't come back, room closed`);
                    this.endRoom(room);
                    break;
                }
                room.seats.delete(id);
                this.saveSeats(room);
                if (room.host)
                    this.send(room.host, `peer-left ${id}`);
                console.log(`relay: room ${room.id}: id ${id} didn't come back`);
            }
        }
        if (quiet || ended)
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
            // list jk1 or list mots: only the games that game can join, so
            // not those whose host said hello as the other one.
            const want = GAMES.includes(args[0]) ? args[0] : null;
            const games = [...this.rooms.values()]
                .filter(r => r.host && (!want || !this.conn(r.host).game || this.conn(r.host).game === want))
                .map(r => `${r.id} ${this.seated(r).length} ${r.entry}`);
            this.send(ws, ["list", ...games].join(" "));
        } else if (op === "host" && args.length === 1 && validEntry(args[0])) {
            this.leave(ws);
            const room = this.newRoom(this.nextRoom++, args[0], null);
            room.host = ws;
            room.seats.set(1, { key: newKey() });
            this.ctx.storage.put({ nextRoom: this.nextRoom, ["room:" + room.id]: room.entry,
                                   ["seats:" + room.id]: Object.fromEntries(room.seats) });
            this.rooms.set(room.id, room);
            this.setConn(ws, room.id, 1);
            this.send(ws, `hosted ${room.id}`);
            this.send(ws, `seat ${room.id} 1 ${room.seats.get(1).key}`);
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
            // Not while its host is away: nobody would welcome them.
            if (!room || !room.host) {
                this.send(ws, "error no-room");
                this.statusChanged();
                return;
            }
            let peerId = 0;
            for (let i = FIRST_PEER_ID; i <= LAST_PEER_ID; i++) {
                if (!room.peers.has(i) && !room.seats.has(i)) {
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
            room.seats.set(peerId, { key: newKey() });
            this.saveSeats(room);
            this.setConn(ws, room.id, peerId);
            this.send(room.host, `peer-joined ${peerId}`);
            this.send(ws, `seat ${room.id} ${peerId} ${room.seats.get(peerId).key}`);
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
        } else if (op === "rejoin" && args.length === 3 && ID_RE.test(args[0]) && ID_RE.test(args[1]) && KEY_RE.test(args[2])) {
            this.takeSeat(ws, Number(args[0]), Number(args[1]), args[2], null);
        } else if (op === "rehost" && (args.length === 2 || args.length === 3) && ID_RE.test(args[0]) && KEY_RE.test(args[1]) &&
                   (args.length === 2 || validEntry(args[2]))) {
            this.takeSeat(ws, Number(args[0]), 1, args[1], args[2] || "");
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

    // The landing page's live counts: who's on and the games they're in, in
    // all and by game (its rooms are each for one game). A player is a game
    // that said hello or is in a room; watching pages aren't.
    status() {
        const byName = (a, b) => a.localeCompare(b);
        const lobby = [];
        const byGame = Object.fromEntries(GAMES.map(g => [g, { online: 0, lobby: [] }]));
        for (const c of this.conns.values()) {
            if (!c.room && c.name != null) {
                lobby.push(c.name);
                byGame[c.game].lobby.push(c.name);
            }
        }
        lobby.sort(byName);
        const games = [];
        let online = lobby.length;
        for (const room of [...this.rooms.values()].sort((a, b) => a.id - b.id)) {
            const info = readEntry(room.entry);
            if (!info)
                continue;
            const host = room.host ? this.conn(room.host) : room.seats.get(1);
            const names = this.seated(room).map(([id, ws, seat]) => (ws ? (id === 1 ? host : this.conn(ws)) : seat).name || "");
            const game = host.game || guessGame(info.episode);
            online += names.length;
            byGame[game].online += names.length;
            games.push({
                id: room.id, name: info.name, game,
                map: info.map, episode: info.episode, mod: info.mod, locked: info.locked,
                players: names.length, max: info.max, names: names.slice(0, MAX_STATUS_NAMES),
            });
        }
        for (const g of Object.values(byGame)) {
            g.online += g.lobby.length;
            g.lobby = g.lobby.sort(byName).slice(0, MAX_STATUS_NAMES);
        }
        return "status " + base64Utf8(JSON.stringify({
            online, lobby: lobby.slice(0, MAX_STATUS_NAMES), byGame, games: games.slice(0, MAX_STATUS_GAMES),
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

    // The room's players by id, the host first, held seats too: [id, ws or
    // null, seat].
    seated(room) {
        const all = new Map();
        all.set(1, [1, room.host, room.seats.get(1)]);
        for (const [id, ws] of room.peers)
            all.set(id, [id, ws, room.seats.get(id)]);
        for (const [id, seat] of room.seats) {
            if (seat.until && !all.has(id))
                all.set(id, [id, null, seat]);
        }
        return [...all.values()].sort((a, b) => a[0] - b[0]);
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
            this.endRoom(room);
            console.log(`relay: room ${room.id} closed`);
        } else if (room.peers.get(c.id) === ws) {
            room.peers.delete(c.id);
            room.seats.delete(c.id);
            this.saveSeats(room);
            if (room.host)
                this.send(room.host, `peer-left ${c.id}`);
            console.log(`relay: room ${room.id}: id ${c.id} left`);
        }
        this.setConn(ws, 0, 0);
    }

    // A socket that closed without leave, errored or went quiet: its seat is
    // held for its player to take back (takeSeat).
    drop(ws) {
        const c = this.conn(ws);
        const room = this.rooms.get(c.room);
        const seat = room && room.seats.get(c.id);
        if (!seat || ws !== (c.id === 1 ? room.host : room.peers.get(c.id))) {
            this.leave(ws);
            return;
        }
        Object.assign(seat, { until: Date.now() + this.holdMs, name: c.name || null, game: c.game || "" });
        if (c.id === 1) {
            room.host = null;
            for (const peer of room.peers.values())
                this.send(peer, "host-lost");
        } else {
            room.peers.delete(c.id);
            if (room.host)
                this.send(room.host, `peer-lost ${c.id}`);
        }
        this.saveSeats(room);
        this.setConn(ws, 0, 0);
        this.sweepLater(seat.until);
        console.log(`relay: room ${room.id}: id ${c.id} dropped, seat held`);
    }

    // rejoin and rehost: a player takes its seat back with its key, held or
    // not (the old socket may not have closed yet, and is replaced). A
    // rehost may bring the room's entry, in case it changed meanwhile.
    takeSeat(ws, roomId, id, key, entry) {
        const room = this.rooms.get(roomId);
        const seat = room && room.seats.get(id);
        if (!seat || seat.key !== key || (id === 1) !== (entry !== null)) {
            this.send(ws, "error no-seat");
            return;
        }
        const old = id === 1 ? room.host : room.peers.get(id);
        if (old !== ws) {
            this.leave(ws);
            if (old) {
                this.setConn(old, 0, 0);
                try { old.close(4001, "replaced"); } catch (e) {}
            }
        }
        const wasHeld = !!seat.until;
        delete seat.until;
        delete seat.name;
        delete seat.game;
        if (id === 1) {
            room.host = ws;
            if (entry && entry !== room.entry) {
                room.entry = entry;
                this.ctx.storage.put("room:" + room.id, entry);
            }
        } else {
            room.peers.set(id, ws);
        }
        this.setConn(ws, room.id, id);
        this.saveSeats(room);
        this.send(ws, id === 1 ? `rehosted ${room.id}` : `rejoined ${room.id} ${id}`);
        if (wasHeld && id === 1) {
            for (const peer of room.peers.values())
                this.send(peer, "host-back");
        } else if (wasHeld && room.host) {
            this.send(room.host, `peer-back ${id}`);
        }
        console.log(`relay: room ${room.id}: id ${id} took its seat back`);
        this.statusChanged();
    }

    // Ends a room: its players are told the host left.
    endRoom(room) {
        this.rooms.delete(room.id);
        this.ctx.storage.delete(["room:" + room.id, "seats:" + room.id]);
        for (const peer of room.peers.values()) {
            this.setConn(peer, 0, 0);
            this.send(peer, "host-left");
        }
    }
}
