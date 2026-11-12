// Checks the match record (src/ladder.js, src/ladder-pages.js): games in a
// room report their match, the lobby puts the reports together, saves the
// match to D1, tells the games, lists it for the page and Discord, and serves
// its page; and its screenshots (src/ladder-shots.js): who may add one, where
// it goes, what's kept of it and how it's served. Runs the Lobby itself in
// Node.js on test/cfstub.mjs, with D1 stood in for by Node's own SQLite and
// R2 by a map. Needs Node.js 22.5 or newer.
//
//   node test/ladder.mjs
//
// It prints a line for each check and exits 1 if one fails.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

const stubUrl = new URL("./cfstub.mjs", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const { FakeStorage, FakeCtx } = await import("./cfstub.mjs");
const { Lobby, default: worker } = await import("../src/lobby.js");
const { cleanReport, discordMessage, hashKey, joinableName, MAX_REPORT_B64 } = await import("../src/ladder.js");
const { periodStart } = await import("../src/ladder-pages.js");
const { SHOTS, jpegSize, shotRoute } = await import("../src/ladder-shots.js");

const logged = [];
const realLog = console.log;
console.log = (...a) => {
    const line = a.join(" ");
    if (line.startsWith("relay:") || line.startsWith("ladder:")) {
        logged.push(line);
        if (process.env.VERBOSE)
            realLog(line);
    } else {
        realLog(...a);
    }
};

// Time, moved on by hand.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const SEC = 1000, MIN = 60 * SEC;

// D1 as the lobby uses it: prepare, bind, first, all, run and batch (one
// transaction). fail makes the next calls throw, as when D1 is away.
class FakeD1 {
    constructor() {
        this.db = new DatabaseSync(":memory:");
        this.fail = 0;
        this.calls = 0;
    }
    prepare(sql) {
        return new FakeStatement(this, sql, []);
    }
    check() {
        this.calls++;
        if (this.fail) {
            this.fail--;
            throw new Error("D1_ERROR: made-up failure");
        }
    }
    async batch(statements) {
        this.check();
        this.db.exec("BEGIN");
        try {
            const out = statements.map(s => s.now());
            this.db.exec("COMMIT");
            return out;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    rows(sql, ...args) {
        return this.db.prepare(sql).all(...args);
    }
}

class FakeStatement {
    constructor(d1, sql, args) {
        Object.assign(this, { d1, sql, args });
    }
    bind(...args) {
        // D1 takes no undefined.
        assert.ok(args.every(a => a !== undefined), `undefined bound in: ${this.sql}`);
        return new FakeStatement(this.d1, this.sql, args);
    }
    now() {
        const st = this.d1.db.prepare(this.sql);
        if (/^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql))
            return { success: true, results: st.all(...this.args).map(r => ({ ...r })) };
        st.run(...this.args);
        return { success: true, results: [] };
    }
    async first() {
        this.d1.check();
        return this.now().results[0] ?? null;
    }
    async all() {
        this.d1.check();
        return this.now();
    }
    async run() {
        this.d1.check();
        return this.now();
    }
}

// An R2 bucket as the lobby uses it: put, get (with onlyIf), head and delete.
// fail makes the next puts throw, and slow makes each take that many ms, so
// two requests can be in the middle of theirs at once.
class FakeR2 {
    constructor() {
        this.m = new Map();
        this.puts = 0;
        this.fail = 0;
        this.slow = 0;
    }
    async put(key, value, opts = {}) {
        if (this.fail) {
            this.fail--;
            throw new Error("R2 made-up failure");
        }
        if (this.slow)
            await new Promise(r => setTimeout(r, this.slow));
        this.puts++;
        const bytes = new Uint8Array(value);
        this.m.set(key, { bytes, type: opts.httpMetadata && opts.httpMetadata.contentType || "",
                          etag: createHash("md5").update(bytes).digest("hex") });
    }
    facts(o) {
        return { size: o.bytes.length, etag: o.etag, httpEtag: `"${o.etag}"` };
    }
    async head(key) {
        const o = this.m.get(key);
        return o ? this.facts(o) : null;
    }
    async get(key, opts = {}) {
        const o = this.m.get(key);
        if (!o)
            return null;
        // A condition that doesn't hold: the object's facts without its body.
        if (opts.onlyIf && opts.onlyIf.etagDoesNotMatch === o.etag)
            return this.facts(o);
        return { ...this.facts(o), body: o.bytes };
    }
    async delete(keys) {
        for (const k of [].concat(keys))
            this.m.delete(k);
    }
}

// A JPEG as far as its frame header goes: w by h pixels, and pad bytes of
// picture data to make it as long as wanted.
function jpeg(w, h, pad = 0) {
    const app = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const out = new Uint8Array(2 + app.length + sof.length + 4 + pad + 2);
    out.set([0xff, 0xd8, ...app, ...sof, 0xff, 0xda, 0, 2]);
    out.fill(0x55, out.length - 2 - pad, out.length - 2);
    out.set([0xff, 0xd9], out.length - 2);
    return out;
}

// What the lobby posted to Discord.
const discord = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://discord.test/")) {
        discord.push(JSON.parse(init.body));
        return { ok: true, status: 204 };
    }
    return realFetch(url, init);
};

// A host's entry: a 240-byte jkMultiEntry, and the tail naming its mod.
function entry({ name = "t_Room", episode = "JK1MP", map = "m2.jkl", password = "", maxRank = 4, tail = "" } = {}) {
    const b = Buffer.alloc(240);
    b.writeUInt32LE(0x4a4b4852, 8);
    b.writeInt32LE(8, 16);
    b.write(name, 24, "utf16le");
    b.write(episode, 88, "latin1");
    b.write(map, 120, "latin1");
    b.write(password, 152, "utf16le");
    b.writeInt32LE(password ? 0x400 | 0x8 : 0x8, 216);
    b.writeInt32LE(10, 224);
    b.writeInt32LE(maxRank, 236);
    return b.toString("hex") + tail;
}

// As mods.js writes it: a mod's fingerprint and name, and the pack's.
function modTail(name, fp, packFp) {
    const b = Buffer.alloc(7 + (fp ? 32 : 0) + (packFp ? 16 : 0) + name.length);
    b.write("JKMD", 0, "latin1");
    b[4] = 2;
    b[5] = (fp ? 1 : 0) | (packFp ? 2 : 0);
    b[6] = name.length;
    let at = 7;
    if (fp)
        at += Buffer.from(fp, "hex").copy(b, at);
    if (packFp)
        at += Buffer.from(packFp, "hex").copy(b, at);
    b.write(name, at, "latin1");
    return b.toString("hex");
}

const b64 = text => Buffer.from(text, "utf8").toString("base64");
const hexPw = text => Buffer.from(text, "utf16le").toString("hex");

class World {
    constructor(env, storage = new FakeStorage()) {
        this.env = env;
        this.storage = storage;
    }
    async start(sockets = []) {
        this.ctx = new FakeCtx(this.storage, sockets);
        this.lobby = new Lobby(this.ctx, this.env);
        await this.ctx.ready;
        return this;
    }
    async connect() {
        await this.lobby.fetch(new Request("https://lobby.test/relay?net=0&pw=1"));
        const ws = this.ctx.sockets.at(-1);
        ws.lobbyLine = ws.take().find(l => l.startsWith("lobby ")) || "";
        return ws;
    }
    say(ws, line) {
        return this.lobby.webSocketMessage(ws, line);
    }
    async close(ws) {
        ws.close(1000, "bye");
        await this.lobby.webSocketClose(ws, 1000, "bye", true);
    }
    // Until the record has nothing left to work through.
    async settle() {
        let q;
        do {
            q = this.lobby.ladder.queue;
            await q;
            await new Promise(r => setImmediate(r));
        } while (q !== this.lobby.ladder.queue);
    }
    async alarm() {
        await this.lobby.alarm();
        await this.settle();
    }
    async host(name, opts = {}) {
        const ws = await this.connect();
        await this.say(ws, `hello ${opts.game || "jk1"} ${b64(name)}`);
        await this.say(ws, "host " + entry(opts));
        const out = ws.take();
        assert.match(out[0] || "", /^hosted \d+$/, `host: ${out}`);
        return new Game(this, ws, Number(out[0].split(" ")[1]), 1, opts);
    }
    async join(name, host, opts = {}) {
        const ws = await this.connect();
        await this.say(ws, `hello ${opts.game || "jk1"} ${b64(name)}`);
        await this.say(ws, `join ${host.room}` + (opts.password ? " " + hexPw(opts.password) : ""));
        const seat = ws.take().find(l => l.startsWith("seat "));
        assert.ok(seat, `${name} got no seat`);
        return new Game(this, ws, host.room, Number(seat.split(" ")[2]), { ...host.opts, ...opts });
    }
    async status() {
        const ws = await this.connect();
        await this.say(ws, "watch");
        const line = ws.take().filter(l => l.startsWith("status ")).pop();
        await this.close(ws);
        return JSON.parse(Buffer.from(line.slice(7), "base64").toString());
    }
    page(path, headers = {}, init = {}) {
        return worker.fetch(new Request("https://lobby.test" + path, { headers, ...init }), this.env, {});
    }
}

// A game in a room, reporting as the engine does: its own count of the kills
// it saw, and how long ago each was.
class Game {
    constructor(world, ws, room, id, opts) {
        Object.assign(this, { world, ws, room, id, opts, n: 0, lv: 1, since: Date.now(), pk: opts.pk ?? null, anon: !!opts.anon });
    }
    report(more = {}) {
        const r = {
            v: 1, lv: this.lv, map: this.opts.map || "m2.jkl", title: this.opts.title || "Nar Shaddaa Loading Terminal",
            t: Date.now() - this.since, build: "abc1234", ev: [], ...more,
        };
        if (this.pk)
            r.pk = this.pk;
        if (this.anon)
            r.anon = 1;
        return this.world.say(this.ws, "match " + b64(JSON.stringify(r)));
    }
    // kills: [victim, killer, kind, ms ago]
    saw(kills, more = {}) {
        return this.report({ ev: kills.map(([victim, killer, kind = 0, ago = 0]) => [++this.n, ago, victim, killer, kind]), ...more });
    }
}

// A kill everyone saw: the victim's game knows what did it.
async function killAll(games, victim, killer, kind = 2) {
    for (const g of games)
        await g.saw([[victim, killer, g.id === victim ? kind : 0]]);
}

// The host leaves, which ends its room. The other games are told, and each
// says its last, as the game does when its level ends under it; the match
// closes a moment after the last of them.
async function hostLeaves(w, H, others = [], more = {}) {
    await H.report({ ...more, end: "left" });
    await w.say(H.ws, "leave");
    for (const g of others)
        await g.report({ end: "left" });
    skew += 2 * SEC;
    await w.alarm();
}

// A whole match in a room of its own, which everyone leaves afterwards:
// players are [name, browser key or null, "silent" for one whose game reports
// nothing or "anon" for one who asked not to be recorded by name], the host
// first; kills are [victim's seat, killer's seat (0 for
// nobody), kind]. Returns the match's number, 0 for one that wasn't kept.
async function playMatch(w, players, kills, opts = {}) {
    const rules = { mode: opts.mode || 0, sl: 0, tl: 0 };
    const H = await w.host(players[0][0], { ...opts, pk: players[0][1] });
    const everyone = [H], all = [H];
    for (const [name, pk, how] of players.slice(1)) {
        const g = await w.join(name, H, { pk, game: opts.game, password: opts.password, anon: how === "anon" });
        everyone.push(g);
        if (how !== "silent")
            all.push(g);
    }
    for (const g of all) {
        g.since = Date.now();
        await g.report({ rules });
    }
    skew += (opts.secs || 180) * SEC;
    for (const [victim, killer, kind = 1] of kills)
        await killAll(all, victim, killer, kind);
    const newest = () => {
        try {
            return w.env.LADDER.rows("SELECT COALESCE(MAX(id), 0) AS id FROM matches")[0].id;
        } catch (e) {
            return 0;
        }
    };
    const before = newest();
    await H.report({ end: "level", rules });
    for (const g of all.slice(1))
        await g.report({ end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    for (const g of everyone.reverse())
        await w.say(g.ws, "leave");
    await w.settle();
    return newest() > before ? newest() : 0;
}

// A page's text: its tags gone, its spaces single.
function textOf(html) {
    return html.replace(/<(script|style)[^>]*>[^]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "|")
        .replace(/&nbsp;/g, " ").replace(/&dagger;/g, "+").replace(/&times;/g, "x").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
}

let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`ok    ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split("\n").join("\n      ")}`);
    }
}

const KEYS = { maw: "11111111111111111111111111111111", kyle: "22222222222222222222222222222222",
               boc: "33333333333333333333333333333333", jan: "44444444444444444444444444444444" };
const MOD_FP = "ab".repeat(32);

function newEnv(more = {}) {
    return { LADDER: new FakeD1(), SITE: "", MOVED_FROM: "", MATCH_LINKS: "https://lobby.test", ...more };
}

