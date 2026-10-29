// Checks src/summary.js: what the lobby keeps of a match summary a page
// posts to /summary, the data points it writes to Analytics Engine, and the
// answers it gives. With an address, also posts to a running lobby
// (npx wrangler dev), whose log then has the summaries:
//
//   node test/summary.mjs [http://127.0.0.1:8787]

import assert from "node:assert/strict";
import { cleanSummary, summaryPoints, takeSummary, MAX_SUMMARY_BYTES } from "../src/summary.js";

const KINDS = ["saber", "shot", "splash", "Force", "other"];
const WHY = ["dead", "not there", "too late", "unknown attack", "out of reach", "already counted", "bad numbers",
             "not playing by claims", "other"];

// A summary as the page's netstats.js makes it: a joiner in a Hit what you see
// match with one other player.
function sample() {
    return {
        v: 1, game: "jk", build: "62766240", rules: "hwys", reach: 300, host: false, secs: 754, players: 2,
        fps: { median: 144, low: 58 },
        others: [{
            secs: 750, hello: 2, link: "direct", ping: 48, rtt: 41,
            drawn: { behind: 72, buffer: 48, buffer90: 55, carried: 0.012, held: 0, jumps: 1, warps: 0 },
            mine: {
                saber: { shown: 40, counted: 38, turnedDown: 2, claims: 40, moments: 40, pastReach: 1,
                         why: { "not there": 2 } },
                Force: { targeted: 3, claims: 3, moments: 3 },
            },
            theirs: {
                shot: { counted: 12, turnedDown: 1, claims: 13, moments: 13, why: { "too late": 1 },
                        ages: { n: 13, median: 123, p90: 260, p99: 330, most: 331,
                                from: { 150: 5, 200: 3, 250: 2, 300: 1, 400: 0, 500: 0 } } },
            },
        }],
    };
}

// 31 other players, each with every kind of hit, every count and every
// reason: more than a page sends (it leaves out detail past 60,000 bytes),
// with the biggest part for each other player it can send.
function biggest() {
    const s = sample();
    const counts = (keys, n) => Object.fromEntries(keys.map(k => [k, n]));
    const why = Object.fromEntries(WHY.map(w => [w, 9999]));
    const other = s.others[0];
    other.mine = Object.fromEntries(KINDS.map(k => [k, {
        ...counts(["shown", "counted", "blocked", "missed", "dead", "turnedDown", "landed", "blocks", "blocksCounted",
                   "blocksMissed", "claims", "moments", "pastReach", "targeted", "targetedTurnedDown"], 99999), why }]));
    other.theirs = Object.fromEntries(KINDS.map(k => [k, {
        ...counts(["counted", "blocked", "dead", "turnedDown", "targeted", "claims", "moments", "pastReach"], 99999), why,
        ages: { n: 99999, median: 1234, p90: 1234, p99: 1234, most: 1999.5,
                from: { 150: 99999, 200: 99999, 250: 99999, 300: 99999, 400: 99999, 500: 99999 } } }]));
    s.others = Array.from({ length: 31 }, () => structuredClone(other));
    s.players = 32;
    return s;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a summary the page makes is kept as it is", () => {
    assert.deepEqual(cleanSummary(sample()), sample());
    const s = { ...sample(), sim: true, test: true, netstats: true, dropped: 4 };
    assert.deepEqual(cleanSummary(s), s);
    // A Classic match's, by the receipts: blocks shown here that the other
    // game counted as hits or never saw.
    const classic = { ...sample(), rules: "classic" };
    classic.others = [{ secs: 71, hello: 2, link: "direct", ping: 3, rtt: 2,
                        mine: { saber: { shown: 7, counted: 5, blocked: 1, missed: 1, landed: 2, blocks: 41,
                                         blocksCounted: 3, blocksMissed: 8 } },
                        theirs: { saber: { counted: 10, blocked: 31 } } }];
    assert.deepEqual(cleanSummary(structuredClone(classic)), classic);
});

test("only the fields it knows: names, addresses and anything else are dropped", () => {
    const s = sample();
    s.name = "Kyle";
    s.room = 12;
    s.others[0].name = "Jerec";
    s.others[0].id = 2;
    s.others[0].ip = "203.0.113.5";
    s.others[0].mine.lightsaber = { counted: 5 };
    s.others[0].mine.saber.extra = 3;
    s.others[0].mine.saber.why = { "not there": 2, "<script>": 1 };
    s.sim = "yes";
    const kept = cleanSummary(s);
    assert.deepEqual(kept, sample());
    assert.ok(!/Kyle|Jerec|203\.0|script/.test(JSON.stringify(kept)));
});

