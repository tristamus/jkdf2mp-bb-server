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
//
// Players in a room also link to each other, not only to their host: the
// lobby passes signal between any two of them, and says so on connect
// (lobby links). And with a TURN key set (see TURN_API), it says turn too, and
// a game in a room that asks (turn) gets short-lived credentials for
// Cloudflare's TURN service, so two players who can't link directly still
// get a WebRTC link, through the Cloudflare cities nearest them, instead of
// sending everything through this one lobby.
//
// Each game says which netcode its build speaks, in the address it connects
// with (/relay?net=<n>), and only lists and joins games whose host speaks the
// same: list leaves the others out, and join answers "error version newer"
// or "error version older", whichever the room's is. Builds that can play a
// match together share a number (they agree on the rest through their own
// hellos), so it only goes up with a change older builds can't play with.
//
// A room's password is checked here, not by the joining game: a game that
// connects with pw=1 (/relay?net=<n>&pw=1) never gets a password in a list,
// and sends the one its player typed with join, to a room listed with the
// password box; no game gets one in a welcome. The lobby keeps a salted HMAC of each password (room.pw), with the
// PASSWORD_KEY secret when that's set. Older games, which check the password
// themselves against the list and send a bare join, still can for a room an
// older game hosts while PASSWORDS_FOR_OLD_GAMES is "host" (the default,
// until PASSWORDS_FOR_OLD_GAMES_UNTIL if that's set), so those rooms' entries
// keep their passwords; any other room with a password is listed to them
// without it, and their join hears "error version newer", which tells their
// player to reload the page. See relay.py for the lines.
//
// In a room: a page watching the lobby says when its player has one of the
// rooms open (look <game> [<name>], the name in base64 UTF-8 as with hello),
// and when not any more (look), and hears looking <game> [<name>] (the name
// as the lobby took it) or looking off once the status it was just sent
// counts it that way. Such a page counts as a player in the room's game, not
// in a match: in online and, by its name, in lobby, as a game that said hello
// does (Antonio, 2026-11-28: people in a room should see themselves, and
// those who open it should see who's there). The lobby says look on connect
// for pages to know it takes this.
//
// Watching a match (spectating): a page watching the lobby says which of its
// rooms it's watching (spectate <room>, spectate 0 for none), and the status
// gives each room whether it can be watched (spect: 1, or 0) and how many
// pages are watching it (watching). A room's host's game may say whether it
// may be (spectators on|off [<delay s>]); one that hasn't said can be,
// unless it has a password. The lobby says spect on connect for games to
// know it takes that. Watchers never take a seat or reach the room's games.
//
// With a Durable Object bound as FEED (src/feed.js), a watchable match also
// gets a feed for pages to watch the game itself, held back by its delay: the
// lobby says feed on connect, a game in a room that takes part says feed, and
// while its match can be watched it's told where to send (feed <room>
// <token>), or feed off when that stops, so a page that comes to watch has
// the game at once (Antonio's choice, 2026-11-19). A game that says feed
// again has lost its feed, and is told its token again. With the FEED_ONLY_WATCHED
// var "1", only while a page watches the match, and for FEED_LINGER_MS after
// the last one stops. The status says feed: 1 for a match whose feed is on.
//
// The room windows' chat (src/chat.js, Antonio 2026-11-28): with the CHAT
// var "1", the lobby says chat on connect, and a page watching it may come
// into a room's chat, say lines there, report them and, with a moderator's
// key, moderate (chat <...>). Its lines are kept in storage for 48 hours.
//
// When a game leaves a match, its page posts a summary of it to /summary:
// counts only, kept in Workers Analytics Engine and the log (src/summary.js).
//
// With a D1 database bound as LADDER, the lobby also keeps a record of every
// match: it says match on connect, the games in a room report what happens in
// theirs (match), and each match gets a page (src/ladder.js,
// src/ladder-pages.js). Without the binding nothing of it runs.
//
// /imperial-games answers the Imperial Network Protocol relay's game list
// (IMPERIAL_LIST), for the page to show beside this lobby's (src/imperial.js).
// It never touches the lobby.
//
// /imperial-feed is a dedicated server on that relay asking for its match's
// feed, with a key IMPERIAL_FEED_KEYS gives it (src/imperial-feed.js). The
// lobby gives the feed a room number of its own (from the rooms' count, so it
// never meets a room's) and lists it in the status (imp), by the server's
// sid, for the page to put Watch on its card; pages spectate it as a room.
//
// /e/ is the engine's files, named by their content and kept by browsers for
// good, sent brotli-compressed at its best where the browser takes it
// (src/engine.js).

import { DurableObject } from "cloudflare:workers";
import { movedTo, movedStatus } from "./moved.js";
import { takeSummary } from "./summary.js";
import { imperialGames } from "./imperial.js";
import { feedRoute, sayClean, WATCH_NAMES_MAX } from "./feed.js";
import { imperialFeedRoute } from "./imperial-feed.js";
import { engineFile } from "./engine.js";
import { Ladder } from "./ladder.js";
import { Chat, linkish } from "./chat.js";
import { addressKey } from "./address.js";
import { ladderRoute } from "./ladder-pages.js";
import { levelsRoute, kickLevels } from "./levels.js";
// The Level Library's job (src/levels.js), a Durable Object of its own.
export { LevelJob } from "./levels.js";
export { Feed } from "./feed.js";

const MAX_MESSAGE = 64 * 1024;
const MAX_ENTRY_HEX = 2048;
const MAX_SIGNAL_B64 = 16384;
const FIRST_PEER_ID = 2;
const LAST_PEER_ID = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[0-9]{1,9}$/;
// The least time between a page's two asks for a match's kills (kills).
const KILLS_MS = 1000;
const KEY_RE = /^[0-9a-f]{32}$/;
// The netcode number in a game's address. A game that doesn't say is 0, as
// is every build until the first change older builds can't play with.
const NET_RE = /^[0-9]{1,3}$/;
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
// A game packet the lobby can't pass on (its sender isn't in a room, or the
// player it's for isn't in the room) still counts against the daily limit,
// and a game that's lost track of its room can send ~1,400 a minute for
// hours. Once they've kept coming for NOTICE_MS, the lobby tells the game
// what it would have heard had it been in the room: host-left for a game
// sending to its host, peer-left for a host sending to a player. Again every
// NOTICE_AGAIN_MS while they don't stop, and they start over after a gap of
// UNSENT_GAP_MS. Not for a held seat: that player may yet come back. The
// NOTICE_MS var overrides it, for tests.
const NOTICE_MS = 5 * 1000;
const NOTICE_AGAIN_MS = 30 * 1000;
const UNSENT_GAP_MS = 10 * 1000;
// How many connections the minute's log names, busiest first.
const LOG_TOP = 5;
// TURN credentials come from Cloudflare's Realtime API, with a TURN key made
// in the dashboard under Realtime: its id in the TURN_KEY_ID secret and its
// API token in TURN_KEY_API_TOKEN (see README.md). Without both, there's no
// TURN. The TURN_API var overrides the address, for tests.
const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys/";
// How long credentials last. A game asks again for links it sets up once half
// of that is up; a link already up through TURN when they run out drops, and
// is set up again with new ones.
const TURN_TTL_S = 24 * 60 * 60;
// Cloudflare asks that more than half of the credentials made get used, so
// only a game in a room gets them, when it's about to link, and a connection
// gets them at most this often. The game asks at most every 10 s.
const TURN_EVERY_MS = 5 * 1000;
// After Cloudflare couldn't make credentials, how long games get none before
// the lobby tries again.
const TURN_RETRY_MS = 60 * 1000;
// Browsers can't reach TURN on port 53 (Cloudflare's docs say so), and a
// link would wait for it to time out.
const PORT_53_RE = /:53(\?|$)/;
// A room's password in its entry: 32 UTF-16 code units at byte 152, of which
// the game uses 31, and sessionFlags at 216, whose 0x400 makes the join
// screen show its password box.
const PW_AT = 152;
const PW_UNITS = 32;
const FLAGS_AT = 216;
const SESSIONFLAG_PASSWORD = 0x400;
// The password a game sends with join: hex of 1 to 31 UTF-16LE code units.
const PW_HEX_RE = /^(?:[0-9a-fA-F]{4}){1,31}$/;
// Wrong passwords tried on one room from one address (CF-Connecting-IP, an
// IPv6 one by its /64) in PW_TRIES_MS before every try from it gets
// "error password wait".
const PW_TRIES = 10;
const PW_TRIES_MS = 60 * 1000;
// How far behind live a watched match may be shown, in seconds, as a
// host's game asks (spectators): never less than SPECT_MIN_DELAY_S, so
// watching can't call out where players are; SPECT_DELAY_S when it doesn't
// say.
const SPECT_MIN_DELAY_S = 30;
const SPECT_MAX_DELAY_S = 300;
const SPECT_DELAY_S = 30;
const SECS_RE = /^[0-9]{1,4}$/;
// With FEED_ONLY_WATCHED, how long a match's feed goes on after its last page
// stops watching it, so a page coming back (or the next one) doesn't wait out
// the delay again.
const FEED_LINGER_MS = 2 * 60 * 1000;
// A game asking for its feed again (feed) has lost it: the room's feed is armed
// again, in case it ended itself, at most once every FEED_REARM_MS.
const FEED_REARM_MS = 5000;
// The most games a feed may say watch from inside the game (src/feed.js
// takes 200).
const MAX_FEED_PAGES = 1000;
// HMAC pads a key with zeros, so this is the same as no key, which
// crypto.subtle won't take.
const NO_KEY = new Uint8Array(64);

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === "/relay") {
            if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
                return new Response("Expected a WebSocket upgrade", { status: 426 });
            const lobby = env.LOBBY.get(env.LOBBY.idFromName("lobby"));
            return lobby.fetch(request);
        }
        if (url.pathname.startsWith("/feed/")) {
            const feed = await feedRoute(request, env, url);
            if (feed)
                return feed;
        }
        if (url.pathname === "/imperial-feed")
            return imperialFeedRoute(request, env);
        if (url.pathname === "/summary")
            return takeSummary(request, env);
        if (url.pathname === "/imperial-games")
            return imperialGames(request, env, ctx);
        // Before the move's redirect: the engine's files are the same on
        // every address, and the page's fetch of one would fail on a
        // redirect to another.
        if (url.pathname.startsWith("/e/"))
            return engineFile(request, env);
        const to = movedTo(url, env.SITE, env.MOVED_FROM);
        if (to)
            return Response.redirect(to, movedStatus(env.MOVED_STATUS));
        // The match record's pages and a player's key (/match/<id>,
        // /matches, /ladder/key): null for any other path.
        const ladder = await ladderRoute(request, env, url);
        if (ladder)
            return ladder;
        // The Level Library's index, levels and pictures (/levels/...): null
        // for any other path, and for all of them without its bucket.
        const levels = await levelsRoute(request, env, url);
        if (levels)
            return levels;
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404)
            return res;
        // The Worker also runs for a path with no file. Its 404 is kept by
        // nothing, also where public/_headers gives the path a year (rooms/),
        // so a page from a newer deploy reaching an older one can find the
        // file once it's there.
        const missing = new Response(res.body, res);
        missing.headers.set("Cache-Control", "no-store");
        return missing;
    },

    // The cron in wrangler.toml (beta only, for now): makes sure the Level
    // Library's job has its alarm set. The job paces itself.
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(kickLevels(env));
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
// {name, fp, pack}: the mod's name and its fingerprint as hex ("" for none),
// and whether the game runs the pack.
function modTail(hex) {
    const b = hexBytes(hex);
    if (b.length < 7 || b[0] !== 0x4a || b[1] !== 0x4b || b[2] !== 0x4d || b[3] !== 0x44 || b[4] !== 2)
        return { name: "", fp: "", pack: false };
    const mod = (b[5] & 1) !== 0, pack = (b[5] & 2) !== 0;
    return {
        name: mod ? ascii(b, 7 + 32 + (pack ? 16 : 0), b[6]) : "",
        // The mod's fingerprint, for the match record.
        fp: mod && b.length >= 7 + 32 ? toHex(b.subarray(7, 7 + 32)) : "",
        pack,
    };
}

