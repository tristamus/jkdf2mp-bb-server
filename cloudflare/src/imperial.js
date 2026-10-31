// The Imperial Network Protocol relay's games, for the landing page's room
// windows: GET /imperial-games.
//
// The relay (sithmartyr's, at IMPERIAL_LIST) has no web API. Its game list
// comes from its own protocol (jkrelay_proto.h in the OpenJKDF2 fork) over a
// WebSocket, so this asks it the way the game's Multiplayer menu does, HELLO
// and then LIST, and answers with JSON the page can draw beside the lobby's
// own games. It runs beside the lobby, never in it: the Lobby Durable Object
// doesn't talk to the relay, so a relay that's down, slow or answering garbage
// only greys out the page's Imperial games.
//
// Answers are kept in the Cache API (per Cloudflare data center) for CACHE_S
// seconds, or twice that when the relay didn't answer, so the relay hears
// from us a few times a minute however many pages are watching. The
// IMPERIAL_CACHE_S var overrides it, for tests, and IMPERIAL_TIMEOUT_MS how
// long the relay gets to answer. The relay's
// address comes only from IMPERIAL_LIST, never from the request, so this
// can't be used to reach anything else. Without IMPERIAL_LIST the route is
// off: 404, and the page shows no Imperial games.
//
// IMPERIAL_PINNED names dedicated servers the page always shows first, as
// "<game> <a.b.c.d:port> <name>" (game jk1 or mots), several separated by
// commas. They're matched by address, since anyone hosting on the relay can
// call a game anything. One the relay doesn't list, or a relay that isn't
// answering, still gets its card, without Join.
//
// The answer:
//   { state: "live" | "down", server, checked,
//     games: [{ key, name, game, map, episode, mod, locked, players, max,
//               dedicated, pinned, listed, joinable, why }] }
// key is the game's session id (32 hex digits; "" for a pinned server that
// isn't listed), which the page hands the engine to select on its Join
// screen. why says why a game can't be joined from a browser: "desktop" (its
// host runs an OpenJKDF2 from before browsers could play with it), "closed"
// (its host turned joining off), "not-listed" or "relay-down". Everything in
// it comes from the relay, so names are cleaned as the lobby cleans its own.

const MAGIC = 0x314B524A;          // "JRK1"
const VERSION = 1;
const HDR = 16;
const HELLO = 1;
const LIST = 3;
const WELCOME = 32;
const LISTREPLY = 34;
// Session description: guid[16], flags, maxPlayers, curPlayers, user[4]
// (u32 each), u8 name length, then the name in UTF-16.
const DESC_FIXED = 16 + 4 * 7 + 1;
// LIST flags and the reply's (in its header's reserved field): each game's
// mod tail, the dedicated servers listed on it with their addresses, and
// whether browsers reach those through the relay's gateway.
const LF_SERVERS = 0x1;
const LF_TAILS = 0x2;
const LF_GATEWAY = 0x4;
const LIST_FLAGS = LF_SERVERS | LF_TAILS | LF_GATEWAY;
const ADDR_SIZE = 7;
const LA_SERVER = 0x1;
// Session flags, as the engine reads them (dplay_shim.h, stdComm_Imperial.c).
const SF_JOINDISABLED = 0x20;
const SF_PASSWORD = 0x400;
const SF_OPENJKDF2WIRE = 0x20000000;
// Jedi Knight's DirectPlay application GUID. OpenJKDF2 uses it for Mysteries
// of the Sith too, so one list has both games' (told apart by episode).
const APP_GUID = [0xC0, 0x13, 0x06, 0xBF, 0x79, 0xDE, 0xD0, 0x11, 0x99, 0xC9, 0x00, 0xA0, 0x24, 0x76, 0xAD, 0x4B];

const TIMEOUT_MS = 3000;
// Replies over the relay's WebSocket are one packet each; the game's client
// reads at most this much.
const MAX_REPLY = 2048;
const MAX_GAMES = 32;
const MAX_LIST_REQUESTS = 4;
const CACHE_S = 15;
const MAX_NAME = 32;
// Control and invisible characters (bidi overrides among them) never reach a
// page, as in lobby.js.
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const PIN_RE = /^(jk1|mots)\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5})\s+(.+)$/;

