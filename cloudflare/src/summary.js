// Match summaries. When a game leaves a match, or its tab closes in one, the
// page posts a summary of it to /summary (summary() in the OpenJKDF2 fork's
// packaging/wasm/netstats.js): counts only, with no names or player numbers,
// so the hit rules' defaults can be set from real matches. The game, its
// build, the hit rules and reach, how long that game was in the match and at
// what frame rate, and for each other player in it, how their link went, how
// far behind they were drawn, and the hits each way, counted or turned down
// and why, with how far back each claim on that game's player reached.
//
// The lobby rebuilds each summary from the fields it knows, with every number
// checked, and drops anything else, then keeps it in Workers Analytics Engine
// (the SUMMARIES binding, three months), one data point for each other player
// in it, and writes it to its log. README.md says how to read them back.

// The page keeps a summary under 60,000 bytes (sendBeacon sends at most 64
// KB), leaving out detail for the biggest matches.
export const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_OTHERS = 31;
const MAX_COUNT = 1e7;
const MAX_MS = 1e5;
const DAY_S = 24 * 60 * 60;
const GAMES = ["jk", "mots"];
const RULES = ["classic", "hwys"];
const LINKS = ["direct", "TURN", "lobby relay", "via host"];
const KINDS = ["saber", "shot", "splash", "Force", "other"];
// Why a claim was turned down (the page's words).
const WHY = ["dead", "not there", "too late", "unknown attack", "out of reach", "already counted", "bad numbers",
             "not playing by claims", "other"];
// This game's hits on another player, by what their game said.
const MINE = ["shown", "counted", "blocked", "missed", "dead", "turnedDown", "landed", "blocks", "blocksCounted",
              "blocksMissed", "claims", "moments", "pastReach", "targeted", "targetedTurnedDown"];
// Another player's hits on this game's player, as this game decided them.
const THEIRS = ["counted", "blocked", "dead", "turnedDown", "targeted", "claims", "moments", "pastReach"];
// How many claims reached at least this far back, in ms.
const REACHES = ["150", "200", "250", "300", "400", "500"];
const FLAGS = ["sim", "test", "netstats"];
const BUILD_RE = /^[0-9a-f]{7,16}$/;

function whole(v, max) {
    return Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

function number(v, max) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
}

function isObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The counts named in keys that o has, each a whole number, without zeros;
// null if there are none.
function pick(o, keys) {
    if (!isObject(o))
        return null;
    const out = {};
    for (const k of keys) {
        const v = whole(o[k], MAX_COUNT);
        if (v)
            out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

function cleanAges(a) {
    if (!isObject(a))
        return null;
    const n = whole(a.n, MAX_COUNT);
    if (!n)
        return null;
    const from = {};
    for (const ms of REACHES)
        from[ms] = whole(isObject(a.from) ? a.from[ms] : null, n) ?? 0;
    return { n, median: number(a.median, MAX_MS), p90: number(a.p90, MAX_MS), p99: number(a.p99, MAX_MS),
             most: number(a.most, MAX_MS), from };
}

// One side's hits by kind: o.saber, o.shot and so on.
function cleanKinds(o, keys, withAges) {
    if (!isObject(o))
        return null;
    const out = {};
    for (const kind of KINDS) {
        const c = pick(o[kind], keys);
        if (!c)
            continue;
        const why = pick(o[kind].why, WHY);
        if (why)
            c.why = why;
        const ages = withAges ? cleanAges(o[kind].ages) : null;
        if (ages)
            c.ages = ages;
        out[kind] = c;
    }
    return Object.keys(out).length ? out : null;
}

function cleanOther(o) {
    if (!isObject(o))
        return null;
    const out = {
        secs: whole(o.secs, DAY_S) ?? 0,
        hello: Number.isInteger(o.hello) && o.hello >= -1 && o.hello <= 99 ? o.hello : -1,
        link: LINKS.includes(o.link) ? o.link : "",
    };
    const ping = number(o.ping, MAX_MS), rtt = number(o.rtt, MAX_MS);
    if (ping !== null)
        out.ping = Math.round(ping);
    if (rtt !== null)
        out.rtt = Math.round(rtt);
    if (isObject(o.drawn)) {
        const d = o.drawn;
        out.drawn = {
            behind: number(d.behind, MAX_MS), buffer: number(d.buffer, MAX_MS), buffer90: number(d.buffer90, MAX_MS),
            carried: number(d.carried, 1), held: number(d.held, 1),
            jumps: whole(d.jumps, MAX_COUNT) ?? 0, warps: whole(d.warps, MAX_COUNT) ?? 0,
        };
    }
    const mine = cleanKinds(o.mine, MINE, false);
    const theirs = cleanKinds(o.theirs, THEIRS, true);
    if (mine)
        out.mine = mine;
    if (theirs)
        out.theirs = theirs;
    return out;
}

// The summary rebuilt from what a page posted (parsed JSON), or null if it
// isn't one.
export function cleanSummary(s) {
    if (!isObject(s) || s.v !== 1 || !GAMES.includes(s.game) || !RULES.includes(s.rules))
        return null;
    const secs = whole(s.secs, DAY_S);
    if (secs === null || !Array.isArray(s.others) || !s.others.length || s.others.length > MAX_OTHERS)
        return null;
    const fps = isObject(s.fps) ? s.fps : {};
    const out = {
        v: 1,
        game: s.game,
        build: typeof s.build === "string" && BUILD_RE.test(s.build) ? s.build : "",
        rules: s.rules,
        reach: whole(s.reach, 10000) ?? 0,
        host: s.host === true,
        secs,
        players: whole(s.players, 64) ?? 0,
        fps: { median: number(fps.median, 10000), low: number(fps.low, 10000) },
        others: s.others.map(cleanOther).filter(Boolean),
    };
    // Other players the page left out to keep it under its size.
    const dropped = whole(s.dropped, 63);
    if (dropped)
        out.dropped = dropped;
    for (const flag of FLAGS) {
        if (s[flag] === true)
            out[flag] = true;
    }
    return out.others.length ? out : null;
}

// How far back claims on this game's player reached, from one other player:
// how many named a moment, and how many reached at least ms back.
function ages(o, ms) {
    let n = 0;
    for (const c of Object.values(o.theirs || {})) {
        if (c.ages)
            n += ms === undefined ? c.ages.n : c.ages.from[ms];
    }
    return n;
}

// The total of one count over every kind, on one side.
function total(o, side, key) {
    let n = 0;
    for (const c of Object.values(o[side] || {}))
        n += c[key] || 0;
    return n;
}

// Analytics Engine's data points for a summary: one for each other player,
// so each says how one link between two games went. Text to sort and filter
// by (blob1 to blob11 in its SQL API): the summary's version, the game, rules,
// build, whether this game hosted, the link, the hello version, any of sim,
// test and netstats, an id the points of one summary share, that player's
// part as JSON, and the rest of the summary as JSON. Numbers to add up
// (double1 to double20): the reach, this game's time in the match, players,
// frame rate (middle and low), that player's time in it with this one, ping,
// the browser's round trip, how far behind they were drawn and the buffer,
// this game's hits on them (shown, counted, turned down, claimed, past the
// reach), their claims on this game's player (all, turned down, with a
// moment, reaching 300 ms or more), and targeted Force powers that played on
// them. -1 for a number not known.
export function summaryPoints(s, id) {
    const flags = FLAGS.filter(f => s[f]).join("+");
    const top = JSON.stringify({ ...s, others: s.others.length });
    return s.others.map(o => ({
        indexes: [s.game],
        blobs: ["1", s.game, s.rules, s.build, s.host ? "host" : "joiner", o.link, String(o.hello), flags, id,
                JSON.stringify(o), top],
        doubles: [
            s.reach, s.secs, s.players, s.fps.median ?? -1, s.fps.low ?? -1,
            o.secs, o.ping ?? -1, o.rtt ?? -1, (o.drawn && o.drawn.behind) ?? -1, (o.drawn && o.drawn.buffer) ?? -1,
            total(o, "mine", "shown"), total(o, "mine", "counted"), total(o, "mine", "turnedDown"),
            total(o, "mine", "claims"), total(o, "mine", "pastReach"),
            total(o, "theirs", "claims"), total(o, "theirs", "turnedDown"), ages(o), ages(o, "300"),
            total(o, "mine", "targeted"),
        ],
    }));
}

function answer(status, text) {
    return new Response(text, { status, headers: { "Cache-Control": "no-store" } });
}

// POST /summary.
export async function takeSummary(request, env) {
    if (request.method !== "POST")
        return new Response("POST a match summary here", { status: 405, headers: { Allow: "POST" } });
    // From a page on this address only, which a browser says (sendBeacon
    // sends Origin with a POST); anything without one, as it comes.
    const origin = request.headers.get("Origin");
    if (origin !== null) {
        let host = null;
        try {
            host = new URL(origin).host;
        } catch (e) {
        }
        if (host !== new URL(request.url).host)
            return answer(403, "Not from this site");
    }
    if (Number(request.headers.get("Content-Length") || 0) > MAX_SUMMARY_BYTES)
        return answer(413, "Too long");
    let text;
    try {
        text = await request.text();
    } catch (e) {
        return answer(400, "Unreadable");
    }
    if (text.length > MAX_SUMMARY_BYTES)
        return answer(413, "Too long");
    let summary = null;
    try {
        summary = cleanSummary(JSON.parse(text));
    } catch (e) {
    }
    if (!summary)
        return answer(400, "Not a match summary");
    const id = crypto.randomUUID().slice(0, 8);
    if (env.SUMMARIES) {
        try {
            for (const point of summaryPoints(summary, id))
                env.SUMMARIES.writeDataPoint(point);
        } catch (e) {
            console.log(`summary ${id}: not kept (${e.message})`);
        }
    }
    console.log(`summary ${id}: ${JSON.stringify(summary)}`);
    return new Response(null, { status: 204 });
}
