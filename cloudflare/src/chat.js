// The room chat (Antonio, 2026-11-28): each of the site's three room windows
// (Nar Shaddaa, Sith: Asteroid and the Free Demo Room) has a chat along its
// bottom, as the Zone's game rooms had: "(Enter)> name", "(Exit)> name" and
// "name> text" lines. On only where the CHAT var is "1" (beta, for now): the
// lobby then says chat on connect, and a page watching it may use these
// lines, the room by its key, a name and a text in base64 UTF-8:
//
//   chat in <room> <browser id> [<name>]   comes into a room's chat (again
//                                          with a new name, or another room)
//   chat out                               leaves it
//   chat say <text>                        says a line to the room
//   chat report <line id>                  reports someone's line
//   chat mod <key>                         a moderator's key (CHAT_MOD_KEY)
//
// and a moderator's page, once its key is taken:
//
//   chat mute <secs> <line id>|r<report id>|n<name>   3600, 86400 or 604800
//   chat unmute <mute id>
//   chat del <line id>          the line goes, for everyone
//   chat clear                  the room's lines all go
//   chat slow on|off            everyone one line per SLOW_MS
//   chat pause on|off           only moderators talk
//   chat dismiss <report id>
//
// The page hears, each JSON in base64 UTF-8:
//
//   chat log <{room, lines, slow, paused, who, you: {name, muted, mod}}>
//   chat line <{id, at, name, text, mod} or {id, at, kind, name|text}>
//   chat del <id>, chat clear, chat state <{slow, paused}>
//   chat who <{names, n}>        who's in the room's chat: names, and all
//   chat you <{name, muted, mod}>
//   chat ok                      its line went out
//   chat no <why> [<n>]          it didn't: link, fast (n s), same, muted (n:
//                                until when, ms), paused, name, taken, long,
//                                empty, room; mod for a key it didn't take
//   chat reported <line id>
//   chat mods <{mutes, reports}> a moderator's lists, whenever they change
//
// Antonio's rules: nothing older than KEEP_MS (48 hours) and at most
// KEEP_LINES a room is kept, in the lobby's own storage; no web address in
// any form (linkish); no spamming (BURST, then one every REFILL_MS, the same
// line not twice in SAME_MS, Enter and Exit at most every SHOW_AGAIN_MS);
// 400 characters on at most two lines; no other filter. Limits count by the
// browser's address, so another tab or browser on it doesn't get more. A
// mute covers the name, the browser and the address its line came from, in
// all three rooms. Addresses are only kept as a salted hash.

import { TLDS, TLDS_IDN } from "./chat-tlds.js";

export const CHAT_ROOMS = ["nar-shaddaa", "sith-asteroid", "bespin-demo"];
export const KEEP_LINES = 100;
export const KEEP_MS = 48 * 60 * 60 * 1000;
export const MAX_TEXT = 400;
const MAX_TEXT_B64 = 4 * 1024;
const MAX_NAME = 15;
const MAX_NAME_B64 = 128;
// Up to BURST lines at once, then one more every REFILL_MS.
export const BURST = 4;
export const REFILL_MS = 3000;
// Slow mode: one line every SLOW_MS.
export const SLOW_MS = 15 * 1000;
// The same text again within SAME_MS isn't sent.
export const SAME_MS = 60 * 1000;
// Lines turned down for coming too fast, FLOOD_REFUSED of them in
// FLOOD_WINDOW_MS, keep the address quiet for COOL_MS[0], or COOL_MS[1] when
// it happened before in the last COOL_AGAIN_MS.
export const FLOOD_REFUSED = 8;
const FLOOD_WINDOW_MS = 60 * 1000;
export const COOL_MS = [2 * 60 * 1000, 10 * 60 * 1000];
const COOL_AGAIN_MS = 60 * 60 * 1000;
// A name's Enter (and its Exit) shows at most once every SHOW_AGAIN_MS, and
// an Exit waits EXIT_WAIT_MS, so a page reloading shows neither.
export const SHOW_AGAIN_MS = 2 * 60 * 1000;
export const EXIT_WAIT_MS = 10 * 1000;
// REPORTS_TO_MUTE people (by address) reporting the same name in REPORTS_MS
// mute it for REPORT_MUTE_S, until a moderator looks.
export const REPORTS_TO_MUTE = 3;
const REPORTS_MS = 15 * 60 * 1000;
export const REPORT_MUTE_S = 3600;
const MUTE_SECS = [3600, 86400, 604800];
// Wrong moderator keys from one address: MOD_TRIES in MOD_TRIES_MS.
const MOD_TRIES = 5;
const MOD_TRIES_MS = 10 * 60 * 1000;
const BID_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const LINE_ID_RE = /^[0-9]{1,16}$/;
// Control and invisible characters (bidi overrides among them), as the lobby's
// HIDDEN_RE, and line breaks, which are taken apart first.
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function fromB64(b64, max) {
    if (!b64 || b64.length > max || !B64_RE.test(b64))
        return null;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)));
    } catch (e) {
        return null;
    }
}

