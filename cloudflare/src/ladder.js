// The match record. Each game in a room tells the lobby what happens in its
// match, the lobby puts what they say together into one match, and keeps it
// in D1 (the LADDER binding, tables in SCHEMA below) with a page of its own
// (src/ladder-pages.js, which also gives a player's browser key). Without the
// binding none of this runs: the lobby doesn't say "match", so games send
// nothing, and the pages aren't there.
//
// The game has no server. Every game keeps score by itself: when a player
// dies, their own game tells the others who killed them (DSS_DEATH), and each
// game counts it. The host's game then sends its scoreboard to the others,
// which take it over their own, so two games' scoreboards agreeing says
// nothing. What the games do see separately is each kill as it's announced,
// so that's what they report, and a kill two games reported is one that was
// announced in the match, not made up afterwards by one of them. It can't
// say more than that: a changed game can announce what it likes, and two
// players can agree to feed each other kills.
//
// A game in a room, when the lobby said "lobby ... match", sends
//
//   match <base64 of UTF-8 JSON>
//
//   { v: 1,
//     lv: 3,                 which level of its session this is, from 1
//     map: "m2.jkl",         the level's file
//     title: "...",          the level's name as the game shows it
//     t: 61234,              ms this game has been in the level
//     pk: "<32 hex>",        its player's browser key (/ladder/key), if any
//     anon: 1,               its player asked not to be recorded by name
//     idle: 1,               its player isn't playing (a host that only serves)
//     build: "<commit>",     the engine's build
//     rules: { mode, sl, tl },   the host's: the game's multiplayer mode
//                            flags, score limit and time limit (minutes)
//     ev: [[n, ago, victim, killer, kind], ...],
//                            the kills it has seen since its last report: n
//                            counts them from 1 in this level, ago is ms
//                            since it saw this one, victim and killer are
//                            seat ids (killer 0 when nobody did it), kind is
//                            1 saber, 2 shot, 3 splash, 4 Force, 5 other, 0
//                            not known (only the victim's game knows)
//     sb: [[id, score, kills, deaths, suicides, team], ...],
//     teams: [5 scores],     the host's scoreboard as it stands
//     end: "level" | "left"  its level is over, or its player left }
//
// when its level starts, within a couple of seconds of a kill, every 30 s
// otherwise, and when the level ends or its player leaves. The lobby never
// answers one, right or wrong. A level's end that couldn't be sent (the
// lobby out of reach just then) comes when it can: from the host before
// anything of its next level, so it still closes its match as it ended, and
// from another game only until its own next level begins.
//
// A match is one level in a room. The host's game opens it (its first report
// with a new lv or map) and closes it: with end, by leaving, or by opening
// the next. The others' reports go to the room's open match when they name
// its map. The lobby knows who's in which seat, so a seat id in a report is
// the player who had that seat at the time, whoever takes it afterwards.
//
// The same kill from two games: same victim and killer, seen within WINDOW_MS
// of each other going by each game's ago, the nearest first. A player can't
// die twice that quickly. A kill counts when the victim's own game reported
// it, or two games did, or the victim's game reports nothing at all (an older
// build); a kill only a bystander reported while the victim's game was
// reporting doesn't, as that's what a tab that stopped for a while sends
// late. (A known limit: when the victim's game reports nothing, two
// bystanders that saw the kill more than WINDOW_MS apart make two of it.
// Every build since the record began reports, so it's left as it is.) The
// match keeps how many of its kills two games agreed on.
//
// A match is kept if two players or more were in it, it ran MIN_SECS or
// longer and someone died. It counts for standings (counted) when it also ran
// COUNT_SECS, two games or more reported, nine in ten of its kills were seen
// by two games, it had no password, and no two of its players had the same
// browser key (one person in two tabs). The standings (src/ladder-pages.js)
// add up the matches that count; the numbers it's worked out from are kept,
// so the rule can change.
//
// Most matches are played with a mod, which everyone in the room runs (a
// joiner's game is restarted into the host's, mods.js), so a match has one:
// its name and fingerprint from the host's entry are kept with the match, as
// are the Remastered pack, the level's file, title and episode, and the
// highest Force rank the host allowed. A mod's name is its folder's on the
// host's computer, so the same mod can come under several names, and the
// fingerprint changes with any file in it.
//
// When a match is saved, the games that reported it and are still connected
// hear
//
//   matched <id>
//
// for their page to link to it.
//
// A game in a room with a password is recorded like any other, but it's in no
// list, isn't posted to Discord and doesn't count.
//
// Who a player is: their browser's key, which the lobby gives out and the
// browser keeps in a cookie and in the page's storage. A browser that lost it
// (its cookies and site data cleared), another browser or another computer
// comes with a new key, and there are no accounts to say whose it is. So a
// key never seen before that plays under the name of exactly one record is
// taken for that record's player (saveRecord; LADDER_JOIN_NAMES = "0" turns
// it off). A name proves nothing: anyone can add matches to a record by
// playing under its name. What keeps that mendable is that every match row
// names the key it came from, so one key's matches can be taken off a record
// again by hand (README.md, "The match record").
//
// A player whose game sent no key (it reported nothing, or was loaded before
// its page had one) is in a match by name only. By the same rule their line
// counts for the one record that has that name (adoptKeyless), whichever came
// first, the line or the record. Such lines hang on a row of their own in
// players, the record's stand-in for them (key_hash "name:<record>"), so they
// too can be taken off the record again.

export const MAX_REPORT_B64 = 24 * 1024;
const MAX_EVENTS = 64;
const MAX_KILLS = 4000;
const MAX_PLAYERS = 64;
const MAX_AGO_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Two games' reports of one kill are at most this far apart.
const WINDOW_MS = 5000;
// How far back a new report looks for the kill it's about.
const SCAN = 256;
// After the host's game says its level is over, how long the others have to
// say so too.
const CLOSE_MS = 15 * 1000;
// A match nobody has reported on for this long is over.
const IDLE_MS = 5 * 60 * 1000;
const MIN_SECS = 60;
const COUNT_SECS = 120;
export const COUNT_AGREE = 0.9;
// A match's players are those in a kill, and those whose game reported being
// in its level for this long: not one who sat in the room without playing
// (still loading, gone before it began, or a host that only serves).
const BRIEF_SECS = 30;
const SAVE_TRIES = 5;
const SAVE_RETRY_MS = 60 * 1000;
// Reports from one connection: this many at once, then one a second.
const RATE_BURST = 20;
const RATE_MS = 1000;
// A new browser key isn't joined to a record by a name shorter than this, or
// by one of these: what the game offers a new player, and names many would
// pick.
const JOIN_NAME_MIN = 3;
const COMMON_NAMES = ["player", "player1", "player 1", "player2", "player 2", "new player", "noname", "no name", "unnamed",
                      "anonymous", "unknown", "unknown player", "guest", "test", "tester", "host", "kyle", "kyle katarn",
                      "katarn", "mara", "mara jade", "jedi", "sith", "jerec", "yun", "luke", "vader", "admin"];