// The same as the page's lists name it.
function modName(hex) {
    const { name, pack } = modTail(hex);
    if (pack)
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
        // The highest Force rank its players may have (jkMultiEntry.maxRank).
        maxRank: Math.max(0, Math.min(99, v.getInt32(236, true))),
    };
}

// The password in an entry, as lowercase hex of its code units up to the
// first 0, "" for none.
function entryPassword(hex) {
    if (hex.length < ENTRY_HEX)
        return "";
    let s = "";
    for (let i = 0; i < PW_UNITS - 1; i++) {
        const unit = hex.substr((PW_AT + i * 2) * 2, 4).toLowerCase();
        if (unit === "0000")
            break;
        s += unit;
    }
    return s;
}

// The entry without its password, and with the password box flag set to box
// unless that's undefined.
function stripEntry(hex, box) {
    if (hex.length < ENTRY_HEX)
        return hex;
    let out = hex.slice(0, PW_AT * 2) + "0".repeat(PW_UNITS * 4) + hex.slice((PW_AT + PW_UNITS * 2) * 2);
    if (box !== undefined) {
        // The flag is in sessionFlags' second byte.
        const at = (FLAGS_AT + 1) * 2;
        const bit = SESSIONFLAG_PASSWORD >> 8;
        const was = parseInt(out.substr(at, 2), 16);
        out = out.slice(0, at) + ((box ? was | bit : was & ~bit).toString(16).padStart(2, "0")) + out.slice(at + 2);
    }
    return out;
}

// join's password: 1 to 31 code units, none of them 0.
function validPassword(hex) {
    return PW_HEX_RE.test(hex) && !/^(?:.{4})*0000/.test(hex);
}

function toHex(bytes) {
    return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

// What the lobby keeps instead of a password: HMAC-SHA-256 of the room's salt
// and the password's code units, keyed with the PASSWORD_KEY secret (no key
// without it). Rooms keep theirs in storage, so changing PASSWORD_KEY while
// rooms with a password are open turns their passwords down until their
// hosts' games send their entries again.
async function passwordMac(saltHex, pwHex, secret) {
    const key = secret ? new TextEncoder().encode(secret) : NO_KEY;
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, hexBytes(saltHex + pwHex))));
}

// A room's verifier: legacy when its host is an older game (no pw=1).
async function newVerifier(pwHex, secret, legacy) {
    const salt = newKey();
    return { salt, mac: await passwordMac(salt, pwHex, secret), legacy };
}