function toB64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

// A name as the chat shows it: as the lobby cleans hello's.
export function chatName(text) {
    if (typeof text !== "string")
        return "";
    return Array.from(text.normalize("NFC").replace(HIDDEN_RE, "").replace(/\s+/g, " ").trim())
        .slice(0, MAX_NAME).join("").trim();
}

// A line's text as it goes out: at most two lines, runs of spaces as one,
// no invisible characters, and at most two accents stacked on a letter (so
// a line can't spill over the others). "" for nothing left.
export function chatText(text) {
    if (typeof text !== "string")
        return "";
    const lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n")
        .map(l => l.replace(HIDDEN_RE, "").replace(/[ \t\u00a0\u3000]+/g, " ").trim())
        .filter(Boolean);
    const two = lines.length > 2 ? [lines[0], lines.slice(1).join(" ")] : lines;
    return two.join("\n").normalize("NFD").replace(/(\p{M}{2})\p{M}+/gu, "$1").normalize("NFC");
}

// Letters that look like Latin ones, as Latin.
const LOOKALIKE = {
    "а": "a", "в": "b", "е": "e", "ё": "e", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "к": "k", "м": "m", "н": "h",
    "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ɡ": "g", "ӏ": "l", "ԛ": "q", "ԝ": "w",
    "ο": "o", "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
    "β": "b", "η": "n", "μ": "u", "ℓ": "l", "ı": "i", "ȷ": "j", "ʀ": "r", "ꜱ": "s", "ᴅ": "d", "ᴇ": "e", "ᴏ": "o",
};
const LOOKALIKE_RE = new RegExp("[" + Object.keys(LOOKALIKE).join("") + "]", "g");
// Dots and slashes that aren't, as those.
const DOTS_RE = /[\u3002\uff61\u2024\u2027\u2219\u00b7\u2022\u22c5\u30fb\ufe12\ufe52\u0701\u0702\u2e33\u2e3c\ua4f8\u06d4]/g;
const SLASHES_RE = /[\u2044\u2215\u29f8\uff0f\u2571\u27cb]/g;
// Digits written for letters in a domain's ending ("c0m").
const LEET = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
// Endings people write with a space after the dot ("site. com") to get past
// a filter, when the line goes on as an address would after it.
const SPACED_ENDINGS = "com|net|org|gg|io|tv|ly|xyz|ru|cc|biz|info";
// The endings a loose reading counts (see readings).
const COMMON_ENDINGS = new Set([...SPACED_ENDINGS.split("|"), "me", "co", "uk", "de", "us", "fr", "br", "pl", "eu",
    "ca", "au", "nl", "es", "su", "ws", "gl", "link", "site", "online", "live", "app", "dev", "shop", "store", "club",
    "fun", "top", "zone", "pro", "win", "click", "rf", "\u0440\u0444"]);

