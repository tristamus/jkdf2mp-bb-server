// A watched match's feed (spectator mode, Stage 2): one Durable Object per
// room, named "room:<id>" (room numbers aren't used again). The games in the
// room send it what they send everyone, and it hands that to the pages
// watching the match, held back by the room's delay, so watching can't call
// out where players are. Nothing in it is kept: a match's feed lives in
// memory while it's sent and watched.
//
// The Lobby arms a feed (arm, over RPC) with the room's delay and a token for
// each game that takes part, tells each game its token (feed <room> <token>),
// and ends it (end) when the room ends, watching is turned off, or nobody has
// watched for a while (FEED_LINGER_MS in lobby.js). The Lobby is the only one
// that says who may send: the address alone gets a page the match to watch.
//
//   /feed/<room>?up=<token>   a game sending (binary messages, below)
//   /feed/<room>              a page watching
//
// A game's message is one chunk: its first byte the kind, then its packets as
// the game frames them (the feed never reads them).
//   0  packets sent to everyone since its last chunk
//   1  the start of a keyframe: the state a game joining now would be sent
//   2  more of the keyframe started by the last 1
// A page gets "feed <delay s>" on connect, then binary batches, each one or
// more records of
//   u32 length of what follows the length (LE), u32 ms since the feed began
//   when the chunk came, u8 kind, u8 seat (1 the host, 2.. players), packets
// starting at a keyframe once there is one at least the delay old, and every
// chunk after it in order as each comes of age. "feed waiting" says there is
// none yet, and "feed ended <why>" comes before the feed closes the socket.
// The host's game sends a keyframe once its feed opens, at each new level and
// every minute; a page that comes when the feed holds none (it was evicted, or
// has just started) has the feed ask the host's game for one ("key"), at
// most once every KEY_ASK_MS.

import { DurableObject } from "cloudflare:workers";

// What one chunk and one feed may hold. A 4-player match was estimated at
// about 16 KB/s (50 positions a second per player, 64-84 bytes each), so
// 5 minutes behind live is about 5 MB.
const MAX_CHUNK = 64 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
// A game batches its packets, every 250 ms or so; incoming messages are
// billed, 20 to a request. More than this many a second (over 5 s) and its
// socket is closed.
const MAX_CHUNKS_PER_S = 20;
const RATE_WINDOW_MS = 5000;
// How many pages may watch one match, and how often the feed looks for
// chunks that came of age while nothing else happens.
const MAX_VIEWERS = 200;
const TICK_MS = 250;
const KIND_DELTA = 0;
const KIND_KEY = 1;
const KIND_KEY_MORE = 2;
const SEAT_MAX = 64;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const RECORD_HEAD = 10;
const SEAT_HOST = 1;
const KEY_ASK_MS = 10 * 1000;
// A feed nothing has been sent to for this long ends itself (its room may
// have ended while the lobby was away).
const IDLE_MS = 10 * 60 * 1000;

