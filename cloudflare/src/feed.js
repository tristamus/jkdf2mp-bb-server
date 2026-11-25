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
//   3  packets sent to everyone, each with who sent it: a u32 player id (LE)
//      before each packet's length. Only in a feed armed wide: a dedicated
//      server on the Imperial relay sends its players' messages along with
//      its own, and their ids don't fit the seat (src/imperial-feed.js).
// A page gets "feed <delay s>" on connect, then binary batches, each one or
// more records of
//   u32 length of what follows the length (LE), u32 ms since the feed began
//   when the chunk came, u8 kind, u8 seat (1 the host, 2.. players), packets
// starting at a keyframe once there is one at least the delay old, and every
// chunk after it in order as each comes of age. "feed waiting" says there is
// none yet, and "feed first <ms>" how long until there is, once the feed
// holds a keyframe that isn't of age yet: when the page comes, or when that
// keyframe comes (the game watching counts it down; one that doesn't know
// it leaves it). "feed ended <why>" comes before the feed closes the socket:
// when the room ended, once the page has had the match's last delay seconds.
// The host's game sends a keyframe once its feed opens, at each new level and
// every minute; a page that comes when the feed holds none (it was evicted, or
// has just started) has the feed ask the host's game for one ("key"), at
// most once every KEY_ASK_MS. The first keyframe the host's game sends, the
// feed tells the Lobby (feedKeyed, over RPC): only then does the room's status
// say feed: 1, so the lobby page offers the game itself to watch. A host's
// game that never sends one (another build, one from before the feed) is
// watched by its scores, rather than on a black screen that waits for a
// first picture that never comes (Antonio, 2026-11-25: a match with bots).
//
// A page watching here is a game watching the match from inside the game
// (Watch in the game). The feed tells the Lobby how many there are
// (feedPages, over RPC) a moment after one comes or goes, so the room's
// watching counts them with the pages watching its scores. One that comes
// with ?box=1 is the game in a viewing page's box (OpenJKDF2's index.html,
// #watch-<room>-embed): that page is counted by the Lobby already (spectate
// <room>, for as long as it shows the match), so the feed leaves it out, and
// the count doesn't move when the box's game starts again (into the host's
// mod) or comes on or off the feed.
//
// One that doesn't have the match's mod, nor finds it in the Mod Library,
// says "mod <fp>" (the mod's fingerprint, its SHA-256 as packed): the feed
// asks the host's game for it ("mod <fp>", at most once every MOD_ASK_MS for
// each mod), and the host's game puts it here as it sends it to joiners,
// without the original game files in it (OpenJKDF2's maps.js feedUp). The
// same for the match's level, when the Level Library doesn't have the
// host's version of it: <fp> is then its GOB's SHA-256, and the host's game
// tells them apart.
//
//   PUT /feed/<room>/mod/<fp>/<part>?up=<token>   the host's game (modPut)
//   GET /feed/<room>/mod/<fp>/<part>              a game watching
//
// <part> is info (JSON, at most MOD_INFO_MAX) or a block's number (at most
// MOD_PART_MAX). They're kept in the SHOTS bucket under
// feed-mods/<room>/<fp>/ while the feed is on, and deleted when it ends:
// only a mod or level a game watching asked for, at most MAX_FEED_MODS of
// them and MOD_MAX_BYTES in all, and nothing for longer than the feed is on.
// Past that, the one put longest ago goes to make room, once nothing of it
// has been put for MOD_IDLE_MS (the games watching have it by then; one that
// comes later asks for it again).
//
// A spectator can talk to the match's players: its game says "say
// <name>\t<text>", and the feed sends the host's game "say <name>
// (watching): <text>", which it puts in the match's chat (spectatorSays).
//
// Who's watching: a game watching says its player's name ("name <name>",
// cleaned as a message's, "name " for none), once its socket opens and when
// it changes, the game in a viewing page's box too. The Lobby hears the names
// with how many watch (feedPages), and tells the feed who watches the match
// in all (watching: how many, and the names it knows; the rest are watching
// without a game, its scores only). The feed tells every page here: "feed
// watching <n>" and, tab-separated after a space, the names (Antonio,
// 2026-11-24: no way to see who else was watching).
//
// An Imperial relay server's feed (src/imperial-feed.js) passes those on
// only when the server said it takes them (hostTakes). Otherwise the game
// watching is told at once: "feed no-files" for a mod or level it asked for,
// "feed no-say" for a message.

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
const KIND_WIDE = 3;
const SEAT_MAX = 64;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const RECORD_HEAD = 10;
const SEAT_HOST = 1;
const KEY_ASK_MS = 10 * 1000;
// A feed nothing has been sent to for this long ends itself (its room may
// have ended while the lobby was away).
const IDLE_MS = 10 * 60 * 1000;
// How long after a page comes or goes the Lobby is told how many watch, so
// a crowd coming at once is one call.
const PAGES_SAY_MS = 2000;
// The host's mod, for games watching that don't have it (above). A part is a
// block of the mod as joiners get it (1 MiB, squeezed where that makes it
// smaller) and a byte for how; a mod is at most 1 GB of files and their
// table, sent in at most about 1,030 blocks, and a block that fails may be
// sent again.
const FP_RE = /^[0-9a-f]{64}$/;
const PART_RE = /^(info|[0-9]{1,4})$/;
const MOD_ASK_MS = 20 * 1000;
// The mod and the levels of a playlist (6 at most), and some.
const MAX_FEED_MODS = 8;
const MOD_IDLE_MS = 2 * 60 * 1000;
const MOD_INFO_MAX = 64 * 1024;
const MOD_PART_MAX = 1024 * 1024 + 64;
const MOD_MAX_PARTS = 1100;
const MOD_MAX_BYTES = 1280 * 1024 * 1024;
const MOD_PUTS_PER_S = 10;
// A page says little (mod <fp> now and then, a spectator's message, its
// player's name): more
// than this in RATE_WINDOW_MS and its socket is closed.
const PAGE_SAYS = 10;
// A spectator's message for the match's players, from a game watching ("say
// <name>\t<text>"): the host's game is sent "say <name> (watching): <text>"
// to put in the match's chat (and so on the feed, for everyone watching), at
// most one every SAY_MS from each socket; more are dropped. Printable ASCII
// only (the game's chat), runs of spaces as one, at most SAY_NAME_MAX and
// SAY_TEXT_MAX characters: the line fits the game's 127.
const SAY_MS = 3000;
const SAY_NAME_MAX = 16;
const SAY_TEXT_MAX = 96;
// The names of those watching the Lobby and the pages are told, at most.
export const WATCH_NAMES_MAX = 32;
export const MOD_PREFIX = "feed-mods/";