// The ways a line is read for an address: as typed (lowercased, without
// accents, with every kind of dot and slash as one), with lookalike letters as
// Latin, with letters spaced out joined ("g o o g l e") and bracketed dots as
// dots. Then, loosely, the word "dot" as a dot and spaces before a dot taken
// out: ordinary talk reads that way too ("the red dot in the corner", "no dot
// here"), so those count only for the endings links use most, or with a path.
function readings(text) {
    const base = text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "")
        .replace(DOTS_RE, ".").replace(SLASHES_RE, "/").replace(/\s+/g, " ");
    const latin = base.replace(LOOKALIKE_RE, ch => LOOKALIKE[ch]);
    const strict = [base, latin];
    const loose = [];
    for (const t of [base, latin]) {
        const joined = joinSpaced(t);
        const brackets = joined.replace(/\s*[(\[{<]\s*(?:dot|d0t|\.)\s*[)\]}>]\s*/g, ".");
        strict.push(joined, brackets);
        const words = brackets.replace(/(\S)\s+(?:dot|d0t)\s+(?=\S)/g, "$1.");
        loose.push(words, words.replace(/\s+\.\s*/g, "."), brackets.replace(/\s+\.\s*/g, "."));
    }
    const s = new Set(strict);
    return [...[...s].map(t => [t, false]), ...[...new Set(loose)].filter(t => !s.has(t)).map(t => [t, true])];
}

// Runs of three or more single characters with spaces between, joined.
function joinSpaced(text) {
    const words = text.split(" ");
    const out = [];
    for (let i = 0; i < words.length;) {
        let j = i;
        while (j < words.length && [...words[j]].length === 1)
            j++;
        if (j - i >= 3) {
            out.push(words.slice(i, j).join(""));
            i = j;
        } else {
            out.push(words[i]);
            i++;
        }
    }
    return out.join(" ");
}

function isEnding(word) {
    if (TLDS.has(word) || TLDS_IDN.has(word))
        return true;
    // "c0m": with digits for letters, if there's a letter in it at all.
    if (/[0-9@$]/.test(word) && /\p{L}/u.test(word)) {
        const w = word.replace(/[0-9@$]/g, ch => LEET[ch] || ch);
        return TLDS.has(w);
    }
    return false;
}

const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
const DOMAIN_RE = new RegExp("(?:^|[^\\p{L}\\p{N}_@.-])(?:" + LABEL + "\\.)+([\\p{L}\\p{N}@$-]{2,63})(?![\\p{L}\\p{N}_-])", "gu");
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}]/u;
const SCHEME_RE = /(?:h\s*[t+]\s*[t+]\s*p\s*s?|hxxps?|ftp|file|data|javascript)\s*:\s*\/\s*\/|:\/\//;
const WWW_RE = /(?:^|[^\p{L}\p{N}])w\s*w\s*w\s*\.\s*[\p{L}\p{N}]/u;
const IP_RE = /(?:^|[^0-9.])[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![0-9])/;
const SPACED_RE = new RegExp("[\\p{L}\\p{N}-]{2,}\\.\\s+(?:" + SPACED_ENDINGS + ")(?=$|[/:?#.])", "u");
// "discord gg/abc", "bit ly/abc", "youtu be/abc": an ending with a space
// before it and a path after.
const SPACE_PATH_RE = /[\p{L}\p{N}-]{2,}\s+(?:com|net|org|gg|io|ly|be|co|tv)\s*\/\s*[\p{L}\p{N}]/u;
const INVITE_RE = /discord(?:app)?\s*(?:\.|\s)\s*(?:gg|com\s*\/\s*invite)\b|\bdsc\s*\.\s*gg\b/;

// Whether a line has a web address in it, however it's written.
export function linkish(text) {
    for (const [t, loose] of readings(text)) {
        if (SCHEME_RE.test(t) || WWW_RE.test(t) || IP_RE.test(t) || EMAIL_RE.test(t) || SPACED_RE.test(t) ||
            SPACE_PATH_RE.test(t) || INVITE_RE.test(t))
            return true;
        for (const m of t.matchAll(DOMAIN_RE)) {
            if (!isEnding(m[1]))
                continue;
            if (!loose || COMMON_ENDINGS.has(m[1].replace(/[0-9@$]/g, ch => LEET[ch] || ch)) ||
                /^\s*\/\s*[\p{L}\p{N}]/u.test(t.slice(m.index + m[0].length)))
                return true;
        }
    }
    return false;
}

async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function sameText(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
}

function newSalt() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// What one line looks like to a page: never who sent it beyond the name.
function shown(l) {
    const out = { id: l.id, at: l.at };
    if (l.kind)
        out.kind = l.kind;
    if (l.name)
        out.name = l.name;
    if (l.text)
        out.text = l.text;
    if (l.mod)
        out.mod = 1;
    return out;
}