test("numbers out of range, or not numbers, are dropped", () => {
    const s = sample();
    const o = s.others[0];
    s.build = "not a hash";
    s.reach = -5;
    s.players = 2.5;
    s.fps = { median: "fast", low: Infinity };
    o.ping = 1e9;
    o.rtt = -1;
    o.hello = 7.5;
    o.link = "carrier pigeon";
    o.drawn.carried = 2;
    o.drawn.jumps = -1;
    o.mine.saber.counted = "38";
    o.mine.saber.shown = 1e12;
    o.theirs.shot.ages.from[300] = 50;
    delete o.theirs.shot.ages.from[500];
    const kept = cleanSummary(s);
    assert.deepEqual([kept.build, kept.reach, kept.players, kept.fps], ["", 0, 0, { median: null, low: null }]);
    const k = kept.others[0];
    assert.deepEqual([k.ping, k.rtt, k.hello, k.link], [undefined, undefined, -1, ""]);
    assert.deepEqual([k.drawn.carried, k.drawn.jumps], [null, 0]);
    assert.deepEqual(k.mine.saber, { turnedDown: 2, claims: 40, moments: 40, pastReach: 1, why: { "not there": 2 } });
    assert.deepEqual(k.theirs.shot.ages.from, { 150: 5, 200: 3, 250: 2, 300: 0, 400: 0, 500: 0 }, "no more than n, 0 if missing");
});

test("anything that isn't a summary is turned down", () => {
    const with_ = change => { const s = sample(); change(s); return s; };
    for (const [what, s] of [
        ["nothing", null], ["a list", [sample()]], ["text", "summary"],
        ["another version", with_(s => { s.v = 2; })],
        ["another game", with_(s => { s.game = "jk1"; })],
        ["other rules", with_(s => { s.rules = "both"; })],
        ["no time", with_(s => { delete s.secs; })],
        ["a negative time", with_(s => { s.secs = -1; })],
        ["over a day", with_(s => { s.secs = 90000; })],
        ["nobody else", with_(s => { s.others = []; })],
        ["32 others", with_(s => { s.others = Array(32).fill(s.others[0]); })],
        ["others not a list", with_(s => { s.others = { 0: s.others[0] }; })],
        ["no other that's a player", with_(s => { s.others = [null, 5, "x"]; })],
    ])
        assert.equal(cleanSummary(s), null, what);
});

test("one data point for each other player, within Analytics Engine's limits", () => {
    const points = summaryPoints(cleanSummary(sample()), "ab12cd34");
    assert.equal(points.length, 1);
    const p = points[0];
    assert.deepEqual(p.indexes, ["jk"]);
    assert.deepEqual(p.blobs.slice(0, 9), ["1", "jk", "hwys", "62766240", "joiner", "direct", "2", "", "ab12cd34"]);
    assert.deepEqual(JSON.parse(p.blobs[9]), sample().others[0]);
    assert.deepEqual(JSON.parse(p.blobs[10]), { ...sample(), others: 1 });
    assert.deepEqual(p.doubles, [300, 754, 2, 144, 58, 750, 48, 41, 72, 48, 40, 38, 2, 43, 1, 13, 1, 13, 1, 3]);

    // Not known: -1. Flags.
    const s = cleanSummary({ ...sample(), test: true, sim: true });
    delete s.others[0].ping;
    delete s.others[0].drawn;
    s.fps.low = null;
    const q = summaryPoints(s, "x")[0];
    assert.equal(q.blobs[7], "sim+test");
    assert.deepEqual([q.doubles[4], q.doubles[6], q.doubles[8], q.doubles[9]], [-1, -1, -1, -1]);

    // What a page sends fits what it may post. Each data point fits what
    // Analytics Engine takes, with the biggest part for each other player a
    // page can send: 20 texts of 16 KB in all, 20 numbers, one index of at
    // most 96 bytes, and 250 points a request.
    assert.ok(MAX_SUMMARY_BYTES >= 60000);
    const big = cleanSummary(biggest());
    assert.deepEqual(big, biggest(), "kept as it is");
    assert.equal(big.others.length, 31);
    const bigPoints = summaryPoints(big, "ab12cd34");
    assert.ok(bigPoints.length <= 250);
    for (const point of bigPoints) {
        const text = point.blobs.reduce((n, b) => n + new TextEncoder().encode(b).length, 0);
        assert.ok(point.blobs.length <= 20 && text <= 16 * 1024, "texts: " + text + " bytes");
        assert.ok(point.doubles.length <= 20 && point.doubles.every(Number.isFinite));
        assert.ok(point.indexes.length === 1 && point.indexes[0].length <= 96);
    }
});