await check("a report is checked field by field", () => {
    const good = { v: 1, lv: 1, map: "M2.JKL", title: " Nar\u0007 Shaddaa ", t: 5000, pk: KEYS.maw, build: "abc1234",
                   rules: { mode: 0x10, sl: 20, tl: 0 }, ev: [[2, 100, 2, 1, 1], [1, 900, 3, 0, 9], "x", [3, 0, 99, 1, 1]],
                   sb: [[1, 3, 4, 1, 1, 0], [2, -1, 0, 4, 1, 7], [0, 0, 0, 0, 0, 0]], teams: [0, 0, 0, 0, 0], end: "level", extra: 1 };
    const r = cleanReport(b64(JSON.stringify(good)));
    assert.equal(r.map, "m2.jkl");
    assert.equal(r.title, "Nar Shaddaa");
    assert.deepEqual(r.ev, [[1, 900, 3, 0, 0], [2, 100, 2, 1, 1]], "in the game's order, a kind it doesn't know is 0, a seat past 64 is dropped");
    assert.deepEqual(r.sb, [[1, 3, 4, 1, 1, 0], [2, -1, 0, 4, 1, 0]]);
    assert.equal(r.end, "level");
    assert.equal(r.extra, undefined);
    for (const bad of [{ ...good, v: 2 }, { ...good, map: "../x" }, { ...good, lv: 0 }, { ...good, t: -1 }, [], "x"])
        assert.equal(cleanReport(b64(JSON.stringify(bad))), null, JSON.stringify(bad).slice(0, 40));
    assert.equal(cleanReport("not base64!"), null);
    assert.equal(cleanReport(b64("{")), null);
    assert.equal(cleanReport("A".repeat(MAX_REPORT_B64 + 4)), null);
    assert.equal(cleanReport(b64(JSON.stringify({ ...good, pk: "nope" }))).pk, "");
});

await check("without the database the lobby doesn't ask for reports or keep them", async () => {
    const w = await new World({ SITE: "", MOVED_FROM: "" }).start();
    const H = await w.host("Maw");
    assert.ok(!H.ws.lobbyLine.split(" ").includes("match"), H.ws.lobbyLine);
    await H.report();
    assert.deepEqual(H.ws.take(), [], "a match line is never answered");
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("match")).length, 0);
    assert.equal("match" in await w.status(), false);
    const res = await w.page("/matches", {}, {}).catch(e => e);
    assert.ok(!(res && res.status === 200), "no pages without the database");
});

// One match of three players, everything seen by all: it's saved, counted,
// told, listed, posted and has a page.
const env = newEnv({ DISCORD_WEBHOOK: "https://discord.test/api/webhooks/1/abc" });
const w = await new World(env).start();
let firstId = 0;
await check("a match three games report is saved once its level is over", async () => {
    const H = await w.host("Maw", { pk: KEYS.maw, tail: modTail("SBX 4.5", MOD_FP, null) });
    assert.ok(H.ws.lobbyLine.split(" ").includes("match"), H.ws.lobbyLine);
    const K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    const B = await w.join("<b>Boc`s</b>", H, { pk: KEYS.boc });
    const all = [H, K, B];
    for (const g of all)
        g.since = Date.now();
    await H.report({ rules: { mode: 0x10, sl: 5, tl: 0 } });
    await K.report();
    await B.report();
    skew += 2 * MIN;
    await killAll(all, 2, 1, 1);
    skew += 10 * SEC;
    await killAll(all, 3, 1, 1);
    skew += 10 * SEC;
    await killAll(all, 1, 2, 2);
    // The same two again, six seconds on: another kill, not the same one.
    skew += 6 * SEC;
    await killAll(all, 1, 2, 4);
    skew += 30 * SEC;
    // One game reports late what the others saw when it happened.
    await H.saw([[3, 1, 0]]);
    await B.saw([[3, 1, 3]]);
    skew += 3 * SEC;
    await K.saw([[3, 1, 0, 3000]]);
    // Nobody did it.
    await killAll(all, 2, 0, 5);
    skew += 20 * SEC;
    assert.deepEqual(all.flatMap(g => g.ws.take()).filter(l => !/^peer-joined/.test(l)), [], "reports are never answered");
    const sb = [[1, 3, 3, 2, 0, 0], [2, 1, 2, 2, 1, 0], [3, 0, 0, 2, 0, 0]];
    await H.report({ sb, teams: [0, 0, 0, 0, 0], end: "level", rules: { mode: 0x10, sl: 5, tl: 0 } });
    await K.report({ end: "level" });
    await B.report({ end: "level" });
    assert.equal(env.LADDER.calls, 0, "nothing goes to D1 while it's played");
    assert.ok(w.storage.alarm, "the lobby's alarm is set for the match's end");
    skew += 16 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches");
    assert.equal(m.length, 1);
    firstId = m[0].id;
    assert.deepEqual({ ...m[0], id: 0, uid: "", started_at: 0, ended_at: 0, detail: "" }, {
        id: 0, uid: "", game: "jk1", map: "m2.jkl", title: "Nar Shaddaa Loading Terminal", episode: "JK1MP", room_name: "t_Room",
        started_at: 0, ended_at: 0, secs: 199, mode: 0x10, score_limit: 5, time_limit: 0, max_rank: 4, players: 3, reporters: 3,
        kills: 6, confirmed: 6, locked: 0, mod: "SBX 4.5", mod_fp: MOD_FP, pack: 0, ended: "level", counted: 1, hidden: 0, detail: "",
    });
    const rows = env.LADDER.rows("SELECT * FROM match_players ORDER BY slot");
    assert.deepEqual(rows.map(r => [r.name, r.score, r.kills, r.deaths, r.suicides, r.streak, r.place, r.won, r.host, r.reported, r.kinds]), [
        ["Maw", 3, 3, 2, 0, 2, 1, 1, 1, 1, "[2,0,1,0,0]"],
        ["Kyle_K", 1, 2, 2, 1, 2, 2, 0, 0, 1, "[0,1,0,1,0]"],
        ["<b>Boc`s</b>", 0, 0, 2, 0, 0, 3, 0, 0, 1, "[0,0,0,0,0]"],
    ]);
    const players = env.LADDER.rows("SELECT * FROM players ORDER BY id");
    assert.deepEqual(players.map(p => p.name), ["Maw", "Kyle_K", "<b>Boc`s</b>"]);
    assert.equal(players[0].key_hash, await hashKey(KEYS.maw), "only the key's hash is kept");
    assert.ok(!JSON.stringify(env.LADDER.rows("SELECT * FROM players")).includes(KEYS.maw));
    assert.deepEqual(rows.map(r => r.player_id), players.map(p => p.id));
    const detail = JSON.parse(m[0].detail);
    assert.equal(detail.kills.length, 6);
    assert.ok(detail.kills.every(k => k[4] === 3), "each kill seen by all three");
    assert.equal(detail.firstBlood, 0);
    assert.deepEqual(detail.agree, { reported: 6, kept: 6, confirmed: 6, sbRows: 3, sbSame: 3 });
    assert.deepEqual([detail.sharedKey, detail.addresses], [false, 0]);
    assert.deepEqual(all.map(g => g.ws.take().filter(l => l.startsWith("matched"))), Array(3).fill([`matched ${firstId}`]),
                     "each game that reported hears its match's number");
    w.H = H;
});

await check("the page's status names it, and the page's lists have it with its mod and winner", async () => {
    assert.equal((await w.status()).match, firstId);
    const res = await w.page("/ladder/recent");
    assert.equal(res.status, 200);
    const lists = JSON.parse(res.body);
    assert.deepEqual(lists.games.mots, []);
    assert.deepEqual(lists.games.jk1.map(m => ({ ...m, at: 0 })), [{
        id: firstId, title: "Nar Shaddaa Loading Terminal", mod: "SBX 4.5", pack: 0, custom: 0, players: 3, secs: 199, at: 0,
        teams: false, name: "Maw", team: 0, score: 3 }]);
    assert.equal(res.headers["Content-Type"], "application/json");
});

await check("Discord gets the scoreboard, with nothing a name could mention or break", async () => {
    assert.equal(discord.length, 1);
    const d = discord[0];
    assert.deepEqual(d.allowed_mentions, { parse: [] });
    assert.equal(d.embeds[0].url, `https://lobby.test/match/${firstId}`);
    assert.equal(d.embeds[0].title, "Nar Shaddaa Loading Terminal: Maw wins");
    assert.match(d.embeds[0].footer.text, /^Jedi Knight \| SBX 4\.5 \| 3 players \| 3 min$/);
    const body = d.embeds[0].description;
    assert.ok(body.startsWith("```\n") && body.endsWith("\n```"));
    assert.equal(body.slice(3, -3).includes("`"), false, "a backtick in a name can't end the block");
    assert.match(body, /1\. Maw +3 +3\/2\/0/);
    // Without an address for the link, none.
    const small = discordMessage(1, { title: "x", rows: [], mode: 0, detail: { teams: null }, game: "mots", mod: "", players: 2,
                                      secs: 200, endedAt: 0 }, "");
    assert.equal(small.embeds[0].url, undefined);
    assert.match(small.embeds[0].footer.text, /^Mysteries of the Sith \| 2 players/);
});