export class Chat {
    constructor(lobby) {
        this.lobby = lobby;
        this.env = lobby.env;
        this.lines = new Map(CHAT_ROOMS.map(r => [r, []]));   // room -> lines, oldest first
        this.state = new Map(CHAT_ROOMS.map(r => [r, { slow: false, paused: false }]));
        this.mutes = new Map();     // id -> {id, n (lowercase name), name, b, h, until, by, at}
        this.reports = new Map();   // id -> {id, at, room, line: {id, name, text}, by, rh, an, ab, ah}
        this.lastId = 0;
        this.salt = "";
        // In memory only, so it starts over when the object is evicted:
        this.buckets = new Map();   // address -> {tokens, at, said: [{t, at}], refused: [at], cool, cooled}
        this.shownAt = new Map();   // "room\nname" -> {enter, exit}: when each last showed
        this.exits = new Map();     // "room\nname" -> timer of an Exit waiting
        this.modTries = new Map();  // address -> [at]
        this.exitWait = Number(this.env.CHAT_EXIT_WAIT_MS) || EXIT_WAIT_MS;   // shorter in tests
    }

    on() {
        return String(this.env.CHAT || "") === "1";
    }

    async restore() {
        if (!this.on())
            return;
        this.salt = await this.store().get("chat:salt");
        if (!this.salt) {
            this.salt = newSalt();
            this.store().put("chat:salt", this.salt);
        }
        const now = Date.now();
        for (const [key, l] of await this.store().list({ prefix: "chatl:" })) {
            const room = key.split(":")[1];
            if (!this.lines.has(room) || now - l.at >= KEEP_MS) {
                this.store().delete(key);
                continue;
            }
            this.lines.get(room).push(l);
            this.lastId = Math.max(this.lastId, l.id);
        }
        for (const lines of this.lines.values())
            lines.sort((a, b) => a.id - b.id);
        for (const [key, m] of await this.store().list({ prefix: "chatm:" })) {
            if (m.until <= now)
                this.store().delete(key);
            else
                this.mutes.set(m.id, m);
            this.lastId = Math.max(this.lastId, m.id);
        }
        for (const [key, r] of await this.store().list({ prefix: "chatr:" })) {
            if (now - r.at >= KEEP_MS)
                this.store().delete(key);
            else
                this.reports.set(r.id, r);
            this.lastId = Math.max(this.lastId, r.id);
        }
        for (const [key, s] of await this.store().list({ prefix: "chats:" })) {
            const room = key.slice(6);
            if (this.state.has(room))
                this.state.set(room, { slow: !!s.slow, paused: !!s.paused });
        }
        for (const room of CHAT_ROOMS)
            this.trim(room);
    }

    store() {
        return this.lobby.ctx.storage;
    }

    newId() {
        this.lastId = Math.max(this.lastId + 1, Date.now() * 1000);
        return this.lastId;
    }

    // The pages in a room's chat: [ws, c.chat].
    members(room) {
        const out = [];
        for (const [ws, c] of this.lobby.conns) {
            if (c.chat && c.chat.room === room)
                out.push([ws, c.chat]);
        }
        return out;
    }

    tell(room, line) {
        for (const [ws] of this.members(room))
            this.lobby.send(ws, line);
    }

    json(op, value) {
        return "chat " + op + " " + toB64(JSON.stringify(value));
    }

    // Who's in a room's chat, for the room's Players list (the demo room's,
    // which the lobby's status doesn't count).
    who(room) {
        const names = new Set();
        let n = 0;
        for (const [, m] of this.members(room)) {
            n++;
            if (m.name)
                names.add(m.name);
        }
        return { names: [...names].sort((a, b) => a.localeCompare(b)).slice(0, 64), n };
    }

    sayWho(room) {
        this.tell(room, this.json("who", this.who(room)));
    }

    muteOf(who, now = Date.now()) {
        let until = 0;
        for (const m of this.mutes.values()) {
            if (m.until > now && ((who.name && m.n === who.name.toLowerCase()) || (m.b && m.b === who.b) || (m.h && m.h === who.h)))
                until = Math.max(until, m.until);
        }
        return until;
    }

    you(m) {
        return { name: m.name || "", muted: m.mod ? 0 : this.muteOf(m), mod: m.mod ? 1 : 0 };
    }

