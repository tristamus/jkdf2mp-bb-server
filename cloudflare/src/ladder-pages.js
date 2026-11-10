// What the Worker serves of the match record (src/ladder.js): a page for each
// match, the list of them, and a player's browser key. None of it without the
// LADDER binding.
//
//   POST /ladder/key   the page's player's browser key: the one in the cookie
//                      the lobby set before, else the one the page kept (its
//                      body, {"key": "<32 hex>"}), else a new one. Sets the
//                      cookie again. The key is who a player is here; D1 only
//                      ever gets its SHA-256.
//   GET /ladder/recent the last matches of each game as JSON, for the landing
//                      page's lists, which it gets again when the lobby's
//                      status names a newer match
//   GET /match/<id>    a match: its scoreboard, who killed whom, and how many
//                      of its players' games reported it
//   GET /matches       the matches, newest first, 30 to a page: ?game=jk or
//                      mots for one game's, ?before=<id> for older ones
//   GET /players       the standings of one game (?game=jk or mots) over a
//                      week, a month or all time (?period=week, month or
//                      all), by any of its columns (?sort=, ?dir=asc)
//   GET /player/<id>   a player: what they did in one game over one of those
//                      periods, who they met most, and their latest matches
//
// Standings and a player's numbers are added up from the matches that count
// (ladder.js: long enough, confirmed by two games, no password). A week
// begins on Monday and a month on its first day, both at 3 in the morning in
// Pacific time, where most of the play is, so an evening's late games are in
// the week it began in. A player is a record in the players table and every
// key joined to it (ladder.js).
//
// The pages are whole documents in the landing page's two looks (the same
// browser setting picks one), made here from D1 for each request. Everything a
// player or host typed (names, room names, level titles) is escaped, and the
// page's policy lets it load nothing and run only scripts that carry its
// nonce: its own, which shows times in the viewer's zone and switches the
// look, and the one Cloudflare Web Analytics adds on the way out when it's on
// for the zone (Cloudflare gives it the page's nonce). A script may only talk
// to this site, which is where that one sends its page view (/cdn-cgi/rum).
// A match in a game with a password has its page, but isn't in any list. Each
// match says its mod and whether its level is a custom one.

import { COUNT_AGREE, MODE_COG_SCORES, MODE_TEAMS, TEAMS, ensureSchema, hashKey, winnerOf } from "./ladder.js";

const KEY_COOKIE = "jkpk";
// Chrome keeps a cookie 400 days at most, so each visit sets it again.
const KEY_COOKIE_S = 400 * 24 * 60 * 60;
const MAX_KEY_BODY = 256;
const KEY_RE = /^[0-9a-f]{32}$/;
const PAGE = 30;
const SIDE = 8;
const RECENT = 8;
// Standings: the rows on the page, and in the landing page's lists.
const BOARD = 100;
const TOP = 10;
// What the kept standings are stamped with, to add them up again when this
// file's idea of them changes.
const BOARD_V = 1;
const PERIODS = { week: "This Week", month: "This Month", all: "All Time" };
const PERIODS_LC = { week: "this week", month: "this month", all: "all time" };
const ZONE = "America/Los_Angeles";
const TURN_HOUR = 3;
// Kills and deaths together before a K/D takes a place in the standings.
const KD_MIN = 30;
// A player's rivals are worked out from this many of their latest matches.
const RIVAL_MATCHES = 50;
const RIVALS = 6;
const PLAYER_MATCHES = 10;
const HOUR_MS = 60 * 60 * 1000, DAY_MS = 24 * HOUR_MS;
const MODE_TIME_LIMIT = 0x8;
const MODE_SCORE_LIMIT = 0x10;
const GAMES = { jk1: "Jedi Knight", mots: "Mysteries of the Sith" };
const GAMES_LONG = { jk1: "Jedi Knight: Dark Forces II", mots: "Jedi Knight: Mysteries of the Sith" };
// ?game= as people would type it.
const GAME_PARAM = { jk: "jk1", jk1: "jk1", mots: "mots" };
const KIND_NAMES = ["", "Lightsaber", "Shots", "Explosions", "Force", "Other"];
// The games' own episodes, by name (maps.js in the OpenJKDF2 fork): a level
// from any other is a custom one.
const RETAIL_EPISODES = ["jk1", "jk1ctf", "jk1mp", "jk1demo", "jk1mpdem", "jk1mpdemo", "jkm", "jkm_kfy", "jkm_mp", "jkm_saber"];

function customMap(episode) {
    return !!episode && !RETAIL_EPISODES.includes(episode.toLowerCase());
}
const ICON = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3E%3Crect%20width='16'%20height='16'%20rx='3'%20fill='%23003333'/%3E%3Cpath%20d='M10%200h3a3%203%200%200%201%203%203v10a3%203%200%200%201-3%203H8z'%20fill='%23336666'/%3E%3Cpath%20d='M5%204l7%204-7%204z'%20fill='%23ffcc66'/%3E%3C/svg%3E";

function json(status, body, headers) {
    return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
    });
}

function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function toHex(bytes) {
    return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

function cookieKey(request) {
    for (const part of (request.headers.get("Cookie") || "").split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq).trim() === KEY_COOKIE) {
            const value = part.slice(eq + 1).trim();
            return KEY_RE.test(value) ? value : "";
        }
    }
    return "";
}

// POST /ladder/key, from a page on this address.
async function keyRoute(request) {
    if (request.method !== "POST")
        return new Response("POST here for a player key", { status: 405, headers: { Allow: "POST" } });
    const origin = request.headers.get("Origin");
    if (origin !== null) {
        let host = null;
        try {
            host = new URL(origin).host;
        } catch (e) {
        }
        if (host !== new URL(request.url).host)
            return json(403, { error: "Not from this site" });
    }
    if (Number(request.headers.get("Content-Length") || 0) > MAX_KEY_BODY)
        return json(413, { error: "Too long" });
    let kept = "";
    try {
        const text = await request.text();
        const body = text && text.length <= MAX_KEY_BODY ? JSON.parse(text) : null;
        if (isObject(body) && typeof body.key === "string" && KEY_RE.test(body.key))
            kept = body.key;
    } catch (e) {
    }
    // The cookie first: it outlasts what a page keeps where the browser
    // clears script-made data by itself (Safari, after a week away).
    const key = cookieKey(request) || kept || toHex(crypto.getRandomValues(new Uint8Array(16)));
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return json(200, { key }, {
        "Set-Cookie": `${KEY_COOKIE}=${key}; Max-Age=${KEY_COOKIE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`,
    });
}