// Compares two MACs in the same time wherever they differ.
function sameMac(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

// The address wrong passwords are counted by (src/address.js): an IPv6 one by
// its first 64 bits.
const triesKey = addressKey;

// PASSWORDS_FOR_OLD_GAMES as the lobby takes it: "host" (or unset) or
// "none". Anything else is taken as "none", which keeps passwords from older
// games rather than handing them out.
function oldGamesMode(env) {
    const mode = String(env.PASSWORDS_FOR_OLD_GAMES || "").trim().toLowerCase();
    return !mode || mode === "host" ? "host" : "none";
}

// PASSWORDS_FOR_OLD_GAMES_UNTIL in ms, Infinity when unset, NaN when it isn't
// a time.
function oldGamesUntil(env) {
    const text = String(env.PASSWORDS_FOR_OLD_GAMES_UNTIL || "").trim();
    return text ? Date.parse(text) : Infinity;
}

// Whether older games still check the password of a room an older game
// hosts themselves: while PASSWORDS_FOR_OLD_GAMES is "host" (or unset), until
// PASSWORDS_FOR_OLD_GAMES_UNTIL if that's set; never with "none", nor with
// an UNTIL that isn't a time.
function oldGamesKeepPasswords(env, now = Date.now()) {
    return oldGamesMode(env) === "host" && now < oldGamesUntil(env);
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

// The netcode number a game connected with, 0 if it didn't say.
function netcode(text) {
    return text && NET_RE.test(text) ? Number(text) : 0;
}

// The names of those watching a match from a game, as its feed says them
// (feedPages): cleaned as the feed cleans them, at most WATCH_NAMES_MAX.
function watchNames(names) {
    return (Array.isArray(names) ? names : []).slice(0, WATCH_NAMES_MAX)
        .map(x => sayClean(String(x), 16)).filter(x => x);
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

function turnOn(env) {
    return !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
}

// What the lobby can do beyond the basics, for the game to know on connect.
function lobbyMessage(env) {
    // match: games in a room report their match (src/ladder.js). spect: a
    // host's game may say whether its match can be watched (spectators), and
    // a page may ask for the kills of the match it watches (kills).
    // feed: a watched match's games send it to its feed (src/feed.js).
    // look: a page may say its player has a room open (look).
    // chat: the room windows' chat (src/chat.js), where CHAT is "1".
    return (turnOn(env) ? "lobby links turn pw" : "lobby links pw") + (env.LADDER ? " match" : "") + " spect" +
        (env.FEED ? " feed" : "") + " look" + (String(env.CHAT || "") === "1" ? " chat" : "");
}

// The iceServers list for a game from Cloudflare's answer: its STUN and TURN
// servers, without the addresses on port 53.
function turnServers(answer) {
    const servers = [];
    for (const s of (answer && Array.isArray(answer.iceServers)) ? answer.iceServers : []) {
        const urls = [].concat(s.urls || []).filter(u => typeof u === "string" && !PORT_53_RE.test(u));
        if (!urls.length)
            continue;
        const server = { urls };
        if (typeof s.username === "string" && typeof s.credential === "string") {
            server.username = s.username;
            server.credential = s.credential;
        }
        servers.push(server);
    }
    if (!servers.some(s => s.username))
        throw new Error("no TURN server in the answer");
    return servers;
}

export class Lobby extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // room id -> {id, host, entry, peers: Map(id -> ws), seats, pw,
        // entrySeq, spect}, where seats is Map(id -> {key, until, lost, name, game,
        // net}) for the host (1) and each peer: until, lost (when its player
        // was last here), name, game and net only while the seat is held,
        // and at, when its player sat down. pw is the password's verifier, {salt, mac,
        // legacy}, null for a room without one. entrySeq counts the host's
        // entries, so one that waited for its verifier doesn't undo a newer.
        // spect is what its host's game said about watching it, {on, delay},
        // null until it does (spectOn). feed is its feed while it's on,
        // {tokens: {player id: token}, idle (when its last page stopped
        // watching, 0 while one does), armed (what the feed was last told),
        // pages (how many games watch it from inside the game, as the feed
        // last said: feedPages), names (the names of the games watching, the
        // games in viewing pages' boxes too: feedPages), watchLine (what its
        // feed was last told of who watches, not kept)}, feedChain the calls
        // to its feed, one after another, and watchTold {player id -> {ws,
        // line}}, what its games were last told of who watches (watchersTell).
        this.rooms = new Map();
        this.holdMs = Number(env.HOLD_MS) || HOLD_MS;
        this.noticeMs = Number(env.NOTICE_MS) || NOTICE_MS;
        // ws -> {room, id, name, game, watch, spect, look, lookName, since,
        // net, pw, ip}: the room id and player id, the player's name and game
        // from hello (name null until then), whether it's a page watching the
        // counts, the room whose match that page is watching (0 or none for
        // none), the game whose room that page's player has open ("" or none
        // for none) and the name it gave (null for none), when it
        // connected, the netcode it connected with, whether it sends
        // passwords with join, and its address (CF-Connecting-IP).
        this.conns = new Map();
        // A page's socket -> when it last asked for a match's kills (kills).
        this.killsAsked = new WeakMap();
        this.heard = new Map();   // ws -> when its last message came (not its pings)
        // ws -> Map(notice -> {first, last, told}): packets it sends that go
        // nowhere, by what it would be told about them (see NOTICE_MS).
        this.unsent = new Map();
        this.turnAt = new Map();  // ws -> when it last got TURN credentials
        // ws -> how many host, join, leave, rejoin and rehost it sent, so a
        // host or join that waited for a password's HMAC is dropped once its
        // game has asked for something else.
        this.opSeq = new Map();
        // room id -> Map(address (triesKey), or ws without one -> {at,
        // checking}): when the wrong passwords tried in the last PW_TRIES_MS
        // were, and how many tries are being checked. In memory only, so
        // they start over when the object is evicted.
        this.pwTries = new Map();
        const mode = String(env.PASSWORDS_FOR_OLD_GAMES || "").trim().toLowerCase();
        if (mode && mode !== oldGamesMode(env))
            console.log("relay: PASSWORDS_FOR_OLD_GAMES isn't host or none, so it's taken as none");
        if (isNaN(oldGamesUntil(env)))
            console.log("relay: PASSWORDS_FOR_OLD_GAMES_UNTIL isn't a time, so it's taken as passed (none)");
        this.turnDownUntil = 0;   // no TURN credentials until then (TURN_RETRY_MS)
        this.alarmAt = null;      // when the next sweep for quiet connections runs
        this.nextRoom = 1;
        this.lastStatus = null;   // the status the watchers have
        this.stats = this.newStats(Date.now());
        this.ladder = new Ladder(this);
        // The room chat (src/chat.js), on where CHAT is "1".
        this.chat = new Chat(this);
        // Names the lists leave out, as web addresses (shownName).
        this.linkNames = new Map();
        // Imperial relay servers' feeds (imperialFeed), by their sid:
        // {sid, id, token, delay, game, name, episode, map, pages, chain}.
        this.imperial = new Map();
        // sid -> the watching line an Imperial server's feed was last told
        // (watchersTell), not kept.
        this.impWatchTold = new Map();
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
        const pws = await this.ctx.storage.list({ prefix: "pw:" });
        const spects = await this.ctx.storage.list({ prefix: "spect:" });
        const feeds = await this.ctx.storage.list({ prefix: "feed:" });
        for (const [key, f] of await this.ctx.storage.list({ prefix: "imp:" }))
            this.imperial.set(key.slice(4), { ...f, pages: f.pages || 0, chain: null });
        for (const [key, entry] of entries) {
            const id = Number(key.slice(5));
            let pw = pws.get("pw:" + id) || null;
            // A password with no verifier for it is from a lobby that didn't
            // check them (before this one, or one rolled back to): its host
            // is taken for an older game.
            const pwHex = entryPassword(entry);
            if (pwHex && (!pw || !sameMac(await passwordMac(pw.salt, pwHex, this.env.PASSWORD_KEY), pw.mac))) {
                pw = await newVerifier(pwHex, this.env.PASSWORD_KEY, pw ? pw.legacy : true);
                this.ctx.storage.put("pw:" + id, pw);
            }
            const room = this.newRoom(id, entry, seats.get("seats:" + id), pw);
            room.spect = spects.get("spect:" + id) || null;
            const feed = feeds.get("feed:" + id);
            room.feed = feed ? { tokens: feed.tokens || {}, idle: feed.idle || 0, armed: "", pages: feed.pages || 0,
                                 names: watchNames(feed.names), told: {}, ok: "" } : null;
            this.rooms.set(id, room);
        }
        this.stripPasswords();
        for (const ws of this.ctx.getWebSockets()) {
            const att = ws.deserializeAttachment() || { room: 0, id: 0 };
            this.conns.set(ws, att);
            if (!att.room)
                continue;
            let room = this.rooms.get(att.room);
            if (!room) {
                // Its entry wasn't kept, but a verifier still checks joins.
                room = this.newRoom(att.room, "", null, pws.get("pw:" + att.room));
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
                    delete seat.lost;
                    changed = true;
                } else if (!live && !seat.until) {
                    seat.until = now + this.holdMs;
                    seat.lost = now;
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
        for (const key of pws.keys()) {
            if (!this.rooms.has(Number(key.slice(3))))
                this.ctx.storage.delete(key);
        }
        for (const key of spects.keys()) {
            if (!this.rooms.has(Number(key.slice(6))))
                this.ctx.storage.delete(key);
        }
        // A feed whose room went while the object was away ends itself once
        // nothing comes (src/feed.js).
        for (const key of feeds.keys()) {
            if (!this.rooms.has(Number(key.slice(5))))
                this.ctx.storage.delete(key);
        }
        if (this.conns.size)
            this.sweepLater();
        if (this.nextExpiry())
            this.sweepLater(this.nextExpiry());
        await this.ladder.restore();
        await this.chat.restore();
    }

    newRoom(id, entry, seats, pw) {
        return {
            id, host: null, entry, peers: new Map(),
            seats: new Map(Object.entries(seats || {}).map(([k, v]) => [Number(k), v])),
            pw: pw || null, entrySeq: 0, spect: null, feed: null, feedChain: null,
        };
    }

    saveSeats(room) {
        this.ctx.storage.put("seats:" + room.id, Object.fromEntries(room.seats));
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        const query = new URL(request.url).searchParams;
        this.saveConn(server, { room: 0, id: 0, name: null, game: "", watch: false, since: Date.now(),
                                net: netcode(query.get("net")), pw: query.get("pw") === "1",
                                ip: request.headers.get("CF-Connecting-IP") || "" });
        this.sweepLater();
        const ice = iceMessage(this.env);
        if (ice)
            this.send(server, ice);
        this.send(server, lobbyMessage(this.env));
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
        this.count(ws, typeof message === "string", size);
        // Only turn (for Cloudflare's answer), and a host, update, join or
        // rehost with a password (for its HMAC), wait for anything: other
        // messages are handled meanwhile.
        const later = typeof message === "string" ? this.onText(ws, message) : this.onBinary(ws, message);
        if (later)
            await later;
    }

    async webSocketClose(ws, code, reason, wasClean) {
        this.chat.left(ws);
        this.drop(ws);
        this.forget(ws);
        this.statusChanged();
        try { ws.close(1000, "bye"); } catch (e) {}
    }

    async webSocketError(ws, error) {
        this.chat.left(ws);
        this.drop(ws);
        this.forget(ws);
        this.statusChanged();
    }

    forget(ws) {
        this.conns.delete(ws);
        this.heard.delete(ws);
        this.unsent.delete(ws);
        this.turnAt.delete(ws);
        this.opSeq.delete(ws);
        this.ladder.forget(ws);
    }

    async alarm() {
        this.alarmAt = null;
        this.sweep();
        this.ladder.sweep();
        this.chat.sweep();
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
            // Gone since it was last heard, not since now.
            this.chat.left(ws);
            this.drop(ws, last);
            // Counted nowhere if the object wakes up before the socket is gone.
            this.saveConn(ws, { room: 0, id: 0, name: null, game: "", watch: false, since: 0 });
            this.forget(ws);
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
        else if ([...this.rooms.values()].some(r => r.feed && r.feed.idle))
            // A feed nobody watches ends once FEED_LINGER_MS is up.
            this.statusChanged();
        for (const [roomId, tries] of this.pwTries) {
            for (const [who, t] of tries) {
                while (t.at.length && now - t.at[0] >= PW_TRIES_MS)
                    t.at.shift();
                if (!t.at.length && !t.checking)
                    tries.delete(who);
            }
            if (!tries.size)
                this.pwTries.delete(roomId);
        }
        this.stripPasswords();
    }

    // Once older games no longer check passwords themselves (with
    // PASSWORDS_FOR_OLD_GAMES_UNTIL passed), the entries older games hosted
    // lose theirs.
    stripPasswords() {
        for (const room of this.rooms.values()) {
            if (!room.pw || this.keepsPassword(room.pw))
                continue;
            const entry = stripEntry(room.entry);
            if (entry !== room.entry) {
                room.entry = entry;
                this.ctx.storage.put("room:" + room.id, entry);
            }
        }
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

    // A minute's message counts, in all and by connection (ws -> {n, packets,
    // unsent, why: Map(reason -> how many)}), and the TURN credentials made.
    newStats(now) {
        return { since: now, text: 0, packets: 0, bytes: 0, by: new Map(), turn: 0, turnFailed: 0 };
    }

    connStats(ws) {
        let b = this.stats.by.get(ws);
        if (!b) {
            b = { n: 0, packets: 0, unsent: 0, why: new Map() };
            this.stats.by.set(ws, b);
        }
        return b;
    }

    // A connection as the logs name it: its player and where it is.
    who(c) {
        const name = c.name ? JSON.stringify(c.name) : c.watch ? "a watching page" : "a game with no name";
        return c.room ? `${name} (room ${c.room}, id ${c.id})` : `${name} (in no room)`;
    }

    count(ws, isText, size) {
        const s = this.stats;
        if (isText)
            s.text++;
        else
            s.packets++;
        s.bytes += size;
        const b = this.connStats(ws);
        b.n++;
        if (!isText)
            b.packets++;
        const now = Date.now();
        if (now - s.since >= STATS_MS) {
            let watching = 0;
            for (const c of this.conns.values())
                watching += c.watch ? 1 : 0;
            // Players whose game packets went through the lobby: those
            // without a WebRTC link (or not yet, or no longer).
            let relayed = 0;
            for (const c of s.by.values())
                relayed += c.packets ? 1 : 0;
            console.log(`relay: ${s.text + s.packets} messages in ${Math.round((now - s.since) / 1000)} s ` +
                `(${s.packets} game packets, ${s.bytes} bytes), ${this.conns.size - watching} connected, ` +
                `${watching} watching, ${relayed} sending game packets through the lobby` +
                (turnOn(this.env) ? `, ${s.turn} TURN credentials made (${s.turnFailed} failed)` : ""));
            // Who sent them, so a match going through the lobby, or a game
            // whose packets go nowhere, can be told apart and named.
            if (s.packets) {
                const top = [...s.by].sort((a, b) => b[1].n - a[1].n).slice(0, LOG_TOP).map(([w, b]) => {
                    const c = this.conns.get(w);
                    let line = `${c ? this.who(c) : "a connection since closed"} ${b.n}`;
                    if (b.unsent)
                        line += `, ${b.unsent} went nowhere (${[...b.why].map(([why, n]) => `${n} ${why}`).join(", ")})`;
                    return line;
                });
                console.log(`relay: busiest: ${top.join("; ")}`);
            }
            this.stats = this.newStats(now);
        }
    }

    onText(ws, line) {
        const parts = line.trim().split(/\s+/);
        if (!parts[0])
            return;
        const [op, ...args] = parts;
        if (op === "ping")
            return;
        if (op === "host" || op === "join" || op === "leave" || op === "rejoin" || op === "rehost")
            this.opSeq.set(ws, (this.opSeq.get(ws) || 0) + 1);
        const c = this.conn(ws);
        if (op === "list") {
            // list jk1 or list mots: only the games that game can join, so
            // not those whose host said hello as the other one, or speaks
            // another netcode.
            const want = GAMES.includes(args[0]) ? args[0] : null;
            const games = [...this.rooms.values()]
                .filter(r => r.host && (!want || !this.conn(r.host).game || this.conn(r.host).game === want) &&
                             this.roomNet(r) === (c.net || 0))
                .map(r => `${r.id} ${this.seated(r).length} ${this.listedEntry(r, c)}`);
            this.send(ws, ["list", ...games].join(" "));
        } else if (op === "host" && args.length === 1 && validEntry(args[0])) {
            return this.host(ws, c, args[0]);
        } else if (op === "update" && args.length === 1 && validEntry(args[0])) {
            return this.update(ws, c, args[0]);
        } else if (op === "join" && (args.length === 1 || args.length === 2) && ID_RE.test(args[0]) &&
                   (args.length === 1 || validPassword(args[1]))) {
            return this.join(ws, c, Number(args[0]), (args[1] || "").toLowerCase());
        } else if (op === "welcome" && args.length === 2 && ID_RE.test(args[0]) && validEntry(args[1])) {
            const room = this.rooms.get(c.room);
            if (room && room.host === ws) {
                const peer = room.peers.get(Number(args[0]));
                if (peer)
                    this.send(peer, `welcome ${args[0]} ${stripEntry(args[1])}`);
            }
        } else if (op === "signal" && args.length === 2 && ID_RE.test(args[0]) && validSignal(args[1])) {
            // Between any two players in the same room: a host and its
            // clients, and two clients linking to each other.
            const room = this.rooms.get(c.room);
            if (room && ws === (c.id === 1 ? room.host : room.peers.get(c.id))) {
                const to = Number(args[0]);
                const target = to === 1 ? room.host : room.peers.get(to);
                if (target && target !== ws)
                    this.send(target, `signal ${c.id} ${args[1]}`);
            }
        } else if (op === "turn" && !args.length) {
            return this.turn(ws, c);
        } else if (op === "rejoin" && args.length === 3 && ID_RE.test(args[0]) && ID_RE.test(args[1]) && KEY_RE.test(args[2])) {
            this.takeSeat(ws, Number(args[0]), Number(args[1]), args[2], null);
        } else if (op === "rehost" && (args.length === 2 || args.length === 3) && ID_RE.test(args[0]) && KEY_RE.test(args[1]) &&
                   (args.length === 2 || validEntry(args[2]))) {
            return this.takeSeat(ws, Number(args[0]), 1, args[1], args[2] || "");
        } else if (op === "leave") {
            this.leave(ws);
            this.statusChanged();
        } else if (op === "hello" && args.length === 2 && GAMES.includes(args[0]) && playerName(args[1]) !== null) {
            this.saveConn(ws, { ...c, name: playerName(args[1]), game: args[0] });
            this.statusChanged();
        } else if (op === "watch" && !args.length) {
            this.saveConn(ws, { ...c, watch: true });
            this.watch(ws);
        } else if (op === "look" && c.watch && (!args.length || (args.length <= 2 && GAMES.includes(args[0]) &&
                   (args.length === 1 || playerName(args[1]) !== null)))) {
            this.look(ws, c, args[0] || "", args.length === 2 ? playerName(args[1]) : null);
        } else if (op === "chat" && args.length && c.watch && this.chat.on()) {
            return this.chat.op(ws, c, args);
        } else if (op === "spectate" && args.length === 1 && ID_RE.test(args[0]) && c.watch) {
            this.spectate(ws, c, Number(args[0]));
        } else if (op === "kills" && args.length === 1 && ID_RE.test(args[0]) && c.watch) {
            this.kills(ws, Number(args[0]));
        } else if (op === "spectators" && (args.length === 1 || args.length === 2) && (args[0] === "on" || args[0] === "off") &&
                   (args.length === 1 || SECS_RE.test(args[1]))) {
            this.spectators(ws, c, args[0] === "on", args.length === 2 ? Number(args[1]) : 0);
        } else if (op === "feed" && args.length === 0 && this.env.FEED && c.room && this.rooms.has(c.room)) {
            if (!c.feed)
                this.saveConn(ws, { ...c, feed: true });
            // A game asking again lost its feed (its socket to it gave up)
            // or never heard of it (the feed didn't answer): it's told its
            // token again once the feed has it, armed again in case it ended
            // itself.
            const room = this.rooms.get(c.room), now = Date.now();
            if (room.feed) {
                delete room.feed.told[c.id];
                if (now - (room.feed.rearmAt || 0) >= FEED_REARM_MS) {
                    room.feed.rearmAt = now;
                    room.feed.armed = "";
                }
            }
            this.feedCheck(room, now);
        } else if (op === "match" && args.length === 1) {
            // Never answered, right or wrong (src/ladder.js).
            return this.ladder.report(ws, c, args[0]);
        } else {
            this.send(ws, "error bad-request");
        }
    }

    // Whether the lobby keeps this password in its room's entry, for older
    // games to check themselves: a room an older game hosts, while
    // PASSWORDS_FOR_OLD_GAMES lets them.
    keepsPassword(pw) {
        return !!pw && pw.legacy && oldGamesKeepPasswords(this.env);
    }

    // Whether older games join this room as they always have, checking its
    // password against the one in their list.
    oldGamesCheck(room) {
        return this.keepsPassword(room.pw) && !!entryPassword(room.entry);
    }

    // A room's entry as a game gets it in list. One that sends passwords with
    // join never gets the password, and gets the password box only for a
    // room that has one (not for one whose host's box was left on). An older
    // game gets a room whose password the lobby checks without either, so
    // its own check passes and its join hears "error version newer".
    listedEntry(room, c) {
        if (c.pw)
            return stripEntry(room.entry, !!room.pw);
        if (!room.pw || this.oldGamesCheck(room))
            return room.entry;
        return stripEntry(room.entry, false);
    }

    // A host's new room. With a password, once its verifier is made, unless
    // its game has asked for something else meanwhile.
    host(ws, c, entry) {
        const pwHex = entryPassword(entry);
        if (!pwHex) {
            this.openRoom(ws, entry, null);
            return;
        }
        const seq = this.opSeq.get(ws);
        return newVerifier(pwHex, this.env.PASSWORD_KEY, !c.pw).then(pw => {
            if (this.opSeq.get(ws) === seq && this.conns.has(ws))
                this.openRoom(ws, entry, pw);
        });
    }

    openRoom(ws, entry, pw) {
        this.leave(ws);
        const room = this.newRoom(this.nextRoom++, this.keepsPassword(pw) ? entry : stripEntry(entry), null, pw);
        room.host = ws;
        room.seats.set(1, { key: newKey(), at: Date.now() });
        const put = { nextRoom: this.nextRoom, ["room:" + room.id]: room.entry,
                      ["seats:" + room.id]: Object.fromEntries(room.seats) };
        if (pw)
            put["pw:" + room.id] = pw;
        this.ctx.storage.put(put);
        this.rooms.set(room.id, room);
        this.setConn(ws, room.id, 1);
        this.send(ws, `hosted ${room.id}`);
        this.send(ws, `seat ${room.id} 1 ${room.seats.get(1).key}`);
        console.log(`relay: room ${room.id} opened${pw ? " with a password" : ""}`);
        this.statusChanged();
    }

    update(ws, c, entry) {
        const room = this.rooms.get(c.room);
        if (!room || room.host !== ws)
            return;
        const seq = ++room.entrySeq;
        if (!entryPassword(entry)) {
            this.setEntry(room, entry, null);
            return;
        }
        return this.verifierFor(room.pw, entry, c).then(pw => {
            if (room.entrySeq === seq && this.rooms.get(room.id) === room && room.host === ws)
                this.setEntry(room, entry, pw);
        });
    }

    // The verifier for a host's entry with a password: the room's own while
    // the password is the same, else a new one. A room stops being an older
    // game's once its host sends pw=1.
    async verifierFor(pw, entry, c) {
        const pwHex = entryPassword(entry);
        if (pw && sameMac(await passwordMac(pw.salt, pwHex, this.env.PASSWORD_KEY), pw.mac))
            return pw.legacy && c.pw ? { ...pw, legacy: false } : pw;
        return newVerifier(pwHex, this.env.PASSWORD_KEY, !c.pw);
    }

    // A host's new entry (update or rehost) and its verifier, null without a
    // password: the room keeps the entry without its password unless older
    // games still check it themselves.
    setEntry(room, entry, pw) {
        const kept = this.keepsPassword(pw) ? entry : stripEntry(entry);
        let changed = false;
        if (pw !== room.pw) {
            changed = !pw !== !room.pw;
            room.pw = pw;
            if (pw)
                this.ctx.storage.put("pw:" + room.id, pw);
            else
                this.ctx.storage.delete("pw:" + room.id);
        }
        if (kept !== room.entry) {
            room.entry = kept;
            this.ctx.storage.put("room:" + room.id, kept);
            changed = true;
        }
        if (changed)
            this.statusChanged();
    }

    // join <room> [<password>]: the password, hex of its UTF-16LE code units,
    // is checked here for a game that sent pw=1; an older game checked it
    // itself against its list, which only has it while oldGamesCheck.
    async join(ws, c, roomId, pwHex) {
        const seq = this.opSeq.get(ws);
        this.leave(ws);
        for (;;) {
            const room = this.rooms.get(roomId);
            // Not while its host is away: nobody would welcome them.
            if (!room || !room.host) {
                this.send(ws, "error no-room");
                this.statusChanged();
                return;
            }
            // Another netcode, from a list that's out of date or a landing
            // page with another build: says whose is newer, so the game can
            // say whose page to reload.
            const net = this.roomNet(room);
            if (net !== (c.net || 0)) {
                this.send(ws, `error version ${net > (c.net || 0) ? "newer" : "older"}`);
                this.statusChanged();
                return;
            }
            const pw = room.pw;
            if (pw && !c.pw && !this.oldGamesCheck(room)) {
                this.send(ws, "error version newer");
                this.statusChanged();
                return;
            }
            if (pw && c.pw) {
                // Too many wrong ones: not even checked, so a right one isn't
                // called wrong.
                const tries = this.triesFor(room.id, c, ws);
                if (tries.at.length + tries.checking >= PW_TRIES) {
                    this.send(ws, "error password wait");
                    this.statusChanged();
                    return;
                }
                // An empty box tells nobody anything, so it isn't counted.
                if (!pwHex) {
                    this.send(ws, "error password");
                    this.statusChanged();
                    return;
                }
                tries.checking++;
                let mac;
                try {
                    mac = await passwordMac(pw.salt, pwHex, this.env.PASSWORD_KEY);
                } finally {
                    tries.checking--;
                }
                // Its game asked for something else, or is gone.
                if (this.opSeq.get(ws) !== seq || !this.conns.has(ws))
                    return;
                // The room, its host or its password changed meanwhile.
                if (this.rooms.get(roomId) !== room || !room.host || room.pw !== pw)
                    continue;
                if (!sameMac(mac, pw.mac)) {
                    tries.at.push(Date.now());
                    if (tries.at.length === PW_TRIES)
                        console.log(`relay: room ${room.id}: ${PW_TRIES} wrong passwords from one address, it waits`);
                    this.send(ws, "error password");
                    this.statusChanged();
                    return;
                }
            }
            this.seatPlayer(ws, room);
            return;
        }
    }

    // The wrong passwords tried on a room from c's address (an IPv6 one's
    // /64; ws alone without one) in the last PW_TRIES_MS.
    triesFor(roomId, c, ws) {
        let byWho = this.pwTries.get(roomId);
        if (!byWho) {
            byWho = new Map();
            this.pwTries.set(roomId, byWho);
        }
        const who = c.ip ? triesKey(c.ip) : ws;
        let t = byWho.get(who);
        if (!t) {
            t = { at: [], checking: 0 };
            byWho.set(who, t);
        }
        const now = Date.now();
        while (t.at.length && now - t.at[0] >= PW_TRIES_MS)
            t.at.shift();
        return t;
    }

    seatPlayer(ws, room) {
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
        room.seats.set(peerId, { key: newKey(), at: Date.now() });
        this.saveSeats(room);
        this.setConn(ws, room.id, peerId);
        this.send(room.host, `peer-joined ${peerId}`);
        this.send(ws, `seat ${room.id} ${peerId} ${room.seats.get(peerId).key}`);
        console.log(`relay: room ${room.id}: player joined as id ${peerId}`);
        this.statusChanged();
    }

    // TURN credentials for a game in a room, as ice with how many seconds
    // they last. Without them (no TURN key, a game in no room or asking too
    // often, or Cloudflare couldn't make them), the ice every game gets on
    // connect, so a game waiting for them goes on at once.
    async turn(ws, c) {
        const now = Date.now();
        const room = this.rooms.get(c.room);
        const seated = !!room && ws === (c.id === 1 ? room.host : room.peers.get(c.id));
        if (!turnOn(this.env) || !seated || now - (this.turnAt.get(ws) || 0) < TURN_EVERY_MS || now < this.turnDownUntil) {
            const ice = iceMessage(this.env);
            if (ice)
                this.send(ws, ice);
            return;
        }
        this.turnAt.set(ws, now);
        let servers;
        try {
            const answer = await fetch((this.env.TURN_API || TURN_API) + encodeURIComponent(this.env.TURN_KEY_ID) +
                                       "/credentials/generate-ice-servers", {
                method: "POST",
                headers: { "Authorization": "Bearer " + this.env.TURN_KEY_API_TOKEN, "Content-Type": "application/json" },
                body: JSON.stringify({ ttl: TURN_TTL_S }),
            });
            if (answer.status !== 201)
                throw new Error(`HTTP ${answer.status}`);
            servers = turnServers(await answer.json());
        } catch (e) {
            this.stats.turnFailed++;
            if (Date.now() >= this.turnDownUntil)
                console.log(`relay: Cloudflare didn't make TURN credentials (${e.message}); none for a minute`);
            this.turnDownUntil = Date.now() + TURN_RETRY_MS;
            const ice = iceMessage(this.env);
            if (ice)
                this.send(ws, ice);
            return;
        }
        this.stats.turn++;
        this.send(ws, `ice ${btoa(JSON.stringify(servers))} ${TURN_TTL_S}`);
    }

    onBinary(ws, data) {
        if (data.byteLength < 8)
            return;
        const c = this.conn(ws);
        const room = this.rooms.get(c.room);
        const view = new DataView(data);
        const idTo = view.getUint32(4, true);
        if (!room) {
            this.unsentPacket(ws, c, null, idTo);
            return;
        }
        const target = (room.host === ws || (idTo !== 0 && idTo !== 1)) ? room.peers.get(idTo) : room.host;
        // The relay stamps a client's real id; the host's is kept, because a
        // host forwards packets for clients it reaches over WebRTC.
        if (room.host !== ws)
            view.setUint32(0, c.id, true);
        if (target && target !== ws)
            this.send(target, data);
        else
            this.unsentPacket(ws, c, room, idTo);
    }

    // A game packet that went nowhere: counted for the minute's log, and once
    // they've kept coming for NOTICE_MS, the sender hears that the player
    // it's sending to is gone. A game in no room may be a host or a client,
    // so it hears host-left only for packets to the host (a host never sends
    // to itself, and host-left would cut a host's direct links), and
    // peer-left for the others, which a client doesn't act on.
    unsentPacket(ws, c, room, idTo) {
        const host = !!room && room.host === ws;
        // A client's packets to 0 are for the host.
        const to = !host && idTo === 0 ? 1 : idTo;
        const seat = room && room.seats.get(to);
        const self = !!room && to === c.id;
        const held = !self && !!(seat && seat.until);
        const why = `to id ${to}: ${!room ? "sender in no room" : self ? "itself" : held ? "a held seat" : "not in the room"}`;
        const b = this.connStats(ws);
        b.unsent++;
        b.why.set(why, (b.why.get(why) || 0) + 1);
        let notice = null;
        if (!room && to === 1)
            notice = "host-left";
        else if ((!room || host) && to > 1 && !held)
            notice = `peer-left ${to}`;
        if (!notice)
            return;
        const now = Date.now();
        let mine = this.unsent.get(ws);
        if (!mine) {
            mine = new Map();
            this.unsent.set(ws, mine);
        }
        let u = mine.get(notice);
        if (!u || now - u.last > UNSENT_GAP_MS) {
            u = { first: now, last: now, told: 0 };
            mine.set(notice, u);
        }
        u.last = now;
        if (now - u.first < this.noticeMs || now - u.told < NOTICE_AGAIN_MS)
            return;
        u.told = now;
        this.send(ws, notice);
        console.log(`relay: told ${this.who(c)} ${notice}, after ${Math.round((now - u.first) / 1000)} s of ` +
            `packets that went nowhere (${why})`);
    }

    // The landing page's live counts: who's on and the games they're in, in
    // all and by game (its rooms are each for one game). A player is a game
    // that said hello or is in a room, or a page whose player has a room open
    // (look); other watching pages aren't. lobby has the names of those not
    // in a match, so a page in a room without a name is only counted.
    status() {
        const byName = (a, b) => a.localeCompare(b);
        const lobby = [];
        const byGame = Object.fromEntries(GAMES.map(g => [g, { online: 0, lobby: [] }]));
        let online = 0;
        for (const c of this.conns.values()) {
            if (c.room)
                continue;
            const game = c.name != null ? c.game : c.watch && GAMES.includes(c.look) ? c.look : "";
            if (!game)
                continue;
            const name = this.shownName(c.name != null ? c.name : c.lookName);
            online++;
            byGame[game].online++;
            if (name) {
                lobby.push(name);
                byGame[game].lobby.push(name);
            }
        }
        lobby.sort(byName);
        // How many pages watch each room's match; the games watching it from
        // inside the game are added from its feed (feedPages), with the names
        // of those watching from a game (roomWatchers).
        const watching = this.spectPages();
        const games = [];
        for (const room of [...this.rooms.values()].sort((a, b) => a.id - b.id)) {
            const info = readEntry(room.entry);
            if (!info)
                continue;
            const host = room.host ? this.conn(room.host) : room.seats.get(1);
            const names = this.seated(room).map(([id, ws, seat]) => this.shownName((ws ? (id === 1 ? host : this.conn(ws)) : seat).name || ""));
            const game = host.game || guessGame(info.episode);
            online += names.length;
            byGame[game].online += names.length;
            // The level's name as the host's game shows it, once its match
            // report has said (src/ladder.js); the page names the retail
            // levels itself before that.
            const title = this.ladder.title(room.id, info.map);
            const locked = info.locked || !!room.pw;
            // Its match as it's played: the rules, the clock and the scores
            // (src/ladder.js, liveView), once its host's game has reported.
            const live = this.ladder.on() ? this.ladder.live(room.id, info.map, locked) : null;
            // Whether its match can be watched, and by how many pages it is.
            const spect = this.spectOn(room, locked);
            const { n: seen, names: watchers } = this.roomWatchers(room, watching, spect);
            games.push({
                id: room.id, name: info.name, game,
                map: info.map, ...(title ? { title } : {}), episode: info.episode, mod: info.mod,
                locked, players: names.length, max: info.max, names: names.slice(0, MAX_STATUS_NAMES),
                net: this.roomNet(room), rank: info.maxRank, ...(live ? { live } : {}),
                spect: spect ? 1 : 0, ...(seen ? { watching: seen } : {}), ...(watchers.length ? { watchers } : {}),
                ...(room.feed ? { feed: 1 } : {}),
            });
        }
        for (const g of Object.values(byGame))
            g.lobby = g.lobby.sort(byName).slice(0, MAX_STATUS_NAMES);
        // Imperial relay servers sending their match's feed (imperialFeed):
        // the page finds each one's card by its sid.
        const imp = [...this.imperial.values()].sort((a, b) => a.id - b.id).map(f => {
            const { n: seen, names: watchers } = this.impWatchers(f, watching);
            return { id: f.id, sid: f.sid, game: f.game, name: f.name, episode: f.episode, map: f.map, delay: f.delay,
                     ...(seen ? { watching: seen } : {}), ...(watchers.length ? { watchers } : {}) };
        });
        return JSON.stringify({
            online, lobby: lobby.slice(0, MAX_STATUS_NAMES), byGame, games: games.slice(0, MAX_STATUS_GAMES),
            ...(imp.length ? { imp } : {}),
            // The last match recorded, for the page to know when to get its
            // lists again (/ladder/recent); not there without the record.
            ...(this.ladder.on() ? { match: this.ladder.latest } : {}),
        });
    }

    // The status line as it goes to a page: status() with the lobby's clock
    // as it's sent (now), which the page sets the times in it by (a match's
    // clock, its last kill). The clock isn't part of what's compared to see
    // whether the watchers have this status already.
    statusLine(status) {
        return "status " + base64Utf8(status.slice(0, -1) + `,"now":${Date.now()}}`);
    }

    // What the match record keeps of a room (src/ladder.js).
    roomInfo(room) {
        const info = readEntry(room.entry) || { name: "", episode: "", map: "", locked: false, maxRank: 0 };
        const host = room.host ? this.conn(room.host) : room.seats.get(1);
        const mod = modTail(room.entry.slice(ENTRY_HEX));
        return {
            game: (host && host.game) || guessGame(info.episode), name: info.name, episode: info.episode,
            locked: info.locked || !!room.pw, mod: mod.name, modFp: mod.fp, pack: mod.pack, maxRank: info.maxRank,
        };
    }

    watchers() {
        return [...this.conns.entries()].filter(([, c]) => c.watch).map(([ws]) => ws);
    }

    // After anything that can change the counts: tells the watching pages,
    // unless they already have this status.
    statusChanged() {
        this.feeds();
        this.watchersTell();
        const watchers = this.watchers();
        if (!watchers.length) {
            this.lastStatus = null;
            return;
        }
        const status = this.status();
        if (status === this.lastStatus)
            return;
        this.lastStatus = status;
        const line = this.statusLine(status);
        for (const w of watchers)
            this.send(w, line);
    }

    watch(ws) {
        const status = this.status();
        const line = this.statusLine(status);
        if (status === this.lastStatus) {
            this.send(ws, line);
            return;
        }
        // A new status here means the lobby just woke up or this is the first
        // page watching: any others may not have it either.
        this.lastStatus = status;
        for (const w of this.watchers())
            this.send(w, line);
    }

    // look <game> [<name>]: this page's player has that game's room open,
    // look for none. The page hears looking once the status it was just
    // sent counts it that way: after statusChanged, which sends it any
    // change (and the page has it already when nothing changed).
    look(ws, c, game, name) {
        name = game && name ? name : null;
        if ((c.look || "") !== game || (c.lookName || null) !== name) {
            this.saveConn(ws, { ...c, look: game, lookName: name });
            this.statusChanged();
        }
        this.send(ws, game ? "looking " + game + (name ? " " + base64Utf8(name) : "") : "looking off");
    }

    // spectate <room>: the match this page watches, 0 for none. A room
    // that isn't there, or ended, is none. Watching takes no seat: the page
    // is only counted, in the room's watching.
    spectate(ws, c, roomId) {
        const id = this.rooms.has(roomId) || this.impById(roomId) ? roomId : 0;
        if ((c.spect || 0) === id)
            return;
        this.saveConn(ws, { ...c, spect: id });
        this.statusChanged();
    }

    // kills <room>: the kills that count of the room's match (src/ladder.js,
    // liveKills), for a page watching it to look back through: "kills <room>
    // <base64 JSON>", {n, kills}, how many in all and the latest 500 of them,
    // the oldest first; none for no match or a password. The status has the
    // latest few as they come (live's kills, and nk). At most one a second
    // for each page (KILLS_MS).
    kills(ws, roomId) {
        const now = Date.now();
        if (now - (this.killsAsked.get(ws) || 0) < KILLS_MS)
            return;
        this.killsAsked.set(ws, now);
        const room = this.rooms.get(roomId);
        const info = room && readEntry(room.entry);
        const kills = info && this.ladder.on() ? this.ladder.liveKills(room.id, info.map, info.locked || !!room.pw, now) : null;
        this.send(ws, `kills ${roomId} ${base64Utf8(JSON.stringify(kills || { n: 0, kills: [] }))}`);
    }

    // spectators on|off [<delay s>], from a room's host's game: whether its
    // match may be watched, and how far behind live, at least
    // SPECT_MIN_DELAY_S.
    spectators(ws, c, on, delay) {
        const room = this.rooms.get(c.room);
        if (!room || room.host !== ws)
            return;
        const spect = { on, delay: Math.min(SPECT_MAX_DELAY_S, Math.max(SPECT_MIN_DELAY_S, delay || SPECT_DELAY_S)) };
        if (room.spect && room.spect.on === spect.on && room.spect.delay === spect.delay)
            return;
        room.spect = spect;
        this.ctx.storage.put("spect:" + room.id, spect);
        this.statusChanged();
    }

    // Whether a room's match can be watched: as its host's game said, else
    // unless it has a password (locked).
    spectOn(room, locked) {
        return room.spect ? !!room.spect.on : !locked;
    }

    // The games in a room that take part in its feed (they said feed), by
    // player id: [[id, ws]].
    feedGames(room) {
        const out = [];
        if (room.host && this.conn(room.host).feed)
            out.push([1, room.host]);
        for (const [id, ws] of room.peers) {
            if (this.conn(ws).feed)
                out.push([id, ws]);
        }
        return out;
    }

    // Puts every room's feed as it should be.
    feeds() {
        if (!this.env.FEED)
            return;
        const now = Date.now();
        for (const room of this.rooms.values())
            this.feedCheck(room, now);
    }

    // Whether a watchable match's feed is on whether or not a page watches:
    // yes, unless FEED_ONLY_WATCHED is "1".
    feedAlways() {
        return String(this.env.FEED_ONLY_WATCHED || "") !== "1";
    }

    // Starts, changes or ends a room's feed, as its watchable state, its
    // pages and its games now are: a token for each game taking part, told
    // to it once the feed has it (feedTell).
    feedCheck(room, now = Date.now()) {
        if (!this.env.FEED || !room)
            return;
        const info = readEntry(room.entry);
        const on = !!info && this.spectOn(room, info.locked || !!room.pw);
        // A game watching from inside the game watches too.
        let watched = !!(room.feed && room.feed.pages);
        for (const c of this.conns.values()) {
            if (c.watch && c.spect === room.id)
                watched = true;
        }
        const always = this.feedAlways();
        // idle 0: watched until now, so it starts to linger.
        const lingering = room.feed && (!room.feed.idle || now - room.feed.idle < FEED_LINGER_MS);
        if (!on || !(always || watched || lingering)) {
            if (room.feed)
                this.feedEnd(room, on ? "nobody watching" : "watching off");
            return;
        }
        if (!room.feed)
            room.feed = { tokens: {}, idle: 0, armed: "", pages: 0, names: [], told: {}, ok: "" };
        const idle = always || watched ? 0 : room.feed.idle || now;
        const tokens = {};
        for (const [id] of this.feedGames(room))
            tokens[id] = room.feed.tokens[id] || newKey();
        const delay = room.spect ? room.spect.delay : SPECT_DELAY_S;
        const armed = JSON.stringify([delay, tokens]);
        if (idle !== room.feed.idle) {
            room.feed.idle = idle;
            this.ctx.storage.put("feed:" + room.id, { tokens: room.feed.tokens, idle, pages: room.feed.pages || 0, names: room.feed.names || [] });
        }
        if (armed === room.feed.armed) {
            if (room.feed.ok === armed)
                this.feedTell(room);
            return;
        }
        room.feed.tokens = tokens;
        room.feed.armed = armed;
        this.ctx.storage.put("feed:" + room.id, { tokens, idle, pages: room.feed.pages || 0, names: room.feed.names || [] });
        const byToken = Object.fromEntries(Object.entries(tokens).map(([id, t]) => [t, Number(id)]));
        const feed = room.feed;
        this.feedCall(room, stub => stub.arm(room.id, delay, byToken)).then(ok => {
            if (room.feed !== feed || feed.armed !== armed)
                return;
            if (!ok) {
                // Asked again the next time anything changes, and its new
                // games are told then.
                feed.armed = "";
                return;
            }
            feed.ok = armed;
            this.feedTell(room);
            // A feed armed again may have ended itself and forgotten who
            // watches: it's told again (the same line changes nothing).
            feed.watchLine = "";
            this.watchersTell();
        });
    }

    // Tells each game taking part in a room's feed its token, once the feed
    // has it: a game not told it yet (new, or the feed didn't answer then),
    // or one that asked again (it lost its feed). Telling a game the token it
    // sends with changes nothing for it.
    feedTell(room) {
        const feed = room.feed;
        for (const [id, ws] of this.feedGames(room)) {
            const t = feed.tokens[id];
            if (t && feed.told[id] !== t) {
                feed.told[id] = t;
                this.send(ws, `feed ${room.id} ${t}`);
            }
        }
    }

    // From a room's feed (src/feed.js), over RPC: how many games watch its
    // match from inside the game now, and the names of the games watching
    // (those in viewing pages' boxes too). They're counted in its watching,
    // and keep a feed that's only on while watched (FEED_ONLY_WATCHED) on.
    async feedPages(roomId, n, names) {
        const clean = watchNames(names);
        const imp = this.impById(Number(roomId));
        if (imp && Number.isInteger(n) && n >= 0) {
            n = Math.min(n, MAX_FEED_PAGES);
            if ((imp.pages || 0) !== n || (imp.names || []).join("\t") !== clean.join("\t")) {
                imp.pages = n;
                imp.names = clean;
                this.impSave(imp);
                this.statusChanged();
            }
            return true;
        }
        const room = this.rooms.get(Number(roomId));
        if (!room || !room.feed || !Number.isInteger(n) || n < 0)
            return false;
        n = Math.min(n, MAX_FEED_PAGES);
        if ((room.feed.pages || 0) === n && (room.feed.names || []).join("\t") === clean.join("\t"))
            return true;
        room.feed.pages = n;
        room.feed.names = clean;
        this.ctx.storage.put("feed:" + room.id, { tokens: room.feed.tokens, idle: room.feed.idle || 0, pages: n, names: clean });
        this.statusChanged();
        return true;
    }

    // Who watches each match, as the pages watching the lobby are told it
    // (status): how many (the pages watching it here, and the games watching
    // it from inside the game, as its feed says), and the names of those
    // watching from a game (its feed's; a page watching only its scores has
    // none). Its games are told too, and the games watching it through its
    // feed: "watching <n>", and after a space the names, tab-separated
    // (Antonio, 2026-11-24: players and those watching see who watches). A
    // game is told when it changes, and once when it's new to the room.
    spectPages() {
        const pages = new Map();
        for (const c of this.conns.values()) {
            if (c.watch && c.spect)
                pages.set(c.spect, (pages.get(c.spect) || 0) + 1);
        }
        return pages;
    }

    // A player's name as the lists show it (the status, who's watching): ""
    // for a web address however it's written (src/chat.js linkish), so a
    // name can't put one in front of everyone.
    shownName(name) {
        if (!name)
            return name;
        let bad = this.linkNames.get(name);
        if (bad === undefined) {
            bad = linkish(name);
            if (this.linkNames.size >= 4096)
                this.linkNames.clear();
            this.linkNames.set(name, bad);
        }
        return bad ? "" : name;
    }

    roomWatchers(room, pages, spect) {
        const names = (spect && room.feed ? room.feed.names || [] : []).filter(x => this.shownName(x));
        const n = spect ? Math.max((pages.get(room.id) || 0) + ((room.feed && room.feed.pages) || 0), names.length) : 0;
        return { n, names };
    }

    impWatchers(f, pages) {
        const names = (f.names || []).filter(x => this.shownName(x));
        return { n: Math.max((pages.get(f.id) || 0) + (f.pages || 0), names.length), names };
    }

    watchersTell() {
        const pages = this.spectPages();
        for (const room of this.rooms.values()) {
            const info = readEntry(room.entry);
            const spect = !!info && this.spectOn(room, info.locked || !!room.pw);
            const { n, names } = this.roomWatchers(room, pages, spect);
            const line = "watching " + n + (names.length ? " " + names.join("\t") : "");
            if (!room.watchTold)
                room.watchTold = new Map();
            for (const [id, ws] of this.feedGames(room)) {
                const was = room.watchTold.get(id);
                if (was ? was.ws === ws && was.line === line : !n)
                    continue;
                room.watchTold.set(id, { ws, line });
                this.send(ws, line);
            }
            const feed = room.feed;
            if (this.env.FEED && feed && feed.ok && feed.watchLine !== line) {
                feed.watchLine = line;
                this.feedCall(room, stub => stub.watching(n, names)).then(ok => {
                    if (!ok && room.feed === feed && feed.watchLine === line)
                        feed.watchLine = "";
                });
            }
        }
        if (!this.env.FEED)
            return;
        for (const f of this.imperial.values()) {
            const { n, names } = this.impWatchers(f, pages);
            const line = "watching " + n + (names.length ? " " + names.join("\t") : "");
            if (this.impWatchTold.get(f.sid) === line)
                continue;
            this.impWatchTold.set(f.sid, line);
            const stub = this.env.FEED.get(this.env.FEED.idFromName("room:" + f.id));
            f.chain = (f.chain || Promise.resolve()).then(() => stub.watching(n, names)).catch(e => {
                if (this.impWatchTold.get(f.sid) === line)
                    this.impWatchTold.delete(f.sid);
                console.log(`relay: imperial ${f.name}: its feed didn't hear who watches: ${e && e.message || e}`);
            });
        }
    }

    feedEnd(room, why) {
        const feed = room.feed;
        room.feed = null;
        this.ctx.storage.delete("feed:" + room.id);
        for (const [id, ws] of this.feedGames(room)) {
            if (feed.tokens[id])
                this.send(ws, "feed off");
        }
        this.feedCall(room, stub => stub.end(why));
    }

    // Calls a room's feed, after its calls before: true once it answered.
    feedCall(room, fn) {
        const stub = this.env.FEED.get(this.env.FEED.idFromName("room:" + room.id));
        const next = (room.feedChain || Promise.resolve()).then(() => fn(stub)).then(() => true, e => {
            console.log(`relay: room ${room.id}: its feed didn't answer: ${e && e.message || e}`);
            return false;
        });
        room.feedChain = next;
        return next;
    }

    // The netcode a room's games speak: its host's, also while the host's
    // seat is held.
    roomNet(room) {
        const host = room.host ? this.conn(room.host) : room.seats.get(1);
        return (host && host.net) || 0;
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
    // held for its player to take back (takeSeat). lost: when its player
    // was last here, for a match its host never came back to (endRoom).
    drop(ws, lost = Date.now()) {
        const c = this.conn(ws);
        const room = this.rooms.get(c.room);
        const seat = room && room.seats.get(c.id);
        if (!seat || ws !== (c.id === 1 ? room.host : room.peers.get(c.id))) {
            this.leave(ws);
            return;
        }
        Object.assign(seat, { until: Date.now() + this.holdMs, lost, name: c.name || null, game: c.game || "", net: c.net || 0 });
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
    // rehost may bring the room's entry, in case it changed meanwhile; one
    // with a password takes the seat once its verifier is made, so the room
    // is never open to anyone meanwhile.
    takeSeat(ws, roomId, id, key, entry) {
        const room = this.rooms.get(roomId);
        const seat = room && room.seats.get(id);
        if (!seat || seat.key !== key || (id === 1) !== (entry !== null)) {
            this.send(ws, "error no-seat");
            return;
        }
        if (!entry || !entryPassword(entry)) {
            this.seatTaken(ws, room, id, seat, entry, null);
            return;
        }
        const seq = this.opSeq.get(ws);
        return this.verifierFor(room.pw, entry, this.conn(ws)).then(pw => {
            if (this.opSeq.get(ws) !== seq || !this.conns.has(ws))
                return;
            if (this.rooms.get(roomId) !== room || room.seats.get(id) !== seat) {
                this.send(ws, "error no-seat");
                return;
            }
            this.seatTaken(ws, room, id, seat, entry, pw);
        });
    }

    seatTaken(ws, room, id, seat, entry, pw) {
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
        delete seat.lost;
        delete seat.name;
        delete seat.game;
        delete seat.net;
        if (id === 1)
            room.host = ws;
        else
            room.peers.set(id, ws);
        this.setConn(ws, room.id, id);
        // Once the host's socket is in the room, so the status setEntry may
        // send doesn't count it in the lobby too.
        if (entry) {
            room.entrySeq++;
            this.setEntry(room, entry, pw);
        }
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

    // From the Worker (/imperial-feed, src/imperial-feed.js), over RPC: a
    // dedicated server on the Imperial relay asks for its match's feed, or
    // ends it. server: {sid, game, name}, as IMPERIAL_FEED_KEYS names it;
    // ask: {episode, map, delay, files, say} or {end: true, off}. Answers
    // {room, token, delay}, {ended: true}, or null when its feed didn't
    // answer. An end plays the pages watching the match's last seconds
    // first, as a room's end does; with off (watching turned off), not.
    async imperialFeed(server, ask) {
        if (!this.env.FEED || !server || !server.sid)
            return null;
        let f = this.imperial.get(server.sid);
        if (ask.end) {
            if (f)
                this.impEnd(f, ask.off ? "watching off" : "room ended");
            return { ended: true };
        }
        const delay = Math.min(SPECT_MAX_DELAY_S, Math.max(SPECT_MIN_DELAY_S, ask.delay || SPECT_DELAY_S));
        if (!f) {
            f = { sid: server.sid, id: this.nextRoom++, token: newKey(), pages: 0, chain: null };
            this.ctx.storage.put("nextRoom", this.nextRoom);
            console.log(`relay: imperial ${server.name}: its feed is room ${f.id}`);
        }
        Object.assign(f, { game: server.game, name: server.name, episode: ask.episode || "", map: ask.map || "", delay });
        this.imperial.set(f.sid, f);
        this.impSave(f);
        // Armed every time it asks: a feed that ended itself (nothing sent
        // for a while) starts again, with the same token. files and say:
        // whether the server takes mod <fp> and say lines (src/feed.js).
        const stub = this.env.FEED.get(this.env.FEED.idFromName("room:" + f.id));
        const opts = { wide: true, files: !!ask.files, say: !!ask.say };
        const next = (f.chain || Promise.resolve()).then(() => stub.arm(f.id, delay, { [f.token]: 1 }, opts))
                                                    .then(() => true, e => {
            console.log(`relay: imperial ${server.name}: its feed didn't answer: ${e && e.message || e}`);
            return false;
        });
        f.chain = next;
        const ok = await next;
        this.statusChanged();
        return ok && this.imperial.get(f.sid) === f ? { room: f.id, token: f.token, delay } : null;
    }

    // From a feed (src/feed.js), over RPC: it ended by itself (nothing came
    // for a while). An Imperial server's is no longer listed; a lobby room's
    // games ask again by themselves.
    async feedEnded(roomId) {
        const f = this.impById(Number(roomId));
        if (f) {
            this.impForget(f);
            this.statusChanged();
        }
        return true;
    }

    impById(id) {
        for (const f of this.imperial.values()) {
            if (f.id === id)
                return f;
        }
        return null;
    }

    impSave(f) {
        const { chain, ...kept } = f;
        this.ctx.storage.put("imp:" + f.sid, kept);
    }

    impForget(f) {
        if (this.imperial.get(f.sid) === f) {
            this.imperial.delete(f.sid);
            this.impWatchTold.delete(f.sid);
        }
        this.ctx.storage.delete("imp:" + f.sid);
    }

    impEnd(f, why) {
        this.impForget(f);
        const stub = this.env.FEED.get(this.env.FEED.idFromName("room:" + f.id));
        f.chain = (f.chain || Promise.resolve()).then(() => stub.end(why)).catch(e => {
            console.log(`relay: imperial ${f.name}: its feed didn't hear it ended: ${e && e.message || e}`);
        });
        this.statusChanged();
    }

    // Ends a room: its players are told the host left. A host whose seat
    // was held to the end was gone before this: its match was over when it
    // was last here.
    endRoom(room) {
        if (room.feed)
            this.feedEnd(room, "room ended");
        this.rooms.delete(room.id);
        this.pwTries.delete(room.id);
        const host = room.seats.get(1);
        this.ladder.roomEnded(room, host && host.until && host.lost ? host.lost : 0);
        this.ctx.storage.delete(["room:" + room.id, "seats:" + room.id, "pw:" + room.id, "spect:" + room.id, "feed:" + room.id]);
        for (const peer of room.peers.values()) {
            this.setConn(peer, 0, 0);
            this.send(peer, "host-left");
        }
    }
}