    // A page's message about the chat, from a page watching the lobby.
    // Returns a promise when it has to wait (hashing its address, a key).
    op(ws, c, args) {
        const [what, ...rest] = args;
        if (!this.on())
            return;
        if (what === "in")
            return this.come(ws, c, rest);
        if (what === "mod" && rest.length === 1)
            return this.modKey(ws, c, rest[0]);
        const m = c.chat;
        if (what === "out") {
            this.left(ws);
            return;
        }
        if (!m)
            return;
        if (what === "say" && rest.length === 1)
            return this.say(ws, c, m, rest[0]);
        if (what === "report" && rest.length === 1 && LINE_ID_RE.test(rest[0]))
            return this.report(ws, m, Number(rest[0]));
        if (!m.mod)
            return;
        if (what === "mute" && rest.length === 2 && MUTE_SECS.includes(Number(rest[0])))
            return this.mute(ws, m, Number(rest[0]), rest[1]);
        if (what === "unmute" && rest.length === 1 && LINE_ID_RE.test(rest[0]))
            return this.unmute(Number(rest[0]));
        if (what === "del" && rest.length === 1 && LINE_ID_RE.test(rest[0]))
            return this.del(m.room, Number(rest[0]));
        if (what === "clear" && !rest.length)
            return this.clear(m.room);
        if ((what === "slow" || what === "pause") && rest.length === 1 && (rest[0] === "on" || rest[0] === "off"))
            return this.setState(m.room, what === "slow" ? "slow" : "paused", rest[0] === "on");
        if (what === "dismiss" && rest.length === 1 && LINE_ID_RE.test(rest[0])) {
            if (this.reports.delete(Number(rest[0]))) {
                this.store().delete("chatr:" + rest[0]);
                this.tellMods();
            }
        }
    }

    // chat in <room> <browser id> [<name>].
    async come(ws, c, args) {
        if (args.length < 2 || args.length > 3 || !CHAT_ROOMS.includes(args[0]) || !BID_RE.test(args[1])) {
            this.lobby.send(ws, "chat no room");
            return;
        }
        let name = args.length === 3 ? chatName(fromB64(args[2], MAX_NAME_B64)) : "";
        const room = args[0], b = args[1];
        const h = c.chat && c.chat.h ? c.chat.h : await this.addressHash(c.ip || b);
        // Someone else in the room has the name: in without one.
        let taken = false;
        if (name) {
            const lower = name.toLowerCase();
            taken = this.members(room).some(([w, x]) => w !== ws && x.name && x.name.toLowerCase() === lower && x.b !== b);
            if (taken)
                name = "";
        }
        const was = this.lobby.conn(ws).chat || null;
        const sameRoom = was && was.room === room;
        if (was && !sameRoom)
            this.left(ws);
        const m = { room, b, h, name, mod: !!(was && was.mod) };
        this.lobby.saveConn(ws, { ...this.lobby.conn(ws), chat: m });
        if (!sameRoom) {
            const lines = this.lines.get(room).map(shown);
            this.lobby.send(ws, this.json("log", { room, lines, ...this.state.get(room), who: this.who(room), you: this.you(m) }));
        } else {
            this.lobby.send(ws, this.json("you", this.you(m)));
        }
        if (taken)
            this.lobby.send(ws, "chat no taken");
        if (name && (!sameRoom || (was.name || "").toLowerCase() !== name.toLowerCase()))
            this.came(room, name);
        if (sameRoom && was.name && was.name.toLowerCase() !== (name || "").toLowerCase())
            this.went(room, was.name, ws);
        this.sayWho(room);
    }

    // The page left the chat (chat out, another room, closed or quiet).
    left(ws) {
        const c = this.lobby.conns.get(ws);
        const m = c && c.chat;
        if (!m)
            return;
        const rest = { ...c };
        delete rest.chat;
        this.lobby.saveConn(ws, rest);
        if (m.name)
            this.went(m.room, m.name, ws);
        this.sayWho(m.room);
    }