// The lines without a key looked at in one go, the newest first.
const ADOPT_MAX = 200;
// What a record's stand-in for its lines without a key has for a key.
export const NAME_KEY = "name:";

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAP_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
export const KEY_COOKIE = "jkpk";
const BUILD_RE = /^[0-9a-f]{7,16}$/;
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const ENDS = ["level", "left"];
// The game's multiplayer mode flags (types_enums.h in the OpenJKDF2 fork).
export const MODE_TEAMS = 0x1;
export const MODE_COG_SCORES = 0x4;
export const KINDS = ["", "saber", "shot", "splash", "Force", "other"];
// The teams as the game's end-of-match screen names them (jkGUIMultiTally.c).
export const TEAMS = ["", "Red", "Gold", "Blue", "Green"];

// The record's tables in D1, made by the lobby itself the first time it
// saves a match or shows a page (ensureSchema): every statement only makes
// what isn't there yet. A column added here later needs an ALTER TABLE too.
//
// players: a row for each browser key, kept only as its SHA-256, with the
// name it last played under. A row without merged_into is a player's record;
// one with it is another key of the record it names (one level only: never a
// row that is itself merged), put there by saveRecord when a new key came
// under the record's name, or by hand. A row whose key_hash is "name:" and a
// record's id is no browser's: the record's lines from players whose game sent
// no key hang on it (adoptKeyless). The record's own row has the name the
// player last used under any of their keys. Setting merged_into back to NULL
// makes that key's matches a record of their own again. hidden, on a record,
// takes its name off the pages.
//
// matches: one row for each match. Times are ms since 1970. uid is made when
// the match ends, so one saved twice is one row. counted says whether it
// meets the rule for standings; what that's worked out from is here too, so
// the rule can change later. mod is the host's mod by its folder's name and
// mod_fp its fingerprint (the SHA-256 of its files, mods.js), both empty for
// none; pack says the MotS Remastered pack was on; max_rank is the highest
// Force rank the host allowed. detail is JSON: the kills in order, the host's
// scoreboard, and how well the games' reports agreed. hidden takes it off the
// pages.
//
// match_players: one row for each player in a match. slot is their number in
// the match's detail. player_id is the players row of the key their game
// sent, so whose match it is takes COALESCE(merged_into, id) of that row. For
// a player whose game sent no key it's the stand-in row of the one record
// that has their name, and empty when there's no such record (or more than
// one), as for one who asked not to be recorded, whose name is empty too.
//
// ladder_cache: the standings as last added up (ladder-pages.js), so a page
// reads a few rows instead of every match: D1 counts each row a query looks
// at, and stops answering for the day once an account has read its share.
// Nothing in it is kept anywhere else: emptying it only makes the next page
// add them up again.
//
// match_shots: one row for each screenshot on a match's page
// (src/ladder-shots.js), whose bytes are in the SHOTS bucket under
// m/<match_id>/<id>.jpg and .t.jpg. slot and player_id are its player's line
// in the match and the players row of the key that sent it. taken is the
// sender's own stamp of the picture, so one sent twice is one row; secs is
// how far into the match it was taken, going by what the sender said. final
// marks the game's own picture of the final scoreboard, one a match. hidden
// takes it off the page and stops it being served. Empty, and nothing reads
// it, in a lobby without the bucket.
export const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        merged_into INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY,
        uid TEXT NOT NULL UNIQUE,
        game TEXT NOT NULL,
        map TEXT NOT NULL,
        title TEXT NOT NULL,
        episode TEXT NOT NULL,
        room_name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        secs INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        score_limit INTEGER NOT NULL,
        time_limit INTEGER NOT NULL,
        max_rank INTEGER NOT NULL DEFAULT 0,
        players INTEGER NOT NULL,
        reporters INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        confirmed INTEGER NOT NULL,
        locked INTEGER NOT NULL,
        mod TEXT NOT NULL,
        mod_fp TEXT NOT NULL DEFAULT '',
        pack INTEGER NOT NULL DEFAULT 0,
        ended TEXT NOT NULL,
        counted INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS matches_game ON matches (game, id)`,
    `CREATE TABLE IF NOT EXISTS match_players (
        match_id INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        player_id INTEGER,
        name TEXT NOT NULL,
        team INTEGER NOT NULL,
        score INTEGER,
        kills INTEGER NOT NULL,
        deaths INTEGER NOT NULL,
        suicides INTEGER NOT NULL,
        streak INTEGER NOT NULL,
        secs INTEGER NOT NULL,
        place INTEGER NOT NULL,
        won INTEGER NOT NULL,
        host INTEGER NOT NULL,
        reported INTEGER NOT NULL,
        kinds TEXT NOT NULL,
        PRIMARY KEY (match_id, slot)
    )`,
    `CREATE INDEX IF NOT EXISTS match_players_player ON match_players (player_id, match_id)`,
    `CREATE INDEX IF NOT EXISTS players_merged ON players (merged_into)`,
    // Finding a record by its name reads a row or two instead of the table.
    `CREATE INDEX IF NOT EXISTS players_name ON players (name COLLATE NOCASE)`,
    `CREATE TABLE IF NOT EXISTS ladder_cache (
        key TEXT PRIMARY KEY,
        stamp TEXT NOT NULL,
        value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS match_shots (
        id TEXT PRIMARY KEY,
        match_id INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        taken INTEGER NOT NULL,
        secs INTEGER NOT NULL,
        final INTEGER NOT NULL DEFAULT 0,
        w INTEGER NOT NULL,
        h INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        thumb_bytes INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0
    )`,
    // A match's pictures, and one picture sent twice.
    `CREATE UNIQUE INDEX IF NOT EXISTS match_shots_once ON match_shots (match_id, player_id, taken)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS match_shots_final ON match_shots (match_id) WHERE final = 1`,
];

export function ensureSchema(db) {
    return db.batch(SCHEMA.map(sql => db.prepare(sql)));
}

function whole(v, max) {
    return Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

function int(v, min, max) {
    return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function cleanText(text, max) {
    return Array.from(text.replace(HIDDEN_RE, "").trim()).slice(0, max).join("").trim();
}

// A report as the lobby takes it, from match's base64: every field checked,
// anything else dropped. null if it isn't one.
export function cleanReport(b64) {
    if (typeof b64 !== "string" || b64.length > MAX_REPORT_B64 || !B64_RE.test(b64))
        return null;
    let r;
    try {
        const bin = atob(b64);
        r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, ch => ch.charCodeAt(0))));
    } catch (e) {
        return null;
    }
    if (!isObject(r) || r.v !== 1 || typeof r.map !== "string" || !MAP_RE.test(r.map))
        return null;
    const lv = whole(r.lv, 1e6), t = whole(r.t, DAY_MS);
    if (!lv || t === null)
        return null;
    const out = {
        lv, t,
        map: r.map.toLowerCase(),
        title: typeof r.title === "string" ? cleanText(r.title, 48) : "",
        pk: typeof r.pk === "string" && KEY_RE.test(r.pk) ? r.pk : "",
        anon: r.anon === 1,
        idle: r.idle === 1,
        build: typeof r.build === "string" && BUILD_RE.test(r.build) ? r.build : "",
        end: ENDS.includes(r.end) ? r.end : "",
        rules: null, ev: [], sb: null, teams: null,
    };
    if (isObject(r.rules)) {
        out.rules = { mode: whole(r.rules.mode, 0xffffff) ?? 0, sl: whole(r.rules.sl, 99999) ?? 0,
                      tl: whole(r.rules.tl, 99999) ?? 0 };
    }
    if (Array.isArray(r.ev)) {
        for (const e of r.ev.slice(0, MAX_EVENTS)) {
            if (!Array.isArray(e))
                continue;
            const n = whole(e[0], 1e6), ago = whole(e[1], DAY_MS), victim = whole(e[2], 64), killer = whole(e[3], 64);
            if (!n || ago === null || !victim || killer === null)
                continue;
            out.ev.push([n, Math.min(ago, MAX_AGO_MS), victim, killer, whole(e[4], 5) ?? 0]);
        }
        // In the order the game saw them.
        out.ev.sort((a, b) => a[0] - b[0]);
    }
    if (Array.isArray(r.sb)) {
        out.sb = [];
        for (const row of r.sb.slice(0, MAX_PLAYERS)) {
            if (!Array.isArray(row))
                continue;
            const id = whole(row[0], 64), score = int(row[1], -99999, 99999), kills = whole(row[2], 99999),
                  deaths = whole(row[3], 99999), suicides = whole(row[4], 99999);
            if (!id || score === null || kills === null || deaths === null || suicides === null)
                continue;
            out.sb.push([id, score, kills, deaths, suicides, whole(row[5], 4) ?? 0]);
        }
        if (Array.isArray(r.teams) && r.teams.length === 5 && r.teams.every(s => int(s, -99999, 99999) !== null))
            out.teams = r.teams.slice();
    }
    return out;
}

function toHex(bytes) {
    return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

// The player key in a request's cookie (/ladder/key sets it), or "".
export function cookieKey(request) {
    for (const part of (request.headers.get("Cookie") || "").split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq).trim() === KEY_COOKIE) {
            const value = part.slice(eq + 1).trim();
            return KEY_RE.test(value) ? value : "";
        }
    }
    return "";
}

// What D1 keeps of a browser key.
export async function hashKey(key) {
    const bytes = new TextEncoder().encode("jkdf2mp-ladder:" + key);
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function newPlayer(seat, key, now) {
    return { seat, key, name: "", pk: "", anon: false, idle: false, build: "", reports: 0, lv: 0, lastN: 0, t: 0, addr: -1,
             joined: now, seen: now, left: 0 };
}

// A finished match as D1 gets it: its row, its players' rows and its detail.
// null for one that isn't kept. why: how the lobby came to close it.
export function buildRecord(m, why, now) {
    const n = m.players.length;
    const stats = m.players.map(() => ({ kills: 0, deaths: 0, suicides: 0, streak: 0, run: 0,
                                         kinds: [0, 0, 0, 0, 0, 0], involved: false }));
    // The kills that count, in the order they happened.
    const kills = m.kills.filter(c => c.own || c.by.length >= 2 || !m.players[c.v].reports)
                         .sort((a, b) => a.ts - b.ts);
    let confirmed = 0, firstBlood = -1;
    for (const c of kills) {
        const victim = stats[c.v];
        victim.deaths++;
        victim.run = 0;
        victim.involved = true;
        if (c.by.length >= 2)
            confirmed++;
        if (c.k < 0 || c.k === c.v) {
            victim.suicides++;
            continue;
        }
        const killer = stats[c.k];
        killer.kills++;
        killer.kinds[c.kind]++;
        killer.involved = true;
        killer.streak = Math.max(killer.streak, ++killer.run);
        if (firstBlood < 0)
            firstBlood = c.k;
    }
    const host = m.players.findIndex(p => p.seat === 1);
    const secsOf = (p) => Math.round((p.reports ? p.t : Math.max(0, p.seen - p.joined)) / 1000);
    const secs = host >= 0 && m.players[host].reports ? secsOf(m.players[host])
                                                      : Math.round(Math.max(0, m.lastAt - m.startedAt) / 1000);
    // Who's kept, and their numbers in the detail.
    const slotOf = new Array(n).fill(-1);
    const kept = [];
    for (let i = 0; i < n; i++) {
        const p = m.players[i];
        if (stats[i].involved || (p.reports && !p.idle && secsOf(p) >= BRIEF_SECS)) {
            slotOf[i] = kept.length;
            kept.push(i);
        }
    }
    const reporters = kept.filter(i => m.players[i].reports).length;
    if (kept.length < 2 || secs < MIN_SECS || !kills.length)
        return null;

    const rules = m.rules || { mode: 0, sl: 0, tl: 0 };
    const teams = (rules.mode & MODE_TEAMS) !== 0;
    const cogScores = (rules.mode & MODE_COG_SCORES) !== 0;
    // How the host's scoreboard and the kills agree, for the players it has.
    let sbRows = 0, sbSame = 0;
    const rows = kept.map((i, slot) => {
        const p = m.players[i], s = stats[i], sb = m.rows[i] || null;
        if (sb) {
            sbRows++;
            if (sb[1] === s.kills && sb[2] === s.deaths && sb[3] === s.suicides)
                sbSame++;
        }
        return {
            slot, pk: p.anon ? "" : p.pk, name: p.anon ? "" : p.name, team: sb ? sb[4] : 0,
            // A level that keeps its own score (Capture the Flag): the
            // host's, or none.
            score: cogScores ? (sb ? sb[0] : null) : s.kills - s.suicides,
            kills: s.kills, deaths: s.deaths, suicides: s.suicides, streak: s.streak, secs: secsOf(p),
            place: 0, won: 0, host: p.seat === 1 ? 1 : 0, reported: p.reports ? 1 : 0, kinds: s.kinds.slice(1),
        };
    });
    // Places by score, the same score the same place. With teams, the team
    // with the most wins: the host's count, or its players' scores added up.
    const byScore = [...rows].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9));
    byScore.forEach((r, i) => {
        r.place = i && (byScore[i - 1].score ?? -1e9) === (r.score ?? -1e9) ? byScore[i - 1].place : i + 1;
    });
    let teamScores = null;
    if (teams) {
        teamScores = m.teams ? m.teams.slice() : [0, 0, 0, 0, 0];
        if (!m.teams)
            rows.forEach(r => { teamScores[r.team] += r.score ?? 0; });
        const used = new Set(rows.map(r => r.team));
        const best = Math.max(...[...used].map(t => teamScores[t]));
        const top = [...used].filter(t => teamScores[t] === best);
        rows.forEach(r => { r.won = top.length === 1 && r.team === top[0] ? 1 : 0; });
    } else {
        const top = rows.filter(r => r.place === 1);
        rows.forEach(r => { r.won = top.length === 1 && r.place === 1 ? 1 : 0; });
    }
    // Two of its players with one browser key are one person in two tabs.
    const keys = rows.map(r => r.pk).filter(Boolean);
    const sharedKey = new Set(keys).size < keys.length;
    const counted = secs >= COUNT_SECS && reporters >= 2 && !m.locked && !sharedKey &&
                    confirmed >= COUNT_AGREE * kills.length;
    const detail = {
        v: 1,
        // [seconds into the match, victim, killer (-1 nobody), kind, games that saw it]
        kills: kills.map(c => [Math.max(0, Math.round((c.ts - m.startedAt) / 1000)), slotOf[c.v],
                               c.k < 0 ? -1 : slotOf[c.k], c.kind, c.by.length]),
        firstBlood: firstBlood < 0 ? -1 : slotOf[firstBlood],
        teams: teamScores,
        // The host's scoreboard rows: [slot, score, kills, deaths, suicides, team]
        sb: kept.map((i, slot) => m.rows[i] ? [slot, ...m.rows[i]] : null).filter(Boolean),
        agree: { reported: m.kills.length, kept: kills.length, confirmed, sbRows, sbSame },
        // For a rule against feeding kills, should one be wanted: whether two
        // of its players had one browser key, and how many addresses its
        // players with a known one came from (not which).
        sharedKey,
        addresses: new Set(kept.map(i => m.players[i].addr).filter(a => a >= 0)).size,
        builds: [...new Set(kept.map(i => m.players[i].build).filter(Boolean))],
        why,
    };
    return {
        uid: crypto.randomUUID(),
        game: m.game, map: m.map, title: m.title || m.map, episode: m.episode, roomName: m.name,
        startedAt: m.startedAt, endedAt: now, secs,
        mode: rules.mode, scoreLimit: rules.sl, timeLimit: rules.tl,
        players: rows.length, reporters, kills: kills.length, confirmed,
        locked: m.locked ? 1 : 0, mod: m.mod || "", modFp: m.modFp || "", pack: m.pack ? 1 : 0,
        maxRank: m.maxRank || 0, ended: m.ended || why, counted: counted ? 1 : 0,
        detail, rows,
    };
}

// Whether a new key may be joined to a record by this name.
export function joinableName(name) {
    const n = name.trim().toLowerCase();
    return Array.from(n).length >= JOIN_NAME_MIN && !COMMON_NAMES.includes(n);
}

// Writes a match and returns its id. Safe to run again for the same match.
// joinNames: a key D1 has never had, under a name that is exactly one
// record's (whatever the letters' case), becomes another key of that record,
// unless the name is too common to say anything, two of the match's players
// have it, or the record's player is in the match under a key of their own.
// The lines without a key under the names in this match go to their records
// the same way (adoptKeyless).
export async function saveRecord(db, rec, opts = {}) {
    const match = await db.prepare(
        `INSERT INTO matches (uid, game, map, title, episode, room_name, started_at, ended_at, secs, mode, score_limit,
                              time_limit, max_rank, players, reporters, kills, confirmed, locked, mod, mod_fp, pack,
                              ended, counted, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (uid) DO UPDATE SET uid = excluded.uid
         RETURNING id`)
        .bind(rec.uid, rec.game, rec.map, rec.title, rec.episode, rec.roomName, rec.startedAt, rec.endedAt, rec.secs,
              rec.mode, rec.scoreLimit, rec.timeLimit, rec.maxRank, rec.players, rec.reporters, rec.kills,
              rec.confirmed, rec.locked, rec.mod, rec.modFp, rec.pack, rec.ended, rec.counted,
              JSON.stringify(rec.detail))
        .first();
    const id = match.id;
    const keyed = rec.rows.filter(r => r.pk);
    // The keys D1 has already: each one's own row, and the record it's a key of.
    const known = new Map();
    if (keyed.length) {
        const found = await db.batch(keyed.map(r => db.prepare(
            "SELECT id, COALESCE(merged_into, id) AS record FROM players WHERE key_hash = ?").bind(r.pk)));
        keyed.forEach((r, i) => {
            if (found[i].results[0])
                known.set(r.pk, found[i].results[0]);
        });
    }
    // The new ones that are a known player's by their name.
    const joins = new Map();
    if (opts.joinNames) {
        const lower = name => name.trim().toLowerCase();
        const names = rec.rows.map(r => lower(r.name));
        const fresh = keyed.filter((r, i) => !known.has(r.pk) && joinableName(r.name) &&
                                             names.filter(n => n === lower(r.name)).length === 1 &&
                                             keyed.findIndex(k => k.pk === r.pk) === i);
        if (fresh.length) {
            const found = await db.batch(fresh.map(r => db.prepare(
                `SELECT id FROM players WHERE name = ? COLLATE NOCASE AND merged_into IS NULL AND hidden = 0
                 LIMIT 2`).bind(r.name.trim())));
            const here = new Set([...known.values()].map(k => k.record));
            fresh.forEach((r, i) => {
                const records = found[i].results;
                if (records.length === 1 && !here.has(records[0].id)) {
                    joins.set(r.pk, records[0].id);
                    console.log(`ladder: match ${id}: a new browser joins record ${records[0].id} by its name`);
                }
            });
        }
    }
    const statements = [];
    const named = (record, r) => db.prepare("UPDATE players SET name = ?, last_at = ? WHERE id = ?")
        .bind(r.name, rec.endedAt, record);
    for (const r of keyed) {
        const k = known.get(r.pk);
        if (k) {
            statements.push(named(k.id, r));
            if (k.record !== k.id)
                statements.push(named(k.record, r));
            continue;
        }
        const record = joins.get(r.pk) ?? null;
        statements.push(db.prepare(
            `INSERT INTO players (key_hash, name, first_at, last_at, merged_into) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (key_hash) DO UPDATE SET name = excluded.name, last_at = excluded.last_at`)
            .bind(r.pk, r.name, rec.endedAt, rec.endedAt, record));
        if (record !== null)
            statements.push(named(record, r));
    }
    for (const r of rec.rows) {
        statements.push(db.prepare(
            `INSERT OR REPLACE INTO match_players (match_id, slot, player_id, name, team, score, kills, deaths, suicides,
                                                   streak, secs, place, won, host, reported, kinds)
             VALUES (?, ?, (SELECT id FROM players WHERE key_hash = ?), ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?)`)
            .bind(id, r.slot, r.pk || null, r.name, r.team, r.score, r.kills, r.deaths, r.suicides, r.streak, r.secs,
                  r.place, r.won, r.host, r.reported, JSON.stringify(r.kinds)));
    }
    await db.batch(statements);
    if (opts.joinNames) {
        // The match is saved whatever comes of this: the next match under
        // one of these names looks again.
        try {
            await adoptKeyless(db, rec.rows.map(r => r.name));
        } catch (e) {
            console.log(`ladder: match ${id}: its names' lines without a key weren't looked at (${e.message})`);
        }
    }
    return id;
}

// Gives the lines of players whose game sent no key to the record that has
// their name, and returns how many. names: only lines under these names (a
// match's, when it's saved); without, every such line. A line goes to a
// record when the name is exactly one record's on the pages (whatever the
// letters' case) and isn't too common to say anything, nobody else in that
// match has it, and the record's player isn't in that match under a key. It
// then hangs on the record's stand-in row, made here when the record has
// none. A stand-in taken off its record by hand stays off: the record gets no
// more such lines.
export async function adoptKeyless(db, names = null) {
    const lower = name => name.trim().toLowerCase();
    let wanted = [];
    if (names) {
        wanted = [...new Set(names.filter(joinableName).map(lower))].slice(0, MAX_PLAYERS);
        if (!wanted.length)
            return 0;
    }
    // Reads the lines that are nobody's (match_players_player): these, and
    // those of players who asked not to be recorded.
    const sql = `SELECT mp.match_id, mp.slot, mp.name, m.ended_at
                 FROM match_players mp JOIN matches m ON m.id = mp.match_id
                 WHERE mp.player_id IS NULL AND mp.name != ''
                       ${wanted.length ? `AND mp.name COLLATE NOCASE IN (${wanted.map(() => "?").join(", ")})` : ""}
                 ORDER BY mp.match_id DESC LIMIT ${ADOPT_MAX}`;
    const asked = wanted.length ? db.prepare(sql).bind(...wanted) : db.prepare(sql);
    const lines = (await asked.all()).results.filter(l => joinableName(l.name));
    if (!lines.length)
        return 0;
    // The one record each name has, if it has one.
    const lineNames = [...new Set(lines.map(l => lower(l.name)))];
    const found = await db.batch(lineNames.map(n => db.prepare(
        `SELECT id FROM players WHERE name = ? COLLATE NOCASE AND merged_into IS NULL AND hidden = 0
         LIMIT 2`).bind(n)));
    const recordOf = new Map();
    lineNames.forEach((n, i) => {
        if (found[i].results.length === 1)
            recordOf.set(n, found[i].results[0].id);
    });
    const open = lines.filter(l => recordOf.has(lower(l.name)));
    if (!open.length)
        return 0;
    // Who else was in those matches, and the records' stand-ins as they are.
    const matchIds = [...new Set(open.map(l => l.match_id))];
    const records = [...new Set(recordOf.values())];
    const more = await db.batch([
        ...matchIds.map(id => db.prepare(
            `SELECT mp.name, COALESCE(p.merged_into, p.id) AS record
             FROM match_players mp LEFT JOIN players p ON p.id = mp.player_id WHERE mp.match_id = ?`).bind(id)),
        ...records.map(id => db.prepare("SELECT merged_into FROM players WHERE key_hash = ?").bind(NAME_KEY + id)),
    ]);
    const inMatch = new Map(matchIds.map((id, i) => [id, more[i].results]));
    const takenOff = new Set(records.filter((id, i) => {
        const standIn = more[matchIds.length + i].results[0];
        return standIn && standIn.merged_into !== id;
    }));
    const statements = [];
    let n = 0;
    for (const l of open) {
        const name = lower(l.name), record = recordOf.get(name), rows = inMatch.get(l.match_id);
        if (takenOff.has(record) || rows.filter(r => lower(r.name) === name).length !== 1 ||
            rows.some(r => r.record === record))
            continue;
        const standIn = NAME_KEY + record;
        statements.push(
            db.prepare(`INSERT INTO players (key_hash, name, first_at, last_at, merged_into) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (key_hash) DO UPDATE SET first_at = MIN(first_at, excluded.first_at),
                                                             last_at = MAX(last_at, excluded.last_at)`)
                .bind(standIn, l.name, l.ended_at, l.ended_at, record),
            db.prepare(`UPDATE match_players SET player_id = (SELECT id FROM players WHERE key_hash = ?)
                        WHERE match_id = ? AND slot = ? AND player_id IS NULL`).bind(standIn, l.match_id, l.slot),
            // The record was first seen when its first match was played.
            db.prepare("UPDATE players SET first_at = MIN(first_at, ?) WHERE id = ?").bind(l.ended_at, record));
        // One line of a name in a match, so this record gets no second there.
        rows.push({ name: l.name, record });
        n++;
        console.log(`ladder: match ${l.match_id}: a player with no key joins record ${record} by their name`);
    }
    if (n) {
        await db.batch(statements);
        // The standings as kept were added up without them. A database from
        // before they were kept has none to empty.
        try {
            await db.prepare("DELETE FROM ladder_cache").run();
        } catch (e) {
            if (!/no such table/i.test(String(e && e.message)))
                throw e;
        }
    }
    return n;
}

// Who won a match, from its players' rows ({name, team, score, won}) and its
// teams' scores: {name, team, score}. name is the winner's ("" for one not
// recorded by name) or null when a team won or nobody did; team is the
// winning team's number (TEAMS), 0 without one.
export function winnerOf(mode, rows, teamScores) {
    const winners = rows.filter(r => r.won);
    if (!winners.length) {
        const top = rows.filter(r => r.place === 1);
        return { name: null, team: 0, score: (mode & MODE_TEAMS) || !top.length ? null : top[0].score };
    }
    if (mode & MODE_TEAMS) {
        const team = winners[0].team;
        return { name: null, team, score: teamScores ? teamScores[team] ?? null : null };
    }
    return { name: winners[0].name, team: 0, score: winners[0].score };
}

// Discord's markdown has no say inside a code block, which only ``` ends.
function plain(text) {
    return text.replace(/`/g, "'");
}

function minutes(secs) {
    return secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

// The message for a finished match: its scoreboard, with a link to its page.
// Names are what players typed, so nothing in it can mention anyone.
export function discordMessage(id, rec, origin) {
    const rows = [...rec.rows].sort((a, b) => a.place - b.place || a.slot - b.slot).slice(0, 16);
    const width = Math.max(4, ...rows.map(r => Array.from(r.name || "Anonymous").length));
    const lines = rows.map(r => {
        const name = plain(r.name || "Anonymous");
        return `${String(r.place).padStart(2)}. ${name}${" ".repeat(width - Array.from(name).length)}  ` +
               `${String(r.score ?? "-").padStart(4)}  ${r.kills}/${r.deaths}/${r.suicides}`;
    });
    const w = winnerOf(rec.mode, rec.rows, rec.detail.teams);
    const title = plain(rec.title) + (w.name !== null ? `: ${plain(w.name || "Anonymous")} wins`
                                      : w.team ? `: ${TEAMS[w.team]} team wins` : "");
    const embed = {
        title: title.slice(0, 256),
        description: ("```\n" + `    ${"Name".padEnd(width)}  Score  K/D/S\n` + lines.join("\n")).slice(0, 4000) + "\n```",
        color: 0xffcc66,
        footer: { text: [rec.game === "mots" ? "Mysteries of the Sith" : "Jedi Knight", rec.mod ? plain(rec.mod) : "",
                         `${rec.players} players`, minutes(rec.secs)].filter(Boolean).join(" | ").slice(0, 2048) },
        timestamp: new Date(rec.endedAt).toISOString(),
    };
    if (origin)
        embed.url = `${origin}/match/${id}`;
    return { allowed_mentions: { parse: [] }, embeds: [embed] };
}

// The lobby's side: one for the Lobby object, which calls it for a game's
// match line, a room that ends, its alarm and its status.
export class Ladder {
    constructor(lobby) {
        this.lobby = lobby;
        // room id -> its match: open, or the last one once it's over ({done,
        // hostLv, map}), so a late report from the host doesn't open it again.
        this.matches = new Map();
        // Finished matches D1 doesn't have yet: {n, rec, tries, at}.
        this.unsaved = [];
        this.nextUnsaved = 1;
        // The last match saved that anyone could have joined, for the page to
        // know there's a new one (status); 0 before the first.
        this.latest = 0;
        this.rates = new Map();   // ws -> {n, at}
        this.hashes = new Map();  // browser key -> its SHA-256
        this.ready = false;       // whether D1 has the tables, as far as this one knows
        // Whether the lines saved before a player with no key could be a
        // known one by their name have been looked at: once for a lobby.
        this.caughtUp = false;
        // Reports and endings are worked through one at a time, in the order
        // they came.
        this.queue = Promise.resolve();
    }

    on() {
        return !!this.lobby.env.LADDER;
    }

    async restore() {
        if (!this.on())
            return;
        const storage = this.lobby.ctx.storage;
        this.latest = (await storage.get("ladder:latest")) || 0;
        this.caughtUp = !!(await storage.get("ladder:keyless"));
        for (const [key, m] of await storage.list({ prefix: "match:" }))
            this.matches.set(Number(key.slice(6)), m);
        for (const [, u] of await storage.list({ prefix: "matchdone:" })) {
            this.unsaved.push(u);
            this.nextUnsaved = Math.max(this.nextUnsaved, u.n + 1);
        }
        // A room that's gone ended while the lobby wasn't running.
        for (const id of [...this.matches.keys()]) {
            if (!this.lobby.rooms.has(id))
                this.roomEnded({ id });
        }
        if (this.unsaved.length)
            this.later(() => this.saveAll());
        this.wake();
    }

    // The name the host's game gives the level a room is on, for the
    // landing page's list (Lobby.status): its match's, from the host's
    // first report of the level on. "" before that, while the match is of
    // another level than map (the room's entry's), and for a level that has
    // no name of its own, which the game calls by its file's (wsrelay_
    // matchTitle in the fork falls back to the key it looks up: the file's
    // name without .jkl, in capitals).
    title(roomId, map) {
        const m = this.matches.get(roomId);
        if (!m || !m.title || typeof map !== "string")
            return "";
        const file = map.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 32).toLowerCase();
        if (m.map !== file || m.title.toLowerCase() === file.replace(/\.jkl$/, ""))
            return "";
        return m.title;
    }

    later(fn) {
        this.queue = this.queue.then(fn).catch(e => console.log(`ladder: ${e && e.stack || e}`));
        return this.queue;
    }

    // A match line from a game. Only from one seated in a room, and never
    // answered.
    report(ws, c, b64) {
        if (!this.on())
            return;
        const room = this.lobby.rooms.get(c.room);
        const seated = !!room && ws === (c.id === 1 ? room.host : room.peers.get(c.id));
        // A game whose room has just ended (its host left) still has its
        // last word while the match closes (roomEnded). The mark the lobby
        // put on its socket says which match it reported, and as whom.
        const late = !seated && c.m ? this.matches.get(c.m[0]) : null;
        if (!seated && !(late && !late.done && late.roomGone))
            return;
        const now = Date.now();
        let rate = this.rates.get(ws);
        if (!rate) {
            rate = { n: RATE_BURST, at: now };
            this.rates.set(ws, rate);
        }
        rate.n = Math.min(RATE_BURST, rate.n + (now - rate.at) / RATE_MS);
        rate.at = now;
        if (rate.n < 1)
            return;
        rate.n--;
        const r = cleanReport(b64);
        if (!r)
            return;
        if (!seated) {
            // As the player with the mark's key, whoever sat in that seat
            // since, and only until its end: a player who left before has
            // said its last. Never the host: its end was its last word, and
            // a host's line can open a match. Looked up in its turn: the
            // game's lines from before the room ended may still be waiting.
            const [roomId, key] = c.m;
            return this.later(() => {
                const m = this.matches.get(roomId);
                if (!m || m.done || !m.roomGone)
                    return;
                const pi = m.players.findIndex(p => p.key && p.key === key && p.seat !== 1 && !p.left);
                if (pi >= 0)
                    return this.take(roomId, m.players[pi].seat, [], { locked: false }, r, now, pi);
            });
        }
        // The seats as they are now: by the time it's worked through, its
        // game may have left.
        const seats = this.lobby.seated(room).filter(([, , seat]) => seat).map(([id, sock, seat]) => ({
            id, key: seat.key.slice(0, 8), at: seat.at || 0,
            name: (sock ? this.lobby.conn(sock).name : seat.name) || "",
            ip: (sock && this.lobby.conn(sock).ip) || "",
        }));
        const info = this.lobby.roomInfo(room);
        // Which match this socket's game reports, kept on the socket itself
        // (m: the room and its seat's key): the lobby sleeps between
        // messages and forgets what's only in memory, and the game is told
        // once the match is saved, also after it has left the room.
        const mine = seats.find(s => s.id === c.id);
        if (mine && !(c.m && c.m[0] === room.id && c.m[1] === mine.key))
            this.lobby.saveConn(ws, { ...c, m: [room.id, mine.key] });
        return this.later(() => this.take(room.id, c.id, seats, info, r, now));
    }

    forget(ws) {
        this.rates.delete(ws);
    }

    // as: the match's player a late line is from (report), else the one in
    // the seat now.
    async take(roomId, seatId, seats, info, r, now, as = -1) {
        let hash = "";
        if (r.pk && !r.anon) {
            hash = this.hashes.get(r.pk) || await hashKey(r.pk);
            if (this.hashes.size > 512)
                this.hashes.clear();
            this.hashes.set(r.pk, hash);
        }
        const isHost = seatId === 1;
        let m = this.matches.get(roomId);
        if (isHost && (!m || m.hostLv !== r.lv || m.map !== r.map)) {
            if (m && !m.done)
                this.finish(m, "next level", now);
            m = {
                room: roomId, game: info.game, name: info.name, episode: info.episode, locked: info.locked,
                mod: cleanText(info.mod, 63), modFp: info.modFp, pack: info.pack, maxRank: info.maxRank,
                map: r.map, title: r.title, hostLv: r.lv, startedAt: now - r.t, lastAt: now,
                closing: 0, ended: "", rules: null, players: [], bySeat: {}, addrs: [], kills: [], rows: {},
                teams: null,
            };
            this.matches.set(roomId, m);
            // Its level's name, for the landing page's list (title).
            if (m.title)
                this.lobby.statusChanged();
        }
        if (!m || m.done || m.map !== r.map)
            return;
        // A password at any time in it is one for the match.
        m.locked = m.locked || info.locked;
        this.roster(m, seats, now);
        const pi = as >= 0 ? as : this.who(m, seatId, now);
        if (pi < 0)
            return;
        const p = m.players[pi];
        // Its game has gone on to another level, before the host's has.
        if (p.lv && p.lv !== r.lv)
            return;
        // A game's first word in a match isn't a level's end: that's the last
        // report of the level before, which its game kept while the lobby was
        // out of its reach (ladder.js in the fork) and sent after the host
        // had opened this one. Only the same level played again gets this
        // far: another map's was turned away above.
        if (!isHost && r.end === "level" && !p.reports)
            return;
        p.lv = r.lv;
        p.reports++;
        p.t = Math.max(p.t, r.t);
        p.anon = r.anon;
        p.idle = r.idle;
        p.pk = r.anon ? "" : hash || p.pk;
        p.build = r.build || p.build;
        if (r.title && (isHost || !m.title) && r.title !== m.title) {
            m.title = r.title;
            this.lobby.statusChanged();
        }
        if (isHost && r.rules)
            m.rules = r.rules;
        for (const e of r.ev)
            this.kill(m, pi, e, now);
        if (isHost && r.sb) {
            for (const [id, score, kills, deaths, suicides, team] of r.sb) {
                const who = this.who(m, id, now);
                if (who >= 0)
                    m.rows[who] = [score, kills, deaths, suicides, team];
            }
            m.teams = r.teams;
        }
        m.lastAt = now;
        // Back in the level after leaving it, its game has more to say.
        p.left = r.end ? now : as >= 0 ? p.left : 0;
        if (r.end && isHost) {
            m.ended = r.end;
            m.closing = now + CLOSE_MS;
        }
        // Its room is gone and that was the last game to say its last.
        if (m.roomGone && this.saidAll(m))
            m.closing = now;
        this.lobby.ctx.storage.put("match:" + roomId, m);
        this.wake();
    }

    // Whether every game that reported the match has sent its end. The
    // host's isn't asked: its room ending is its end.
    saidAll(m) {
        return m.players.every(p => p.seat === 1 || !p.reports || p.left);
    }

    // The players in the room's seats, each a player of the match from the
    // time they sat down.
    roster(m, seats, now) {
        for (const s of seats) {
            let pi = m.players.findIndex(p => p.seat === s.id && p.key === s.key);
            if (pi < 0) {
                if (m.players.length >= MAX_PLAYERS)
                    continue;
                pi = m.players.length;
                // Someone who was in the room before the level began was in
                // it from its start.
                const from = Math.max(s.at || now, m.startedAt);
                m.players.push(newPlayer(s.id, s.key, from));
                (m.bySeat[s.id] = m.bySeat[s.id] || []).push([pi, s.at ? from : now]);
            }
            const p = m.players[pi];
            if (s.name)
                p.name = s.name;
            // Which of the match's addresses is theirs: only how many there
            // were is kept.
            if (s.ip && m.addrs.length < MAX_PLAYERS) {
                if (!m.addrs.includes(s.ip))
                    m.addrs.push(s.ip);
                p.addr = m.addrs.indexOf(s.ip);
            }
            p.seen = now;
        }
    }

    // The player who had a seat at a time: the last to sit down in it by
    // then. One the lobby never saw there (gone before any report) is a
    // player with no name. -1 when the match has all the players it takes.
    who(m, seatId, ts) {
        let hist = m.bySeat[seatId];
        if (!hist) {
            if (m.players.length >= MAX_PLAYERS)
                return -1;
            m.players.push(newPlayer(seatId, "", ts));
            hist = m.bySeat[seatId] = [[m.players.length - 1, 0]];
        }
        let pi = hist[0][0];
        for (const [i, from] of hist) {
            if (from <= ts)
                pi = i;
        }
        return pi;
    }

    // A kill one game saw: another game's report of the same one, or new.
    kill(m, ri, e, now) {
        const p = m.players[ri];
        const [n, ago, victimSeat, killerSeat, kind] = e;
        if (n <= p.lastN)
            return;
        p.lastN = n;
        const ts = now - ago;
        const v = this.who(m, victimSeat, ts), k = killerSeat ? this.who(m, killerSeat, ts) : -1;
        if (v < 0 || (killerSeat && k < 0))
            return;
        const own = ri === v;
        let best = null;
        for (let i = m.kills.length - 1; i >= 0 && i >= m.kills.length - SCAN; i--) {
            const c = m.kills[i];
            if (c.v !== v || c.k !== k || c.by.includes(ri) || Math.abs(c.ts - ts) > WINDOW_MS)
                continue;
            if (!best || Math.abs(c.ts - ts) < Math.abs(best.ts - ts))
                best = c;
        }
        if (best) {
            best.by.push(ri);
            // The victim's game saw it first and knows what did it.
            if (own) {
                best.own = true;
                best.ts = ts;
                best.kind = kind || best.kind;
            } else if (!best.kind) {
                best.kind = kind;
            }
        } else if (m.kills.length < MAX_KILLS) {
            m.kills.push({ ts, v, k, kind, by: [ri], own });
        }
    }

    // A room that ended: its match is over. A host that leaves ends its
    // room at once, while the other games' last reports (their last kills,
    // their time, their end) are still on their way, so the match stays open
    // for them CLOSE_MS at most, as after the host's end of a level, and
    // closes as soon as each has said its last (take).
    roomEnded(room) {
        const open = this.matches.get(room.id);
        if (!open)
            return;
        // Marked at once, not in its turn: the other games' last lines can
        // come while the lobby is still working through what came before
        // (report).
        if (!open.done)
            open.roomGone = true;
        const now = Date.now();
        this.later(() => {
            const m = this.matches.get(room.id);
            if (m && !m.done) {
                m.roomGone = true;
                if (this.saidAll(m))
                    return this.finish(m, "room closed", now);
                if (!m.closing || m.closing > now + CLOSE_MS)
                    m.closing = now + CLOSE_MS;
                this.lobby.ctx.storage.put("match:" + room.id, m);
                return this.wake();
            }
            this.matches.delete(room.id);
            this.lobby.ctx.storage.delete("match:" + room.id);
        });
    }

    // Closes the matches whose time is up, and tries again what D1 didn't
    // take. From the lobby's alarm.
    sweep() {
        if (!this.on())
            return;
        const now = Date.now();
        for (const m of this.matches.values()) {
            if (m.done)
                continue;
            if (m.closing && m.closing <= now)
                this.later(() => { if (!m.done) this.finish(m, m.roomGone ? "room closed" : "level over", now); });
            else if (m.lastAt + IDLE_MS <= now)
                this.later(() => { if (!m.done) this.finish(m, "went quiet", now); });
        }
        if (this.unsaved.some(u => u.at <= now))
            this.later(() => this.saveAll());
        this.later(() => this.wake());
    }

    // Has the lobby's alarm run when the next match closes or is tried again.
    wake() {
        let at = 0;
        const sooner = t => { at = at ? Math.min(at, t) : t; };
        for (const m of this.matches.values()) {
            if (!m.done)
                sooner(m.closing || m.lastAt + IDLE_MS);
        }
        for (const u of this.unsaved)
            sooner(u.at);
        if (at)
            this.lobby.sweepLater(Math.max(at, Date.now() + 1000));
    }

    finish(m, why, now) {
        const rec = buildRecord(m, why, now);
        const storage = this.lobby.ctx.storage;
        m.done = true;
        if (m.roomGone) {
            // Nothing more can come for it.
            this.matches.delete(m.room);
            storage.delete("match:" + m.room);
        } else {
            // What's left says it's over, for a late report from its host,
            // and what its level is called while the room stays on it.
            const done = { done: true, room: m.room, hostLv: m.hostLv, map: m.map, title: m.title || "" };
            this.matches.set(m.room, done);
            storage.put("match:" + m.room, done);
        }
        if (!rec) {
            console.log(`ladder: room ${m.room}: ${m.map} not kept (${m.players.length} players, ${m.kills.length} kills, ${why})`);
            return;
        }
        // tell: the games to tell once it's saved, by the mark on their
        // sockets (report).
        const u = { n: this.nextUnsaved++, rec, tries: 0, at: 0,
                    tell: { room: m.room, keys: m.players.filter(p => p.reports).map(p => p.key) } };
        this.unsaved.push(u);
        storage.put("matchdone:" + u.n, u);
        this.later(() => this.saveAll());
    }

    async saveAll() {
        const now = Date.now();
        const storage = this.lobby.ctx.storage;
        for (const u of [...this.unsaved]) {
            if (u.at > now)
                continue;
            let id;
            try {
                if (!this.ready) {
                    await ensureSchema(this.lobby.env.LADDER);
                    this.ready = true;
                }
                // LADDER_JOIN_NAMES = "0" keeps every new key a record of its
                // own, and a player with no key out of every record.
                const joinNames = this.lobby.env.LADDER_JOIN_NAMES !== "0";
                id = await saveRecord(this.lobby.env.LADDER, u.rec, { joinNames });
                if (joinNames && !this.caughtUp)
                    await this.catchUp();
            } catch (e) {
                // The tables may be gone (another database bound).
                this.ready = false;
                u.tries++;
                u.at = Date.now() + SAVE_RETRY_MS;
                const gaveUp = u.tries >= SAVE_TRIES;
                console.log(`ladder: ${u.rec.map} not saved (${e.message}), ${gaveUp ? "given up" : "trying again in a minute"}`);
                if (gaveUp) {
                    this.unsaved = this.unsaved.filter(x => x !== u);
                    storage.delete("matchdone:" + u.n);
                } else {
                    storage.put("matchdone:" + u.n, u);
                }
                continue;
            }
            this.unsaved = this.unsaved.filter(x => x !== u);
            storage.delete("matchdone:" + u.n);
            const rec = u.rec;
            console.log(`ladder: match ${id}: ${rec.game} ${rec.map}, ${rec.players} players (${rec.reporters} reporting), ` +
                        `${rec.secs} s, ${rec.kills} kills (${rec.confirmed} seen by two games), ` +
                        `scoreboard ${rec.detail.agree.sbSame}/${rec.detail.agree.sbRows} the same, ` +
                        `${rec.counted ? "counts" : "listed only"}, ${rec.detail.why}`);
            for (const ws of u.tell ? this.lobby.ctx.getWebSockets() : []) {
                const mark = this.lobby.conn(ws).m;
                if (mark && mark[0] === u.tell.room && u.tell.keys.includes(mark[1]))
                    this.lobby.send(ws, `matched ${id}`);
            }
            // The page's lists are of matches anyone could have joined.
            if (!rec.locked && id > this.latest) {
                this.latest = id;
                storage.put("ladder:latest", id);
                this.lobby.statusChanged();
            }
            // Not waited for: the next match doesn't wait on Discord.
            const told = this.tellDiscord(id, rec);
            if (this.lobby.ctx.waitUntil)
                this.lobby.ctx.waitUntil(told);
        }
        this.wake();
    }

    // With the first match a lobby saves: the earlier lines of players with
    // no key, whatever their names. The match is saved whatever comes of it,
    // and a failure is tried again with the next match.
    async catchUp() {
        try {
            const n = await adoptKeyless(this.lobby.env.LADDER);
            this.caughtUp = true;
            this.lobby.ctx.storage.put("ladder:keyless", 1);
            if (n)
                console.log(`ladder: ${n} earlier line(s) of players with no key joined their records`);
        } catch (e) {
            console.log(`ladder: the earlier lines of players with no key weren't looked at (${e.message})`);
        }
    }

    // Posts a finished match to the Discord channel whose webhook address is
    // in the DISCORD_WEBHOOK secret: open games of DISCORD_MIN_PLAYERS (3) or
    // more that ran two minutes. Nothing without the secret.
    async tellDiscord(id, rec) {
        const env = this.lobby.env;
        const min = Number(env.DISCORD_MIN_PLAYERS) || 3;
        if (!env.DISCORD_WEBHOOK || rec.players < min || rec.locked || rec.secs < COUNT_SECS)
            return;
        try {
            const res = await fetch(env.DISCORD_WEBHOOK, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(discordMessage(id, rec, env.MATCH_LINKS || env.SITE || "")),
            });
            if (!res.ok)
                console.log(`ladder: match ${id}: Discord answered ${res.status}`);
        } catch (e) {
            console.log(`ladder: match ${id}: not posted to Discord (${e.message})`);
        }
    }
}