await check("its page shows it, with every name escaped and nothing loaded from elsewhere", async () => {
    const res = await w.page(`/match/${firstId}`, { Cookie: `jkpk=${KEYS.kyle}` });
    assert.equal(res.status, 200);
    const html = res.body;
    const csp = res.headers["Content-Security-Policy"];
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.match(csp, /^default-src 'none'/);
    // Only to the site itself, for Cloudflare Web Analytics' page view.
    assert.match(csp, /; connect-src 'self';/);
    assert.equal(/https?:|\*/.test(csp), false, "no other site is named");
    assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.equal(/ style="/.test(html), false, "no style attributes: the policy would drop them");
    assert.equal(/ on[a-z]+="/.test(html), false);
    assert.equal(html.includes("<b>Boc"), false, "a name is never markup");
    assert.ok(html.includes("&lt;b&gt;Boc`s&lt;/b&gt;"));
    assert.ok(html.includes("Confirmed by 3 of 3 players"));
    assert.ok(html.includes("Mod: <b>SBX 4.5</b>"));
    assert.ok(html.includes("Max rank 4"));
    assert.ok(html.includes("Score limit 5"));
    assert.ok(html.includes("Maw wins"));
    assert.match(html, /<tr class="you">\s*<td class="num"><span class="place p2">2<\/span><\/td>\s*<td class="name"><b><a href="\/player\/2\?game=jk">Kyle_K<\/a><\/b> <span class="tag">You<\/span>/);
    assert.match(html, /<meta property="og:title" content="Nar Shaddaa Loading Terminal: Maw wins">/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.equal(res.headers["Cache-Control"], "private, max-age=30");
    // Who killed whom: Maw's row, then Kyle's.
    assert.match(html, /<th scope="row">Maw<\/th><td class="self"><\/td><td>1<\/td><td class="top">2<\/td>/);
    assert.match(html, /<th scope="row">Kyle_K<\/th><td class="top">2<\/td><td class="self">1<\/td><td>0<\/td>/);
    const other = await w.page(`/match/${firstId}`);
    assert.equal(other.body.includes('class="tag">You'), false, "nobody's row is marked without their key");
    // Highlights name everyone who shares one: Maw and Kyle both had two in
    // a life, and all three died twice.
    const text = textOf(html);
    assert.ok(text.includes("Longest streak Maw and Kyle_K, 2 in one life each"), text);
    assert.ok(text.includes("Most saber kills Maw, 2"));
    assert.ok(text.includes("Most deaths 3 players, 2 each"));
    assert.ok(text.includes("Most suicides Kyle_K, 1"));
});

await check("the list has it, by game, and a missing match is a 404", async () => {
    const all = await w.page("/matches");
    assert.equal(all.status, 200);
    assert.ok(all.body.includes(`<a href="/match/${firstId}">Nar Shaddaa Loading Terminal</a>`));
    assert.ok(all.body.includes('<td class="mod">SBX 4.5</td>'));
    assert.ok((await w.page("/matches?game=jk")).body.includes(`/match/${firstId}`));
    const mots = await w.page("/matches?game=mots");
    assert.equal(mots.body.includes(`/match/${firstId}`), false);
    assert.ok(mots.body.includes("No matches recorded yet."));
    const none = await w.page("/match/999");
    assert.equal(none.status, 404);
    assert.equal(none.headers["Cache-Control"], "no-store");
    assert.equal((await w.page("/matches", {}, { method: "POST" })).status, 405);
    env.LADDER.db.exec(`UPDATE matches SET hidden = 1 WHERE id = ${firstId}`);
    assert.equal((await w.page(`/match/${firstId}`)).status, 404, "a hidden match has no page");
    assert.equal((await w.page("/matches")).body.includes(`/match/${firstId}`), false);
    env.LADDER.db.exec(`UPDATE matches SET hidden = 0`);
});

await check("the next level in the same room is another match, and so is one after a restart", async () => {
    const H = w.H;
    H.lv = 2;
    H.n = 0;
    H.opts = { ...H.opts, map: "m4.jkl", title: "Canyon Oasis" };
    H.since = Date.now();
    await H.report({ rules: { mode: 0, sl: 0, tl: 0 } });
    const J = await w.join("Jan_Ors", H, { pk: KEYS.jan });
    J.lv = 1;
    J.since = Date.now();
    await J.report();
    skew += 90 * SEC;
    await killAll([H, J], J.id, 1, 2);
    // The lobby restarts with the match open: the sockets stay.
    const w2 = await new World(env, w.storage).start(w.ctx.sockets);
    H.world = J.world = w2;
    skew += 90 * SEC;
    await killAll([H, J], 1, J.id, 1);
    for (const g of [H, J])
        g.ws.take();
    await hostLeaves(w2, H, [J]);
    const m = env.LADDER.rows("SELECT * FROM matches ORDER BY id");
    assert.equal(m.length, 2);
    // Which games to tell is kept on their sockets, so the restart, which
    // the lobby does whenever it has slept, doesn't lose it, nor does the
    // room ending.
    assert.deepEqual([H, J].map(g => g.ws.take().filter(l => l.startsWith("matched"))), Array(2).fill([`matched ${m[1].id}`]),
                     "both games are told, after the restart and with the room gone");
    assert.deepEqual([m[1].map, m[1].title, m[1].players, m[1].kills, m[1].confirmed, m[1].ended, m[1].counted, m[1].secs],
                     ["m4.jkl", "Canyon Oasis", 2, 2, 2, "left", 1, 180]);
    const rows = env.LADDER.rows("SELECT name, kills, won, place FROM match_players WHERE match_id = ? ORDER BY slot", m[1].id);
    assert.deepEqual(rows.map(r => ({ ...r })), [{ name: "Maw", kills: 1, won: 0, place: 1 }, { name: "Jan_Ors", kills: 1, won: 0, place: 1 }]);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM players")[0].n, 4, "the host is the same player in both");
    assert.equal(discord.length, 1, "a match of two isn't posted");
    assert.equal((await w2.status()).match, m[1].id, "the status names the newer one, also after the restart");
    assert.deepEqual(JSON.parse((await w2.page("/ladder/recent")).body).games.jk1.map(x => [x.title, x.name]),
                     [["Canyon Oasis", null], ["Nar Shaddaa Loading Terminal", "Maw"]]);
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("match")).length, 0, "nothing of a closed room is left in storage");
});

await check("only what the victim's game or two games saw counts, and a seat's next player is another player", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    const B = await w.join("Boc", H, { anon: true, pk: KEYS.boc });
    for (const g of [H, K, B]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 70 * SEC;
    await K.saw([[2, 1, 1]]);
    // A bystander saw the same one: now two games did.
    await B.saw([[2, 1, 0]]);
    skew += 20 * SEC;
    // Only its victim's game saw this one: counts, unconfirmed.
    await K.saw([[2, 0, 5]]);
    // Only a bystander saw this, while the victim's game is reporting: doesn't.
    await B.saw([[1, 2, 0]]);
    skew += 20 * SEC;
    // Two bystanders: counts.
    await H.saw([[3, 2, 0]]);
    await K.saw([[3, 2, 0]]);
    // The same report sent twice changes nothing.
    K.n--;
    await K.saw([[3, 2, 0]]);
    // Boc leaves, and Jan takes the seat: kills on seat 3 from here are Jan's.
    await B.report({ end: "left" });
    await w.say(B.ws, "leave");
    const J = await w.join("Jan_Ors", H, { pk: KEYS.jan });
    assert.equal(J.id, B.id, "the seat is used again");
    J.since = Date.now();
    await J.report();
    skew += 40 * SEC;
    await killAll([H, K, J], 3, 1, 2);
    skew += 20 * SEC;
    await H.report({ end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.deepEqual([m.players, m.reporters, m.kills, m.confirmed, m.counted], [4, 4, 4, 3, 0], "three of four kills confirmed: not nine in ten");
    const rows = env.LADDER.rows("SELECT name, kills, deaths, player_id FROM match_players ORDER BY slot");
    assert.deepEqual(rows.map(r => [r.name, r.kills, r.deaths, r.player_id === null]),
                     [["Maw", 2, 0, false], ["Kyle_K", 1, 2, false], ["", 0, 1, true], ["Jan_Ors", 0, 1, false]]);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM players")[0].n, 3, "no record for a player who asked not to be");
    const html = (await w.page(`/match/${m.id}`)).body;
    assert.ok(html.includes("<b>Anonymous</b>"));
    assert.ok(html.includes("Reported by 4 of 4 players, not confirmed"));
    assert.equal(JSON.parse(m.detail).agree.reported, 5);
});

await check("one browser in two seats doesn't count, and a game's next level isn't taken for this one", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const K = await w.join("Maw2", H, { pk: KEYS.maw });
    for (const g of [H, K]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 3 * MIN;
    await killAll([H, K], 2, 1);
    // The joiner's game is in the next level already; the host's isn't.
    K.lv = 2;
    K.n = 0;
    await K.saw([[1, 2, 1]]);
    await H.report({ end: "left" });
    await w.say(H.ws, "leave");
    await w.settle();
    // Its end isn't this level's either, so the match waits out its time.
    await K.report({ end: "left" });
    skew += 2 * SEC;
    await w.alarm();
    assert.equal(env.LADDER.calls, 0, "still open for the joiner's last word");
    skew += 14 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.deepEqual([m.players, m.kills, m.confirmed, m.counted], [2, 1, 1, 0]);
    assert.equal(JSON.parse(m.detail).sharedKey, true);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM players")[0].n, 1);
    // A host that only serves is no player of its match.
    const D = await w.host("Server");
    const A = await w.join("Kyle_K", D), B = await w.join("Boc", D);
    await D.report({ idle: 1 });
    await A.report();
    await B.report();
    skew += 3 * MIN;
    await killAll([D, A, B], A.id, B.id);
    await hostLeaves(w, D, [A, B], { idle: 1 });
    const d = env.LADDER.rows("SELECT * FROM matches ORDER BY id DESC")[0];
    assert.deepEqual([d.players, d.reporters, d.secs], [2, 2, 180]);
    assert.deepEqual(env.LADDER.rows("SELECT name, host FROM match_players WHERE match_id = ? ORDER BY slot", d.id).map(r => [r.name, r.host]),
                     [["Kyle_K", 0], ["Boc", 0]]);
});

await check("a host that leaves ends its room, and the other games still get their last word", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    const B = await w.join("Boc", H, { pk: KEYS.boc });
    for (const g of [H, K, B]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 2 * MIN;
    await killAll([H, K, B], 2, 1);
    // Boc leaves and stays in the lobby; Jan takes the seat.
    await B.report({ end: "left" });
    await w.say(B.ws, "leave");
    const J = await w.join("Jan_Ors", H, { pk: KEYS.jan });
    assert.equal(J.id, B.id, "the seat is used again");
    await J.report();
    skew += 1 * MIN;
    // The host kills Jan and quits, before the other games have reported it.
    await H.saw([[J.id, 1, 0]], { sb: [[1, 2, 2, 0, 0, 0], [2, 0, 0, 1, 0, 0], [3, 0, 0, 1, 0, 0]], teams: [0, 0, 0, 0, 0], end: "left" });
    await w.say(H.ws, "leave");
    await w.settle();
    assert.equal(env.LADDER.calls, 0, "not saved yet: two games haven't said their last");
    assert.ok([...w.storage.m.keys()].some(k => k.startsWith("match:")), "it's kept open");
    // The lobby sleeps in between, as it does whenever it's quiet: what
    // comes next finds the match in storage and the marks on the sockets.
    const w2 = await new World(env, w.storage).start(w.ctx.sockets);
    for (const g of [H, K, B, J])
        g.world = w2;
    skew += 3 * SEC;
    // Not the host's any more, nor a socket's that never reported it, nor a
    // player's who left before: Boc's game can't speak for Jan's seat.
    await H.report({ t: 999 * SEC });
    const X = await w2.connect();
    await w2.say(X, "match " + b64(JSON.stringify({ v: 1, lv: 1, map: "m2.jkl", title: "", t: 5000, build: "", ev: [[1, 0, 2, 1, 1]] })));
    await B.saw([[J.id, 2, 4]]);
    // A bystander's game saw the kill, and the victim's own knows what did it.
    await K.saw([[J.id, 1, 0]]);
    await J.saw([[J.id, 1, 1]], { end: "left" });
    skew += 2 * SEC;
    await w2.alarm();
    assert.equal(env.LADDER.calls, 0, "one game hasn't sent its end");
    await K.report({ end: "left" });
    skew += 2 * SEC;
    await w2.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.deepEqual([m.players, m.reporters, m.kills, m.confirmed, m.ended, m.secs], [4, 4, 2, 2, "left", 180]);
    const detail = JSON.parse(m.detail);
    assert.equal(detail.why, "room closed");
    assert.deepEqual([detail.agree.sbSame, detail.agree.sbRows], [3, 3], "the host's scoreboard has its last kill, and so has the record");
    const rows = env.LADDER.rows("SELECT name, kills, deaths, secs FROM match_players ORDER BY slot");
    assert.deepEqual(rows.map(r => [r.name, r.kills, r.deaths, r.secs]),
                     [["Maw", 2, 0, 180], ["Kyle_K", 0, 1, 185], ["Boc", 0, 0, 120], ["Jan_Ors", 0, 1, 63]],
                     "each game's time is its own last line's");
    assert.deepEqual([H, K, J].map(g => g.ws.take().filter(l => l.startsWith("matched"))), Array(3).fill([`matched ${m.id}`]));
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("match")).length, 0, "nothing of it is left in storage");
});

await check("a game's last word is heard when it comes while the lobby is busy with something else", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    for (const g of [H, K]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 3 * MIN;
    await killAll([H, K], 2, 1);
    // The record is in the middle of something, as when D1 takes its time
    // over another room's match.
    let free;
    w.lobby.ladder.later(() => new Promise(r => { free = r; }));
    await new Promise(r => setImmediate(r));
    assert.equal(typeof free, "function");
    // The host kills once more and quits, and the other game says what it saw
    // and that it's over, all before the lobby gets to any of it.
    const waiting = [H.saw([[2, 1, 0]], { end: "left" })];
    await w.say(H.ws, "leave");
    waiting.push(K.saw([[2, 1, 1]], { end: "left" }));
    free();
    await Promise.all(waiting);
    await w.settle();
    skew += 2 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.ok(m, "the match is saved");
    assert.deepEqual([m.players, m.reporters, m.kills, m.confirmed, m.ended], [2, 2, 2, 2, "left"]);
    assert.equal(JSON.parse(m.detail).why, "room closed");
    assert.deepEqual(env.LADDER.rows("SELECT name, kills, deaths FROM match_players ORDER BY slot").map(r => [r.name, r.kills, r.deaths]),
                     [["Maw", 2, 0], ["Kyle_K", 0, 2]]);
});

await check("a host's last report of a level that comes late, ahead of its next level's first, closes the match as it ended", async () => {
    const rules = { mode: 0, sl: 0, tl: 0 };
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const J = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    for (const g of [H, J]) { g.since = Date.now(); await g.report({ rules }); }
    skew += 3 * MIN;
    await killAll([H, J], 2, 1, 1);
    await H.report({ rules, sb: [[1, 1, 1, 0, 0, 0], [2, 0, 0, 1, 0, 0]], teams: [0, 0, 0, 0, 0] });
    skew += 30 * SEC;
    // The lobby's socket drops for the host. A kill only it and the joiner saw, 4 s before the level ends.
    await J.saw([[2, 1, 1]]);
    skew += 4 * SEC;
    const endedAt = Date.now(), t = endedAt - H.since;
    await J.report({ end: "level" });
    // 20 s later the host is back, in its next level already: the kept last report, then the new level's first.
    skew += 20 * SEC;
    await H.report({ t, rules, sb: [[1, 2, 2, 0, 0, 0], [2, 0, 0, 2, 0, 0]], teams: [0, 0, 0, 0, 0], end: "level",
                     ev: [[++H.n, Date.now() - (endedAt - 4 * SEC), 2, 1, 0]] });
    H.lv = 2; H.n = 0; H.since = Date.now() - 12 * SEC;
    await H.report({ rules });
    await w.settle();
    const m = env.LADDER.rows("SELECT * FROM matches");
    assert.equal(m.length, 1, "the next level's first report closed it at once");
    assert.deepEqual([m[0].ended, m[0].secs, m[0].kills, m[0].confirmed, m[0].counted], ["level", 214, 2, 2, 1],
                     "as it ended: its length is the level's, and the kill the host still had is the one the other game saw");
    assert.deepEqual(env.LADDER.rows("SELECT kills, deaths FROM match_players ORDER BY slot").map(r => Object.values(r)), [[2, 0], [0, 2]]);
    assert.equal(JSON.parse(m[0].detail).agree.sbSame, 2, "with the host's scoreboard as the level ended");
});

await check("another game's late last report isn't taken for the same level played again", async () => {
    const rules = { mode: 0, sl: 0, tl: 0 };
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const J = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    for (const g of [H, J]) { g.since = Date.now(); await g.report({ rules }); }
    skew += 3 * MIN;
    await killAll([H, J], 2, 1, 1);
    skew += 10 * SEC;
    // The joiner's socket is down as the level ends; the host's isn't.
    const t = Date.now() - J.since;
    await H.report({ rules, end: "level" });
    skew += 5 * SEC;
    // The host's next level, the same map again.
    H.lv = 2; H.n = 0; H.since = Date.now();
    await H.report({ rules });
    // The joiner's socket is back before its own next level began: its kept last report.
    await J.report({ t, end: "level", ev: [[++J.n, 6000, 2, 1, 1]] });
    // Then its game is in the next level too.
    J.lv = 2; J.n = 0; J.since = Date.now();
    await J.report();
    skew += 3 * MIN;
    await killAll([H, J], 2, 1, 1);
    await killAll([H, J], 2, 1, 1);
    await H.report({ rules, end: "level" });
    await J.report({ end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches ORDER BY id");
    assert.equal(m.length, 2);
    assert.deepEqual([m[0].kills, m[0].confirmed], [1, 1], "the first match is as the lobby had it");
    assert.deepEqual([m[1].kills, m[1].confirmed, m[1].reporters, m[1].counted], [2, 2, 2, 1],
                     "the second has its own two kills, both seen by both games, and nothing of the level before");
});

await check("a weapon highlight is left out when kills of a kind nobody told could change it", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { pk: KEYS.maw });
    const K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    // An older game: it reports nothing, so nobody says what killed its player.
    await w.join("Boc", H);
    for (const g of [H, K]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 3 * MIN;
    await killAll([H, K], 2, 1, 1);
    await killAll([H, K], 3, 1);
    skew += 10 * SEC;
    await killAll([H, K], 3, 1);
    await H.report({ end: "level" });
    await K.report({ end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT id, kills FROM matches")[0];
    assert.equal(m.kills, 3);
    const text = textOf((await w.page(`/match/${m.id}`)).body);
    assert.ok(text.includes("Lightsaber 1 Not known 2"), text);
    assert.equal(text.includes("Most saber kills"), false, "Maw's one saber kill leads by less than the two unknown");
    assert.ok(text.includes("Most deaths Boc, 2"));
});

await check("a short match, a match alone and one nobody died in aren't kept", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw");
    await H.report();
    skew += 5 * MIN;
    await H.saw([[1, 0, 5]]);
    await H.report({ end: "left" });
    await w.say(H.ws, "leave");
    await w.settle();
    assert.equal(logged.filter(l => l.includes("not kept")).length >= 1, true, "alone, there's nobody's last word to wait for");
    const H2 = await w.host("Maw");
    const K = await w.join("Kyle_K", H2);
    await H2.report();
    await K.report();
    skew += 30 * SEC;
    await killAll([H2, K], 2, 1);
    await hostLeaves(w, H2, [K]);
    const H3 = await w.host("Maw");
    const K3 = await w.join("Kyle_K", H3);
    await H3.report();
    await K3.report();
    skew += 5 * MIN;
    await hostLeaves(w, H3, [K3]);
    assert.equal(env.LADDER.calls, 0);
    assert.equal(logged.filter(l => l.includes("not kept")).length >= 3, true);
});

await check("a game with a password is recorded, but listed and posted nowhere", async () => {
    const env = newEnv({ DISCORD_WEBHOOK: "https://discord.test/api/webhooks/1/abc", PASSWORD_KEY: "k" });
    const w = await new World(env).start();
    const before = discord.length;
    const H = await w.host("Maw", { password: "sesame" });
    const K = await w.join("Kyle_K", H, { password: "sesame" });
    const B = await w.join("Boc", H, { password: "sesame" });
    for (const g of [H, K, B]) {
        g.since = Date.now();
        await g.report();
    }
    skew += 3 * MIN;
    await killAll([H, K, B], 2, 1);
    await hostLeaves(w, H, [K, B]);
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.deepEqual([m.locked, m.counted, m.players], [1, 0, 3]);
    assert.equal((await w.status()).match, 0);
    assert.deepEqual(JSON.parse((await w.page("/ladder/recent")).body).games, { jk1: [], mots: [] });
    assert.equal(discord.length, before);
    assert.equal((await w.page("/matches")).body.includes(`/match/${m.id}`), false);
    const page = await w.page(`/match/${m.id}`);
    assert.equal(page.status, 200, "its players can still open its page");
    assert.ok(page.body.includes("password game"));
    // As well known as any other: its kills were seen by all three games.
    assert.ok(page.body.includes("Confirmed by 3 of 3 players"));
    assert.equal(/standings/.test(page.body), false, "nothing ranks players yet");
    assert.deepEqual(K.ws.take().filter(l => l.startsWith("matched")), [`matched ${m.id}`]);
});

await check("teams: the team with the most wins, and a custom map is marked", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw", { game: "mots", episode: "sabersgalore", map: "duel.jkl", title: "Sabers Galore",
                                    tail: modTail("", null, "cd".repeat(16)) });
    const K = await w.join("Kyle_K", H, { game: "mots" });
    const B = await w.join("Boc", H, { game: "mots" });
    for (const g of [H, K, B]) {
        g.since = Date.now();
        await g.report({ rules: { mode: 0x1 | 0x8, sl: 0, tl: 15 } });
    }
    skew += 3 * MIN;
    await killAll([H, K, B], 3, 1, 1);
    await killAll([H, K, B], 3, 2, 1);
    await killAll([H, K, B], 1, 3, 1);
    await H.report({ sb: [[1, 1, 1, 1, 0, 1], [2, 1, 1, 0, 0, 1], [3, 1, 1, 2, 0, 3]], teams: [0, 2, 0, 1, 0],
                     rules: { mode: 0x1 | 0x8, sl: 0, tl: 15 }, end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches")[0];
    assert.deepEqual([m.game, m.mod, m.pack, m.episode, m.time_limit], ["mots", "", 1, "sabersgalore", 15]);
    const rows = env.LADDER.rows("SELECT name, team, won FROM match_players ORDER BY slot");
    assert.deepEqual(rows.map(r => [r.name, r.team, r.won]), [["Maw", 1, 1], ["Kyle_K", 1, 1], ["Boc", 3, 0]]);
    const s = JSON.parse((await w.page("/ladder/recent")).body).games.mots[0];
    assert.deepEqual([s.teams, s.name, s.team, s.score, s.custom, s.pack], [true, null, 1, 2, 1, 1]);
    const html = (await w.page(`/match/${m.id}`)).body;
    assert.ok(html.includes("Red team wins"));
    assert.ok(html.includes("Custom map (sabersgalore, duel.jkl)"));
    assert.ok(html.includes("Remastered pack"));
    assert.ok(html.includes("Time limit 15 min"));
    assert.ok(html.includes("Mysteries of the Sith"));
    const list = (await w.page("/matches?game=mots")).body;
    assert.ok(list.includes("Red team won") || list.includes("Red team"));
    assert.ok(list.includes('<span class="tag soft">Custom</span>'));
});

await check("a match D1 doesn't take is tried again, and a match nobody ends closes by itself", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw");
    const K = await w.join("Kyle_K", H);
    await H.report();
    await K.report();
    skew += 3 * MIN;
    await killAll([H, K], 2, 1);
    // No end from anyone, and no more reports: over after five quiet minutes.
    // The sockets stay up meanwhile, as a page's pings keep them.
    const quiet = async (ms) => {
        for (let at = 0; at < ms; at += MIN) {
            skew += MIN;
            await w.say(H.ws, "ping");
            await w.say(K.ws, "ping");
        }
    };
    await quiet(4 * MIN);
    await w.alarm();
    assert.equal(env.LADDER.calls, 0, "still open");
    env.LADDER.fail = 3;
    await quiet(2 * MIN);
    await w.alarm();
    assert.equal(env.LADDER.fail < 3, true, "tried");
    assert.equal(env.LADDER.rows("SELECT name FROM sqlite_master WHERE name = 'matches'").length, 0);
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("matchdone:")).length, 1, "kept in storage meanwhile");
    // The lobby restarts before the next try.
    const w2 = await new World(env, w.storage).start(w.ctx.sockets);
    env.LADDER.fail = 0;
    skew += 61 * SEC;
    await w2.alarm();
    const m = env.LADDER.rows("SELECT * FROM matches");
    assert.equal(m.length, 1);
    assert.equal(JSON.parse(m[0].detail).why, "went quiet");
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("matchdone:")).length, 0);
    // A late report from its host doesn't open it again.
    await H.report();
    await w2.settle();
    skew += 6 * MIN;
    await w2.alarm();
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM matches")[0].n, 1);
});

