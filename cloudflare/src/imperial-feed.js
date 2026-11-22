// A dedicated server on the Imperial relay sending its match's feed, so pages
// can watch it as they watch a lobby room's (spectator mode for Imperial
// games, asked for 2026-11-22): POST /imperial-feed.
//
// Only servers named in IMPERIAL_FEED_KEYS (a secret, never in wrangler.toml)
// may, one to a line or separated by commas:
//
//   <key> <game> <a.b.c.d:port> <name>
//
// key is 32 to 64 hex digits, given to that server's owner and nobody else;
// game is jk1 or mots; the address is the server's as the relay lists it,
// which is how its card on the landing page is found (serverSid in
// src/imperial.js); name is what the page calls it. Without the secret, or
// the FEED binding, the route is off: 404.
//
//   POST /imperial-feed
//   Authorization: Bearer <key>
//
//   {"episode": "JK1CTF", "map": "c3.jkl", "delay": 30}
//     A match starts (or watching was turned on): its feed. Answers
//     {"room": <id>, "token": "<32 hex>", "url": "wss://<this
//     host>/feed/<id>?up=<token>", "delay": <s>}, the delay as asked,
//     30 to 300 s (30 when it doesn't say). Asking again while its feed is
//     on gets the same room and token, with the delay as asked now.
//
//   {"end": true}
//     Watching is off, or the server is empty: its feed ends. {"ended": true}
//
// The server then sends its chunks to url as src/feed.js says, the host of
// its feed: kind 3 for its players' messages (with who sent each, since
// relay player ids don't fit the feed's seat), 0 for its own, 1 and 2 for
// keyframes. It hears key, mod <fp> and say lines there as a host's game
// does. A feed nothing is sent to for 10 minutes ends itself, and the lobby
// stops listing it.
//
// 401 for no key or one not listed, 400 for a body that isn't one of those,
// 405 for anything but POST, 413 for a body over MAX_BODY, 503 when the feed
// didn't answer (asking again is fine).

import { serverSid, cleanText } from "./imperial.js";

const MAX_BODY = 4096;
const KEY_RE = /^[0-9a-f]{32,64}$/;
const LINE_RE = /^([0-9a-f]{32,64})\s+(jk1|mots)\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5})\s+(.+)$/;
const FILE_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const MAX_NAME = 32;


// The servers IMPERIAL_FEED_KEYS names: [{key, game, addr, name, sid}].
// Lines that don't read are left out, and said so in the log (without them).
export function parseFeedKeys(text) {
    const out = [];
    let bad = 0;
    for (const part of String(text || "").split(/[\n,]/)) {
        const line = part.trim();
        if (!line)
            continue;
        const m = LINE_RE.exec(line);
        if (!m) {
            bad++;
            continue;
        }
        const name = cleanText(m[4], MAX_NAME);
        out.push({ key: m[1], game: m[2], addr: m[3], name: name || m[3], sid: serverSid(m[3]) });
    }
    if (bad)
        console.log(`imperial-feed: ${bad} line(s) of IMPERIAL_FEED_KEYS don't read as <key> <game> <address> <name>`);
    return out;
}

async function sha256(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, "0")).join("");
}

// The server a request's key is, or null. Keys are compared by their
// SHA-256, so how long a comparison takes says nothing of a key.
export async function serverFor(request, servers) {
    const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("Authorization") || "");
    if (!m || !KEY_RE.test(m[1]))
        return null;
    const given = await sha256(m[1]);
    for (const s of servers) {
        if ((await sha256(s.key)) === given)
            return s;
    }
    return null;
}

// What a server asked, or null for anything else.
export function readAsk(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return null;
    if (body.end !== undefined)
        return body.end === true ? { end: true } : null;
    const episode = body.episode === undefined ? "" : body.episode;
    const map = body.map === undefined ? "" : body.map;
    if (typeof episode !== "string" || typeof map !== "string" || (episode && !FILE_RE.test(episode)) ||
        (map && !FILE_RE.test(map)))
        return null;
    if (body.delay !== undefined && !(Number.isInteger(body.delay) && body.delay >= 0 && body.delay <= 3600))
        return null;
    return { episode, map, delay: body.delay || 0 };
}

const answer = (status, obj) => new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export async function imperialFeedRoute(request, env) {
    const servers = parseFeedKeys(env.IMPERIAL_FEED_KEYS);
    if (!env.FEED || !servers.length)
        return answer(404, { error: "Not here" });
    if (request.method !== "POST")
        return new Response("POST here", { status: 405, headers: { Allow: "POST" } });
    const server = await serverFor(request, servers);
    if (!server)
        return answer(401, { error: "Not a server this lobby knows" });
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY)
        return answer(413, { error: "Too long" });
    const text = await request.text();
    if (text.length > MAX_BODY)
        return answer(413, { error: "Too long" });
    let ask = null;
    try {
        ask = readAsk(JSON.parse(text));
    } catch (e) {
    }
    if (!ask)
        return answer(400, { error: "Send {episode, map, delay} or {end: true}" });
    const lobby = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
    let r = null;
    try {
        r = await lobby.imperialFeed({ sid: server.sid, game: server.game, name: server.name }, ask);
    } catch (e) {
        console.log(`imperial-feed: ${server.name}: the lobby didn't answer: ${e && e.message || e}`);
    }
    if (!r)
        return answer(503, { error: "Its feed didn't answer; ask again" });
    if (r.ended)
        return answer(200, { ended: true });
    const url = new URL(request.url);
    const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host + "/feed/" + r.room + "?up=" + r.token;
    return answer(200, { room: r.room, token: r.token, url: ws, delay: r.delay });
}