export async function imperialGames(request, env, ctx) {
    const server = (env.IMPERIAL_LIST || "").trim();
    if (!server)
        return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

    const keepS = env.IMPERIAL_CACHE_S !== undefined && env.IMPERIAL_CACHE_S !== "" ? Number(env.IMPERIAL_CACHE_S) : CACHE_S;
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request(new URL("/imperial-games", request.url).toString());
    if (cache) {
        try {
            const hit = await cache.match(key);
            if (hit)
                return forPage(hit);
        } catch (e) {}
    }

    let listing = null;
    try {
        listing = await askRelay(relayUrl(server), Number(env.IMPERIAL_TIMEOUT_MS) || TIMEOUT_MS);
    } catch (e) {
        console.log(`imperial: ${server} didn't give its list: ${e.message}`);
    }
    const answer = gamesAnswer(listing, server, parsePinned(env.IMPERIAL_PINNED), new Date());
    const res = new Response(JSON.stringify(answer), {
        headers: { "Content-Type": "application/json; charset=utf-8",
                   "Cache-Control": `max-age=${listing ? keepS : keepS * 2}` },
    });
    if (cache && ctx && keepS > 0) {
        try {
            ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
        } catch (e) {}
    }
    return forPage(res);
}

// The page asks again on its own clock, so its browser keeps nothing.
function forPage(res) {
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    return out;
}