    // (Enter)> name, unless it's a page coming back before its Exit showed,
    // or it showed in the last SHOW_AGAIN_MS.
    came(room, name) {
        const key = room + "\n" + name.toLowerCase();
        const waiting = this.exits.get(key);
        if (waiting) {
            clearTimeout(waiting);
            this.exits.delete(key);
            return;
        }
        const s = this.shownAt.get(key) || { enter: 0, exit: 0 };
        const now = Date.now();
        if (now - s.enter < SHOW_AGAIN_MS)
            return;
        s.enter = now;
        this.shownAt.set(key, s);
        this.tell(room, this.json("line", { id: this.newId(), at: now, kind: "enter", name }));
    }

    // (Exit)> name, EXIT_WAIT_MS later, unless the name is still in the room
    // on another page, or comes back meanwhile.
    went(room, name, ws) {
        const lower = name.toLowerCase();
        if (this.members(room).some(([w, x]) => w !== ws && x.name && x.name.toLowerCase() === lower))
            return;
        const key = room + "\n" + lower;
        if (this.exits.has(key))
            return;
        this.exits.set(key, setTimeout(() => {
            this.exits.delete(key);
            if (this.members(room).some(([, x]) => x.name && x.name.toLowerCase() === lower))
                return;
            const s = this.shownAt.get(key) || { enter: 0, exit: 0 };
            const now = Date.now();
            if (now - s.exit < SHOW_AGAIN_MS)
                return;
            s.exit = now;
            this.shownAt.set(key, s);
            this.tell(room, this.json("line", { id: this.newId(), at: now, kind: "exit", name }));
        }, this.exitWait));
    }

    async addressHash(address) {
        return (await sha256Hex(this.salt + "\n" + address)).slice(0, 24);
    }

    bucket(h, now) {
        let b = this.buckets.get(h);
        if (!b) {
            b = { tokens: BURST, at: now, said: [], refused: [], cool: 0, cooled: 0, last: 0 };
            this.buckets.set(h, b);
        }
        b.tokens = Math.min(BURST, b.tokens + (now - b.at) / REFILL_MS);
        b.at = now;
        return b;
    }

    // chat say <text>: checked, kept and sent to everyone in the room.
    say(ws, c, m, b64) {
        const now = Date.now();
        const no = (why, n) => this.lobby.send(ws, "chat no " + why + (n !== undefined ? " " + n : ""));
        const raw = fromB64(b64, MAX_TEXT_B64);
        if (raw === null)
            return no("long");
        if (!m.name)
            return no("name");
        const text = chatText(raw);
        if (!text)
            return no("empty");
        if (text.length > MAX_TEXT)
            return no("long");
        const state = this.state.get(m.room);
        if (!m.mod) {
            const muted = this.muteOf(m, now);
            if (muted)
                return no("muted", muted);
            if (state.paused)
                return no("paused");
        }
        // Never a web address, from anyone.
        if (linkish(text))
            return no("link");
        if (!m.mod) {
            const b = this.bucket(m.h, now);
            if (b.cool > now)
                return no("fast", Math.ceil((b.cool - now) / 1000));
            const wait = state.slow ? Math.max(0, b.last + SLOW_MS - now) : b.tokens >= 1 ? 0 : (1 - b.tokens) * REFILL_MS;
            if (wait > 0) {
                b.refused = b.refused.filter(t => now - t < FLOOD_WINDOW_MS);
                b.refused.push(now);
                if (b.refused.length >= FLOOD_REFUSED) {
                    b.cool = now + COOL_MS[now - b.cooled < COOL_AGAIN_MS ? 1 : 0];
                    b.cooled = now;
                    b.refused = [];
                    return no("fast", Math.ceil((b.cool - now) / 1000));
                }
                return no("fast", Math.ceil(wait / 1000));
            }
            const same = text.toLowerCase().replace(/\s+/g, " ");
            b.said = b.said.filter(s => now - s.at < SAME_MS);
            if (b.said.some(s => s.t === same))
                return no("same");
            b.said.push({ t: same, at: now });
            b.tokens -= 1;
            b.last = now;
        }
        const line = { id: this.newId(), at: now, name: m.name, text, ...(m.mod ? { mod: 1 } : {}), b: m.b, h: m.h };
        this.keep(m.room, line);
        this.lobby.send(ws, "chat ok");
        this.tell(m.room, this.json("line", shown(line)));
    }

    // A line kept in its room, oldest ones going past KEEP_LINES.
    keep(room, line) {
        this.lines.get(room).push(line);
        this.store().put(`chatl:${room}:${line.id}`, line);
        this.trim(room);
    }

