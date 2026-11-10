// Checks the match record (src/ladder.js, src/ladder-pages.js): games in a
// room report their match, the lobby puts the reports together, saves the
// match to D1, tells the games, lists it for the page and Discord, and serves
// its page. Runs the Lobby itself in Node.js on test/cfstub.mjs, with D1
// stood in for by Node's own SQLite. Needs Node.js 22.5 or newer.
//
//   node test/ladder.mjs
//
// It prints a line for each check and exits 1 if one fails.

import assert from "node:assert/strict";
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
const { cleanReport, discordMessage, hashKey, MAX_REPORT_B64 } = await import("../src/ladder.js");

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
    assert.match(html, /<tr class="you">\s*<td class="num"><span class="place p2">2<\/span><\/td>\s*<td class="name"><b>Kyle_K<\/b> <span class="tag">You<\/span>/);
    assert.match(html, /<meta property="og:title" content="Nar Shaddaa Loading Terminal: Maw wins">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.equal(res.headers["Cache-Control"], "private, max-age=30");
    // Who killed whom: Maw's row, then Kyle's.
    assert.match(html, /<th scope="row">Maw<\/th><td class="self"><\/td><td>1<\/td><td class="top">2<\/td>/);
    assert.match(html, /<th scope="row">Kyle_K<\/th><td class="top">2<\/td><td class="self">1<\/td><td>0<\/td>/);
    const other = await w.page(`/match/${firstId}`);
    assert.equal(other.body.includes('class="tag">You'), false, "nobody's row is marked without their key");
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
    await H.report({ end: "left" });
    await w2.say(H.ws, "leave");
    await w2.settle();
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
    await D.report({ idle: 1, end: "left" });
    await w.say(D.ws, "leave");
    await w.settle();
    const d = env.LADDER.rows("SELECT * FROM matches ORDER BY id DESC")[0];
    assert.deepEqual([d.players, d.reporters, d.secs], [2, 2, 180]);
    assert.deepEqual(env.LADDER.rows("SELECT name, host FROM match_players WHERE match_id = ? ORDER BY slot", d.id).map(r => [r.name, r.host]),
                     [["Kyle_K", 0], ["Boc", 0]]);
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
    const H2 = await w.host("Maw");
    const K = await w.join("Kyle_K", H2);
    await H2.report();
    await K.report();
    skew += 30 * SEC;
    await killAll([H2, K], 2, 1);
    await H2.report({ end: "left" });
    await w.say(H2.ws, "leave");
    await w.settle();
    const H3 = await w.host("Maw");
    const K3 = await w.join("Kyle_K", H3);
    await H3.report();
    await K3.report();
    skew += 5 * MIN;
    await H3.report({ end: "left" });
    await w.say(H3.ws, "leave");
    await w.settle();
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
    await H.report({ end: "left" });
    await w.say(H.ws, "leave");
    await w.settle();
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

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