await check("only a game in the room's seat is heard, and only so often", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const H = await w.host("Maw");
    const K = await w.join("Kyle_K", H);
    const out = await w.connect();
    await w.say(out, "match " + b64(JSON.stringify({ v: 1, lv: 1, map: "m2.jkl", t: 0 })));
    await w.settle();
    assert.equal(w.lobby.ladder.matches.size, 0, "a game in no room opens no match");
    // A joiner alone doesn't open one either: the host's game does.
    await K.report();
    assert.equal(w.lobby.ladder.matches.size, 0);
    await H.report();
    assert.equal(w.lobby.ladder.matches.size, 1);
    // Another level's report from a joiner isn't this match's.
    await K.report({ map: "m4.jkl" });
    assert.equal(w.lobby.ladder.matches.get(H.room).players.filter(p => p.reports).length, 1);
    for (let i = 0; i < 60; i++)
        await K.saw([[1, 2, 1]]);
    const kills = w.lobby.ladder.matches.get(H.room).kills.length;
    assert.equal(kills, 18, `${kills} kills taken from 60 lines at once: 20 lines, two of them used before`);
    assert.deepEqual(K.ws.take().concat(out.take()).filter(l => !/^(peer-|seat|lobby|ice)/.test(l)), [], "none of it is answered");
});

await check("a player's key: the cookie first, then the page's own, then a new one", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const post = (headers, body) => w.page("/ladder/key", { Origin: "https://lobby.test", ...headers }, { method: "POST", body });
    const fresh = await post({}, "");
    assert.equal(fresh.status, 200);
    const key = JSON.parse(fresh.body).key;
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(fresh.headers["Set-Cookie"], `jkpk=${key}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Lax; Secure`);
    assert.equal(fresh.headers["Cache-Control"], "no-store");
    assert.notEqual(JSON.parse((await post({}, "")).body).key, key);
    assert.equal(JSON.parse((await post({}, JSON.stringify({ key: KEYS.maw }))).body).key, KEYS.maw);
    assert.equal(JSON.parse((await post({ Cookie: `a=b; jkpk=${KEYS.kyle}` }, JSON.stringify({ key: KEYS.maw }))).body).key, KEYS.kyle);
    assert.notEqual(JSON.parse((await post({ Cookie: "jkpk=<script>" }, JSON.stringify({ key: "x" }))).body).key.length, 0);
    assert.equal((await post({ Origin: "https://elsewhere.test" }, "")).status, 403);
    assert.equal((await w.page("/ladder/key")).status, 405);
    assert.equal((await post({}, "x".repeat(600))).status, 200, "a body that isn't a key is as none");
    assert.equal(env.LADDER.calls, 0, "a key touches no database");
});

await check("a week begins on Monday at three in the morning, Pacific time, summer and winter", () => {
    const utc = (...a) => Date.UTC(...a);
    // Tuesday 10 November 2026, half past midnight there: Monday the 9th at 3, winter time.
    assert.equal(periodStart("week", utc(2026, 10, 10, 8, 30)), utc(2026, 10, 9, 11));
    // A minute before it turns, it's still the week before.
    assert.equal(periodStart("week", utc(2026, 10, 9, 10, 59)), utc(2026, 10, 2, 11));
    assert.equal(periodStart("week", utc(2026, 10, 9, 11, 0)), utc(2026, 10, 9, 11));
    // Summer time, and the week the clocks go back in.
    assert.equal(periodStart("week", utc(2026, 6, 15, 19)), utc(2026, 6, 13, 10));
    assert.equal(periodStart("week", utc(2026, 10, 1, 20)), utc(2026, 9, 26, 10));
    // A month: its first day at 3, and before that hour still last month.
    assert.equal(periodStart("month", utc(2026, 10, 10, 8, 30)), utc(2026, 10, 1, 11));
    assert.equal(periodStart("month", utc(2026, 2, 1, 10)), utc(2026, 1, 1, 11));
    assert.equal(periodStart("month", utc(2026, 6, 15, 19)), utc(2026, 6, 1, 10));
    assert.equal(periodStart("all", utc(2026, 10, 10)), 0);
    assert.equal(periodStart("nonsense", utc(2026, 10, 10)), 0);
    for (let day = 0; day < 400; day += 3) {
        const now = utc(2026, 0, 1, 5, 17) + day * 24 * 60 * MIN;
        const at = new Date(periodStart("week", now));
        const there = at.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", hour: "numeric", minute: "2-digit" });
        assert.equal(there, "Monday 3:00 AM");
        assert.ok(at <= now && now - at < 7 * 24 * 60 * MIN + 2 * 60 * MIN);
    }
});