    trim(room, now = Date.now()) {
        const lines = this.lines.get(room);
        let drop = Math.max(0, lines.length - KEEP_LINES);
        while (drop < lines.length && now - lines[drop].at >= KEEP_MS)
            drop++;
        if (!drop)
            return;
        const gone = lines.splice(0, drop);
        this.store().delete(gone.map(l => `chatl:${room}:${l.id}`));
    }

    note(room, text) {
        const line = { id: this.newId(), at: Date.now(), kind: "note", text };
        this.keep(room, line);
        this.tell(room, this.json("line", shown(line)));
    }

    findLine(id) {
        for (const [room, lines] of this.lines) {
            const l = lines.find(x => x.id === id);
            if (l)
                return { room, l };
        }
        return null;
    }

    // chat report <line id>: once per address and line; REPORTS_TO_MUTE
    // addresses reporting a name in REPORTS_MS mute it for REPORT_MUTE_S.
    report(ws, m, id) {
        const found = this.findLine(id);
        if (!found || found.room !== m.room || !found.l.name || found.l.kind || found.l.mod || !m.name || found.l.h === m.h)
            return;
        const l = found.l, now = Date.now();
        if ([...this.reports.values()].some(r => r.line.id === id && r.rh === m.h)) {
            this.lobby.send(ws, "chat reported " + id);
            return;
        }
        const r = { id: this.newId(), at: now, room: m.room, line: { id, name: l.name, text: l.text }, by: m.name, rh: m.h,
                    an: l.name.toLowerCase(), ab: l.b, ah: l.h };
        this.reports.set(r.id, r);
        this.store().put("chatr:" + r.id, r);
        this.lobby.send(ws, "chat reported " + id);
        const by = new Set([...this.reports.values()]
            .filter(x => now - x.at < REPORTS_MS && (x.an === r.an || x.ah === r.ah)).map(x => x.rh));
        if (by.size >= REPORTS_TO_MUTE && !this.muteOf({ name: l.name, b: l.b, h: l.h }, now))
            this.addMute({ name: l.name, b: l.b, h: l.h }, REPORT_MUTE_S, "reports", m.room);
        this.tellMods();
    }

    addMute(who, secs, by, room) {
        const now = Date.now();
        const mute = { id: this.newId(), n: who.name.toLowerCase(), name: who.name, b: who.b || "", h: who.h || "",
                       until: now + secs * 1000, by, at: now };
        this.mutes.set(mute.id, mute);
        this.store().put("chatm:" + mute.id, mute);
        const span = secs === 3600 ? "1 hour" : secs === 86400 ? "24 hours" : secs === 604800 ? "7 days" : secs + " seconds";
        this.note(room, by === "reports" ? `${who.name} was muted for ${span} after reports from players.` :
                        `${who.name} was muted for ${span} by a moderator.`);
        this.tellYou();
        this.tellMods();
    }

    // chat mute <secs> <line id> | r<report id> | n<name>.
    mute(ws, m, secs, what) {
        let who = null;
        if (LINE_ID_RE.test(what)) {
            const found = this.findLine(Number(what));
            if (found && found.l.name && !found.l.kind)
                who = { name: found.l.name, b: found.l.b, h: found.l.h };
        } else if (what[0] === "r" && LINE_ID_RE.test(what.slice(1))) {
            const r = this.reports.get(Number(what.slice(1)));
            if (r)
                who = { name: r.line.name, b: r.ab, h: r.ah };
        } else if (what[0] === "n") {
            const name = chatName(fromB64(what.slice(1), MAX_NAME_B64));
            if (name) {
                const lower = name.toLowerCase();
                const there = this.members(m.room).find(([, x]) => x.name && x.name.toLowerCase() === lower);
                who = { name, b: there ? there[1].b : "", h: there ? there[1].h : "" };
            }
        }
        if (!who)
            return;
        // Never a moderator, by name or browser.
        if (this.members(m.room).some(([, x]) => x.mod && (x.b === who.b || (x.name || "").toLowerCase() === who.name.toLowerCase())))
            return;
        this.addMute(who, secs, "mod", m.room);
    }