// The Worker's routes: null for any other path, and for all of them without
// the LADDER binding.
export async function ladderRoute(request, env, url) {
    const path = url.pathname;
    if (!env.LADDER || !(path === "/ladder/key" || path === "/ladder/recent" || path === "/matches" || path === "/players" ||
                         path.startsWith("/match/") || path.startsWith("/player/")))
        return null;
    if (path === "/ladder/key")
        return keyRoute(request);
    const m = /^\/match\/([1-9][0-9]{0,8})$/.exec(path);
    const pl = /^\/player\/([1-9][0-9]{0,8})$/.exec(path);
    if ((path.startsWith("/match/") && !m) || (path.startsWith("/player/") && !pl))
        return null;
    if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    // The pages mark their viewer's own row, and the lists say where they stand.
    const key = path === "/matches" ? "" : cookieKey(request);
    const viewer = key ? await hashKey(key) : "";
    const now = Date.now();
    const show = () => m ? matchPage(env.LADDER, Number(m[1]), viewer)
                     : pl ? playerPage(env.LADDER, Number(pl[1]), url, viewer, now)
                     : path === "/players" ? playersPage(env.LADDER, url, viewer, now)
                     : path === "/matches" ? matchesPage(env.LADDER, url) : recentMatches(env.LADDER, viewer, now);
    try {
        try {
            return await show();
        } catch (e) {
            // A database nothing has been saved to yet has no tables.
            if (!/no such table/i.test(String(e && e.message)))
                throw e;
            await ensureSchema(env.LADDER);
            return await show();
        }
    } catch (e) {
        console.log(`ladder: ${path} failed (${e && e.message || e})`);
        if (path === "/ladder/recent")
            return json(503, { error: "The match record can't be read right now" });
        return page(503, "Match record", "The match record",
                    `<div class="ladder-main"><p class="empty"><b>The match record can't be read right now.</b>
                     Try again in a minute.</p></div>`, { noStore: true });
    }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(v) {
    return String(v).replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

function length(secs) {
    if (secs < 90)
        return `${secs} s`;
    const min = Math.round(secs / 60);
    return min < 120 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function count(n, one, many) {
    return `${n} ${n === 1 ? one : many || one + "s"}`;
}

// A time, in UTC until the page's script puts it in the viewer's zone ("date",
// or "day" for the day alone) or says how long ago it was ("ago").
function time(ms, as) {
    const d = new Date(ms);
    const utc = d.toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
                                            hour: "numeric", minute: "2-digit" }) + " UTC";
    return `<time datetime="${d.toISOString()}" data-at="${ms}" data-as="${as}">${esc(utc)}</time>`;
}

// The names a match's players are shown under: their own, or "Anonymous" for
// one who asked not to be recorded by name or whose record is hidden, and
// "Unknown player" for one the lobby never saw; numbered when there are
// several of either.
function shownNames(rows) {
    const label = r => r.name && !r.hidden ? null : r.reported ? "Anonymous" : "Unknown player";
    const totals = {}, seen = {};
    for (const r of rows) {
        const l = label(r);
        if (l)
            totals[l] = (totals[l] || 0) + 1;
    }
    return rows.map(r => {
        const l = label(r);
        if (!l)
            return r.name;
        seen[l] = (seen[l] || 0) + 1;
        return totals[l] > 1 ? `${l} ${seen[l]}` : l;
    });
}

function parse(text, fallback) {
    try {
        const v = JSON.parse(text);
        return v === null || v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function placeCell(place) {
    return place >= 1 && place <= 3 ? `<span class="place p${place}">${place}</span>` : String(place);
}

function gameBall(game) {
    return `<span class="ball ${game === "mots" ? "mots" : "jk"}" aria-hidden="true"></span>`;
}

// How a list says who won.
function wonLine(w) {
    if (w.name !== null)
        return `Won by ${esc(w.name || "Anonymous")}`;
    return w.team ? `${TEAMS[w.team]} team won` : "No single winner";
}

// From a match's player row (mp) to the record it counts for (c), if any.
const RECORD_JOIN = `LEFT JOIN players p ON p.id = mp.player_id
                     LEFT JOIN players c ON c.id = COALESCE(p.merged_into, p.id)`;

// The matches a list shows, newest first, with who won each: the public ones
// (no password, not hidden), of one game if asked, older than an id if asked.
function listQueries(db, game, before, limit) {
    const where = ["hidden = 0", "locked = 0"], args = [];
    if (game) {
        where.push("game = ?");
        args.push(game);
    }
    if (before) {
        where.push("id < ?");
        args.push(before);
    }
    const pick = `FROM matches WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`;
    return [
        db.prepare(`SELECT id, game, title, episode, mod, pack, players, secs, ended_at, mode, counted,
                           json_extract(detail, '$.teams') AS teams ${pick}`).bind(...args, limit),
        db.prepare(`SELECT mp.match_id, mp.name, mp.team, mp.score, mp.place, mp.won, COALESCE(c.hidden, 0) AS hidden
                    FROM match_players mp ${RECORD_JOIN}
                    WHERE (mp.won = 1 OR mp.place = 1) AND mp.match_id IN (SELECT id ${pick})`).bind(...args, limit),
    ];
}

function listed(matches, tops) {
    const byMatch = new Map();
    for (const t of tops) {
        if (!byMatch.has(t.match_id))
            byMatch.set(t.match_id, []);
        byMatch.get(t.match_id).push({ ...t, name: t.hidden ? "" : t.name });
    }
    return matches.map(m => ({ ...m, winner: winnerOf(m.mode, byMatch.get(m.id) || [], parse(m.teams, null)) }));
}

function sideList(list, here) {
    if (!list.length)
        return `<p class="none">None yet.</p>`;
    return list.map(m => `
        <div class="entry">
          ${m.id === here ? `<b class="here">${esc(m.title)}</b>` : `<a href="/match/${m.id}">${esc(m.title)}</a>`}
          <span class="label">${gameBall(m.game)}${m.mod ? esc(m.mod) + " &middot; " : ""}${count(m.players, "player")} &middot; ${length(m.secs)} &middot; ${time(m.ended_at, "ago")}</span>
          <span class="line"><span>${wonLine(m.winner)}</span><span>${m.winner.score ?? ""}</span></span>
        </div>`).join("");
}

// GET /ladder/recent, for the landing page:
//
//   { v: 1,
//     games: { jk1: [match, ...], mots: [...] },
//     top: { jk1: { period: "week", week: board, month: board, all: board }, mots: {...} },
//     you: { id, name, last } }
//
// A match is {id, title, mod, pack, custom, players, secs, at, teams, name,
// team, score}: name the winner's ("" for one not recorded by name), null when
// a team won (team, its number) or nobody did. top has each game's standings
// over each period, and which period to show first: the shortest anyone
// played in. A board is {players: [{id, name, score, kills, deaths, matches}],
// of, matches, you}: its first TOP players, how many players and matches it
// has in all, and where the viewer stands in it ({rank, score}, or null). you
// is the viewer by their browser's cookie, with their latest match's number,
// or null for a browser the record doesn't know.
export async function recentMatches(db, viewerHash = "", now = Date.now()) {
    const ids = Object.keys(GAMES);
    const statements = ids.flatMap(game => listQueries(db, game, 0, RECENT));
    if (viewerHash) {
        // Their latest match under any of their keys, each key's found by
        // the index alone.
        statements.push(db.prepare(
            `SELECT c.id, c.name, c.hidden,
                    (SELECT MAX((SELECT MAX(mp.match_id) FROM match_players mp WHERE mp.player_id = k.id))
                     FROM players k WHERE k.id = c.id OR k.merged_into = c.id) AS last
             FROM players p JOIN players c ON c.id = COALESCE(p.merged_into, p.id) WHERE p.key_hash = ?`).bind(viewerHash));
    }
    const { boards, more: answers } = await standings(db, now, statements);
    const viewer = viewerHash ? answers.at(-1).results[0] : null;
    const you = viewer && !viewer.hidden ? { id: viewer.id, name: viewer.name, last: viewer.last || 0 } : null;
    const games = {}, top = {};
    ids.forEach((game, i) => {
        games[game] = listed(answers[i * 2].results, answers[i * 2 + 1].results).map(m => ({
            id: m.id, title: m.title, mod: m.mod, pack: m.pack ? 1 : 0, custom: customMap(m.episode) ? 1 : 0,
            players: m.players, secs: m.secs, at: m.ended_at, teams: (m.mode & MODE_TEAMS) !== 0, ...m.winner,
        }));
        top[game] = { period: Object.keys(PERIODS).find(p => boards[game][p].rows.length) || "week" };
        for (const period of Object.keys(PERIODS)) {
            const rows = standing(boards[game][period].rows).sort(byScore);
            const mine = you ? rows.findIndex(r => r.id === you.id) : -1;
            top[game][period] = {
                players: rows.slice(0, TOP).map(r => ({ id: r.id, name: r.name, score: r.score, kills: r.kills, deaths: r.deaths,
                                                        matches: r.matches })),
                of: rows.length, matches: boards[game][period].matches,
                you: mine < 0 ? null : { rank: mine + 1, score: rows[mine].score },
            };
        }
    });
    // Kept a little while by the browser: every page asks when a match ends.
    return json(200, { v: 1, games, top, you }, { "Cache-Control": "private, max-age=10" });
}

// GET /match/<id>
export async function matchPage(db, id, viewerHash) {
    const statements = [
        db.prepare("SELECT * FROM matches WHERE id = ? AND hidden = 0").bind(id),
        db.prepare(`SELECT mp.*, c.id AS pid, COALESCE(c.hidden, 0) AS hidden
                    FROM match_players mp ${RECORD_JOIN}
                    WHERE mp.match_id = ? ORDER BY mp.place, mp.slot`).bind(id),
        ...listQueries(db, "", 0, SIDE),
    ];
    if (viewerHash)
        statements.push(viewerQuery(db, viewerHash));
    const answers = await db.batch(statements);
    const m = answers[0].results[0];
    const side = `<aside class="ladder-side" aria-label="Latest matches"><h2>Latest matches</h2>
        ${sideList(listed(answers[2].results, answers[3].results), id)}
        <p class="more"><a href="/matches">All matches</a></p></aside>`;
    if (!m) {
        return page(404, "No such match", "The match record",
                    `<div class="ladder-main"><p class="empty"><b>There's no match ${id}.</b>
                     It may have been removed. <a href="/matches">See the latest matches</a></p></div>${side}`,
                    { noStore: true });
    }
    const rows = answers[1].results;
    const you = viewerHash && answers[4].results[0] ? answers[4].results[0].id : 0;
    const detail = parse(m.detail, {});
    const names = shownNames(rows);
    // slot -> the name shown, for the detail's numbers.
    const bySlot = new Map(rows.map((r, i) => [r.slot, names[i]]));
    const teams = (m.mode & MODE_TEAMS) !== 0;
    const teamScores = Array.isArray(detail.teams) ? detail.teams : null;
    const winner = winnerOf(m.mode, rows.map((r, i) => ({ ...r, name: r.hidden ? "" : r.name })), teamScores);
    const host = rows.findIndex(r => r.host);
    const gameName = GAMES[m.game] || GAMES.jk1;

    const facts = [gameName];
    if (m.mod)
        facts.push(`Mod: <b>${esc(m.mod)}</b>`);
    if (m.pack)
        facts.push("Remastered pack");
    if (customMap(m.episode))
        facts.push(`Custom map (${esc(m.episode)}, ${esc(m.map)})`);
    else if (m.episode)
        facts.push(esc(m.episode));
    facts.push(teams ? "Team play" : "Free-for-all");
    if (m.mode & MODE_COG_SCORES)
        facts.push("Scored by the level");
    if ((m.mode & MODE_SCORE_LIMIT) && m.score_limit)
        facts.push(`Score limit ${m.score_limit}`);
    if ((m.mode & MODE_TIME_LIMIT) && m.time_limit)
        facts.push(`Time limit ${m.time_limit} min`);
    facts.push(`Max rank ${m.max_rank}`);
    facts.push(time(m.started_at, "date"), length(m.secs));
    if (host >= 0)
        facts.push(`hosted by ${esc(names[host])}`);
    if (m.locked)
        facts.push("password game");

    // How well it's known: green when two games or more reported it, nine
    // in ten of its kills were seen by two, and no two of its players shared
    // a browser. (Whether it counts for standings also takes its length and
    // no password: a short match or a private one is as well known.)
    let badge;
    if (m.reporters >= 2 && m.confirmed >= COUNT_AGREE * m.kills && !detail.sharedKey)
        badge = `<span class="verified">Confirmed by ${m.reporters} of ${count(m.players, "player")}</span>`;
    else if (m.reporters < 2)
        badge = `<span class="verified one">Reported by ${m.reporters} of ${count(m.players, "player")}</span>`;
    else
        badge = `<span class="verified one">Reported by ${m.reporters} of ${count(m.players, "player")}, not confirmed</span>`;

    const result = winner.name !== null ? `${esc(winner.name || "Anonymous")} wins`
                 : winner.team ? `${TEAMS[winner.team]} team wins` : "";
    const teamLine = teams && teamScores
        ? `<p class="teams">${[...new Set(rows.map(r => r.team))].sort((a, b) => teamScores[b] - teamScores[a])
            .map(t => `<span class="team t${t}"><b>${TEAMS[t] || "No team"}</b> ${teamScores[t]}</span>`).join("")}</p>` : "";

    // A name is a link to its player, for one who has a record to show.
    const linked = (r, i) => r.pid && !r.hidden && r.name ? `<a href="${playerLink(r.pid, m.game, "")}">${esc(names[i])}</a>` : esc(names[i]);
    const board = rows.map((r, i) => `
            <tr class="${[r.won ? "winner" : "", you && r.pid === you ? "you" : ""].join(" ").trim()}">
              <td class="num">${placeCell(r.place)}</td>
              <td class="name"><b>${linked(r, i)}</b>${you && r.pid === you ? ` <span class="tag">You</span>` : ""}${r.host ? ` <span class="tag soft">Host</span>` : ""}</td>
              ${teams ? `<td><span class="team t${r.team}">${TEAMS[r.team] || "None"}</span></td>` : ""}
              <td class="num strong">${r.score ?? "&ndash;"}</td>
              <td class="num">${r.kills}</td>
              <td class="num">${r.deaths}</td>
              <td class="num">${r.suicides}</td>
              <td class="num">${r.streak}</td>
              <td class="num">${length(r.secs)}</td>
            </tr>`).join("");

    // Highlights: each only when there's something to say, and with every
    // player who shares it. spare: how many more any player might have that
    // the record can't place, which leaves a lead no bigger than that unsaid.
    const best = (key, min, spare = 0) => {
        const values = rows.map(r => typeof key === "function" ? key(r) : r[key]);
        const v = Math.max(...values);
        if (!(v >= min))
            return null;
        const first = names.filter((n, i) => values[i] === v);
        const next = Math.max(0, ...values.filter(x => x < v));
        return spare && (first.length > 1 || v - next <= spare) ? null : { v, names: first };
    };
    const held = (top, what = "") => top.names.length === 1 ? `${esc(top.names[0])}, ${top.v}${what}`
        : top.names.length === 2 ? `${esc(top.names[0])} and ${esc(top.names[1])}, ${top.v}${what} each`
        : `${top.names.length} players, ${top.v}${what} each`;
    const kinds = rows.map(r => parse(r.kinds, []));
    const kindTotals = [0, 0, 0, 0, 0];
    kinds.forEach(k => k.forEach((n, i) => { if (i < 5) kindTotals[i] += Number(n) || 0; }));
    const known = kindTotals.reduce((a, b) => a + b, 0);
    const killsByOthers = rows.reduce((a, r) => a + r.kills, 0);
    // Kills of a kind nobody told (their victim's game didn't report): any
    // of them could be anyone's saber or Force kill.
    const untold = Math.max(0, killsByOthers - known);
    const highlights = [];
    if (Number.isInteger(detail.firstBlood) && bySlot.has(detail.firstBlood))
        highlights.push(["First blood", esc(bySlot.get(detail.firstBlood))]);
    const streak = best("streak", 2);
    if (streak)
        highlights.push(["Longest streak", held(streak, " in one life")]);
    const saber = best(r => parse(r.kinds, [])[0] || 0, 1, untold);
    if (saber)
        highlights.push(["Most saber kills", held(saber)]);
    const force = best(r => parse(r.kinds, [])[3] || 0, 1, untold);
    if (force)
        highlights.push(["Most Force kills", held(force)]);
    const deaths = best("deaths", 1);
    if (deaths)
        highlights.push(["Most deaths", held(deaths)]);
    const suicides = best("suicides", 1);
    if (suicides)
        highlights.push(["Most suicides", held(suicides)]);

    const kindRows = KIND_NAMES.slice(1).map((name, i) => kindTotals[i] ? `<tr><td>${name}</td><td class="num">${kindTotals[i]}</td></tr>` : "")
        .join("") + (killsByOthers > known ? `<tr><td class="soft">Not known</td><td class="num soft">${killsByOthers - known}</td></tr>` : "");

    // Who killed whom: rows kill, columns die, a player's own square their
    // suicides.
    const slots = rows.map(r => r.slot);
    const grid = new Map(slots.map(s => [s, new Map(slots.map(t => [t, 0]))]));
    for (const k of Array.isArray(detail.kills) ? detail.kills : []) {
        const victim = k[1], killer = k[2] < 0 ? k[1] : k[2];
        if (grid.has(killer) && grid.get(killer).has(victim))
            grid.get(killer).set(victim, grid.get(killer).get(victim) + 1);
    }
    let most = 0;
    for (const s of slots)
        for (const t of slots)
            if (s !== t)
                most = Math.max(most, grid.get(s).get(t));
    const matrix = `<table class="matrix"><thead><tr><td></td>${rows.map((r, i) => `<th scope="col">${esc(names[i])}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr><th scope="row">${esc(names[i])}</th>${rows.map(c => {
            const n = grid.get(r.slot).get(c.slot);
            return r.slot === c.slot ? `<td class="self">${n || ""}</td>`
                                     : `<td${n && n === most ? ` class="top"` : ""}>${n}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table>`;

    const agree = isObject(detail.agree) ? detail.agree : {};
    const how = `Each player's game reports the kills it sees to the lobby. ${count(m.reporters, "game")} of ${m.players} reported this match, and ` +
                `${m.confirmed} of its ${count(m.kills, "kill")} ${m.confirmed === 1 ? "was" : "were"} seen by two games or more.` +
                (agree.sbRows ? ` The host's scoreboard matched for ${agree.sbSame} of ${count(agree.sbRows, "player")}.` : "") +
                (detail.sharedKey ? " Two of its players played from the same browser." : "");

    const title = `${m.title}${result ? ": " + (winner.name !== null ? (winner.name || "Anonymous") + " wins" : TEAMS[winner.team] + " team wins") : ""}`;
    const top = rows.slice(0, 8).map((r, i) => `${r.place}. ${names[i]} ${r.score ?? "-"} (${r.kills}/${r.deaths}/${r.suicides})`).join(" | ");
    const body = `
      <div class="ladder-main">
        <div class="ladder-head">
          <a class="back" href="/matches">&lsaquo; Matches</a>
          <span class="spacer"></span>
          ${badge}
        </div>
        <div class="ladder-head">
          <h2>${esc(m.title)}</h2>
          ${result ? `<span class="result">${result}</span>` : ""}
        </div>
        <p class="sub">${facts.join(" &middot; ")}</p>
        ${teamLine}
        <div class="scroll">
          <table class="ladder-table">
            <caption class="sr">Scoreboard</caption>
            <thead><tr>
              <th scope="col" class="num">#</th><th scope="col">Name</th>${teams ? `<th scope="col">Team</th>` : ""}
              <th scope="col" class="num">Score</th><th scope="col" class="num">Kills</th>
              <th scope="col" class="num">Deaths</th><th scope="col" class="num">Suicides</th>
              <th scope="col" class="num">Best streak</th><th scope="col" class="num">Time in</th>
            </tr></thead>
            <tbody>${board}
            </tbody>
          </table>
        </div>
        <div class="cards">
          ${highlights.length ? `<section class="card"><h3>Highlights</h3><div class="body"><table>
            ${highlights.map(([k, v]) => `<tr><td class="soft">${k}</td><td class="num">${v}</td></tr>`).join("")}
          </table></div></section>` : ""}
          ${kindRows ? `<section class="card"><h3>Kills by</h3><div class="body"><table>${kindRows}</table></div></section>` : ""}
          <section class="card wide"><h3>Who killed whom</h3><div class="body">
            <div class="scroll">${matrix}</div>
            <p class="later">Rows killed columns. A player's own square is their suicides.</p>
          </div></section>
        </div>
        <p class="foot">${how}</p>
      </div>
      ${side}`;
    return page(200, `${title} - jkdf2mp match ${id}`, `${GAMES_LONG[m.game] || GAMES_LONG.jk1} - Match ${id}`, body, {
        description: `${gameName}${m.mod ? " with " + m.mod : ""}, ${count(m.players, "player")}, ${length(m.secs)}. ${top}`,
        ogTitle: title, path: `/match/${id}`,
    });
}

// GET /matches
export async function matchesPage(db, url) {
    const game = GAME_PARAM[url.searchParams.get("game") || ""] || "";
    const beforeText = url.searchParams.get("before") || "";
    const before = /^[1-9][0-9]{0,8}$/.test(beforeText) ? Number(beforeText) : 0;
    const answers = await db.batch(listQueries(db, game, before, PAGE + 1));
    const list = listed(answers[0].results, answers[1].results);
    const more = list.length > PAGE;
    const shown = list.slice(0, PAGE);
    const link = (g, b) => "/matches" + (g || b ? "?" + [g ? `game=${g === "jk1" ? "jk" : g}` : "", b ? `before=${b}` : ""]
        .filter(Boolean).join("&amp;") : "");
    const tab = (g, label) => `<a href="${link(g, 0)}"${g === game ? ` aria-current="page"` : ""}>${g ? gameBall(g) : ""}${label}</a>`;
    const rows = shown.map(m => `
            <tr>
              <td class="level"><a href="/match/${m.id}">${esc(m.title)}</a>${customMap(m.episode) ? ` <span class="tag soft">Custom</span>` : ""}</td>
              ${game ? "" : `<td class="game">${gameBall(m.game)}${GAMES[m.game] || GAMES.jk1}</td>`}
              <td class="mod">${esc(m.mod) || (m.pack ? "Remastered pack" : `<span class="soft">&ndash;</span>`)}</td>
              <td class="num">${m.players}</td>
              <td class="num">${length(m.secs)}</td>
              <td>${wonLine(m.winner).replace(/^Won by /, "")}</td>
              <td class="num strong">${m.winner.score ?? "&ndash;"}</td>
              <td class="when">${time(m.ended_at, "ago")}</td>
            </tr>`).join("");
    const body = `
      <div class="ladder-main full">
        <div class="ladder-head">
          <h2>Latest matches</h2>
          <nav class="tabs" aria-label="Game">${tab("", "Both games")}${tab("jk1", GAMES.jk1)}${tab("mots", GAMES.mots)}</nav>
        </div>
        ${shown.length ? `<div class="scroll">
          <table class="ladder-table">
            <thead><tr>
              <th scope="col">Level</th>${game ? "" : `<th scope="col">Game</th>`}<th scope="col">Mod</th>
              <th scope="col" class="num">Players</th><th scope="col" class="num">Length</th>
              <th scope="col">Won by</th><th scope="col" class="num">Score</th><th scope="col">Played</th>
            </tr></thead>
            <tbody>${rows}
            </tbody>
          </table>
        </div>` : `<p class="empty"><b>${before ? "No older matches." : "No matches recorded yet."}</b>
          A match is recorded when two or more players play a level in a <a href="/#rooms">game room</a>
          for a minute or more.</p>`}
        ${more ? `<p class="pager"><a href="${link(game, shown[shown.length - 1].id)}">Older matches &rsaquo;</a></p>` : ""}
        <p class="foot">Each player's game reports the kills it sees, and the lobby puts the reports together.
          Games with a password aren't listed here.</p>
      </div>`;
    return page(200, `${game ? GAMES[game] + " matches" : "Latest matches"} - jkdf2mp`,
                `${game ? GAMES_LONG[game] : "Jedi Knight"} - Latest Matches`, body, {
        description: "The latest multiplayer matches played in the jkdf2mp game rooms.",
        ogTitle: `${game ? GAMES[game] + " matches" : "Latest matches"} - jkdf2mp Game Rooms`,
        path: link(game, 0).replace(/&amp;/g, "&"),
    });
}

function viewerQuery(db, hash) {
    return db.prepare("SELECT COALESCE(merged_into, id) AS id FROM players WHERE key_hash = ?").bind(hash);
}

const ZONE_CLOCK = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
});

// The standings' clock: what the date and time are in its zone.
function zoneClock(ms) {
    const c = {};
    for (const part of ZONE_CLOCK.formatToParts(new Date(ms)))
        if (part.type !== "literal")
            c[part.type] = Number(part.value);
    return c;
}

// And when it is, or was, a given hour of a given day there.
function zoneTime(year, month, day, hour) {
    const wall = Date.UTC(year, month - 1, day, hour);
    let ms = wall;
    for (let i = 0; i < 3; i++) {
        const c = zoneClock(ms);
        ms += wall - Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
    }
    return ms;
}

// When a period began: this week's Monday or this month's first day at
// TURN_HOUR, 0 for all time.
export function periodStart(period, now) {
    if (period !== "week" && period !== "month")
        return 0;
    const c = zoneClock(now);
    // The day it still is there: before the hour, yesterday's.
    const day = new Date(Date.UTC(c.year, c.month - 1, c.day) - (c.hour < TURN_HOUR ? DAY_MS : 0));
    if (period === "week")
        day.setTime(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
    return zoneTime(day.getUTCFullYear(), day.getUTCMonth() + 1, period === "week" ? day.getUTCDate() : 1, TURN_HOUR);
}

// The matches standings are added up from: a game's that count, since a time.
const COUNTED = "m.game = ? AND m.counted = 1 AND m.hidden = 0 AND m.locked = 0 AND m.ended_at >= ?";

// A game's players since a time, each with what they did in the matches that
// count: a record's every key together, without the records taken off the
// pages.
function standingsQuery(db, game, from) {
    return db.prepare(
        `SELECT c.id, c.name, COUNT(*) AS matches, SUM(mp.won) AS wins, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths,
                SUM(mp.suicides) AS suicides, SUM(mp.secs) AS secs, MAX(mp.streak) AS streak, MAX(mp.kills) AS best,
                MAX(m.ended_at) AS last_at
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         JOIN players p ON p.id = mp.player_id
         JOIN players c ON c.id = COALESCE(p.merged_into, p.id)
         WHERE ${COUNTED} AND c.hidden = 0
         GROUP BY c.id`).bind(game, from);
}

// Every game's standings over every period: {jk1: {week: {matches, rows}, month,
// all}, mots: ...}, rows as standingsQuery gives them and matches how many
// were added up. Adding them up reads every match's rows, so it's done once
// and kept in D1 (ladder_cache) under a stamp of what it depends on: the
// newest match, when the week and the month began, and the day (so a record
// changed by hand shows within a day at most, or at once when ladder_cache
// is emptied). A page then reads the six kept rows; the first one after a
// match is saved adds them up again. also: more statements for the same
// round trip, whose answers come back as more.
async function standings(db, now, also = []) {
    const games = Object.keys(GAMES), periods = Object.keys(PERIODS);
    const from = Object.fromEntries(periods.map(p => [p, periodStart(p, now)]));
    const answers = await db.batch([
        db.prepare("SELECT COALESCE(MAX(id), 0) AS latest FROM matches"),
        db.prepare("SELECT key, stamp, value FROM ladder_cache WHERE key LIKE 'board:%'"),
        ...also,
    ]);
    const more = answers.slice(2);
    const stamp = [BOARD_V, answers[0].results[0].latest, from.week, from.month, Math.floor(now / DAY_MS)].join(":");
    const kept = new Map(answers[1].results.filter(r => r.stamp === stamp).map(r => [r.key, parse(r.value, null)]));
    const boards = {};
    let whole = true;
    for (const game of games) {
        boards[game] = {};
        for (const period of periods) {
            const b = kept.get(`board:${game}:${period}`);
            whole = whole && isObject(b) && Array.isArray(b.rows);
            boards[game][period] = b;
        }
    }
    if (whole)
        return { boards, more };
    const pairs = games.flatMap(game => periods.map(period => [game, period]));
    const fresh = await db.batch(pairs.flatMap(([game, period]) => [
        standingsQuery(db, game, from[period]),
        db.prepare(`SELECT COUNT(*) AS n FROM matches m WHERE ${COUNTED}`).bind(game, from[period]),
    ]));
    pairs.forEach(([game, period], i) => {
        boards[game][period] = { matches: fresh[i * 2 + 1].results[0].n, rows: fresh[i * 2].results };
    });
    try {
        await db.batch(pairs.map(([game, period]) => db.prepare(
            "INSERT OR REPLACE INTO ladder_cache (key, stamp, value) VALUES (?, ?, ?)")
            .bind(`board:${game}:${period}`, stamp, JSON.stringify(boards[game][period]))));
    } catch (e) {
        // The page has them all the same; the next one adds them up again.
        console.log(`ladder: the standings weren't kept (${e && e.message || e})`);
    }
    return { boards, more };
}

// Its rows with what's worked out from them. Score is kills less suicides, as
// the game's own scoreboard has it, whatever a level scored by.
function standing(rows) {
    return rows.map(r => ({ ...r, score: r.kills - r.suicides, kd: r.kills / Math.max(1, r.deaths),
                            qualified: r.kills + r.deaths >= KD_MIN }));
}

function byScore(a, b) {
    return b.score - a.score || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id;
}

// The standings' columns: what each sorts by.
const COLUMNS = [
    ["score", "Score", r => r.score], ["kills", "Kills", r => r.kills], ["deaths", "Deaths", r => r.deaths],
    ["suicides", "Suicides", r => r.suicides], ["kd", "K/D", r => r.kd], ["matches", "Matches", r => r.matches],
    ["wins", "Wins", r => r.wins], ["time", "Time", r => r.secs],
];

function num(n) {
    return Number(n).toLocaleString("en-US");
}

function ratio(kd) {
    return kd.toFixed(2);
}

function ordinal(n) {
    const tens = n % 100, ones = n % 10;
    return n + (tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th");
}

// A long time: hours and minutes.
function span(secs) {
    const min = Math.round(secs / 60);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

function standingCell(r, key) {
    if (key === "kd")
        return ratio(r.kd) + (r.qualified ? "" : "&nbsp;&dagger;");
    if (key === "time")
        return span(r.secs);
    return num(COLUMNS.find(c => c[0] === key)[2](r));
}

function query(parts) {
    const q = Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
    return q.length ? "?" + q.join("&amp;") : "";
}

function playersLink(game, period, sort, up) {
    return "/players" + query({ game: game === "mots" ? "mots" : "", period, sort: sort === "score" ? "" : sort, dir: up ? "asc" : "" });
}

// A player's page says its game: without one it shows the game they played last.
function playerLink(id, game, period) {
    return `/player/${id}` + query({ game: game === "mots" ? "mots" : game === "jk1" ? "jk" : "", period });
}

function tabs(label, items, current) {
    return `<nav class="tabs" aria-label="${label}">${items.map(([key, text, href]) =>
        `<a href="${href}"${key === current ? ` aria-current="page"` : ""}>${text}</a>`).join("")}</nav>`;
}

const HOW_COUNTED = `Only matches that count are added up: two minutes or longer, reported by two games or more, and with no password.
          A week starts on Monday and a month on its first day, at 3 in the morning Pacific time.`;

// GET /players
export async function playersPage(db, url, viewerHash, now) {
    const game = GAME_PARAM[url.searchParams.get("game") || ""] || "jk1";
    const asked = url.searchParams.get("period") || "";
    const periods = PERIODS[asked] ? [asked] : Object.keys(PERIODS);
    const sortAsked = url.searchParams.get("sort") || "";
    const sort = sortAsked === "name" || COLUMNS.some(c => c[0] === sortAsked) ? sortAsked : "score";
    const up = url.searchParams.get("dir") === "asc";
    const statements = [
        db.prepare(`SELECT m.id, m.title, m.ended_at FROM matches m WHERE ${COUNTED} ORDER BY m.id DESC LIMIT 1`).bind(game, 0),
    ];
    if (viewerHash)
        statements.push(viewerQuery(db, viewerHash));
    const { boards, more: answers } = await standings(db, now, statements);
    const you = viewerHash && answers[1].results[0] ? answers[1].results[0].id : 0;
    const last = answers[0].results[0];
    // The period asked for, or the shortest one anyone played in.
    const period = periods.find(p => boards[game][p].rows.length) || periods[0];
    const rows = standing(boards[game][period].rows);
    const matches = boards[game][period].matches;
    const value = sort === "name" ? null : COLUMNS.find(c => c[0] === sort)[2];
    rows.sort((a, b) => {
        if (sort === "name")
            return (up ? 1 : -1) * a.name.localeCompare(b.name) || byScore(a, b);
        if (sort === "kd" && a.qualified !== b.qualified)
            return a.qualified ? -1 : 1;
        return (up ? 1 : -1) * (value(a) - value(b)) || byScore(a, b);
    });
    const shown = rows.slice(0, BOARD);
    const arrow = up ? " &#9650;" : " &#9660;";
    const head = (key, label, cls) => `<th scope="col"${cls ? ` class="${cls}"` : ""}${key === sort ? ` aria-sort="${up ? "ascending" : "descending"}"` : ""}>` +
        `<a href="${playersLink(game, period, key, key === sort ? !up : key === "name")}">${label}${key === sort ? arrow : ""}</a></th>`;
    let place = 0, unranked = false;
    const body = shown.map(r => {
        const ranked = !(sort === "kd" && !r.qualified);
        if (!r.qualified)
            unranked = true;
        return `
            <tr${r.id === you ? ` class="you"` : ""}>
              <td class="num">${ranked ? placeCell(++place) : "&ndash;"}</td>
              <td class="name"><a href="${playerLink(r.id, game, period)}">${esc(r.name)}</a>${r.id === you ? ` <span class="tag">You</span>` : ""}</td>
              ${COLUMNS.map(([key]) => `<td class="num${key === sort ? " sorted" : ""}${key === "kd" && !r.qualified ? " soft" : ""}">${standingCell(r, key)}</td>`).join("")}
            </tr>`;
    }).join("");
    const gameTabs = tabs("Game", Object.keys(GAMES).map(g => [g, gameBall(g) + GAMES[g], playersLink(g, asked, sort, up)]), game);
    const periodTabs = tabs("Period", Object.keys(PERIODS).map(p => [p, PERIODS[p], playersLink(game, p, sort, up)]), period);
    const kills = rows.reduce((n, r) => n + r.kills, 0);
    const empty = !last
        ? `<p class="empty"><b>No ${GAMES[game]} matches count yet.</b>
           A match counts when two or more players play a level in a <a href="/#rooms">game room</a> for two minutes or more.</p>`
        : `<p class="empty"><b>No ${GAMES[game]} matches yet ${PERIODS_LC[period]}.</b>
           The last one was <a href="/match/${last.id}">${esc(last.title)}</a>, ${time(last.ended_at, "ago")}.
           <a href="${playersLink(game, "all", sort, up)}">Show all time</a></p>`;
    const main = `
      <div class="ladder-main full">
        <div class="ladder-head">
          <h2>${GAMES[game]} standings</h2>
          ${gameTabs}
        </div>
        <div class="ladder-head">
          <p class="sub">${rows.length ? `${PERIODS[period]} &middot; ${count(rows.length, "player")} &middot; ${count(matches, "match", "matches")} &middot; ${num(kills)} kills` : PERIODS[period]}</p>
          ${periodTabs}
        </div>
        ${rows.length ? `<div class="scroll">
          <table class="ladder-table standings">
            <caption class="sr">${GAMES[game]} standings, ${PERIODS_LC[period]}</caption>
            <thead><tr>
              <th scope="col" class="num">#</th>${head("name", "Player", "")}
              ${COLUMNS.map(([key, label]) => head(key, label, "num")).join("")}
            </tr></thead>
            <tbody>${body}
            </tbody>
          </table>
        </div>` : empty}
        ${rows.length > BOARD ? `<p class="foot">The first ${BOARD} of ${count(rows.length, "player")}.</p>` : ""}
        <p class="foot">Score is kills minus suicides, as on the game's own scoreboard. Deaths include suicides.
          ${unranked ? `&dagger; Fewer than ${KD_MIN} kills and deaths ${PERIODS_LC[period]}: K/D is shown but takes no place. ` : ""}Pick a column to sort by it.
          ${HOW_COUNTED}</p>
      </div>`;
    return page(200, `${GAMES[game]} standings, ${PERIODS_LC[period]} - jkdf2mp`, `${GAMES_LONG[game]} - Standings`, main, {
        description: `Who leads the ${GAMES[game]} game rooms ${PERIODS_LC[period]}: kills, deaths, wins and time played.`,
        ogTitle: `${GAMES[game]} standings - jkdf2mp Game Rooms`,
        path: playersLink(game, asked, "score", false).replace(/&amp;/g, "&"),
    });
}

// GET /player/<id>
export async function playerPage(db, id, url, viewerHash, now) {
    const games = Object.keys(GAMES);
    const week = periodStart("week", now), month = periodStart("month", now);
    // Who it is (a key's own number goes on to its record), and when they
    // played which game.
    const first = [
        db.prepare(`SELECT c.id, c.name, c.hidden, c.first_at,
                           (SELECT COUNT(*) FROM players k WHERE k.id = c.id OR k.merged_into = c.id) AS browsers
                    FROM players p JOIN players c ON c.id = COALESCE(p.merged_into, p.id) WHERE p.id = ?`).bind(id),
        db.prepare(`SELECT m.game, COUNT(*) AS n, MAX(m.ended_at) AS last_at, SUM(m.counted) AS counted,
                           SUM(m.counted AND m.ended_at >= ?) AS week, SUM(m.counted AND m.ended_at >= ?) AS month
                    FROM match_players mp JOIN matches m ON m.id = mp.match_id
                    JOIN players p ON p.id = mp.player_id
                    WHERE COALESCE(p.merged_into, p.id) = (SELECT COALESCE(merged_into, id) FROM players WHERE id = ?)
                          AND m.hidden = 0 AND m.locked = 0
                    GROUP BY m.game`).bind(week, month, id),
    ];
    if (viewerHash)
        first.push(viewerQuery(db, viewerHash));
    const { boards, more: found } = await standings(db, now, first);
    const who = found[0].results[0];
    if (!who || who.hidden) {
        return page(404, "No such player", "The match record",
                    `<div class="ladder-main full"><p class="empty"><b>There's no player ${id}.</b>
                     Their record may have been removed. <a href="/players">See the standings</a></p></div>`,
                    { noStore: true });
    }
    const search = url.search || "";
    if (who.id !== id)
        return new Response(null, { status: 302, headers: { Location: `/player/${who.id}${search}`, "Cache-Control": "no-store" } });
    const you = viewerHash && found[2].results[0] ? found[2].results[0].id : 0;
    const played = new Map(found[1].results.map(r => [r.game, r]));
    // The game asked for, or the one they played last; the period asked for,
    // or the shortest they played it in.
    const game = GAME_PARAM[url.searchParams.get("game") || ""] ||
                 games.filter(g => played.has(g)).sort((a, b) => played.get(b).last_at - played.get(a).last_at)[0] || "jk1";
    const asked = url.searchParams.get("period") || "";
    const in_ = played.get(game) || { n: 0, counted: 0, week: 0, month: 0, last_at: 0 };
    const period = PERIODS[asked] ? asked : in_.week ? "week" : in_.month ? "month" : "all";
    const from = periodStart(period, now);

    // Their matches: a record's and its other keys'.
    const MINE = "mp.player_id IN (SELECT id FROM players WHERE id = ? OR merged_into = ?)";
    const mine = `FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE ${MINE} AND ${COUNTED}`;
    const args = [id, id, game, from];
    const latest = `SELECT m.id ${mine} ORDER BY m.id DESC LIMIT ${RIVAL_MATCHES}`;
    const answers = await db.batch([
        db.prepare(`SELECT SUM(json_extract(mp.kinds, '$[0]')) AS k0, SUM(json_extract(mp.kinds, '$[1]')) AS k1,
                           SUM(json_extract(mp.kinds, '$[2]')) AS k2, SUM(json_extract(mp.kinds, '$[3]')) AS k3,
                           SUM(json_extract(mp.kinds, '$[4]')) AS k4, SUM(mp.host) AS hosted,
                           SUM(json_extract(m.detail, '$.firstBlood') = mp.slot) AS first_bloods ${mine}`).bind(...args),
        db.prepare(`SELECT MAX(m.id) AS latest, m.title, m.episode, COUNT(*) AS n ${mine}
                    GROUP BY m.episode, m.map ORDER BY n DESC, latest DESC LIMIT 3`).bind(...args),
        db.prepare(`SELECT m.mod, m.pack, COUNT(*) AS n ${mine} GROUP BY m.mod, m.pack ORDER BY n DESC, MAX(m.id) DESC LIMIT 3`).bind(...args),
        db.prepare(`SELECT m.id, m.title, mp.kills ${mine} ORDER BY mp.kills DESC, m.id DESC LIMIT 1`).bind(...args),
        db.prepare(`SELECT m.id, m.title, m.episode, m.mod, m.pack, m.players, m.secs, m.ended_at, m.counted, m.mode,
                           mp.name, mp.place, mp.won, mp.score, mp.kills, mp.deaths, mp.suicides
                    FROM match_players mp JOIN matches m ON m.id = mp.match_id
                    WHERE ${MINE} AND m.game = ? AND m.hidden = 0 AND m.locked = 0
                    ORDER BY m.id DESC LIMIT ${PLAYER_MATCHES}`).bind(id, id, game),
        db.prepare(`SELECT mp.name, MAX(m.ended_at) AS last_at
                    FROM match_players mp JOIN matches m ON m.id = mp.match_id
                    WHERE ${MINE} AND m.hidden = 0 AND m.locked = 0 AND mp.name != ''
                    GROUP BY mp.name COLLATE NOCASE ORDER BY last_at DESC LIMIT 6`).bind(id, id),
        db.prepare(`SELECT id, detail FROM matches WHERE id IN (${latest})`).bind(...args),
        db.prepare(`SELECT mp.match_id, mp.slot, mp.name, c.id AS pid, c.name AS known, COALESCE(c.hidden, 0) AS hidden
                    FROM match_players mp ${RECORD_JOIN} WHERE mp.match_id IN (${latest})`).bind(...args),
    ]);
    const board = standing(boards[game][period].rows).sort(byScore);
    const rank = board.findIndex(r => r.id === id);
    const me = rank < 0 ? null : board[rank];
    const extra = answers[0].results[0] || {};
    const maps = answers[1].results, mods = answers[2].results, best = answers[3].results[0];
    const names = answers[5].results.map(r => r.name).filter(n => n.toLowerCase() !== who.name.toLowerCase());

    // Who they met: from each match's kills, by the others' records where
    // they have one and by the name they played under where not.
    const seats = new Map();
    for (const r of answers[7].results) {
        if (!seats.has(r.match_id))
            seats.set(r.match_id, new Map());
        seats.get(r.match_id).set(r.slot, r);
    }
    const met = new Map();
    const other = r => {
        const shown = r.pid && !r.hidden && r.name;
        const key = shown ? `p${r.pid}` : r.name && !r.hidden ? `n${r.name.toLowerCase()}` : "anonymous";
        if (!met.has(key))
            met.set(key, { name: shown ? r.known : r.name && !r.hidden ? r.name : "Anonymous players", pid: shown ? r.pid : 0, killed: 0, by: 0 });
        return met.get(key);
    };
    for (const m of answers[6].results) {
        const inMatch = seats.get(m.id) || new Map();
        const kills = parse(m.detail, {}).kills;
        for (const k of Array.isArray(kills) ? kills : []) {
            const victim = inMatch.get(k[1]), killer = inMatch.get(k[2]);
            if (!victim || !killer || victim === killer)
                continue;
            if (killer.pid === id && victim.pid !== id)
                other(victim).killed++;
            else if (victim.pid === id && killer.pid !== id)
                other(killer).by++;
        }
    }
    const rivals = [...met.values()].sort((a, b) => (b.killed + b.by) - (a.killed + a.by) || b.killed - a.killed);
    const rival = r => r.pid ? `<a href="${playerLink(r.pid, game, "")}">${esc(r.name)}</a>` : esc(r.name);
    const nemesis = rivals.filter(r => r.by).sort((a, b) => b.by - a.by)[0];
    const target = rivals.filter(r => r.killed).sort((a, b) => b.killed - a.killed)[0];

    const gameTabs = tabs("Game", games.map(g => [g, gameBall(g) + GAMES[g], playerLink(id, g, asked)]), game);
    const periodTabs = tabs("Period", Object.keys(PERIODS).map(p => [p, PERIODS[p], playerLink(id, game, p)]), period);
    const youTag = you === id ? ` <span class="tag">You</span>` : "";
    const facts = [];
    if (me)
        facts.push(`${ordinal(rank + 1)} of ${board.length} ${PERIODS_LC[period]}`);
    facts.push(GAMES[game]);
    if (in_.last_at)
        facts.push(`last played ${time(in_.last_at, "ago")}`);
    facts.push(`first seen ${time(who.first_at, "day")}`);
    const head = `
        <div class="ladder-head">
          <a class="back" href="${playersLink(game, asked, "score", false)}">&lsaquo; Standings</a>
          <span class="spacer"></span>
          ${gameTabs}
        </div>
        <div class="ladder-head">
          <h2>${esc(who.name)}${youTag}</h2>
          <span class="spacer"></span>
          ${periodTabs}
        </div>
        <p class="sub">${facts.join(" &middot; ")}${names.length ? `<br>Also played as ${names.map(n => `<b>${esc(n)}</b>`).join(", ")}` : ""}</p>`;

    const kindTotals = [extra.k0, extra.k1, extra.k2, extra.k3, extra.k4].map(n => Number(n) || 0);
    const known = kindTotals.reduce((a, b) => a + b, 0);
    const kindRows = me ? KIND_NAMES.slice(1).map((name, i) => kindTotals[i]
        ? `<tr><td class="soft">${name}</td><td class="num">${num(kindTotals[i])}</td><td class="num soft">${Math.round(100 * kindTotals[i] / me.kills)}%</td></tr>` : "").join("") +
        (me.kills > known ? `<tr><td class="soft">Not known</td><td class="num soft">${num(me.kills - known)}</td><td class="num soft">${Math.round(100 * (me.kills - known) / me.kills)}%</td></tr>` : "") : "";
    const modName = m => m.mod || (m.pack ? "Remastered pack" : "No mod");
    const stats = me ? `
        <dl class="stats" aria-label="${esc(who.name)}, ${GAMES[game]}, ${PERIODS_LC[period]}">
          ${COLUMNS.map(([key, label]) => `<div${key === "score" ? ` class="strong"` : ""}><dt>${label}</dt><dd${key === "kd" && !me.qualified ? ` class="soft"` : ""}>${standingCell(me, key)}</dd></div>`).join("")}
          <div><dt>Best match</dt><dd>${best ? `<a href="/match/${best.id}">${count(best.kills, "kill")}</a>` : "&ndash;"}</dd></div>
          <div><dt>Best streak</dt><dd>${me.streak}</dd></div>
        </dl>
        <div class="cards ${kindRows ? "three" : "two"}">
          <section class="card"><h3>Rivals</h3><div class="body"><table>
            <tr><td class="soft">Nemesis</td><td class="num">${nemesis ? `${rival(nemesis)}, killed by them ${num(nemesis.by)}&times;` : "&ndash;"}</td></tr>
            <tr><td class="soft">Favorite target</td><td class="num">${target ? `${rival(target)}, killed ${num(target.killed)}&times;` : "&ndash;"}</td></tr>
            <tr><td class="soft">First bloods</td><td class="num">${num(Number(extra.first_bloods) || 0)}</td></tr>
            <tr><td class="soft">Kills per 10 min</td><td class="num">${me.secs ? (me.kills / (me.secs / 600)).toFixed(1) : "&ndash;"}</td></tr>
            <tr><td class="soft">Win rate</td><td class="num">${Math.round(100 * me.wins / me.matches)}%</td></tr>
            <tr><td class="soft">Matches hosted</td><td class="num">${num(Number(extra.hosted) || 0)}</td></tr>
          </table></div></section>
          ${kindRows ? `<section class="card"><h3>How the kills came</h3><div class="body"><table>${kindRows}</table></div></section>` : ""}
          <section class="card"><h3>Played most</h3><div class="body"><table>
            ${maps.map(m => `<tr><td>${esc(m.title)}${customMap(m.episode) ? ` <span class="tag soft">Custom</span>` : ""}</td><td class="num count">${count(m.n, "match", "matches")}</td></tr>`).join("")}
            ${mods.map(m => `<tr><td class="soft">${esc(modName(m))}</td><td class="num count">${count(m.n, "match", "matches")}</td></tr>`).join("")}
          </table></div></section>
          ${rivals.length ? `<section class="card wide"><h3>Head to head</h3><div class="body">
            <div class="scroll"><table class="versus">
              <thead><tr><th scope="col">Against</th><th scope="col" class="num">Killed them</th><th scope="col" class="num">Killed by them</th><th scope="col" class="num">Difference</th></tr></thead>
              <tbody>${rivals.slice(0, RIVALS).map(r => `<tr><td>${rival(r)}</td><td class="num">${num(r.killed)}</td><td class="num">${num(r.by)}</td>
                <td class="num ${r.killed >= r.by ? "up" : "down"}">${r.killed > r.by ? "+" : ""}${num(r.killed - r.by)}</td></tr>`).join("")}</tbody>
            </table></div>
            <p class="later">From ${me.matches > RIVAL_MATCHES ? `the latest ${RIVAL_MATCHES} matches` : count(me.matches, "match", "matches")} ${PERIODS_LC[period]}.</p>
          </div></section>` : ""}
        </div>` : `<p class="empty"><b>${esc(who.name)} has no ${GAMES[game]} matches that count ${PERIODS_LC[period]}.</b>
           ${period !== "all" && in_.counted ? `<a href="${playerLink(id, game, "all")}">Show all time</a>` : ""}</p>`;

    const recent = answers[4].results;
    const matchRows = recent.map(r => `
            <tr>
              <td class="level"><a href="/match/${r.id}">${esc(r.title)}</a>${customMap(r.episode) ? ` <span class="tag soft">Custom</span>` : ""}${r.counted ? "" : ` <span class="tag soft">Not counted</span>`}</td>
              <td class="mod">${esc(r.mod) || (r.pack ? "Remastered pack" : `<span class="soft">&ndash;</span>`)}</td>
              <td class="num">${r.won ? `<span class="place p1">1</span>` : ordinal(r.place)} of ${r.players}</td>
              <td class="num strong">${r.score ?? "&ndash;"}</td>
              <td class="num">${r.kills} / ${r.deaths} / ${r.suicides}</td>
              <td class="num">${length(r.secs)}</td>
              <td class="when">${time(r.ended_at, "ago")}</td>
            </tr>`).join("");
    const main = `
      <div class="ladder-main full">
        ${head}
        ${stats}
        ${recent.length ? `<h3 class="part">Latest ${GAMES[game]} matches</h3>
        <div class="scroll">
          <table class="ladder-table">
            <thead><tr>
              <th scope="col">Level</th><th scope="col">Mod</th><th scope="col" class="num">Place</th>
              <th scope="col" class="num">Score</th><th scope="col" class="num">Kills / deaths / suicides</th>
              <th scope="col" class="num">Length</th><th scope="col">Played</th>
            </tr></thead>
            <tbody>${matchRows}
            </tbody>
          </table>
        </div>` : ""}
        <p class="foot">${me && !me.qualified ? `&dagger; Fewer than ${KD_MIN} kills and deaths ${PERIODS_LC[period]}: K/D is shown but takes no place in the standings. ` : ""}${HOW_COUNTED}
          A player here is a browser, together with any new browser that later played under the same name${who.browsers > 1 ? ` (this record has matches from ${who.browsers} browsers)` : ""}.</p>
      </div>`;
    const line = me ? `${num(me.kills)} kills, ${num(me.deaths)} deaths, ${count(me.matches, "match", "matches")}, ${span(me.secs)} played ${PERIODS_LC[period]}.` : "";
    return page(200, `${who.name} - ${GAMES[game]} - jkdf2mp`, `${GAMES_LONG[game]} - ${who.name}`, main, {
        description: `${who.name} in the ${GAMES[game]} game rooms. ${line}`.trim(),
        ogTitle: `${who.name} - jkdf2mp Game Rooms`, path: `/player/${id}`,
    });
}

const STYLE = `
:root {
  --teal: #336666; --teal-light: #669999; --teal-dark: #003333; --gold: #ffcc66; --link: #ffffcc;
  --muted: #99cccc; --ink: #ffffff; --win-grey: #d4d0c8; --win-dark: #808080; --live: #33cc66;
  --rule: #224444; --card: #061a1a; --card-rule: #1c3838; --card-edge: #2a4d4d; --head: #0b2a2a;
  color-scheme: dark;
}
html.style-2001 {
  --teal: #006699; --teal-light: #53b5e6; --teal-dark: #004c73; --muted: #bfe1f1; --gold: #8fd0f2;
  --tab: #3399cc; --tab-dark: #1f7fb8; --rule: #1b3f55; --card: #04131d; --card-rule: #14324a;
  --card-edge: #1b4a66; --head: #082033;
}
html { background-color: var(--teal); }
body { margin: 0; background-color: var(--teal); color: var(--ink); font: 14px/1.35 Arial, Helvetica, sans-serif; }
a { color: var(--link); text-decoration: underline; }
a:hover { color: var(--gold); }
:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.zone-page { max-width: 1000px; }
.topnav { display: flex; flex-wrap: wrap; background-color: var(--teal-dark); border-bottom: 1px solid #000;
  font: bold 15px Verdana, Geneva, sans-serif; }
.topnav a { padding: 3px 8px; border-right: 1px solid var(--teal-light); }
.style-pick { display: flex; align-items: center; gap: 4px; margin-left: auto; padding: 2px 8px; color: var(--muted);
  font: bold 12px Verdana, Geneva, sans-serif; }
.style-pick span { margin-right: 2px; }
.style-pick button { padding: 1px 7px; border: 1px solid var(--gold); background-color: transparent; color: var(--gold);
  font: inherit; cursor: pointer; }
.style-pick button:hover { background-color: rgba(255, 204, 102, 0.2); }
.style-pick button[aria-pressed=true] { background-color: var(--gold); color: #000; cursor: default; }
.masthead { display: flex; flex-wrap: wrap; align-items: stretch;
  background: linear-gradient(100deg, var(--teal-dark) 0 62%, var(--teal) 62%); }
.brand { padding: 10px 14px 8px; min-width: 190px; }
.brand a { text-decoration: none; }
.brand-mark { font: italic bold 40px/1 Verdana, Geneva, sans-serif; letter-spacing: -2px; color: #fff; }
.brand-mark span { color: var(--gold); }
.brand-sub { margin-top: 4px; font: bold 17px Verdana, Geneva, sans-serif; letter-spacing: 3px; text-transform: uppercase;
  color: var(--muted); }
.banner { flex: 1 1 300px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px;
  padding: 10px 14px; background-color: #fff; border: 1px solid #000; color: #003333; }
.banner p { margin: 0; font: bold 15px Verdana, Geneva, sans-serif; }
.banner small { display: block; margin-top: 3px; font: 12px Arial, sans-serif; color: #335555; }
.banner a.play { flex: none; padding: 8px 20px; border: 2px outset #ffe7a8;
  background: linear-gradient(#ffe7a8, #ffcc66 55%, #e8a93a); color: #1a1a00; font: bold 18px Verdana, Geneva, sans-serif;
  text-decoration: none; text-shadow: 0 1px 0 #fff3cf; white-space: nowrap; }
.banner a.play:hover { background: linear-gradient(#fff1c9, #ffd780 55%, #f0b549); color: #1a1a00; }
.goldnav { display: flex; flex-wrap: wrap; background-color: var(--gold); border-top: 1px solid #000;
  border-bottom: 1px solid #000; font: bold 15px Arial, Helvetica, sans-serif; }
.goldnav a { padding: 2px 12px; border-right: 1px solid #000; color: #000; text-decoration: none; }
.goldnav a:hover { background-color: #ffe0a0; color: #000; }
main { padding: 12px 8px 24px; }

.window { border: 2px solid #000; background-color: var(--win-grey); color: #000;
  font: 13px/1.35 Verdana, Geneva, sans-serif; box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.45); }
.titlebar { padding: 4px 12px; background-color: var(--gold); border-bottom: 1px solid #000; }
.titlebar h1 { margin: 0; font: bold 15px Verdana, Geneva, sans-serif; overflow-wrap: anywhere; }
.win-body { display: flex; align-items: stretch; border-top: 2px solid #fff; }
.ladder-main { flex: 1; min-width: 0; padding: 12px; background-color: #000; color: #fff;
  border-right: 2px solid var(--win-dark); }
.ladder-main.full { border-right: 0; }
.ladder-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0 0 8px; }
.ladder-head h2 { margin: 0; font: bold 18px Verdana, Geneva, sans-serif; color: var(--gold); overflow-wrap: anywhere; }
.ladder-head .result { font-weight: bold; }
.ladder-head .back { font: bold 12px Verdana, sans-serif; }
.ladder-head .spacer { flex: 1; }
.sub { margin: 0 0 10px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.teams { display: flex; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 10px; }
.team { white-space: nowrap; }
.teams .team { padding: 2px 8px; border: 1px solid var(--card-edge); background-color: var(--card); }
.team.t1 b, td .team.t1 { color: #ff8a80; }
.team.t2 b, td .team.t2 { color: #ffd76a; }
.team.t3 b, td .team.t3 { color: #8ab8ff; }
.team.t4 b, td .team.t4 { color: #86e08a; }
.scroll { overflow-x: auto; }
.ladder-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ladder-table th { padding: 4px 8px; background-color: var(--teal); color: #fff; text-align: left; white-space: nowrap;
  font-weight: bold; }
.ladder-table th.num, .ladder-table td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ladder-table td { padding: 5px 8px; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.ladder-table tbody tr:hover td { background-color: rgba(255, 255, 255, 0.07); }
.ladder-table td.name { white-space: nowrap; }
.ladder-table td.level { min-width: 150px; overflow-wrap: anywhere; }
.ladder-table td.strong { font-weight: bold; }
.ladder-table td.game, .ladder-table td.when { white-space: nowrap; color: var(--muted); }
.ladder-table td.mod { min-width: 56px; max-width: 180px; overflow-wrap: break-word; }
.sub b { color: #fff; }
.ladder-table th a { color: #fff; text-decoration: none; }
.ladder-table th a:hover { color: var(--gold); text-decoration: underline; }
.ladder-table th[aria-sort] { background-color: var(--teal-dark); }
.ladder-table th[aria-sort] a { color: var(--gold); }
.ladder-table td.sorted { background-color: rgba(255, 255, 255, 0.06); font-weight: bold; }
.ladder-table td.name a { font-weight: bold; }
.ladder-table tr.winner td { color: var(--gold); }
.ladder-table tr.you td { background-color: rgba(255, 204, 102, 0.13); }
.style-2001 .ladder-table tr.you td { background-color: rgba(143, 208, 242, 0.16); }
.ladder-table tr.you td:first-child { box-shadow: inset 3px 0 var(--gold); }
.tag { margin-left: 6px; color: var(--gold); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.tag.soft, .soft { color: #9aa; }
.place { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid #000;
  color: #1a1200; font: bold 10px Verdana, sans-serif; vertical-align: middle; }
.place.p1 { background: radial-gradient(circle at 35% 30%, #fff3cf, #ffcc66 55%, #a06a10); }
.place.p2 { background: radial-gradient(circle at 35% 30%, #fff, #c9d3d6 55%, #6f7f85); }
.place.p3 { background: radial-gradient(circle at 35% 30%, #ffe0c4, #d08a4e 55%, #6b3a12); }
.ball { display: inline-block; width: 10px; height: 10px; margin-right: 5px; border-radius: 50%; border: 1px solid #000;
  vertical-align: -1px; }
.ball.jk { background: radial-gradient(circle at 35% 30%, #ffe7a8, #c27a2a 70%, #5a3000); }
.ball.mots { background: radial-gradient(circle at 35% 30%, #e9ffff, #8fdbe4 55%, #2b8796); }
.verified { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid #1f7a45;
  background-color: #06220f; color: #7fe3a4; font-size: 11px; }
.verified::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background-color: var(--live); }
.verified.one { border-color: #7a651f; background-color: #221b06; color: #e3cd7f; }
.verified.one::before { background-color: #e3b93c; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 12px; margin-top: 14px;
  align-items: start; }
.card { min-width: 0; border: 1px solid var(--card-edge); background-color: var(--card); }
.card.wide { grid-column: 1 / -1; }
.cards.three { grid-template-columns: 4fr 3fr 4fr; }
.cards.two { grid-template-columns: 1fr 1fr; }
.card h3 { margin: 0; padding: 3px 8px; background-color: var(--teal); color: #fff;
  font: bold 11px Verdana, Geneva, sans-serif; text-transform: uppercase; letter-spacing: 0.05em; }
.card .body { padding: 6px 8px 8px; font-size: 12px; }
.card table { width: 100%; border-collapse: collapse; }
.card td { padding: 2px 0; vertical-align: baseline; }
.card td.num { text-align: right; font-variant-numeric: tabular-nums; padding-left: 10px; overflow-wrap: anywhere; }
.card .later { margin: 6px 0 0; color: #7f9a9a; font-size: 11px; }
.card table.matrix { width: auto; font-size: 11px; }
.matrix th, .matrix td { padding: 3px 6px; border: 1px solid var(--card-rule); text-align: right;
  font-variant-numeric: tabular-nums; }
.matrix th { background-color: var(--head); color: #cfe; font-weight: normal; text-align: left; white-space: nowrap;
  max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.matrix thead th { text-align: right; max-width: 72px; }
.matrix thead td { border: 0; }
.matrix td.self { color: #9aa; background-color: #101010; }
.matrix td.top { color: var(--gold); font-weight: bold; }
.card td.count { white-space: nowrap; }
.card td.soft:first-child { white-space: nowrap; padding-right: 8px; }
.card table.versus { font-size: 12px; }
.versus th { padding: 2px 0 4px; color: #9aa; font-weight: normal; text-align: left; white-space: nowrap; }
.versus th.num, .versus td.num { text-align: right; padding-left: 14px; }
.versus td.up { color: #7fe3a4; }
.versus td.down { color: #ff9a8f; }
.ladder-head .sub { margin: 0; }
.ladder-head + .scroll, .ladder-head + .empty { margin-top: 4px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 1px; margin: 4px 0 0;
  border: 1px solid var(--card-edge); }
.stats div { min-width: 0; box-shadow: 0 0 0 1px var(--card-edge); }
.stats dt { padding: 3px 8px; background-color: var(--teal); color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; }
.stats dd { margin: 0; padding: 6px 8px 7px; font-size: 15px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats .strong dd { color: var(--gold); font-weight: bold; }
.stats dd a { font-size: 13px; }
h3.part { margin: 18px 0 6px; color: var(--gold); font: bold 14px Verdana, Geneva, sans-serif; }
.foot { margin: 12px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.empty { margin: 28px auto; max-width: 460px; text-align: center; color: var(--muted); }
.empty b { display: block; margin-bottom: 6px; color: #fff; font-size: 14px; }
.pager { margin: 12px 0 0; font-weight: bold; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.tabs a { padding: 1px 8px; border: 1px solid var(--gold); color: var(--gold); font: bold 12px Verdana, Geneva, sans-serif;
  text-decoration: none; white-space: nowrap; }
.tabs a:hover { background-color: rgba(255, 204, 102, 0.2); }
.tabs a[aria-current] { background-color: var(--gold); color: #000; }
.tabs .ball { vertical-align: -1px; }

.ladder-side { flex: none; width: 232px; box-sizing: border-box; padding: 6px 8px 10px; background-color: #000; color: #e0e0e0;
  font-size: 12px; }
.ladder-side h2 { margin: 2px 0 4px; padding-bottom: 3px; border-bottom: 1px solid #808080; color: #e0e0e0;
  font: 13px Verdana, Geneva, sans-serif; text-transform: uppercase; }
.ladder-side .entry { padding: 4px 0 5px; border-bottom: 1px solid #262626; line-height: 16px; }
.ladder-side .entry a, .ladder-side .entry .here { display: block; overflow-wrap: anywhere; }
.ladder-side .entry .here { color: var(--gold); }
.ladder-side .label { display: block; color: #9a9a9a; font-size: 11px; }
.ladder-side .line { display: flex; justify-content: space-between; gap: 8px; }
.ladder-side .line span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ladder-side .line span:last-child { flex: none; font-variant-numeric: tabular-nums; color: #fff; }
.ladder-side .none { color: #808080; }
.ladder-side .more { margin: 8px 0 0; font-weight: bold; }

.style-2001 .topnav { background-color: var(--teal); border-bottom: 0; font-size: 14px; }
.style-2001 .style-pick button { border-color: var(--teal-light); color: var(--link); }
.style-2001 .style-pick button:hover { background-color: rgba(83, 181, 230, 0.3); }
.style-2001 .style-pick button[aria-pressed=true] { background-color: var(--teal-light); color: #002643; }
.style-2001 .masthead { align-items: center; background: var(--teal); }
.style-2001 .brand-mark span { color: #63b8ee; }
.style-2001 .banner { border: 1px solid #fff; background-color: var(--muted); color: #002643; }
.style-2001 .banner small { color: #2c4d63; }
.style-2001 .banner a.play { border: 1px solid #a33c00; border-radius: 3px;
  background: linear-gradient(#fcae78, #f77f2a 45%, #ec5c05 55%, #cf4f00); color: #fff; text-shadow: 0 1px 1px #7a2e00; }
.style-2001 .banner a.play:hover { background: linear-gradient(#fdc196, #fa8f40 45%, #f26812 55%, #e05800); color: #fff; }
.style-2001 .goldnav { border: 0; background-color: var(--teal-light); font: bold 14px Verdana, Geneva, sans-serif; }
.style-2001 .goldnav a { border-right-color: #fff; color: #002643; }
.style-2001 .goldnav a:hover { background-color: #8fd0f2; color: #002643; }
.style-2001 .titlebar { background: linear-gradient(var(--tab), var(--tab-dark)); color: #fff; }

@media (max-width: 720px) {
  main { padding: 10px 0 20px; }
  .window { border-left: 0; border-right: 0; box-shadow: none; }
  .win-body { flex-direction: column; }
  .ladder-main { border-right: 0; border-bottom: 2px solid var(--win-dark); padding: 12px 16px; }
  .ladder-side { width: auto; padding: 8px 16px 12px; }
  .tabs { margin-left: 0; }
  .cards.three, .cards.two { grid-template-columns: 1fr; }
  .banner a.play { padding: 6px 14px; font-size: 16px; }
}
@media (pointer: coarse) {
  .style-pick button { min-height: 26px; }
  .tabs a { padding: 4px 10px; }
}
`;

// The page's own script: the look the landing page's setting picked (and the
// buttons that change it), and times as the viewer's clock has them.
const SCRIPT = `
(function() {
  var KEY = 'jkdf2mp-page-style';
  var root = document.documentElement;
  var style = '2000';
  function showStyle() {
    root.classList.toggle('style-2001', style === '2001');
    document.querySelectorAll('[data-page-style]').forEach(function(b) {
      b.setAttribute('aria-pressed', String(b.dataset.pageStyle === style));
    });
  }
  try { if (localStorage.getItem(KEY) === '2001') style = '2001'; } catch (e) {}
  showStyle();
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    if (s < 30 * 86400) return Math.round(s / 86400) + ' days ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function showTimes() {
    document.querySelectorAll('time[data-at]').forEach(function(el) {
      var ms = Number(el.dataset.at);
      if (!ms) return;
      var full = new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric',
                                                         hour: 'numeric', minute: '2-digit' });
      el.textContent = el.dataset.as === 'ago' ? ago(ms)
        : el.dataset.as === 'day' ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : full;
      if (el.dataset.as !== 'date') el.title = full;
    });
  }
  document.addEventListener('DOMContentLoaded', function() { showStyle(); showTimes(); });
  document.addEventListener('click', function(ev) {
    var b = ev.target.closest && ev.target.closest('[data-page-style]');
    if (!b) return;
    style = b.dataset.pageStyle;
    showStyle();
    try { localStorage.setItem(KEY, style); } catch (e) {}
  });
  window.addEventListener('storage', function(ev) {
    if (ev.key !== KEY) return;
    style = ev.newValue === '2001' ? '2001' : '2000';
    showStyle();
  });
})();
`;

// A whole page: the landing page's top, and a window with a title bar and the
// body given. Not kept by search engines: the names in it are players'.
function page(status, title, windowTitle, body, opts = {}) {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const og = opts.ogTitle ? `
<meta name="description" content="${esc(opts.description || "")}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="jkdf2mp Game Rooms">
<meta property="og:title" content="${esc(opts.ogTitle)}">
<meta property="og:description" content="${esc(opts.description || "")}">
<meta name="theme-color" content="#ffcc66">` : "";
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">${og}
<link rel="icon" href="${ICON}">
<script nonce="${nonce}">${SCRIPT}</script>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div class="zone-page">
  <nav class="topnav" aria-label="Site">
    <a href="/">Home</a>
    <a href="/#rooms">Game Rooms</a>
    <a href="/matches">Matches</a>
    <a href="/players">Players</a>
    <div class="style-pick" role="group" aria-label="Page style">
      <span aria-hidden="true">Style</span>
      <button type="button" data-page-style="2000" aria-pressed="true">2000</button>
      <button type="button" data-page-style="2001" aria-pressed="false">2001&ndash;2006</button>
    </div>
  </nav>
  <header class="masthead">
    <div class="brand">
      <a href="/"><div class="brand-mark">jkdf2<span>mp</span></div></a>
      <div class="brand-sub">Match Record</div>
    </div>
    <div class="banner">
      <p>Jedi Knight multiplayer, right in your browser.
        <small>Matches played in the game rooms are recorded here.</small></p>
      <a class="play" href="/">Play JKDF2</a>
    </div>
  </header>
  <nav class="goldnav" aria-label="Sections">
    <a href="/#rooms">Game Rooms</a>
    <a href="/matches">Latest Matches</a>
    <a href="/players">Jedi Knight Standings</a>
    <a href="/players?game=mots">Mysteries of the Sith Standings</a>
  </nav>
  <main>
    <div class="window">
      <div class="titlebar"><h1>${esc(windowTitle)}</h1></div>
      <div class="win-body">${body}
      </div>
    </div>
  </main>
</div>
</body>
</html>
`;
    return new Response(html, {
        status,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            // A match's page marks its viewer's row, so it's theirs alone.
            "Cache-Control": opts.noStore ? "no-store" : "private, max-age=30",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
                                       "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; " +
                                       "frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "X-Robots-Tag": "noindex",
        },
    });
}