// As the game watching cleans what it sends (stdComm_WSRelay.c's
// wsrelay_SayClean), so it knows its own message coming back: printable
// ASCII ("?" for the rest), runs of spaces as one, no space at either end,
// at most max characters.
export function sayClean(text, max) {
    return String(text).replace(/[^\x20-\x7e\t\n\r\f\v]/g, "?").replace(/[ \t\n\r\f\v]+/g, " ").trim()
        .substring(0, max).trim();
}

export class Feed extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // {room, delay (s), tokens: {token: seat}, began (ms), wide}, null
        // until the Lobby arms it. Kept in storage, so a feed that was evicted
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
        this.keyTold = false;     // whether the Lobby has heard the host's game sent one (keySay)
        this.ending = null;       // why, while pages get the match's last seconds (end)
        this.pagesTold = -1;      // how many pages the Lobby was last told watch, -1 for not yet
        this.namesTold = "";      // and the names it was told, as one string
        this.watchingNow = null;  // the line pages get of who watches (watching), kept in storage
        this.pagesTimer = null;   // the wait before it's told again
        this.mods = {};           // fp -> bytes put of the host's mod or level (modPut), kept in storage
        this.modAt = {};          // fp -> when a part of it was last put, kept in storage
        this.modGone = new Set(); // fps on their way out of the bucket (modRoom)
        this.modAsked = new Map(); // fp -> when the host's game was last asked for it
        this.modPuts = [];        // when the latest parts were put
        this.modWrites = new Set(); // parts on their way to the bucket
        ctx.blockConcurrencyWhile(async () => {
            this.cfg = (await ctx.storage.get("cfg")) || null;
            this.mods = (await ctx.storage.get("mods")) || {};
            this.modAt = (await ctx.storage.get("modAt")) || {};
            this.watchingNow = (await ctx.storage.get("watching")) || null;
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
    // token is gone is closed. opts.wide: its host's game may send packets
    // with who sent each (kind 3), as an Imperial relay's dedicated server
    // does; such a host takes mod <fp> lines only with opts.files and say
    // lines only with opts.say (hostTakes).
    async arm(room, delay, tokens, opts) {
        const clean = {};
        for (const [t, seat] of Object.entries(tokens || {})) {
            if (TOKEN_RE.test(t) && Number.isInteger(seat) && seat >= 1 && seat <= SEAT_MAX)
                clean[t] = seat;
        }
        const began = this.cfg && this.cfg.room === room ? this.cfg.began : Date.now();
        this.cfg = { room, delay: Math.max(0, Number(delay) || 0), tokens: clean, began,
                     ...(opts && opts.wide ? { wide: true, files: opts.files === true, say: opts.say === true } : {}) };
        this.ending = null;
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

    // From the Lobby: the room ended, or watching it did. Nothing more comes
    // from the games, and nothing is kept. When the room ended, the pages
    // watching first get the match's last delay seconds as they come of age,
    // as they would have, then "feed ended"; otherwise that comes at once.
    async end(why) {
        why = why || "over";
        for (const [ws, s] of [...this.socks]) {
            if ("seat" in s)
                this.closeWs(ws, 1000, why);
        }
        this.rate.clear();
        const room = this.cfg ? this.cfg.room : null;
        const mods = Object.keys(this.mods).length > 0;
        this.mods = {};
        this.modAt = {};
        this.modAsked.clear();
        this.watchingNow = null;
        await this.ctx.storage.deleteAll();
        if (this.cfg && why === "room ended" && this.unsent()) {
            this.cfg = { ...this.cfg, tokens: {} };
            this.ending = why;
            this.flush();
        } else {
            this.finish(why);
        }
        if (mods && room !== null)
            await this.modsDelete(room);
        return true;
    }

    // Deletes what the host's game put of its mod and level (of those fps
    // only, when given), once what's on its way is in.
    async modsDelete(room, fps) {
        if (!this.env || !this.env.SHOTS)
            return;
        await Promise.allSettled([...this.modWrites]);
        const prefixes = fps ? fps.map(fp => MOD_PREFIX + room + "/" + fp + "/") : [MOD_PREFIX + room + "/"];
        try {
            const keys = [];
            for (const prefix of prefixes) {
                let cursor;
                do {
                    const list = await this.env.SHOTS.list({ prefix, cursor });
                    for (const o of list.objects)
                        keys.push(o.key);
                    cursor = list.truncated ? list.cursor : undefined;
                } while (cursor);
            }
            for (let i = 0; i < keys.length; i += 1000)
                await this.env.SHOTS.delete(keys.slice(i, i + 1000));
        } catch (e) {
            console.log(`feed: room ${room}: the host's mod wasn't all deleted: ${e && e.message || e}`);
        }
    }

    // The ones to delete to make room for bytes more of fp (new: not kept
    // yet), the one put longest ago first, of those nothing has been put of
    // for MOD_IDLE_MS; null when there isn't room even so.
    modRoom(fp, isNew, bytes, now) {
        const out = [];
        let count = Object.keys(this.mods).length, total = Object.values(this.mods).reduce((a, b) => a + b, 0);
        const idle = Object.keys(this.mods).filter(k => k !== fp && now - (this.modAt[k] || 0) >= MOD_IDLE_MS)
                                           .sort((a, b) => (this.modAt[a] || 0) - (this.modAt[b] || 0));
        while ((isNew && count >= MAX_FEED_MODS) || total + bytes > MOD_MAX_BYTES) {
            const k = idle.shift();
            if (k === undefined)
                return null;
            out.push(k);
            count--;
            total -= this.mods[k];
        }
        return out;
    }

    // From the Worker (feedRoute): a part of the host's mod, put by the game
    // with token up (the host's). {status}: 200 when it's kept.
    async modPut(up, fp, part, body) {
        if (!this.cfg || !this.env || !this.env.SHOTS)
            return { status: 404 };
        const seat = TOKEN_RE.test(String(up)) ? this.cfg.tokens[up] : undefined;
        if (seat !== SEAT_HOST)
            return { status: 403 };
        part = String(part);
        if (!FP_RE.test(String(fp)) || !PART_RE.test(part) || (part !== "info" && Number(part) >= MOD_MAX_PARTS))
            return { status: 400 };
        const bytes = body instanceof ArrayBuffer ? body.byteLength : body && body.length;
        if (!(bytes > 0) || bytes > (part === "info" ? MOD_INFO_MAX : MOD_PART_MAX))
            return { status: 413 };
        const now = Date.now();
        this.modPuts = this.modPuts.filter(t => now - t < RATE_WINDOW_MS);
        if (this.modPuts.length >= MOD_PUTS_PER_S * RATE_WINDOW_MS / 1000)
            return { status: 429 };
        // Only a mod or level a game watching asked for, and so much in all:
        // what was put longest ago goes, if it can (modRoom). One still
        // going is tried again (the host's game does, maps.js runFeedUp).
        if (this.modGone.has(fp))
            return { status: 503 };
        const isNew = !(fp in this.mods);
        if (isNew && !this.modAsked.has(fp))
            return { status: 403 };
        const gone = this.modRoom(fp, isNew, bytes, now);
        if (!gone)
            return { status: isNew && Object.keys(this.mods).length >= MAX_FEED_MODS ? 403 : 413 };
        for (const k of gone) {
            delete this.mods[k];
            delete this.modAt[k];
            this.modGone.add(k);
        }
        this.modPuts.push(now);
        this.mods[fp] = (this.mods[fp] || 0) + bytes;
        this.modAt[fp] = now;
        this.lastUp = now;
        await this.ctx.storage.put({ mods: this.mods, modAt: this.modAt });
        if (gone.length) {
            console.log(`feed: room ${this.cfg.room}: deleting ${gone.length} of what the host's game put earlier, to make room`);
            await this.modsDelete(this.cfg.room, gone);
            for (const k of gone)
                this.modGone.delete(k);
            if (!this.cfg)
                return { status: 404 };
        }
        const write = this.env.SHOTS.put(MOD_PREFIX + this.cfg.room + "/" + fp + "/" + part, body, {
            httpMetadata: { contentType: part === "info" ? "application/json" : "application/octet-stream" }
        });
        this.modWrites.add(write);
        try {
            await write;
        } catch (e) {
            console.log(`feed: room ${this.cfg && this.cfg.room}: a part of the host's mod wasn't kept: ${e && e.message || e}`);
            return { status: 503 };
        } finally {
            this.modWrites.delete(write);
        }
        return { status: 200 };
    }

    // Whether a page watching hasn't had all there is for it yet.
    unsent() {
        const key = this.chunks.some(c => c.kind === KIND_KEY);
        for (const s of this.socks.values()) {
            if (!("next" in s))
                continue;
            if (s.next >= 0 ? s.next < this.nextSeq : key)
                return true;
        }
        return false;
    }

    // Tells the pages it's over, closes everything and forgets the match.
    finish(why) {
        for (const [ws, s] of [...this.socks]) {
            if ("next" in s)
                this.sendTo(ws, "feed ended " + why);
            this.closeWs(ws, 1000, why);
        }
        this.socks.clear();
        this.rate.clear();
        this.chunks = [];
        this.bytes = 0;
        this.base = this.nextSeq;
        this.cfg = null;
        this.ending = null;
        this.pagesTold = -1;
        this.namesTold = "";
        this.keyTold = false;
        this.watchingNow = null;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pagesTimer) {
            clearTimeout(this.pagesTimer);
            this.pagesTimer = null;
        }
    }

    async alarm() {
        if (!this.cfg)
            return;
        const now = Date.now();
        if (now - this.lastUp < IDLE_MS) {
            await this.ctx.storage.setAlarm(this.lastUp + IDLE_MS);
            return;
        }
        const room = this.cfg.room;
        await this.end("idle");
        // The Lobby hears, for a feed only it and its sender know of (an
        // Imperial server's): a lobby room's games ask again by themselves.
        if (this.env && this.env.LOBBY) {
            try {
                await this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby")).feedEnded(room, "idle");
            } catch (e) {
                console.log(`feed: room ${room}: the lobby didn't hear it ended: ${e && e.message || e}`);
            }
        }
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

    // Every page here (boxed = false: not those in a viewing page's box,
    // which the Lobby counts as the page itself).
    pageCount(boxed = true) {
        let pages = 0;
        for (const s of this.socks.values()) {
            if ("next" in s && (boxed || !s.box)) pages++;
        }
        return pages;
    }

    // A page came or went: the Lobby hears how many watch, PAGES_SAY_MS
    // later (without the LOBBY binding, nobody does).
    pagesChanged() {
        if (!this.cfg || this.pagesTimer || !this.env || !this.env.LOBBY)
            return;
        this.pagesTimer = setTimeout(() => {
            this.pagesTimer = null;
            this.pagesSay();
        }, PAGES_SAY_MS);
    }

    async pagesSay() {
        if (!this.cfg || !this.env || !this.env.LOBBY)
            return;
        const room = this.cfg.room, n = this.pageCount(false), names = this.pageNames();
        const told = names.join("\t");
        if (n === this.pagesTold && told === this.namesTold)
            return;
        this.pagesTold = n;
        this.namesTold = told;
        try {
            const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby"));
            await lobby.feedPages(room, n, names);
        } catch (e) {
            // Told again the next time a page comes or goes.
            this.pagesTold = -1;
            console.log(`feed: room ${room}: the lobby didn't hear how many watch: ${e && e.message || e}`);
        }
    }

    // The names the games watching here said (name), those in a viewing
    // page's box too, in the order they came.
    pageNames() {
        const names = [];
        for (const s of this.socks.values()) {
            if ("next" in s && s.name && names.length < WATCH_NAMES_MAX)
                names.push(s.name);
        }
        return names;
    }

    // From the Lobby: who watches the match, in all: how many, and the names
    // of those it knows (pageNames, and none for a page watching its scores
    // only). Every page here is told, and one that comes later as it comes.
    async watching(n, names) {
        n = Number.isInteger(n) && n >= 0 ? Math.min(n, 100000) : 0;
        const clean = (Array.isArray(names) ? names : []).slice(0, WATCH_NAMES_MAX)
            .map(x => sayClean(String(x), SAY_NAME_MAX)).filter(x => x);
        const line = "feed watching " + Math.max(n, clean.length) + (clean.length ? " " + clean.join("\t") : "");
        if (line === this.watchingNow)
            return true;
        this.watchingNow = line;
        await this.ctx.storage.put("watching", line);
        for (const [ws, s] of this.socks) {
            if ("next" in s)
                this.sendTo(ws, line);
        }
        return true;
    }

    // name <name>: the player's name of a game watching (above).
    pageName(ws, said) {
        const s = this.socks.get(ws);
        if (!s || !("next" in s))
            return;
        const name = sayClean(said, SAY_NAME_MAX);
        if ((s.name || "") === name)
            return;
        if (name)
            s.name = name;
        else
            delete s.name;
        try { ws.serializeAttachment(s.box ? { next: -1, box: 1, ...(name ? { name } : {}) } : { next: -1, ...(name ? { name } : {}) }); } catch (e) {}
        this.pagesChanged();
    }

    async fetch(request) {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
            return new Response("Expected a WebSocket upgrade", { status: 426 });
        if (!this.cfg)
            return new Response("No feed for this match", { status: 404 });
        const params = new URL(request.url).searchParams, up = params.get("up");
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
            if (this.pageCount() >= MAX_VIEWERS)
                return new Response("Too many watching", { status: 503 });
            state = params.get("box") === "1" ? { next: -1, box: 1 } : { next: -1 };
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        try { server.serializeAttachment(state); } catch (e) {}
        this.socks.set(server, state);
        if ("next" in state) {
            this.sendTo(server, "feed " + this.cfg.delay);
            if (this.watchingNow)
                this.sendTo(server, this.watchingNow);
            this.flush();
            if (state.next < 0) {
                this.sendTo(server, "feed waiting");
                this.askKey();
                this.sayFirst();
            }
            if (!state.box)
                this.pagesChanged();
        }
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        const s = this.socks.get(ws);
        if (!s)
            return;
        // A page says only mod <fp>, say and name (its ping is answered
        // without waking the object), and a game nothing in text.
        if (!("seat" in s)) {
            if (typeof message === "string")
                this.pageSays(ws, message);
            return;
        }
        if (typeof message === "string")
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
        const top = this.cfg && this.cfg.wide && s.seat === SEAT_HOST ? KIND_WIDE : KIND_KEY_MORE;
        if (data.length < 2 || data.length > MAX_CHUNK || data[0] > top) {
            this.closeWs(ws, 1003, "bad chunk");
            return;
        }
        this.lastUp = now;
        this.take(now, data[0], s.seat, data.subarray(1));
        this.flush(now);
        if (data[0] === KIND_KEY) {
            this.sayFirst(now);
            if (s.seat === SEAT_HOST)
                await this.keySay();
        }
    }

    // The host's game sent a keyframe: the Lobby hears, once, that the match
    // can be watched in the game (feedKeyed). Not an Imperial relay server's
    // feed, which the lobby lists by itself (imp), nor without the LOBBY
    // binding. One it didn't hear is told at the next keyframe.
    async keySay() {
        if (this.keyTold || !this.cfg || this.cfg.wide || !this.env || !this.env.LOBBY)
            return;
        this.keyTold = true;
        const room = this.cfg.room;
        try {
            const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("lobby"));
            await lobby.feedKeyed(room);
        } catch (e) {
            this.keyTold = false;
            console.log(`feed: room ${room}: the lobby didn't hear the host's game sent a keyframe: ${e && e.message || e}`);
        }
    }

    async webSocketClose(ws) {
        const s = this.socks.get(ws);
        this.socks.delete(ws);
        this.rate.delete(ws);
        try { ws.close(1000, "bye"); } catch (e) {}
        if (s && "next" in s && (!s.box || s.name))
            this.pagesChanged();
        this.endIfDone();
    }

    async webSocketError(ws) {
        const s = this.socks.get(ws);
        this.socks.delete(ws);
        this.rate.delete(ws);
        if (s && "next" in s && (!s.box || s.name))
            this.pagesChanged();
        this.endIfDone();
    }

    // A game watching asks for the host's mod: the host's game is asked to
    // put it here, at most once every MOD_ASK_MS for each mod.
    pageSays(ws, text) {
        const now = Date.now();
        const times = (this.rate.get(ws) || []).filter(t => now - t < RATE_WINDOW_MS);
        times.push(now);
        this.rate.set(ws, times);
        if (times.length > PAGE_SAYS) {
            this.closeWs(ws, 1008, "too many");
            this.pagesChanged();
            return;
        }
        if (text.startsWith("say ")) {
            this.spectatorSays(ws, text.substring(4), now);
            return;
        }
        if (text.startsWith("name ") || text === "name") {
            this.pageName(ws, text.substring(5));
            return;
        }
        const m = /^mod ([0-9a-f]{64})$/.exec(text);
        if (!m || !this.cfg || this.ending)
            return;
        // A host that doesn't send them: the game watching needn't wait.
        if (!this.hostTakes("files")) {
            this.sendTo(ws, "feed no-files");
            return;
        }
        if (now - (this.modAsked.get(m[1]) || 0) < MOD_ASK_MS)
            return;
        for (const [host, s] of this.socks) {
            if (s.seat === SEAT_HOST) {
                if (this.modAsked.size >= 64)
                    this.modAsked.clear();
                this.modAsked.set(m[1], now);
                this.sendTo(host, "mod " + m[1]);
                return;
            }
        }
    }

    // A spectator's message (SAY_MS above): to the host's game, as the line
    // the match's chat shows.
    spectatorSays(ws, said, now) {
        const s = this.socks.get(ws);
        if (!s || !this.cfg || this.ending || now - (s.saidAt || 0) < SAY_MS)
            return;
        const tab = said.indexOf("\t");
        if (tab < 0)
            return;
        const name = sayClean(said.substring(0, tab), SAY_NAME_MAX) || "Someone";
        const words = sayClean(said.substring(tab + 1), SAY_TEXT_MAX);
        if (!words)
            return;
        // A host that doesn't put them in its match's chat: the spectator is
        // told so, rather than waiting for their message to show.
        if (!this.hostTakes("say")) {
            s.saidAt = now;
            this.sendTo(ws, "feed no-say");
            return;
        }
        for (const [host, h] of this.socks) {
            if (h.seat === SEAT_HOST) {
                s.saidAt = now;
                this.sendTo(host, "say " + name + " (watching): " + words);
                return;
            }
        }
    }

    // Whether the host's game takes mod <fp> ("files") or say lines ("say"):
    // a lobby room's always does, an Imperial server's when it said so.
    hostTakes(what) {
        return !this.cfg || !this.cfg.wide || this.cfg[what] === true;
    }

    // Ending, with no page left that has anything to get: over.
    endIfDone() {
        if (this.ending && !this.unsent())
            this.finish(this.ending);
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
                if ("next" in st && st.next >= 0 && st.next <= c.seq) {
                    st.next = -1;
                    st.told = 0;
                }
            }
        }
        this.base = this.chunks.length ? this.chunks[0].seq : this.nextSeq;
    }

    // How long until the first keyframe the feed holds comes of age, -1 for
    // none. One of age has been sent to every page by then (flush), so a
    // page still waiting waits for this one.
    firstIn(now) {
        const ripe = now - this.cfg.delay * 1000;
        for (const c of this.chunks) {
            if (c.kind === KIND_KEY && c.at > ripe)
                return c.at - ripe;
        }
        return -1;
    }

    // Tells each page waiting for its first keyframe when it comes
    // ("feed first <ms>"), once: early in a match the wait is the delay, and
    // a page counts it down rather than only say so (the audit of watching,
    // 2026-11-24).
    sayFirst(now = Date.now()) {
        if (!this.cfg)
            return;
        const ms = this.firstIn(now);
        if (ms < 0)
            return;
        for (const [ws, s] of this.socks) {
            if (!("next" in s) || s.next >= 0 || s.told)
                continue;
            s.told = 1;
            this.sendTo(ws, "feed first " + Math.ceil(ms));
        }
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
        // Ending: once every page has had the last of it, over.
        if (this.ending && !this.unsent()) {
            this.finish(this.ending);
            return;
        }
        this.later(wait);
    }

    // Looks again once the next chunk comes of age, while any page watches.
    later(ms) {
        if (this.timer || !ms)
            return;
        if (!this.pageCount())
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
// deployment has them (the FEED binding). And /feed/<room>/mod/<fp>/<part>:
// the host's mod, put through the feed (modPut) and got straight from the
// bucket.
const FEED_PATH_RE = /^\/feed\/([0-9]{1,9})$/;
const FEED_MOD_RE = /^\/feed\/([0-9]{1,9})\/mod\/([0-9a-f]{64})\/(info|[0-9]{1,4})$/;
const MOD_TEXT = { 400: "Bad part", 403: "Not the host's game in this match", 404: "No feed for this match",
                   413: "Too big", 429: "Too many", 503: "Not kept, try again" };
export async function feedRoute(request, env, url) {
    const mod = FEED_MOD_RE.exec(url.pathname);
    if (mod)
        return feedModRoute(request, env, url, Number(mod[1]), mod[2], mod[3]);
    const m = FEED_PATH_RE.exec(url.pathname);
    if (!m)
        return null;
    if (!env.FEED)
        return new Response("Not found", { status: 404 });
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket upgrade", { status: 426 });
    return env.FEED.get(env.FEED.idFromName("room:" + Number(m[1]))).fetch(request);
}

async function feedModRoute(request, env, url, room, fp, part) {
    const plain = (text, status) => new Response(text, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    if (!env.FEED || !env.SHOTS)
        return plain("Not found", 404);
    if (request.method === "GET" || request.method === "HEAD") {
        const obj = await env.SHOTS.get(MOD_PREFIX + room + "/" + fp + "/" + part);
        if (!obj)
            return plain("Not here (yet)", 404);
        const headers = { "Content-Type": part === "info" ? "application/json" : "application/octet-stream",
                          "Cache-Control": "no-store" };
        return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
    }
    if (request.method !== "PUT")
        return plain("Method not allowed", 405);
    const max = part === "info" ? MOD_INFO_MAX : MOD_PART_MAX;
    const length = Number(request.headers.get("Content-Length"));
    if (length > max)
        return plain(MOD_TEXT[413], 413);
    const body = await request.arrayBuffer();
    if (!body.byteLength || body.byteLength > max)
        return plain(MOD_TEXT[body.byteLength ? 413 : 400], body.byteLength ? 413 : 400);
    const up = url.searchParams.get("up") || "";
    const r = await env.FEED.get(env.FEED.idFromName("room:" + room)).modPut(up, fp, part, body);
    const status = r && r.status || 503;
    return plain(status === 200 ? "Kept" : MOD_TEXT[status] || "Not kept", status);
}