await check("the standings add up the matches that count, one game and one period at a time", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const boc = "<b>Boc`s</b>";
    // From a Tuesday, so the first match is last week's and the others this
    // week's, whenever this runs.
    skew += ((2 - new Date(Date.now()).getUTCDay() + 7) % 7) * 24 * 60 * MIN;
    // Old: Maw 3, Kyle 3 (one of them Maw), so nobody won; Boc killed twice and once by himself.
    const first = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], [boc, KEYS.boc]],
                                  [[2, 1], [2, 1], [2, 1, 4], [1, 2, 2], [3, 0, 5], [3, 2, 2], [3, 2, 2]]);
    skew += 8 * 24 * 60 * MIN;
    const second = await playMatch(w, [["Kyle_K", KEYS.kyle], ["Maw", KEYS.maw]], [[2, 1], [2, 1], [1, 2]],
                                   { title: "Canyon Oasis", map: "m4.jkl", tail: modTail("SBX 4.5", MOD_FP, null) });
    const sith = await playMatch(w, [["Maw", KEYS.maw], ["Jan", KEYS.jan]], [[1, 2], [1, 2]], { game: "mots" });
    // Too short to count, and one with a password.
    const short = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1]], { secs: 70 });
    const locked = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]], { password: "hush" });
    assert.ok(first && second && sith && short && locked);
    assert.deepEqual(env.LADDER.rows("SELECT counted FROM matches ORDER BY id").map(r => r.counted), [1, 1, 1, 0, 0]);
    const [maw, kyle, bocId, jan] = env.LADDER.rows("SELECT id FROM players ORDER BY id").map(r => r.id);

    // No period asked for: the shortest anyone played in.
    const week = await w.page("/players", { Cookie: `jkpk=${KEYS.maw}` });
    assert.equal(week.status, 200);
    const rowsOf = html => [...html.matchAll(/<tr(?: class="you")?>\s*<td class="num">[^]*?<\/tr>/g)].map(r => textOf(r[0]).trim());
    assert.deepEqual(rowsOf(week.body), ["1 Kyle_K 2 2 1 0 2.00 + 1 1 3 min", "2 Maw You 1 1 2 0 0.50 + 1 0 3 min"]);
    assert.ok(textOf(week.body).includes("This Week | 2 players | 1 match | 3 kills"));
    assert.match(week.body, /<a href="\/players\?period=week" aria-current="page">This Week<\/a>/);
    assert.match(week.body, new RegExp(`<tr class="you">\\s*<td class="num"><span class="place p2">2</span></td>\\s*<td class="name"><a href="/player/${maw}\\?game=jk&amp;period=week">Maw</a>`));
    assert.ok(week.body.includes("Fewer than 30 kills and deaths this week"));
    // All time, with a name that isn't markup and the worst score last.
    const all = await w.page("/players?period=all");
    assert.deepEqual(rowsOf(all.body), ["1 Kyle_K 5 5 4 0 1.25 + 2 1 6 min", "2 Maw 4 4 3 0 1.33 + 2 0 6 min",
                                        "3 b Boc`s /b -1 0 3 1 0.00 + 1 0 3 min"]);
    assert.equal(all.body.includes("<b>Boc"), false);
    assert.ok(all.body.includes("&lt;b&gt;Boc`s&lt;/b&gt;</a>"));
    const namesOf = html => [...html.matchAll(/<td class="name"><a [^>]*>([^<]*)<\/a>/g)].map(r => r[1][0]);
    assert.equal(all.body.includes('class="tag">You'), false);
    // By another column, and the other way up.
    assert.deepEqual(namesOf((await w.page("/players?period=all&sort=deaths")).body), ["K", "M", "&"]);
    assert.deepEqual(namesOf((await w.page("/players?period=all&sort=deaths&dir=asc")).body), ["M", "&", "K"]);
    assert.deepEqual(namesOf((await w.page("/players?period=all&sort=name&dir=asc")).body), ["&", "K", "M"]);
    assert.deepEqual(namesOf((await w.page("/players?period=all&sort=wins")).body), ["K", "M", "&"]);
    // Nobody has 30 kills and deaths, so by K/D nobody has a place.
    assert.equal(((await w.page("/players?period=all&sort=kd")).body.match(/<td class="num">&ndash;<\/td>/g) || []).length, 3);
    assert.equal((await w.page("/players?sort=nonsense&period=nonsense")).status, 200);
    // The other game.
    const mots = await w.page("/players?game=mots");
    assert.deepEqual(rowsOf(mots.body), ["1 Jan 2 2 0 0 2.00 + 1 1 3 min", "2 Maw 0 0 2 0 0.00 + 1 0 3 min"]);
    assert.ok(mots.body.includes("Mysteries of the Sith standings"));
    assert.equal(week.headers["Cache-Control"], "private, max-age=30");
    assert.equal(/ style="/.test(all.body), false);

    // The landing page's lists: each game's leaders over each period, where
    // the viewer stands in them, and the viewer's own latest match (the one
    // with a password, which is in no list).
    const lists = JSON.parse((await w.page("/ladder/recent", { Cookie: `jkpk=${KEYS.maw}` })).body);
    assert.equal(lists.top.jk1.period, "week");
    assert.deepEqual(lists.top.jk1.week, { of: 2, matches: 1, you: { rank: 2, score: 1 }, players: [
        { id: kyle, name: "Kyle_K", score: 2, kills: 2, deaths: 1, matches: 1 }, { id: maw, name: "Maw", score: 1, kills: 1, deaths: 2, matches: 1 }] });
    assert.deepEqual([lists.top.jk1.all.of, lists.top.jk1.all.matches, lists.top.jk1.all.you], [3, 2, { rank: 2, score: 4 }]);
    assert.deepEqual(lists.top.jk1.all.players.map(p => p.name), ["Kyle_K", "Maw", boc]);
    assert.deepEqual(lists.top.mots.week.players.map(p => p.name), ["Jan", "Maw"]);
    assert.deepEqual(lists.you, { id: maw, name: "Maw", last: locked });
    const nobody = JSON.parse((await w.page("/ladder/recent")).body);
    assert.deepEqual([nobody.you, nobody.top.jk1.week.you], [null, null]);
    assert.equal(lists.games.jk1.some(m => m.id === locked), false);

    // The standings were added up once and kept: a page reads them in one
    // round trip, whatever it sorts by.
    assert.deepEqual(env.LADDER.rows("SELECT key FROM ladder_cache ORDER BY key").map(r => r.key),
                     ["board:jk1:all", "board:jk1:month", "board:jk1:week", "board:mots:all", "board:mots:month", "board:mots:week"]);
    const calls = env.LADDER.calls;
    await w.page("/players?period=all&sort=kills");
    await w.page("/ladder/recent", { Cookie: `jkpk=${KEYS.kyle}` });
    assert.equal(env.LADDER.calls - calls, 2);

    // A player: what they did, who they met, and their matches.
    const page = await w.page(`/player/${kyle}?game=jk&period=all`, { Cookie: `jkpk=${KEYS.kyle}` });
    assert.equal(page.status, 200);
    const text = textOf(page.body);
    assert.match(page.body, /<h2>Kyle_K <span class="tag">You<\/span><\/h2>/);
    assert.ok(text.includes("1st of 3 all time | Jedi Knight | last played"), text.slice(0, 900));
    assert.ok(text.includes("Score 5 Kills 5 Deaths 4 Suicides 0 K/D 1.25 + Matches 2 Wins 1 Time 6 min Best match 3 kills Best streak 3"), text.slice(0, 1200));
    assert.ok(text.includes("+ Fewer than 30 kills and deaths all time: K/D is shown but takes no place in the standings."));
    assert.ok(text.includes("Nemesis Maw , killed by them 4x"));
    assert.ok(text.includes("Favorite target Maw , killed 3x"));
    assert.ok(text.includes("First bloods 1"));
    assert.ok(text.includes("Win rate 50%"));
    assert.ok(text.includes("Matches hosted 1"));
    assert.ok(text.includes("Lightsaber 2 40% Shots 3 60%"), text);
    assert.ok(text.includes("Canyon Oasis 1 match") && text.includes("SBX 4.5 1 match") && text.includes("No mod 1 match"));
    assert.ok(text.includes("Against Killed them Killed by them Difference Maw 3 4 -1 b Boc`s /b 2 0 +2 From 2 matches all time."));
    assert.match(page.body, new RegExp(`<td><a href="/player/${maw}\\?game=jk">Maw</a></td><td class="num">3</td><td class="num">4</td>\\s*<td class="num down">-1</td>`));
    // Their matches, the short one marked and the one with a password left out.
    assert.ok(page.body.includes(`/match/${short}`) && text.includes("Not counted"));
    assert.equal(page.body.includes(`/match/${locked}`), false);
    assert.equal(page.body.split("<aside")[0].includes(`/match/${sith}`), false, "another game's match isn't in this game's list");
    assert.equal(page.body.includes("<b>Boc"), false);
    assert.equal(/ style="/.test(page.body), false);
    assert.equal(/ on[a-z]+="/.test(page.body), false);
    // Without a game it's the one they played last; this week Kyle has one match.
    const now = textOf((await w.page(`/player/${kyle}`)).body);
    assert.ok(now.includes("1st of 2 this week | Jedi Knight"), now.slice(0, 900));
    assert.ok(textOf((await w.page(`/player/${maw}?game=mots`)).body).includes("2nd of 2 this week | Mysteries of the Sith"));
    const none = await w.page(`/player/${jan}?game=jk`);
    assert.ok(textOf(none.body).includes("Jan has no Jedi Knight matches that count all time."));
    // A match's names lead to their players.
    assert.ok((await w.page(`/match/${first}`)).body.includes(`<a href="/player/${bocId}?game=jk">&lt;b&gt;Boc\`s&lt;/b&gt;</a>`));
    // Nobody by that number, a record taken off the pages, and other paths.
    assert.equal((await w.page("/player/999")).status, 404);
    env.LADDER.db.exec(`UPDATE players SET hidden = 1 WHERE id = ${bocId}`);
    assert.equal((await w.page(`/player/${bocId}`)).status, 404);
    assert.equal((await w.page(`/match/${first}`)).body.includes(`/player/${bocId}`), false);
    // The standings are the kept ones until they're emptied, a match is
    // saved or the day is over.
    assert.equal(rowsOf((await w.page("/players?period=all")).body).length, 3);
    env.LADDER.db.exec("DELETE FROM ladder_cache");
    assert.equal(rowsOf((await w.page("/players?period=all")).body).length, 2);
    env.LADDER.db.exec(`UPDATE players SET hidden = 0 WHERE id = ${bocId}`);
    skew += 24 * 60 * MIN;
    assert.equal(rowsOf((await w.page("/players?period=all")).body).length, 3, "added up again the next day");
    // A new match is in them at once, and a new week starts empty.
    await playMatch(w, [["Jan", KEYS.jan], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1], [2, 1]]);
    assert.deepEqual(rowsOf((await w.page("/players?period=all")).body).map(r => r.split(" ").slice(0, 3).join(" ")),
                     ["1 Kyle_K 5", "2 Maw 4", "3 Jan 3", "4 b Boc`s"]);
    skew += 7 * 24 * 60 * MIN;
    const later = JSON.parse((await w.page("/ladder/recent")).body);
    assert.deepEqual([later.top.jk1.week.players, later.top.jk1.week.matches, later.top.jk1.all.of], [[], 0, 4]);
    assert.notEqual(later.top.jk1.period, "week");
    assert.equal((await w.page("/players", {}, { method: "POST" })).status, 405);
    env.ASSETS = { fetch: async () => new Response("asset", { status: 200 }) };
    assert.equal((await w.page("/player/abc")).body, "asset");
    assert.equal((await w.page("/playersx")).body, "asset");
});