export class Feed extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // {room, delay (s), tokens: {token: seat}, began (ms)}, null until
        // the Lobby arms it. Kept in storage, so a feed that was evicted
        // still knows who may send; what it held is gone (pages wait for
        // the next keyframe).
        this.cfg = null;
        // Chunks not yet dropped, oldest first: {seq, at, kind, seat, rec}
        // (rec: the record pages get). seq counts every chunk this object
        // took; base is the first one's.
        this.chunks = [];
        this.base = 0;
        this.nextSeq = 0;
        this.bytes = 0;
        // ws -> {seat} for a game, {next} for a page: the seq it gets next,
        // -1 until it has had a keyframe.
        this.socks = new Map();
        this.rate = new Map();    // a game's ws -> times of its latest chunks
        this.timer = null;
        this.lastUp = 0;          // when a game last sent, or the feed was armed
        this.keyAsked = 0;        // when the host's game was last asked for a keyframe
        ctx.blockConcurrencyWhile(async () => {
            this.cfg = (await ctx.storage.get("cfg")) || null;
            for (const ws of ctx.getWebSockets())
                this.socks.set(ws, ws.deserializeAttachment() || { next: -1 });
            for (const s of this.socks.values()) {
                if ("next" in s)
                    s.next = -1;
            }
        });
    }

    // From the Lobby: the feed's room, delay and the games that may send
    // ({token: seat}). Called again whenever any of it changes; a game whose
    // token is gone is closed.
    async arm(room, delay, tokens) {
        const clean = {};
        for (const [t, seat] of Object.entries(tokens || {})) {
            if (TOKEN_RE.test(t) && Number.isInteger(seat) && seat >= 1 && seat <= SEAT_MAX)
                clean[t] = seat;
        }
        const began = this.cfg && this.cfg.room === room ? this.cfg.began : Date.now();
        this.cfg = { room, delay: Math.max(0, Number(delay) || 0), tokens: clean, began };
        this.lastUp = Date.now();
        await this.ctx.storage.put("cfg", this.cfg);
        if (!(await this.ctx.storage.getAlarm()))
            await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
        const seats = new Set(Object.values(clean));
        for (const [ws, s] of this.socks) {
            if ("seat" in s && !seats.has(s.seat))
                this.closeWs(ws, 4001, "not sending");
        }
        this.flush();
        return true;
    }

    // From the Lobby: the room ended, or watching it did.
    async end(why) {
        for (const [ws, s] of [...this.socks]) {
            if ("next" in s)
                this.sendTo(ws, "feed ended " + (why || "over"));
            this.closeWs(ws, 1000, why || "over");
        }
        this.socks.clear();
        this.rate.clear();
        this.chunks = [];
        this.bytes = 0;
        this.cfg = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        await this.ctx.storage.deleteAll();
        return true;
    }

    async alarm() {
        if (!this.cfg)
            return;
        const now = Date.now();
        if (now - this.lastUp < IDLE_MS)
            await this.ctx.storage.setAlarm(this.lastUp + IDLE_MS);
        else
            await this.end("idle");
    }

    // What the feed holds, for tests and the log.
    async info() {
        let games = 0, pages = 0;
        for (const s of this.socks.values()) {
            if ("seat" in s) games++;
            else pages++;
        }
        return { armed: !!this.cfg, delay: this.cfg ? this.cfg.delay : 0, chunks: this.chunks.length, bytes: this.bytes, games, pages };
    }

    async fetch(request) {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
            return new Response("Expected a WebSocket upgrade", { status: 426 });
        if (!this.cfg)
            return new Response("No feed for this match", { status: 404 });
        const up = new URL(request.url).searchParams.get("up");
        let state;
        if (up !== null) {
            const seat = TOKEN_RE.test(up) ? this.cfg.tokens[up] : undefined;
            if (!seat)
                return new Response("Not a game in this match", { status: 403 });
            // One socket per seat: a game that reconnects takes its place.
            for (const [ws, s] of this.socks) {
                if (s.seat === seat)
                    this.closeWs(ws, 4002, "replaced");
            }
            state = { seat };
        } else {
            let pages = 0;
            for (const s of this.socks.values()) {
                if ("next" in s) pages++;
            }
            if (pages >= MAX_VIEWERS)
                return new Response("Too many watching", { status: 503 });
            state = { next: -1 };
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        try { server.serializeAttachment(state); } catch (e) {}
        this.socks.set(server, state);
        if ("next" in state) {
            this.sendTo(server, "feed " + this.cfg.delay);
            this.flush();
            if (state.next < 0) {
                this.sendTo(server, "feed waiting");
                this.askKey();
            }
        }
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        const s = this.socks.get(ws);
        // Pages have nothing to say (their ping is answered without waking
        // the object), nor has a game in text.
        if (!s || !("seat" in s) || typeof message === "string")
            return;
        const now = Date.now();
        const times = (this.rate.get(ws) || []).filter(t => now - t < RATE_WINDOW_MS);
        times.push(now);
        this.rate.set(ws, times);
        if (times.length > MAX_CHUNKS_PER_S * RATE_WINDOW_MS / 1000) {
            this.closeWs(ws, 1008, "too many");
            return;
        }
        const data = new Uint8Array(message);
        if (data.length < 2 || data.length > MAX_CHUNK || data[0] > KIND_KEY_MORE) {
            this.closeWs(ws, 1003, "bad chunk");
            return;
        }
        this.lastUp = now;
        this.take(now, data[0], s.seat, data.subarray(1));
        this.flush(now);
    }

    async webSocketClose(ws) {
        this.socks.delete(ws);
        this.rate.delete(ws);
        try { ws.close(1000, "bye"); } catch (e) {}
    }

    async webSocketError(ws) {
        this.socks.delete(ws);
        this.rate.delete(ws);
    }

    // A page waits with no keyframe here to start from, not even one still
    // coming of age: ask the host's game for one.
    askKey(now = Date.now()) {
        if (this.chunks.some(c => c.kind === KIND_KEY) || now - this.keyAsked < KEY_ASK_MS)
            return;
        for (const [ws, s] of this.socks) {
            if (s.seat === SEAT_HOST) {
                this.keyAsked = now;
                this.sendTo(ws, "key");
                return;
            }
        }
    }

    take(now, kind, seat, packets) {
        const rec = new Uint8Array(RECORD_HEAD + packets.length);
        const dv = new DataView(rec.buffer);
        dv.setUint32(0, rec.length - 4, true);
        dv.setUint32(4, Math.max(0, now - this.cfg.began) >>> 0, true);
        rec[8] = kind;
        rec[9] = seat;
        rec.set(packets, RECORD_HEAD);
        this.chunks.push({ seq: this.nextSeq++, at: now, kind, seat, rec });
        this.bytes += rec.length;
        // Too far behind to hold: drop the oldest, and pages start again from
        // the next keyframe.
        while (this.bytes > MAX_BUFFER && this.chunks.length) {
            const c = this.chunks.shift();
            this.bytes -= c.rec.length;
            for (const st of this.socks.values()) {
                if ("next" in st && st.next >= 0 && st.next <= c.seq)
                    st.next = -1;
            }
        }
        this.base = this.chunks.length ? this.chunks[0].seq : this.nextSeq;
    }

    // Sends every page what came of age, and drops what nobody can need:
    // the chunks before the latest keyframe that's of age (every one of age,
    // when none is a keyframe), since every page has had them or starts at
    // a keyframe.
    flush(now = Date.now()) {
        if (!this.cfg)
            return;
        const ripe = now - this.cfg.delay * 1000;
        let end = 0;
        while (end < this.chunks.length && this.chunks[end].at <= ripe)
            end++;
        let key = -1;
        for (let i = end - 1; i >= 0; i--) {
            if (this.chunks[i].kind === KIND_KEY) {
                key = i;
                break;
            }
        }
        for (const [ws, s] of this.socks) {
            if (!("next" in s))
                continue;
            // A page whose next chunk was dropped starts again at a keyframe.
            if (s.next >= 0 && s.next < this.base)
                s.next = -1;
            const from = s.next < 0 ? key : s.next - this.base;
            if (from < 0 || from >= end)
                continue;
            this.sendTo(ws, joinRecords(this.chunks, from, end));
            s.next = this.chunks[end - 1].seq + 1;
        }
        const wait = end < this.chunks.length ? this.chunks[end].at + this.cfg.delay * 1000 - now : 0;
        const drop = key >= 0 ? key : end;
        if (drop > 0) {
            for (const c of this.chunks.splice(0, drop))
                this.bytes -= c.rec.length;
            this.base = this.chunks.length ? this.chunks[0].seq : this.nextSeq;
        }
        this.later(wait);
    }

    // Looks again once the next chunk comes of age, while any page watches.
    later(ms) {
        if (this.timer || !ms)
            return;
        let pages = false;
        for (const s of this.socks.values()) {
            if ("next" in s) pages = true;
        }
        if (!pages)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, Math.max(TICK_MS, Math.min(ms, 5000)));
    }

    sendTo(ws, data) {
        try {
            ws.send(data);
        } catch (e) {
            // Closed: its close event cleans up.
        }
    }

    closeWs(ws, code, reason) {
        this.socks.delete(ws);
        this.rate.delete(ws);
        try { ws.close(code, reason); } catch (e) {}
    }
}

function joinRecords(chunks, from, end) {
    let n = 0;
    for (let i = from; i < end; i++)
        n += chunks[i].rec.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (let i = from; i < end; i++) {
        out.set(chunks[i].rec, at);
        at += chunks[i].rec.length;
    }
    return out.buffer;
}

// The Worker's route for /feed/<room>: to that room's feed, if this
// deployment has them (the FEED binding).
const FEED_PATH_RE = /^\/feed\/([0-9]{1,9})$/;
export async function feedRoute(request, env, url) {
    const m = FEED_PATH_RE.exec(url.pathname);
    if (!m)
        return null;
    if (!env.FEED)
        return new Response("Not found", { status: 404 });
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket upgrade", { status: 426 });
    return env.FEED.get(env.FEED.idFromName("room:" + Number(m[1]))).fetch(request);
}