// As the game names a server (jkrelay_client.c, jkr_WsUrlFor): a ws:// or
// wss:// URL as it is, host:port as ws://host:port/, a bare host as
// wss://<host>/imperial. fetch() takes them as http:// and https://.
export function relayUrl(server) {
    let url;
    if (/^wss?:\/\//i.test(server))
        url = server;
    else if (server.includes(":"))
        url = `ws://${server}/`;
    else
        url = `wss://${server}/imperial`;
    return url.replace(/^ws(s?):/i, "http$1:");
}

// HELLO, then LIST until the relay has given every game (or MAX_GAMES), over
// one WebSocket, within timeoutMs. The raw listing, or throws.
async function askRelay(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let ws = null;
    try {
        const resp = await fetch(url, { headers: { Upgrade: "websocket" }, signal: abort.signal });
        ws = resp.webSocket;
        if (!ws)
            throw new Error(`no WebSocket (HTTP ${resp.status})`);
        ws.accept();
        const next = inbox(ws);
        const ask = async (type, token, seq, body, want) => {
            ws.send(packet(type, token, seq, body));
            for (;;) {
                const p = await next(deadline);
                if (p.length > MAX_REPLY)
                    throw new Error(`a reply of ${p.length} bytes`);
                const v = view(p);
                if (p.length >= HDR && v.getUint32(0, true) === MAGIC && p[4] === want && v.getUint32(12, true) === seq)
                    return p;
                // Anything else (a keepalive, an answer we stopped waiting
                // for) isn't this answer.
            }
        };

        const hello = new Uint8Array(4);
        view(hello).setUint32(0, VERSION, true);
        const welcome = await ask(HELLO, 0, 1, hello, WELCOME);
        if (welcome.length < HDR + 4)
            throw new Error("a short WELCOME");
        const token = view(welcome).getUint32(HDR, true);

        const listing = { flags: 0, games: [] };
        for (let seq = 2; seq < 2 + MAX_LIST_REQUESTS; seq++) {
            const body = new Uint8Array(24);
            body.set(APP_GUID, 0);
            view(body).setUint32(16, listing.games.length, true);
            view(body).setUint32(20, LIST_FLAGS, true);
            const page = parseListReply(await ask(LIST, token, seq, body, LISTREPLY));
            listing.flags = page.flags;
            listing.games.push(...page.games);
            if (!page.games.length || listing.games.length >= Math.min(page.total, MAX_GAMES))
                break;
        }
        listing.games = listing.games.slice(0, MAX_GAMES);
        return listing;
    } finally {
        clearTimeout(timer);
        if (ws) {
            try { ws.close(1000, "done"); } catch (e) {}
        }
    }
}

function view(b) {
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function packet(type, token, seq, body) {
    const p = new Uint8Array(HDR + body.length);
    const v = view(p);
    v.setUint32(0, MAGIC, true);
    p[4] = type;
    p[5] = VERSION;
    v.setUint32(8, token, true);
    v.setUint32(12, seq, true);
    p.set(body, HDR);
    return p;
}

// The WebSocket's binary messages, one at a time: next(deadline) gives the
// next one, or throws once the socket is closed or the deadline has passed.
function inbox(ws) {
    const queue = [];
    let wake = null, ended = null;
    const poke = () => {
        const w = wake;
        wake = null;
        if (w) w();
    };
    // Binary messages come as a Blob unless binaryType says otherwise (newer
    // compatibility dates), so it's set and both are taken.
    try { ws.binaryType = "arraybuffer"; } catch (e) {}
    ws.addEventListener("message", ev => {
        const take = buf => {
            if (queue.length < 64) {
                queue.push(new Uint8Array(buf));
                poke();
            }
        };
        if (ev.data instanceof ArrayBuffer)
            take(ev.data);
        else if (ev.data && typeof ev.data.arrayBuffer === "function")
            ev.data.arrayBuffer().then(take, () => {});
    });
    ws.addEventListener("close", () => { ended = ended || "closed the connection"; poke(); });
    ws.addEventListener("error", () => { ended = ended || "connection failed"; poke(); });
    return async function next(deadline) {
        for (;;) {
            if (queue.length)
                return queue.shift();
            if (ended)
                throw new Error(ended);
            const left = deadline - Date.now();
            if (left <= 0)
                throw new Error("no answer in time");
            await new Promise(resolve => {
                wake = resolve;
                setTimeout(resolve, left);
            });
        }
    };
}

// A LISTREPLY packet: { total, flags, games: [{ guid, flags, max, cur, name,
// addr, laFlags, tail }] }. Throws on one that's cut short or doesn't add up.
export function parseListReply(p) {
    if (p.length < HDR + 4 || p.length > MAX_REPLY)
        throw new Error("a list reply of the wrong size");
    const v = view(p);
    if (v.getUint32(0, true) !== MAGIC || p[4] !== LISTREPLY)
        throw new Error("not a list reply");
    const flags = v.getUint16(6, true);
    const total = v.getUint16(HDR, true);
    const count = v.getUint16(HDR + 2, true);
    if (count > MAX_GAMES)
        throw new Error(`a list reply of ${count} games`);
    const games = [];
    let at = HDR + 4;
    const need = n => {
        if (at + n > p.length)
            throw new Error("a list reply cut short");
    };
    for (let i = 0; i < count; i++) {
        need(DESC_FIXED);
        const g = {
            guid: hex(p.subarray(at, at + 16)),
            flags: v.getUint32(at + 16, true),
            max: v.getUint32(at + 20, true),
            cur: v.getUint32(at + 24, true),
            name: "",
            addr: "",
            laFlags: 0,
            tail: "",
        };
        const nameLen = p[at + DESC_FIXED - 1];
        at += DESC_FIXED;
        need(nameLen * 2);
        for (let k = 0; k < nameLen; k++)
            g.name += String.fromCharCode(v.getUint16(at + k * 2, true));
        at += nameLen * 2;
        if (flags & LF_SERVERS) {
            need(ADDR_SIZE);
            const ip = v.getUint32(at, true);
            const port = v.getUint16(at + 4, true);
            g.laFlags = p[at + 6];
            if (g.laFlags & LA_SERVER)
                g.addr = `${ip >>> 24}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}:${port}`;
            at += ADDR_SIZE;
        }
        if (flags & LF_TAILS) {
            need(1);
            const n = p[at];
            need(1 + n);
            for (let k = 0; k < n; k++)
                g.tail += String.fromCharCode(p[at + 1 + k]);
            at += 1 + n;
        }
        games.push(g);
    }
    return { total, flags, games };
}

function hex(b) {
    return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

export function cleanText(text, max) {
    return Array.from(text.replace(HIDDEN_RE, "").trim()).slice(0, max).join("").trim();
}

// A C string's worth of printable ASCII.
function ascii(text, max) {
    return text.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

// "<server>:<episode>:<map>", as JK.EXE names its DirectPlay games; read from
// the right, so a ':' in the server's name doesn't break it.
export function splitName(name) {
    const m = name.lastIndexOf(":");
    const e = m > 0 ? name.lastIndexOf(":", m - 1) : -1;
    if (m < 0 || e < 0)
        return { server: name, episode: "", map: "" };
    return { server: name.slice(0, e), episode: name.slice(e + 1, m), map: name.slice(m + 1) };
}

// The mod named in a host's tail (ASCII hex, as the web lobby's: mods.js),
// as lobby.js reads it: "JKMD", version 2, flags (1 a mod, 2 the MotS
// Remastered pack), the name's length, the fingerprints, then the name.
export function modName(tail) {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(tail))
        return "";
    const b = tail.match(/../g).map(x => parseInt(x, 16));
    if (b.length < 7 || b[0] !== 0x4a || b[1] !== 0x4b || b[2] !== 0x4d || b[3] !== 0x44 || b[4] !== 2)
        return "";
    const flags = b[5];
    let name = "";
    if (flags & 1) {
        const from = 7 + 32 + (flags & 2 ? 16 : 0);
        for (let i = from; i < Math.min(from + b[6], b.length) && b[i]; i++)
            name += b[i] >= 0x20 && b[i] < 0x7f ? String.fromCharCode(b[i]) : "?";
    }
    if (flags & 2)
        return name ? name + ", Remastered pack" : "Remastered pack";
    return name;
}

// The retail Mysteries of the Sith episodes all start with JKM, as in lobby.js.
function guessGame(episode) {
    return /^jkm/i.test(episode) ? "mots" : "jk1";
}

export function parsePinned(text) {
    const out = [];
    for (const part of (text || "").split(",")) {
        const m = PIN_RE.exec(part.trim());
        if (m)
            out.push({ game: m[1], addr: m[2], name: cleanText(m[3], MAX_NAME) });
    }
    return out;
}

// The JSON the page gets, from a listing (null when the relay didn't give one).
export function gamesAnswer(listing, server, pinned, now) {
    const games = [];
    const gateway = listing ? (listing.flags & LF_GATEWAY) !== 0 : false;
    for (const g of listing ? listing.games : []) {
        const dedicated = (g.laFlags & LA_SERVER) !== 0;
        // A server listed at its own address: browsers reach it only through
        // the relay's gateway, as the game's own list leaves it out without.
        if (dedicated && !gateway)
            continue;
        const parts = splitName(g.name);
        const episode = ascii(parts.episode, 64);
        const wire = (g.flags & SF_OPENJKDF2WIRE) !== 0;
        const closed = (g.flags & SF_JOINDISABLED) !== 0;
        // A dedicated server's own slot is one of its players (its player 0,
        // which never plays), so it's taken off both counts.
        const own = dedicated ? 1 : 0;
        const max = Math.max(0, Math.min(g.max, 64) - own);
        games.push({
            key: g.guid,
            name: cleanText(parts.server, MAX_NAME),
            game: guessGame(episode),
            map: ascii(parts.map, 64),
            episode,
            mod: modName(g.tail),
            locked: (g.flags & SF_PASSWORD) !== 0,
            players: Math.min(Math.max(0, g.cur - own), 64),
            max,
            dedicated,
            pinned: false,
            listed: true,
            joinable: wire && !closed,
            why: !wire ? "desktop" : closed ? "closed" : "",
            addr: g.addr,
        });
    }
    const first = [];
    for (const pin of pinned) {
        const i = games.findIndex(g => g.dedicated && g.addr === pin.addr);
        if (i >= 0) {
            first.push({ ...games[i], pinned: true });
            games.splice(i, 1);
        } else {
            first.push({
                key: "", name: pin.name, game: pin.game, map: "", episode: "", mod: "", locked: false,
                players: 0, max: 0, dedicated: true, pinned: true, listed: false, joinable: false,
                why: listing ? "not-listed" : "relay-down", addr: pin.addr,
            });
        }
    }
    // The page has no use for addresses.
    const all = first.concat(games).map(({ addr, ...g }) => g);
    return { state: listing ? "live" : "down", server, checked: now.toISOString(), games: all };
}