await check("a browser never seen before joins the record that has its name, and can be taken off it again", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const NEW = n => String(n).repeat(32);
    const players = () => env.LADDER.rows("SELECT id, name, merged_into FROM players ORDER BY id").map(p => [p.id, p.name, p.merged_into]);
    const board = async () => [...(await w.page("/players?period=all")).body.matchAll(/<td class="name"><a href="\/player\/(\d+)[^"]*">([^<]*)<\/a>[^]*?<td class="num[^"]*">(-?\d+)<\/td>\s*<td class="num[^"]*">(\d+)<\/td>/g)]
        .map(r => [Number(r[1]), r[2], Number(r[4])]);
    assert.deepEqual([joinableName("Maw"), joinableName(" player "), joinableName("Al"), joinableName("KYLE")], [true, false, false, false]);

    const m1 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    // Maw from a browser the lobby never saw, in other letters: the same player.
    const m2 = await playMatch(w, [["Kyle_K", KEYS.kyle], ["maw", NEW(5)]], [[1, 2], [1, 2], [1, 2]]);
    assert.deepEqual(players(), [[1, "maw", null], [2, "Kyle_K", null], [3, "maw", 1]]);
    assert.deepEqual(env.LADDER.rows("SELECT match_id, player_id FROM match_players WHERE name IN ('Maw', 'maw') ORDER BY match_id")
        .map(r => [r.match_id, r.player_id]), [[m1, 1], [m2, 3]], "each row keeps the browser it came from");
    assert.deepEqual(await board(), [[1, "maw", 5], [2, "Kyle_K", 0]]);
    assert.ok(logged.some(l => l.includes(`match ${m2}: a new browser joins record 1 by its name`)));
    // The new browser's player is "You" in the old browser's match, and its own number leads to the record.
    assert.match((await w.page(`/match/${m1}`, { Cookie: `jkpk=${NEW(5)}` })).body, /<a href="\/player\/1\?game=jk">Maw<\/a><\/b> <span class="tag">You<\/span>/);
    const moved = await w.page("/player/3?period=all");
    assert.deepEqual([moved.status, moved.headers.Location], [302, "/player/1?period=all"]);
    const page = textOf((await w.page("/player/1?period=all")).body);
    assert.ok(page.includes("1st of 2 all time") && page.includes("this record has matches from 2 browsers"), page.slice(-600));
    assert.ok(page.includes("Also played as Maw") === false, "the same name in other letters isn't another name");

    // Not when the record's own browser is in the match: that's somebody else.
    await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["maw ", NEW(6)]], [[2, 1], [3, 1]]);
    assert.deepEqual(players().slice(3), [[4, "maw", null]]);
    // Not two of one name in a match, which then are two records, and not a third of that name afterwards.
    await playMatch(w, [["Twin", NEW(7)], ["Twin", NEW(8)], ["Kyle_K", KEYS.kyle]], [[3, 1], [3, 2]]);
    await playMatch(w, [["Twin", NEW(9)], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(players().slice(4), [[5, "Twin", null], [6, "Twin", null], [7, "Twin", null]]);
    // Not by a name anyone might have.
    await playMatch(w, [["Player", NEW("a")], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    await playMatch(w, [["Player", NEW("b")], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(players().slice(7), [[8, "Player", null], [9, "Player", null]]);
    // A browser the lobby knows keeps its own record whatever it's called, and its record takes the new name.
    await playMatch(w, [["Kyle_K", KEYS.maw], ["Jan", KEYS.jan]], [[2, 1], [2, 1]]);
    assert.deepEqual(players().slice(0, 3), [[1, "Kyle_K", null], [2, "Kyle_K", null], [3, "maw", 1]]);
    assert.equal(players().length, 10);
    // A record taken off the pages isn't joined.
    env.LADDER.db.exec("UPDATE players SET hidden = 1 WHERE name = 'Jan'");
    await playMatch(w, [["Jan", NEW("c")], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(players().slice(10), [[11, "Jan", null]]);

    // By hand: the new browser's matches become a record of their own again.
    env.LADDER.db.exec("UPDATE players SET merged_into = NULL WHERE id = 3");
    const split = await board();
    assert.deepEqual(split.filter(r => r[0] === 1 || r[0] === 3), [[1, "Kyle_K", 6], [3, "maw", 3]]);
    assert.equal((await w.page("/player/3?period=all")).status, 200);

    // Turned off, every new browser is a new record.
    const env2 = newEnv({ LADDER_JOIN_NAMES: "0" });
    const w2 = await new World(env2).start();
    await playMatch(w2, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    await playMatch(w2, [["Maw", NEW(5)], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(env2.LADDER.rows("SELECT name, merged_into FROM players ORDER BY id").map(p => [p.name, p.merged_into]),
                     [["Maw", null], ["Kyle_K", null], ["Maw", null]]);
});

await check("a player whose game sent no key counts for the one record that has their name, whichever came first", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const NEW = n => String(n).repeat(32);
    // A name's lines: [match, the record it counts for, by "key" or by "name"].
    const lines = (e, name) => e.LADDER.rows(
        `SELECT mp.match_id, COALESCE(p.merged_into, p.id) AS record, p.key_hash
         FROM match_players mp LEFT JOIN players p ON p.id = mp.player_id
         WHERE mp.name = ? COLLATE NOCASE ORDER BY mp.match_id, mp.slot`, name)
        .map(r => [r.match_id, r.record, !r.key_hash ? null : r.key_hash.startsWith("name:") ? "name" : "key"]);
    // The standings: [record, name, matches], by record.
    const board = async (world = w) => [...(await world.page("/players?period=all")).body.matchAll(/<td class="name"><a href="\/player\/(\d+)[^"]*">([^<]*)<\/a>[^]*?<\/tr>/g)]
        .map(r => [Number(r[1]), r[2], Number(textOf(r[0]).trim().split(" ").at(-4))]).sort((a, b) => a[0] - b[0]);

    // Drum's game says nothing in its first match (a tab from before the
    // record): in it by name, and nobody's.
    const m1 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Drum", null, "silent"]], [[3, 1], [3, 2], [1, 3]]);
    assert.deepEqual(lines(env, "Drum"), [[m1, null, null]]);
    assert.deepEqual(env.LADDER.rows("SELECT counted, reporters, players FROM matches").map(r => [r.counted, r.reporters, r.players]), [[1, 2, 3]]);
    assert.deepEqual(await board(), [[1, "Maw", 1], [2, "Kyle_K", 1]]);
    // Then with a key, in other letters: a record, and the earlier match is its too.
    const m2 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["drum", NEW(5)]], [[3, 1], [1, 3]]);
    assert.deepEqual(lines(env, "Drum"), [[m1, 3, "name"], [m2, 3, "key"]]);
    assert.deepEqual(env.LADDER.rows("SELECT id, key_hash, name, merged_into FROM players WHERE id > 2 ORDER BY id")
        .map(p => [p.id, p.key_hash.length, p.name, p.merged_into]), [[3, 64, "drum", null], [4, 6, "Drum", 3]]);
    assert.ok(logged.some(l => l.includes(`match ${m1}: a player with no key joins record 3 by their name`)));
    assert.deepEqual(await board(), [[1, "Maw", 2], [2, "Kyle_K", 2], [3, "drum", 2]]);
    // First seen when the first of its matches was played.
    assert.equal(env.LADDER.rows("SELECT first_at FROM players WHERE id = 3")[0].first_at,
                 env.LADDER.rows("SELECT ended_at FROM matches WHERE id = ?", m1)[0].ended_at);
    // The match's name leads to the record, the stand-in's own number too, and
    // the others met one Drum, not two.
    assert.ok((await w.page(`/match/${m1}`)).body.includes(`<a href="/player/3?game=jk">Drum</a>`));
    const moved = await w.page("/player/4?period=all");
    assert.deepEqual([moved.status, moved.headers.Location], [302, "/player/3?period=all"]);
    const drum = textOf((await w.page("/player/3?period=all")).body);
    assert.ok(drum.includes("Matches 2") && drum.includes("the match counts by their name alone (1 match of this record)"), drum.slice(-500));
    assert.equal(drum.includes("browsers)"), false, "the stand-in is no browser");
    const maw = (await w.page("/player/1?period=all")).body;
    assert.equal((maw.match(/<td><a href="\/player\/3\?game=jk">drum<\/a><\/td>/g) || []).length, 1);
    assert.equal(/<td>Drum<\/td>/i.test(maw), false);
    assert.ok(textOf(maw).includes("the match counts by their name alone."));

    // Later without a key again, this time from a game that reports: the record's at once.
    const m3 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Drum", null]], [[3, 1]]);
    assert.deepEqual(lines(env, "Drum").slice(2), [[m3, 3, "name"]]);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM players")[0].n, 4, "one stand-in for a record");
    assert.deepEqual((await board())[2], [3, "drum", 3]);

    // Not when the record's player is in the match with their key: that's somebody else.
    const m4 = await playMatch(w, [["Maw", KEYS.maw], ["Drum", NEW(5)], ["Drum", null, "silent"]], [[3, 1], [2, 1]]);
    assert.deepEqual(lines(env, "Drum").slice(3), [[m4, 3, "key"], [m4, null, null]]);
    // Not when two in the match have the name and neither a key: which of them would it be.
    const mTwo = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Drum", null, "silent"], ["drum", null, "silent"]],
                                 [[3, 1], [4, 2]]);
    assert.deepEqual(lines(env, "Drum").slice(5), [[mTwo, null, null], [mTwo, null, null]]);
    // Not by a name anyone might have, though one record has it.
    await playMatch(w, [["Maw", KEYS.maw], ["Player", NEW(6)]], [[2, 1], [2, 1]]);
    const m6 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Player", null, "silent"]], [[3, 1], [3, 2]]);
    assert.deepEqual(lines(env, "Player").at(-1), [m6, null, null]);
    // Not a name two records have.
    await playMatch(w, [["Twin", NEW(7)], ["Twin", NEW(8)], ["Kyle_K", KEYS.kyle]], [[3, 1], [3, 2]]);
    const m8 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Twin", null, "silent"]], [[3, 1], [3, 2]]);
    assert.deepEqual(lines(env, "Twin").at(-1), [m8, null, null]);
    // Not when the record was in that match under the name it had then: Kyle
    // takes the name of someone who played beside him.
    const m9 = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Ghost", null, "silent"]], [[3, 1], [3, 2]]);
    await playMatch(w, [["Maw", KEYS.maw], ["Ghost", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.equal(env.LADDER.rows("SELECT name FROM players WHERE id = 2")[0].name, "Ghost");
    assert.deepEqual(lines(env, "Ghost")[0], [m9, null, null]);
    // Not a record taken off the pages.
    env.LADDER.db.exec("UPDATE players SET hidden = 1 WHERE id = 1");
    const m11 = await playMatch(w, [["Jan", KEYS.jan], ["Ghost", KEYS.kyle], ["Maw", null, "silent"]], [[3, 1], [3, 2]]);
    assert.deepEqual(lines(env, "Maw").at(-1), [m11, null, null]);
    env.LADDER.db.exec("UPDATE players SET hidden = 0 WHERE id = 1");
    // ... which the next match under that name puts right.
    await playMatch(w, [["Maw", KEYS.maw], ["Jan", KEYS.jan]], [[2, 1], [2, 1]]);
    assert.deepEqual(lines(env, "Maw").filter(l => l[0] === m11), [[m11, 1, "name"]]);

    // By hand: the stand-in taken off its record is a player of its own, and
    // the record gets no more such lines, whatever becomes of the stand-in.
    env.LADDER.db.exec("UPDATE players SET merged_into = NULL WHERE key_hash = 'name:3'");
    env.LADDER.db.exec("DELETE FROM ladder_cache");
    assert.deepEqual((await board()).filter(r => r[0] === 3 || r[0] === 4), [[3, "Drum", 2], [4, "Drum", 2]]);
    const m13 = await playMatch(w, [["Jan", KEYS.jan], ["Ghost", KEYS.kyle], ["Drum", null, "silent"]], [[3, 1], [3, 2]]);
    assert.deepEqual(lines(env, "Drum").at(-1), [m13, null, null]);
    env.LADDER.db.exec("UPDATE players SET hidden = 1 WHERE id = 4");
    const m14 = await playMatch(w, [["Jan", KEYS.jan], ["Ghost", KEYS.kyle], ["Drum", null, "silent"]], [[3, 1], [3, 2]]);
    assert.deepEqual(lines(env, "Drum").slice(-2), [[m13, null, null], [m14, null, null]]);

    // A record is found by its name without reading the table.
    assert.match(env.LADDER.rows(`EXPLAIN QUERY PLAN SELECT id FROM players WHERE name = ? COLLATE NOCASE AND merged_into IS NULL
                                  AND hidden = 0 LIMIT 2`, "x").map(r => r.detail).join(" "), /USING INDEX players_name/);

    // Turned off, a player with no key is nobody's.
    const env2 = newEnv({ LADDER_JOIN_NAMES: "0" });
    const w2 = await new World(env2).start();
    const old = await playMatch(w2, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Drum", null, "silent"]], [[3, 1], [3, 2]]);
    await playMatch(w2, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Drum", NEW(5)]], [[3, 1], [1, 3]]);
    assert.deepEqual(lines(env2, "Drum")[0], [old, null, null]);
    assert.deepEqual((await board(w2))[2], [3, "Drum", 1]);
    // A lobby that has the rule looks at what was saved before it once, with
    // the first match it saves, whoever played in that one; the standings
    // have it at once.
    const env3 = { ...env2, LADDER_JOIN_NAMES: "1" };
    const w3 = await new World(env3).start();
    assert.equal(env3.LADDER.calls, env2.LADDER.calls, "nothing goes to D1 before a match is saved");
    await playMatch(w3, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(lines(env3, "Drum")[0], [old, 3, "name"]);
    assert.ok(logged.some(l => l.includes("1 earlier line(s) of players with no key joined their records")));
    assert.deepEqual((await board(w3))[2], [3, "Drum", 2]);
    assert.equal(w3.storage.m.get("ladder:keyless"), 1);
    // Once: a line that turns up nobody's afterwards waits for a match under its name.
    env3.LADDER.db.exec("UPDATE match_players SET player_id = NULL WHERE match_id = " + old + " AND name = 'Drum'");
    await playMatch(w3, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.deepEqual(lines(env3, "Drum")[0], [old, null, null]);
    await playMatch(w3, [["Maw", KEYS.maw], ["Drum", NEW(5)]], [[2, 1], [2, 1]]);
    assert.deepEqual(lines(env3, "Drum")[0], [old, 3, "name"]);
});

await check("a database with no tables yet shows an empty list, and one that's away says so", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    const res = await w.page("/matches");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("No matches recorded yet."));
    env.LADDER.fail = 5;
    const down = await w.page("/matches");
    assert.equal(down.status, 503);
    assert.equal(down.headers["Cache-Control"], "no-store");
    env.LADDER.fail = 5;
    assert.equal((await w.page("/ladder/recent")).status, 503);
    // Other paths aren't the record's.
    env.LADDER.fail = 0;
    env.ASSETS = { fetch: async () => new Response("asset", { status: 200 }) };
    assert.equal((await w.page("/match/abc")).body, "asset");
    assert.equal((await w.page("/matchesx")).body, "asset");
    assert.equal((await w.page("/")).body, "asset");
});

await check("the page's status names the level a room is on, from its host's report, and follows it", async () => {
    const env = newEnv();
    const w = await new World(env).start();
    // A page watching, as the landing page does: it hears each change.
    const page = await w.connect();
    await w.say(page, "watch");
    const heard = () => page.take().filter(l => l.startsWith("status "))
        .map(l => JSON.parse(Buffer.from(l.slice(7), "base64").toString()).games.map(g => [g.map, g.title]));
    heard();
    const H = await w.host("Maw", { map: "m10.jkl", title: "Canyon Oasis" });
    assert.deepEqual(heard().pop(), [["m10.jkl", undefined]], "no name before its host's game has said");
    H.since = Date.now();
    await H.report();
    await w.settle();
    assert.deepEqual(heard(), [[["m10.jkl", "Canyon Oasis"]]], "the page is told as soon as it has said");
    // Another game's word doesn't change what its host's said.
    const K = await w.join("Kyle_K", H, { title: "Something else" });
    K.since = Date.now();
    await K.report();
    await w.settle();
    assert.deepEqual((await w.status()).games.map(g => g.title), ["Canyon Oasis"]);
    heard();
    // The next level: its entry first, then its report.
    await w.say(H.ws, "update " + entry({ map: "M4.JKL" }));
    assert.deepEqual(heard().pop(), [["M4.JKL", undefined]], "the level before's name isn't this one's");
    H.lv = 2;
    H.since = Date.now();
    H.opts = { ...H.opts, map: "M4.JKL", title: "Bespin Mining Station" };
    await H.report();
    await w.settle();
    assert.deepEqual(heard().pop(), [["M4.JKL", "Bespin Mining Station"]], "the file's name matches whatever its case");
    // Its match ends (the host's end of the level) while the room stays on
    // it: the name stays, and across a restart.
    await H.report({ end: "level" });
    await K.report({ end: "level" });
    skew += 16 * SEC;
    await w.alarm();
    assert.equal(w.lobby.ladder.matches.get(H.room).done, true);
    assert.deepEqual((await w.status()).games.map(g => g.title), ["Bespin Mining Station"]);
    const w2 = await new World(env, w.storage).start(w.ctx.sockets);
    assert.deepEqual((await w2.status()).games.map(g => g.title), ["Bespin Mining Station"], "after a restart");
    for (const g of [K, H])
        await w2.say(g.ws, "leave");
    await w2.settle();
    // A level with no name of its own: the game falls back to its file's
    // name in capitals, which isn't one.
    const N = await w2.host("Boc", { map: "apg_castle.jkl", title: "APG_CASTLE" });
    N.since = Date.now();
    await N.report();
    await w2.settle();
    const nameless = (await w2.status()).games.find(g => g.id === N.room);
    assert.deepEqual([nameless.map, "title" in nameless], ["apg_castle.jkl", false]);
    // Without the record nothing has a name: the page names the retail
    // levels itself.
    const w3 = await new World({ SITE: "", MOVED_FROM: "" }).start();
    const O = await w3.host("Jan", { map: "m10.jkl", title: "Canyon Oasis" });
    await O.report();
    assert.equal("title" in (await w3.status()).games[0], false);
});

// ---- Screenshots on match pages (src/ladder-shots.js).

const shotPath = (age, taken, final) => `/ladder/shot?age=${age}&taken=${taken}${final ? "&final=1" : ""}`;

// Asks where a picture taken `age` ms ago would go.
async function askShot(w, key, age, taken, final = false) {
    const res = await w.page(shotPath(age, taken, final), key ? { Cookie: `jkpk=${key}` } : {});
    return { status: res.status, ...JSON.parse(res.body) };
}

// Sends one as the page does: a form with the picture and its small copy.
async function sendShot(w, key, age, taken, opts = {}) {
    const form = new FormData();
    const full = "full" in opts ? opts.full : jpeg(1280, 720, 2000), thumb = "thumb" in opts ? opts.thumb : jpeg(480, 270, 500);
    if (full)
        form.set("full", new Blob([full], { type: "image/jpeg" }), "full.jpg");
    if (thumb)
        form.set("thumb", new Blob([thumb], { type: "image/jpeg" }), "thumb.jpg");
    const made = new Request("https://lobby.test/form", { method: "POST", body: form });
    const body = await made.arrayBuffer();
    const headers = { "Content-Type": made.headers.get("Content-Type"), ...(key ? { Cookie: `jkpk=${key}` } : {}),
                      ...(opts.noLength ? {} : { "Content-Length": String(body.byteLength) }), ...(opts.headers || {}) };
    const res = await w.page(opts.path || shotPath(age, taken, opts.final), headers, { method: "POST", body });
    return { status: res.status, ...JSON.parse(res.body) };
}

function shotEnv(more = {}) {
    return newEnv({ SHOTS: new FakeR2(), ...more });
}

await check("a JPEG's size is read from its frame header, and nothing else passes for one", () => {
    assert.deepEqual(jpegSize(jpeg(1920, 1080)), { w: 1920, h: 1080 });
    assert.deepEqual(jpegSize(jpeg(480, 270, 300)), { w: 480, h: 270 });
    const good = jpeg(640, 480, 10);
    // Progressive ones have another frame marker.
    const progressive = good.slice();
    progressive[progressive.indexOf(0xc0, 20)] = 0xc2;
    assert.deepEqual(jpegSize(progressive), { w: 640, h: 480 });
    assert.equal(jpegSize(good.slice(0, good.length - 1)), null, "cut short");
    assert.equal(jpegSize(new Uint8Array([...good, 0x3c, 0x73])), null, "something after its end");
    assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd9])), null, "a PNG");
    assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null, "no frame at all");
    assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])), null, "data with no frame before it");
    assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2, 0xff, 0xd9])), null, "a part longer than the file");
    assert.equal(jpegSize(new Uint8Array(0)), null);
});