    unmute(id) {
        if (!this.mutes.delete(id))
            return;
        this.store().delete("chatm:" + id);
        this.tellYou();
        this.tellMods();
    }

    del(room, id) {
        const lines = this.lines.get(room);
        const at = lines.findIndex(l => l.id === id);
        if (at < 0)
            return;
        lines.splice(at, 1);
        this.store().delete(`chatl:${room}:${id}`);
        this.tell(room, "chat del " + id);
    }

    clear(room) {
        const lines = this.lines.get(room);
        this.store().delete(lines.map(l => `chatl:${room}:${l.id}`));
        lines.length = 0;
        this.tell(room, "chat clear");
        this.note(room, "A moderator cleared the chat.");
    }

    setState(room, what, on) {
        const s = this.state.get(room);
        if (s[what] === on)
            return;
        s[what] = on;
        this.store().put("chats:" + room, s);
        this.tell(room, this.json("state", s));
        this.note(room, what === "slow" ? (on ? "A moderator turned on slow mode: one line every 15 seconds." : "Slow mode is off.") :
                                          (on ? "A moderator paused the chat." : "The chat is open again."));
    }

    // Everyone hears whether they're muted now.
    tellYou() {
        for (const [ws, c] of this.lobby.conns) {
            if (c.chat)
                this.lobby.send(ws, this.json("you", this.you(c.chat)));
        }
    }

    mods() {
        const now = Date.now();
        return {
            mutes: [...this.mutes.values()].filter(x => x.until > now).sort((a, b) => a.until - b.until)
                .map(x => ({ id: x.id, name: x.name, until: x.until, by: x.by })),
            reports: [...this.reports.values()].sort((a, b) => b.at - a.at)
                .map(r => ({ id: r.id, at: r.at, room: r.room, line: r.line.id, name: r.line.name, text: r.line.text, by: r.by })),
        };
    }

    tellMods() {
        const line = this.json("mods", this.mods());
        for (const [ws, c] of this.lobby.conns) {
            if (c.chat && c.chat.mod)
                this.lobby.send(ws, line);
        }
    }

    // chat mod <key>: the CHAT_MOD_KEY secret (or one of them, comma
    // separated). The page has to be in a room's chat first.
    async modKey(ws, c, b64) {
        const key = fromB64(b64, 512);
        const m = c.chat;
        const keys = String(this.env.CHAT_MOD_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
        if (!m || key === null || !keys.length) {
            this.lobby.send(ws, "chat no mod");
            return;
        }
        const now = Date.now();
        const tries = (this.modTries.get(m.h) || []).filter(t => now - t < MOD_TRIES_MS);
        if (tries.length >= MOD_TRIES) {
            this.lobby.send(ws, "chat no mod");
            return;
        }
        const given = await sha256Hex(key);
        let ok = false;
        for (const k of keys)
            ok = sameText(given, await sha256Hex(k)) || ok;
        if (!ok) {
            tries.push(now);
            this.modTries.set(m.h, tries);
            this.lobby.send(ws, "chat no mod");
            return;
        }
        const cur = this.lobby.conn(ws).chat;
        if (!cur)
            return;
        const mm = { ...cur, mod: true };
        this.lobby.saveConn(ws, { ...this.lobby.conn(ws), chat: mm });
        this.lobby.send(ws, this.json("you", this.you(mm)));
        this.lobby.send(ws, this.json("mods", this.mods()));
    }

    // With the lobby's sweep: lines past KEEP_MS, mutes that ran out and old
    // reports go.
    sweep() {
        if (!this.on())
            return;
        const now = Date.now();
        for (const room of CHAT_ROOMS)
            this.trim(room, now);
        let changed = false;
        for (const [id, x] of this.mutes) {
            if (x.until <= now) {
                this.mutes.delete(id);
                this.store().delete("chatm:" + id);
                changed = true;
            }
        }
        for (const [id, r] of this.reports) {
            if (now - r.at >= KEEP_MS) {
                this.reports.delete(id);
                this.store().delete("chatr:" + id);
                changed = true;
            }
        }
        for (const [h, b] of this.buckets) {
            if (now - b.at > COOL_AGAIN_MS && b.cool < now)
                this.buckets.delete(h);
        }
        if (changed) {
            this.tellYou();
            this.tellMods();
        }
    }
}