// takeSummary with a made-up request, and a made-up SUMMARIES binding.
async function post(body, { method = "POST", headers = {}, url = "https://jediknight.zone/summary", env } = {}) {
    const points = [];
    env = env || { SUMMARIES: { writeDataPoint: point => points.push(point) } };
    const logged = [];
    const log = console.log;
    console.log = text => logged.push(text);
    try {
        const response = await takeSummary(new Request(url, { method, headers, body }), env);
        return { status: response.status, response, points, logged };
    } finally {
        console.log = log;
    }
}

test("POST /summary keeps it, and logs it", async () => {
    const r = await post(JSON.stringify(sample()), { headers: { Origin: "https://jediknight.zone" } });
    assert.equal(r.status, 204);
    assert.equal(r.points.length, 1);
    assert.equal(r.logged.length, 1);
    const m = /^summary ([0-9a-f]{8}): (.*)$/.exec(r.logged[0]);
    assert.ok(m, r.logged[0]);
    assert.deepEqual(JSON.parse(m[2]), sample());
    assert.equal(r.points[0].blobs[8], m[1], "the id in the log");
    // Without an Origin, as it comes; from a page on another address, no.
    assert.equal((await post(JSON.stringify(sample()))).status, 204);
    assert.equal((await post(JSON.stringify(sample()), { headers: { Origin: "https://example.org" } })).status, 403);
    assert.equal((await post(JSON.stringify(sample()), { headers: { Origin: "null" } })).status, 403);
    assert.equal((await post(JSON.stringify(sample()), { url: "http://127.0.0.1:8787/summary",
                                                          headers: { Origin: "http://127.0.0.1:8787" } })).status, 204);
});

test("anything else at /summary is turned down", async () => {
    const get = await post(undefined, { method: "GET" });
    assert.equal(get.status, 405);
    assert.equal(get.response.headers.get("Allow"), "POST");
    assert.equal((await post("{")).status, 400);
    assert.equal((await post(JSON.stringify({ v: 1 }))).status, 400);
    assert.equal((await post("x".repeat(MAX_SUMMARY_BYTES + 1))).status, 413);
    const said = await post("{}", { headers: { "Content-Length": String(MAX_SUMMARY_BYTES + 1) } });
    assert.equal(said.status, 413);
    for (const r of [get, said])
        assert.equal(r.points.length + r.logged.length, 0);
});

test("without Analytics Engine, or when it fails, the log still has it", async () => {
    const none = await post(JSON.stringify(sample()), { env: {} });
    assert.deepEqual([none.status, none.logged.length], [204, 1]);
    const failing = await post(JSON.stringify(sample()), { env: { SUMMARIES: { writeDataPoint() { throw new Error("full"); } } } });
    assert.equal(failing.status, 204);
    assert.match(failing.logged[0], /^summary [0-9a-f]{8}: not kept \(full\)$/);
    assert.match(failing.logged[1], /^summary [0-9a-f]{8}: \{/);
});

// Against a running lobby.
const address = process.argv[2];
if (address) {
    test("a running lobby takes a summary at /summary and turns the rest down", async () => {
        const url = address.replace(/\/+$/, "") + "/summary";
        const sent = await fetch(url, { method: "POST", body: JSON.stringify({ ...sample(), test: true }) });
        assert.equal(sent.status, 204);
        assert.equal((await fetch(url, { method: "POST", body: "{" })).status, 400);
        assert.equal((await fetch(url)).status, 405);
        assert.equal((await fetch(url, { method: "POST", body: JSON.stringify(sample()),
                                         headers: { Origin: "https://example.org" } })).status, 403);
    });
}

let failed = 0;
for (const t of tests) {
    try {
        await t.fn();
        console.log("ok   " + t.name);
    } catch (e) {
        failed++;
        console.log("FAIL " + t.name + "\n" + (e.stack || e));
    }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