await check("without the bucket the lobby takes no pictures, and its pages are as they were", async () => {
    for (const env of [newEnv(), shotEnv({ LADDER_SHOTS: "0" })]) {
        const w = await new World(env).start();
        const id = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
        for (const path of [shotPath(60 * SEC, 1), "/shot/" + "ab".repeat(12) + ".jpg", "/ladder/shot/" + "ab".repeat(12)])
            assert.equal(await shotRoute(new Request("https://lobby.test" + path, { headers: { Cookie: `jkpk=${KEYS.maw}` } }),
                                         env, new URL("https://lobby.test" + path)), null, path);
        assert.equal("shots" in JSON.parse((await w.page("/ladder/recent")).body), false);
        const page = await w.page(`/match/${id}`);
        assert.equal(page.body.includes("Screenshots"), false);
        assert.equal(page.body.includes("og:image"), false);
        assert.match(page.headers["Content-Security-Policy"], /; img-src data:;/);
    }
    // With the bucket, the landing page hears the limits.
    const on = await new World(shotEnv()).start();
    assert.deepEqual(JSON.parse((await on.page("/ladder/recent")).body).shots, SHOTS);
});

await check("a player's picture goes on the page of the match it was taken in, once", async () => {
    const env = shotEnv({ SHOTS_CONTACT: "https://example.test/ask" });
    const w = await new World(env).start();
    const boc = "<b>Boc`s</b>";
    // 180 s of play, then the kills, then 16 s until the lobby closes it.
    const id = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], [boc, KEYS.boc]], [[2, 1], [3, 1], [1, 3]]);
    assert.ok(id);
    const none = await w.page(`/match/${id}`);
    assert.ok(textOf(none.body).includes("Screenshots None yet. A screenshot one of its players takes in the game"), "a new match says where they'd be");
    assert.equal(none.body.includes('<dialog class="shot-view"'), false);
    assert.equal(none.body.includes("og:image"), false);

    // A minute before the lobby closed it: 136 s in.
    const asked = await askShot(w, KEYS.maw, 60 * SEC, 1001);
    assert.deepEqual(asked, { status: 200, match: id, secs: 136, left: SHOTS.perPlayer });
    assert.equal(env.SHOTS.m.size, 0, "asking stores nothing");
    const sent = await sendShot(w, KEYS.maw, 60 * SEC, 1001, { headers: { Origin: "https://lobby.test" } });
    assert.equal(sent.status, 200);
    assert.match(sent.id, /^[0-9a-f]{24}$/);
    assert.deepEqual([sent.match, sent.secs, sent.left], [id, 136, SHOTS.perPlayer]);
    assert.deepEqual([...env.SHOTS.m.keys()].sort(), [`m/${id}/${sent.id}.jpg`, `m/${id}/${sent.id}.t.jpg`]);
    assert.equal(env.SHOTS.m.get(`m/${id}/${sent.id}.jpg`).type, "image/jpeg");
    assert.deepEqual(env.LADDER.rows("SELECT match_id, slot, taken, secs, final, w, h, hidden FROM match_shots").map(r => ({ ...r })),
                     [{ match_id: id, slot: 0, taken: 1001, secs: 136, final: 0, w: 1280, h: 720, hidden: 0 }]);
    // The same picture again (a page that never heard the answer): the one
    // row, nothing stored twice, also when it only asks.
    const puts = env.SHOTS.puts;
    const again = await sendShot(w, KEYS.maw, 61 * SEC, 1001);
    assert.deepEqual([again.status, again.id], [200, sent.id]);
    assert.equal((await askShot(w, KEYS.maw, 61 * SEC, 1001)).id, sent.id);
    assert.equal(env.SHOTS.puts, puts);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM match_shots")[0].n, 1);

    // Boc's, taken as the kills came (180 s in).
    const bocs = await sendShot(w, KEYS.boc, 16 * SEC, 2002, { full: jpeg(1920, 1080, 100) });
    assert.deepEqual([bocs.status, bocs.secs], [200, 180]);

    // Served as an image and nothing else.
    const full = await w.page(`/shot/${sent.id}.jpg`);
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, jpeg(1280, 720, 2000));
    assert.equal(full.headers["Content-Type"], "image/jpeg");
    assert.equal(full.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(full.headers["Content-Security-Policy"], "default-src 'none'; sandbox");
    assert.equal(full.headers["Content-Length"], String(jpeg(1280, 720, 2000).length));
    const small = await w.page(`/shot/${sent.id}.t.jpg`);
    assert.deepEqual(small.body, jpeg(480, 270, 500));
    const seen = await w.page(`/shot/${sent.id}.jpg`, { "If-None-Match": full.headers.ETag });
    assert.deepEqual([seen.status, seen.body], [304, null]);
    const head = await w.page(`/shot/${sent.id}.jpg`, {}, { method: "HEAD" });
    assert.deepEqual([head.status, head.body, head.headers["Content-Length"]], [200, null, full.headers["Content-Length"]]);
    assert.equal((await w.page(`/shot/${sent.id}.jpg`, {}, { method: "POST" })).status, 405);
    assert.equal((await w.page("/shot/" + "0".repeat(24) + ".jpg")).status, 404);
    env.ASSETS = { fetch: async () => new Response("asset", { status: 200 }) };
    assert.equal((await w.page(`/shot/${sent.id}.png`)).body, "asset", "no other path is a picture's");
    assert.equal((await w.page(`/shot/${sent.id.toUpperCase()}.jpg`)).body, "asset");

    // The match's page: both, in the order they were taken, each with its
    // player, and the page may load pictures from this site only.
    const page = await w.page(`/match/${id}`);
    const html = page.body, text = textOf(html);
    assert.match(page.headers["Content-Security-Policy"], /; img-src 'self' data:;/);
    assert.equal(/https?:|\*/.test(page.headers["Content-Security-Policy"]), false, "no other site is named");
    assert.equal((html.match(/<script/g) || []).length, 1);
    assert.equal(/ style="/.test(html), false, "no style attributes: the policy would drop them");
    assert.equal(/ on[a-z]+="/.test(html), false);
    assert.ok(text.includes("Screenshots 2 from 2 players"), text);
    assert.ok(html.indexOf(sent.id) < html.indexOf(bocs.id));
    assert.ok(html.includes(`<a href="/shot/${sent.id}.jpg" data-shot="0"`));
    assert.ok(html.includes(`src="/shot/${sent.id}.t.jpg" width="480" height="270"`));
    assert.match(html, /<span class="who"><b><a href="\/player\/1\?game=jk">Maw<\/a><\/b> <span class="at">2:16 in<\/span><\/span>/);
    assert.ok(html.includes('alt="Screenshot by Maw, 2:16 into the match"'));
    // Boc's was taken as Maw killed Kyle: the nearest kill, the first of them.
    assert.ok(text.includes("3:00 in About when Maw killed Kyle_K"), text);
    assert.equal(html.includes("<b>Boc`"), false, "a name is never markup");
    assert.ok(html.includes('alt="Screenshot by &lt;b&gt;Boc`s&lt;/b&gt;, 3:00 into the match"'));
    assert.ok(html.includes('<dialog class="shot-view" id="shot-view"'));
    assert.ok(text.includes("Taken in this match by its players and sent from their own browsers. To have a picture taken down: example.test/ask"), text);
    assert.ok(html.includes('<a href="https://example.test/ask" rel="noopener">'));
    // A link to the match shows its first picture where it's pasted.
    assert.ok(html.includes(`<meta property="og:image" content="https://lobby.test/shot/${sent.id}.jpg">`));

    // Hidden by hand, a picture is off the page and no longer served; a
    // hidden match's aren't either.
    env.LADDER.db.exec(`UPDATE match_shots SET hidden = 1 WHERE id = '${bocs.id}'`);
    assert.equal((await w.page(`/shot/${bocs.id}.jpg`)).status, 404);
    assert.equal((await w.page(`/match/${id}`)).body.includes(bocs.id), false);
    env.LADDER.db.exec(`UPDATE matches SET hidden = 1 WHERE id = ${id}`);
    assert.equal((await w.page(`/shot/${sent.id}.t.jpg`)).status, 404);
    assert.equal((await askShot(w, KEYS.maw, 62 * SEC, 1002)).error, "none");
});

await check("only a player of the match adds to it, within its time and the limits, and only a JPEG of a sane size", async () => {
    const env = shotEnv();
    const w = await new World(env).start();
    const first = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    skew += 10 * MIN;
    const second = await playMatch(w, [["Jan", KEYS.jan], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    // From the second match's end back into the first: 196 s of it, ten
    // minutes between them, and a minute before the first one closed.
    const inFirst = 196 * SEC + 10 * MIN + 60 * SEC;
    assert.equal((await askShot(w, KEYS.maw, inFirst, 1)).match, first);
    assert.equal((await askShot(w, KEYS.kyle, inFirst, 1)).match, first);
    assert.equal((await askShot(w, KEYS.kyle, 60 * SEC, 1)).match, second);

    // Nobody without a key, nobody the record doesn't know, nobody who
    // wasn't in it, and no page of another site.
    assert.deepEqual(await askShot(w, "", 60 * SEC, 1), { status: 401, error: "key" });
    assert.deepEqual(await sendShot(w, "", 60 * SEC, 1), { status: 401, error: "key" });
    assert.deepEqual(await askShot(w, KEYS.boc, 60 * SEC, 1), { status: 404, error: "none", wait: true });
    assert.deepEqual(await askShot(w, KEYS.jan, inFirst, 1), { status: 404, error: "none", wait: false });
    assert.deepEqual(await sendShot(w, KEYS.jan, inFirst, 1), { status: 404, error: "none", wait: false });
    assert.deepEqual(await sendShot(w, KEYS.kyle, 60 * SEC, 1, { headers: { Origin: "https://elsewhere.test" } }),
                     { status: 403, error: "site" });
    // Between the two matches: no match of theirs. After the last: its own
    // may be saved yet, so the page is told to ask again.
    assert.deepEqual(await askShot(w, KEYS.kyle, 196 * SEC + 5 * MIN, 1), { status: 404, error: "none", wait: false });
    skew += 5 * MIN;
    assert.deepEqual(await askShot(w, KEYS.kyle, 2 * MIN, 1), { status: 404, error: "none", wait: true });
    assert.equal((await askShot(w, KEYS.kyle, 5 * MIN + 60 * SEC, 1)).match, second);
    // What the address must say.
    for (const path of ["/ladder/shot", "/ladder/shot?age=60000", "/ladder/shot?age=-1&taken=1", "/ladder/shot?age=1e3&taken=1",
                        "/ladder/shot?age=60000&taken=x"])
        assert.deepEqual(JSON.parse((await w.page(path, { Cookie: `jkpk=${KEYS.kyle}` })).body), { error: "fields" }, path);
    assert.equal((await w.page(shotPath(60 * SEC, 1), { Cookie: `jkpk=${KEYS.kyle}` }, { method: "PUT" })).status, 405);

    // What the form must hold. Nothing of a refused one is kept.
    const at = 5 * MIN + 60 * SEC;
    const refused = async (opts, status, error) => {
        const res = await sendShot(w, KEYS.kyle, at, 50, opts);
        assert.deepEqual([res.status, res.error], [status, error], JSON.stringify(Object.keys(opts)));
    };
    await refused({ full: jpeg(1280, 720, SHOTS.bytes) }, 413, "big");
    await refused({ thumb: jpeg(480, 270, SHOTS.thumbBytes) }, 413, "big");
    await refused({ full: jpeg(1280, 720, SHOTS.bytes), thumb: jpeg(480, 270, SHOTS.thumbBytes) }, 413, "big");
    await refused({ full: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) }, 415, "jpeg");
    await refused({ thumb: new TextEncoder().encode("<script>alert(1)</script>") }, 415, "jpeg");
    await refused({ full: jpeg(SHOTS.edge + 1, 1080) }, 415, "size");
    await refused({ full: jpeg(1080, SHOTS.edge + 1) }, 415, "size");
    await refused({ full: jpeg(32, 32) }, 415, "size");
    await refused({ thumb: jpeg(SHOTS.thumbEdge + 1, 270) }, 415, "size");
    await refused({ thumb: null }, 400, "fields");
    await refused({ full: null }, 400, "fields");
    await refused({ noLength: true }, 411, "length");
    const notForm = await w.page(shotPath(at, 50), { Cookie: `jkpk=${KEYS.kyle}`, "Content-Type": "text/plain", "Content-Length": "5" },
                                 { method: "POST", body: "hello" });
    assert.deepEqual([notForm.status, JSON.parse(notForm.body).error], [400, "form"]);
    env.SHOTS.fail = 1;
    await refused({}, 503, "store");
    assert.equal(env.SHOTS.m.size, 0);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM match_shots")[0].n, 0);

    // So many a player in one match, and so many a match.
    for (let n = 1; n <= SHOTS.perPlayer; n++) {
        const res = await sendShot(w, KEYS.kyle, at, 100 + n, { full: jpeg(640, 480), thumb: jpeg(320, 240) });
        assert.deepEqual([res.status, res.left], [200, SHOTS.perPlayer - (n - 1)], `picture ${n}`);
    }
    assert.deepEqual(await sendShot(w, KEYS.kyle, at, 999), { status: 409, error: "full" });
    assert.deepEqual(await askShot(w, KEYS.kyle, at, 999), { status: 409, error: "full" });
    assert.equal((await askShot(w, KEYS.kyle, at, 101)).status, 200, "one already there is still found");
    assert.equal((await askShot(w, KEYS.jan, at, 1)).left, SHOTS.perPlayer, "the other player's are their own");
    assert.equal((await askShot(w, KEYS.kyle, inFirst + 5 * MIN, 1)).left, SHOTS.perPlayer, "and so is another match");
    assert.equal(env.SHOTS.m.size, 2 * SHOTS.perPlayer);
    // Other players' fill the match up to its own limit (rows put in by hand).
    const kyle = env.LADDER.rows("SELECT player_id FROM match_shots LIMIT 1")[0].player_id;
    for (let n = 0; n < SHOTS.perMatch - SHOTS.perPlayer - 1; n++)
        env.LADDER.db.exec(`INSERT INTO match_shots (id, match_id, slot, player_id, taken, secs, w, h, bytes, thumb_bytes, added_at)
                            VALUES ('x${n}', ${second}, 1, ${kyle + 100 + n}, ${n}, 5, 640, 480, 10, 5, 0)`);
    assert.equal((await askShot(w, KEYS.jan, at, 1)).left, 1);
    // Two sent at the same moment for the one place left, both told there's
    // room: the row's own statement lets one in.
    env.SHOTS.slow = 30;
    const stored = env.SHOTS.puts;
    const race = await Promise.all([sendShot(w, KEYS.jan, at, 1), sendShot(w, KEYS.jan, at, 2)]);
    env.SHOTS.slow = 0;
    assert.deepEqual(race.map(r => [r.status, r.error || ""]).sort(), [[200, ""], [409, "full"]]);
    assert.equal(env.SHOTS.puts, stored + 4, "both were stored first");
    assert.deepEqual(await sendShot(w, KEYS.jan, at, 3), { status: 409, error: "full" });
    assert.equal(env.SHOTS.m.size, 2 * SHOTS.perPlayer + 2, "what was stored for a row that wasn't made is deleted again");

    // A player whose record is hidden adds nothing, and a match is open to
    // pictures for so many days.
    env.LADDER.db.exec("UPDATE players SET hidden = 1 WHERE name = 'Maw'");
    assert.deepEqual(await askShot(w, KEYS.maw, inFirst + 5 * MIN, 1), { status: 403, error: "hidden" });
    env.LADDER.db.exec("UPDATE players SET hidden = 0");
    skew += SHOTS.days * 24 * 60 * MIN;
    assert.deepEqual(await askShot(w, KEYS.maw, inFirst + 5 * MIN + SHOTS.days * 24 * 60 * MIN, 1), { status: 404, error: "none", wait: false });
});

await check("a picture is taken off again by its player, from any of their keys, and by nobody else", async () => {
    const env = shotEnv();
    const w = await new World(env).start();
    const id = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    const a = await sendShot(w, KEYS.maw, 60 * SEC, 1), b = await sendShot(w, KEYS.maw, 50 * SEC, 2);
    const remove = (shot, key, more = {}) => w.page(`/ladder/shot/${shot}`, { ...(key ? { Cookie: `jkpk=${key}` } : {}), ...more },
                                                    { method: "DELETE" });
    assert.equal((await remove(a.id, "")).status, 401);
    assert.equal((await remove(a.id, KEYS.kyle)).status, 404, "another player's isn't theirs to take off");
    assert.equal((await remove(a.id, KEYS.maw, { Origin: "https://elsewhere.test" })).status, 403);
    assert.equal((await w.page(`/ladder/shot/${a.id}`, { Cookie: `jkpk=${KEYS.maw}` })).status, 405);
    assert.equal(env.SHOTS.m.size, 4);
    const gone = await remove(a.id, KEYS.maw, { Origin: "https://lobby.test" });
    assert.deepEqual([gone.status, JSON.parse(gone.body)], [200, { gone: a.id }]);
    assert.deepEqual([...env.SHOTS.m.keys()].sort(), [`m/${id}/${b.id}.jpg`, `m/${id}/${b.id}.t.jpg`]);
    assert.equal((await w.page(`/shot/${a.id}.jpg`)).status, 404);
    const html = (await w.page(`/match/${id}`)).body;
    assert.deepEqual([html.includes(a.id), html.includes(b.id)], [false, true]);
    assert.equal((await remove(a.id, KEYS.maw)).status, 404, "once");
    // It can be sent again afterwards.
    assert.equal((await sendShot(w, KEYS.maw, 60 * SEC, 1)).status, 200);
    // Another browser of the same player (a new key that played under their
    // name joins their record) takes one off too.
    const other = "5".repeat(32);
    await playMatch(w, [["Maw", other], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    assert.equal((await remove(b.id, other)).status, 200);
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM match_shots WHERE id = ?", b.id)[0].n, 0);
});

await check("the final scoreboard: one a match, of a level its host ended, and none with an Anonymous player in it", async () => {
    const env = shotEnv();
    const w = await new World(env).start();
    const id = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    // The game takes it as the level ends, which the lobby closed 16 s later.
    assert.deepEqual(await askShot(w, KEYS.kyle, 16 * SEC, 7, true), { status: 200, match: id, secs: 196, left: 1 });
    // Not one from the middle of the match, or from long after it.
    assert.deepEqual(await askShot(w, KEYS.kyle, 100 * SEC, 7, true), { status: 404, error: "none", wait: false });
    const theirs = await sendShot(w, KEYS.maw, 60 * SEC, 5);
    const final = await sendShot(w, KEYS.kyle, 16 * SEC, 7, { final: true, full: jpeg(1024, 768, 50), thumb: jpeg(480, 360, 20) });
    assert.deepEqual([final.status, final.match, final.secs], [200, id, 196]);
    // Every game shows the same screen: the first one's is the match's.
    assert.deepEqual(await sendShot(w, KEYS.maw, 15 * SEC, 8, { final: true }), { status: 409, error: "have" });
    assert.deepEqual(await askShot(w, KEYS.maw, 15 * SEC, 8, true), { status: 409, error: "have" });
    assert.equal((await sendShot(w, KEYS.kyle, 16 * SEC, 7, { final: true })).id, final.id, "the same one again is found");
    assert.equal(env.SHOTS.m.size, 4);
    // It doesn't count as one of its sender's own.
    assert.equal((await askShot(w, KEYS.kyle, 60 * SEC, 9)).left, SHOTS.perPlayer);
    const page = await w.page(`/match/${id}`);
    const html = page.body, text = textOf(html);
    assert.ok(text.includes("Screenshots 1 from 1 player, and the final scoreboard"), text);
    assert.ok(html.indexOf(final.id) < html.indexOf(theirs.id), "first on the page");
    assert.ok(html.includes('<li class="shot final">'));
    assert.ok(text.includes("Final scoreboard As the game showed it when the level ended"), text);
    assert.ok(html.includes(`src="/shot/${final.id}.t.jpg" width="480" height="360"`));
    assert.ok(html.includes('alt="The final scoreboard, as the game showed it"'));
    assert.ok(text.includes("the final scoreboard is the game's own picture"), text);
    assert.ok(html.includes(`<meta property="og:image" content="https://lobby.test/shot/${final.id}.jpg">`));
    // Two sent at the same moment: the table lets one in.
    env.LADDER.db.exec(`DELETE FROM match_shots WHERE id = '${final.id}'`);
    env.SHOTS.slow = 30;
    const stored = env.SHOTS.puts, kept = env.SHOTS.m.size;
    const both = await Promise.all([sendShot(w, KEYS.kyle, 16 * SEC, 7, { final: true }), sendShot(w, KEYS.maw, 15 * SEC, 8, { final: true })]);
    env.SHOTS.slow = 0;
    assert.deepEqual(both.map(r => [r.status, r.error || ""]).sort(), [[200, ""], [409, "have"]]);
    assert.equal(env.SHOTS.puts, stored + 4, "both were stored first");
    assert.equal(env.SHOTS.m.size, kept + 2, "and the one that lost is deleted again");
    assert.equal(env.LADDER.rows("SELECT COUNT(*) AS n FROM match_shots WHERE final = 1")[0].n, 1);

    // A room its host left wasn't ended by a level's end: no final there.
    const H = await w.host("Maw", { pk: KEYS.maw }), K = await w.join("Kyle_K", H, { pk: KEYS.kyle });
    for (const g of [H, K]) {
        g.since = Date.now();
        await g.report({ rules: { mode: 0, sl: 0, tl: 0 } });
    }
    skew += 3 * MIN;
    await killAll([H, K], 2, 1);
    await hostLeaves(w, H, [K]);
    await w.say(K.ws, "leave");
    await w.settle();
    const left = env.LADDER.rows("SELECT id, ended FROM matches ORDER BY id DESC LIMIT 1")[0];
    assert.equal(left.ended, "left");
    assert.deepEqual(await askShot(w, KEYS.kyle, 2 * SEC, 9, true), { status: 404, error: "none", wait: false });
    assert.equal((await askShot(w, KEYS.kyle, 30 * SEC, 9)).match, left.id, "a player's own picture of it is taken");

    // That screen names everyone, so a match with a player who's shown as
    // Anonymous gets none: one who asked not to be named, or whose record
    // is hidden. The others' own pictures are theirs to share.
    skew += MIN;
    const anon = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle], ["Shy", KEYS.boc, "anon"]], [[2, 1], [3, 1]]);
    assert.deepEqual(await askShot(w, KEYS.kyle, 16 * SEC, 10, true), { status: 409, error: "anonymous" });
    assert.deepEqual(await sendShot(w, KEYS.kyle, 16 * SEC, 10, { final: true }), { status: 409, error: "anonymous" });
    assert.equal((await sendShot(w, KEYS.kyle, 60 * SEC, 11)).match, anon);
    assert.deepEqual(await askShot(w, KEYS.boc, 60 * SEC, 12), { status: 404, error: "none", wait: true },
                     "one recorded as Anonymous has no key in the match");
    skew += MIN;
    const hid = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    env.LADDER.db.exec("UPDATE players SET hidden = 1 WHERE name = 'Maw'");
    assert.deepEqual(await askShot(w, KEYS.kyle, 16 * SEC, 13, true), { status: 409, error: "anonymous" });
    env.LADDER.db.exec("UPDATE players SET hidden = 0");
    assert.equal((await askShot(w, KEYS.kyle, 16 * SEC, 13, true)).match, hid);
});

await check("a database from before the pictures gets their table when it's first needed", async () => {
    const env = shotEnv();
    const w = await new World(env).start();
    const id = await playMatch(w, [["Maw", KEYS.maw], ["Kyle_K", KEYS.kyle]], [[2, 1], [2, 1]]);
    const drop = () => env.LADDER.db.exec("DROP TABLE match_shots");
    drop();
    assert.equal((await w.page(`/match/${id}`)).status, 200);
    drop();
    assert.equal((await askShot(w, KEYS.maw, 60 * SEC, 1)).match, id);
    drop();
    assert.equal((await sendShot(w, KEYS.maw, 60 * SEC, 1)).status, 200);
    drop();
    assert.equal((await w.page("/shot/" + "0".repeat(24) + ".jpg")).status, 404);
    // And a database that's away says so, each in its own way.
    env.LADDER.fail = 5;
    assert.deepEqual(await askShot(w, KEYS.maw, 60 * SEC, 2), { status: 503, error: "busy" });
    env.LADDER.fail = 5;
    assert.equal((await w.page("/shot/" + "0".repeat(24) + ".jpg")).status, 503);
    env.LADDER.fail = 0;
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
