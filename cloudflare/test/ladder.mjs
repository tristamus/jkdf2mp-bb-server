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
const { cleanReport, discordMessage, hashKey, joinableName, MAX_REPORT_B64 } = await import("../src/ladder.js");
const { periodStart } = await import("../src/ladder-pages.js");

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
// players are [name, browser key or null], the host first; kills are [victim's
// seat, killer's seat (0 for nobody), kind]. Returns the match's number, 0 for
// one that wasn't kept.
async function playMatch(w, players, kills, opts = {}) {
    const rules = { mode: opts.mode || 0, sl: 0, tl: 0 };
    const H = await w.host(players[0][0], { ...opts, pk: players[0][1] });
    const all = [H];
    for (const [name, pk] of players.slice(1))
        all.push(await w.join(name, H, { pk, game: opts.game, password: opts.password }));
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
    for (const g of all.reverse())
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
