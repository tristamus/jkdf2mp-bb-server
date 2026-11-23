// Checks an Imperial relay server's feed (src/imperial-feed.js, and its part
// in src/lobby.js and src/feed.js): its key, asking for its feed and ending
// it, the status listing it for the page, pages watching it, and the wide
// chunks only its feed takes. Runs the Lobby and the Feed in Node.js on
// test/cfstub.mjs. Needs Node.js 22 or newer.
//
//   node test/imperial-feed.mjs
//
// It prints a line for each check and exits 1 if one fails.

import assert from "node:assert/strict";
import { register } from "node:module";

const stubUrl = new URL("./cfstub.mjs", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const { FakeStorage, FakeCtx } = await import("./cfstub.mjs");
const { Feed } = await import("../src/feed.js");
const { Lobby } = await import("../src/lobby.js");
const { parseFeedKeys, readAsk, imperialFeedRoute } = await import("../src/imperial-feed.js");
const { serverSid } = await import("../src/imperial.js");

const realLog = console.log;
console.log = (...a) => {
    const line = a.join(" ");
    if (!/^(relay|ladder|imperial-feed|feed):/.test(line))
        realLog(...a);
    else if (process.env.VERBOSE)
        realLog(line);
};

let failed = 0, passed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`ok    ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split("\n").join("\n      ")}`);
    }
}

const KEY = "ab".repeat(16);
const KEY2 = "cd".repeat(24);
const KEYS = `${KEY} jk1 162.248.94.121:27960 Coruscant\n${KEY2} mots 1.2.3.4:5 Other`;
const SID = serverSid("162.248.94.121:27960");
const statusOf = line => JSON.parse(Buffer.from(line.slice(7), "base64").toString());

// FEED and LOBBY as the Worker has them, run here: one Feed per name, and
// the one Lobby, whose methods are called as RPC is.
class Feeds {
    constructor(world) { this.byName = new Map(); this.world = world; }
    idFromName(n) { return n; }
    get(n) {
        if (!this.byName.has(n)) {
            const ctx = new FakeCtx(new FakeStorage());
            const f = new Feed(ctx, { LOBBY: this.world.lobbyNs });
            f.ctx = ctx;
            this.byName.set(n, f);
        }
        return this.byName.get(n);
    }
    of(room) { return this.byName.get("room:" + room); }
}

class World {
    constructor(env = {}, storage = new FakeStorage()) {
        this.feeds = new Feeds(this);
        this.lobbyNs = { idFromName: n => n, get: () => this.lobby };
        this.env = { SITE: "", MOVED_FROM: "", FEED: this.feeds, LOBBY: this.lobbyNs, IMPERIAL_FEED_KEYS: KEYS, ...env };
        this.storage = storage;
    }
    async start(sockets = []) {
        this.ctx = new FakeCtx(this.storage, sockets);
        this.lobby = new Lobby(this.ctx, this.env);
        await this.ctx.ready;
        return this;
    }
    async ask(body, { key = KEY, method = "POST", url = "https://jediknight.zone/imperial-feed" } = {}) {
        const headers = { "Content-Type": "application/json" };
        if (key)
            headers.Authorization = "Bearer " + key;
        const init = { method, headers };
        if (method === "POST")
            init.body = typeof body === "string" ? body : JSON.stringify(body);
        const r = await imperialFeedRoute(new Request(url, init), this.env);
        const text = typeof r.body === "string" ? r.body : await new Response(r.body).text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: r.status, json };
    }
    async page() {
        await this.lobby.fetch(new Request("https://lobby.test/relay?net=0&pw=1"));
        const ws = this.ctx.sockets.at(-1);
        ws.take();
        await this.lobby.webSocketMessage(ws, "watch");
        ws.take();
        return ws;
    }
    async status() {
        const ws = await this.page();
        await this.lobby.webSocketMessage(ws, "watch");
        const line = ws.take().filter(l => l.startsWith("status ")).pop();
        ws.close(1000, "bye");
        await this.lobby.webSocketClose(ws, 1000, "bye", true);
        return statusOf(line);
    }
}
await check("the keys: one to a line or comma, as <key> <game> <address> <name>; others are left out", async () => {
    const servers = parseFeedKeys(`${KEYS}, nothex jk1 1.2.3.4:5 Bad\n${"ef".repeat(16)} quake 1.2.3.4:5 Bad\n\n` +
                                  `${"12".repeat(16)}   mots   9.9.9.9:1   \u202eSpaced  name  `);
    assert.deepEqual(servers.map(s => [s.key.slice(0, 4), s.game, s.addr, s.name]), [
        ["abab", "jk1", "162.248.94.121:27960", "Coruscant"],
        ["cdcd", "mots", "1.2.3.4:5", "Other"],
        ["1212", "mots", "9.9.9.9:1", "Spaced  name"],
    ]);
    assert.equal(servers[0].sid, SID, "the sid its card has (src/imperial.js)");
    assert.deepEqual(parseFeedKeys(undefined), []);
});

await check("what a server may ask", async () => {
    assert.deepEqual(readAsk({ end: true }), { end: true, off: false });
    assert.deepEqual(readAsk({ end: true, off: true }), { end: true, off: true });
    assert.deepEqual(readAsk({ episode: "JK1CTF", map: "c3.jkl", delay: 60 }),
                     { episode: "JK1CTF", map: "c3.jkl", delay: 60, files: false, say: false });
    assert.deepEqual(readAsk({}), { episode: "", map: "", delay: 0, files: false, say: false });
    assert.deepEqual(readAsk({ files: true, say: false }), { episode: "", map: "", delay: 0, files: true, say: false });
    for (const bad of [null, [], "x", { end: 1 }, { end: true, off: 1 }, { map: "../x" }, { episode: 5 }, { delay: -1 },
                       { delay: 1.5 }, { delay: 4000 }, { map: "a".repeat(65) }, { files: 1 }, { say: "yes" }])
        assert.equal(readAsk(bad), null, JSON.stringify(bad));
});

await check("the route: off without keys or feeds, POST only, a listed key, a body that reads", async () => {
    let w = await new World({ IMPERIAL_FEED_KEYS: "" }).start();
    assert.equal((await w.ask({})).status, 404);
    w = await new World({ FEED: undefined }).start();
    assert.equal((await w.ask({})).status, 404);
    w = await new World().start();
    assert.equal((await w.ask(null, { method: "GET" })).status, 405);
    assert.equal((await w.ask({}, { key: "" })).status, 401);
    assert.equal((await w.ask({}, { key: "ee".repeat(16) })).status, 401, "a key nobody was given");
    assert.equal((await w.ask({}, { key: "zz" })).status, 401);
    assert.equal((await w.ask("{nope")).status, 400);
    assert.equal((await w.ask({ map: "../../x" })).status, 400);
    assert.equal((await w.ask({ episode: "x".repeat(5000) })).status, 413);
    assert.equal(w.lobby.imperial.size, 0, "none of those made a feed");
});

await check("a server's ask arms a wide feed for it, as its host, and it gets where to send", async () => {
    const w = await new World().start();
    const r = await w.ask({ episode: "JK1CTF", map: "c3.jkl" });
    assert.equal(r.status, 200);
    const { room, token, url, delay } = r.json;
    assert.ok(Number.isInteger(room) && room >= 1);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(url, `wss://jediknight.zone/feed/${room}?up=${token}`);
    assert.equal(delay, 30, "30 s when it doesn't say");
    const feed = w.feeds.of(room);
    assert.deepEqual(feed.cfg.tokens, { [token]: 1 });
    assert.equal(feed.cfg.wide, true);
    assert.equal(feed.cfg.delay, 30);
    // A room hosted after it gets a number of its own.
    assert.equal(w.lobby.nextRoom, room + 1);
    // Plain http (wrangler dev) gets ws.
    const local = await w.ask({}, { url: "http://127.0.0.1:8787/imperial-feed" });
    assert.equal(local.json.url, `ws://127.0.0.1:8787/feed/${room}?up=${token}`);
});

await check("asking again gets the same room and token, with the delay as asked now (30 to 300 s)", async () => {
    const w = await new World().start();
    const a = (await w.ask({ map: "c3.jkl", delay: 10 })).json;
    assert.equal(a.delay, 30);
    const b = (await w.ask({ map: "c2.jkl", delay: 120 })).json;
    assert.deepEqual([b.room, b.token, b.delay], [a.room, a.token, 120]);
    assert.equal(w.feeds.of(a.room).cfg.delay, 120);
    assert.equal((await w.ask({ delay: 4000 })).status, 400);
    assert.equal((await w.ask({ delay: 999 })).json.delay, 300);
    // Another server: a feed of its own.
    const c = (await w.ask({}, { key: KEY2 })).json;
    assert.notEqual(c.room, a.room);
    assert.notEqual(c.token, a.token);
});

await check("the status lists it by its sid for the page, with how many watch", async () => {
    const w = await new World().start();
    assert.equal((await w.status()).imp, undefined, "none: not there");
    const { room } = (await w.ask({ episode: "JK1CTF", map: "c3.jkl", delay: 45 })).json;
    let s = await w.status();
    assert.deepEqual(s.imp, [{ id: room, sid: SID, game: "jk1", name: "Coruscant", episode: "JK1CTF", map: "c3.jkl", delay: 45 }]);
    assert.ok(!JSON.stringify(s).includes("162.248"), "never its address");
    assert.ok(!JSON.stringify(s).includes(w.lobby.imperial.get(SID).token), "never its token");
    // A page watching it, and games watching from inside the game (the feed says).
    const p = await w.page();
    await w.lobby.webSocketMessage(p, `spectate ${room}`);
    s = await w.status();
    assert.equal(s.imp[0].watching, 1);
    assert.equal(await w.lobby.feedPages(room, 3), true);
    s = await w.status();
    assert.equal(s.imp[0].watching, 4);
    // A room that isn't there is still none.
    await w.lobby.webSocketMessage(p, `spectate ${room + 50}`);
    s = await w.status();
    assert.equal(s.imp[0].watching, 3);
});

await check("ending it: the feed ends and it's no longer listed; a feed that ended itself isn't either", async () => {
    const w = await new World().start();
    const { room } = (await w.ask({})).json;
    const r = await w.ask({ end: true, off: true });
    assert.deepEqual([r.status, r.json], [200, { ended: true }]);
    for (let i = 0; i < 3; i++)
        await new Promise(res => setImmediate(res));
    assert.equal(w.feeds.of(room).cfg, null, "its feed ended");
    assert.equal((await w.status()).imp, undefined);
    assert.deepEqual((await w.ask({ end: true })).json, { ended: true }, "ending one that isn't on is fine");
    // Asked for again: a new room, as a match is.
    const again = (await w.ask({})).json;
    assert.notEqual(again.room, room);
    // Nothing sent for 10 minutes: the feed ends itself and tells the lobby.
    const feed = w.feeds.of(again.room);
    const realNow = Date.now;
    try {
        const t = realNow() + 11 * 60 * 1000;
        Date.now = () => t;
        await feed.alarm();
    } finally {
        Date.now = realNow;
    }
    assert.equal(feed.cfg, null);
    assert.equal((await w.status()).imp, undefined);
    assert.equal(w.storage.m.has("imp:" + SID), false);
    // The lobby ignores that for a lobby room's feed.
    assert.equal(await w.lobby.feedEnded(12345), true);
});

await check("a lobby restart keeps it, with the same room and token", async () => {
    const w = await new World().start();
    const a = (await w.ask({ map: "c3.jkl", delay: 60 })).json;
    const again = await new World({}, w.storage).start();
    again.feeds = w.feeds;
    again.env.FEED = w.feeds;
    w.lobby = again.lobby;
    const b = (await again.ask({ map: "c3.jkl" })).json;
    assert.deepEqual([b.room, b.token], [a.room, a.token]);
    assert.equal((await again.status()).imp[0].id, a.room);
});

await check("its feed takes wide chunks (3) from it; a lobby room's feed doesn't", async () => {
    const w = await new World().start();
    const { room, token } = (await w.ask({})).json;
    const feed = w.feeds.of(room);
    const up = new Request(`https://jediknight.zone/feed/${room}?up=${token}`, { headers: { Upgrade: "websocket" } });
    assert.equal((await feed.fetch(up)).status, 101);
    const g = feed.ctx.sockets.at(-1);
    // Who sent it (u32 LE), its length (u16 LE), then the packet.
    const wide = new Uint8Array([3, 0x39, 0x30, 0, 0, 2, 0, 0xaa, 0xbb]).buffer;
    await feed.webSocketMessage(g, wide);
    assert.equal(g.closed, null, "taken");
    assert.equal((await feed.info()).chunks, 1);
    assert.equal(feed.chunks[0].kind, 3);
    assert.equal(feed.chunks[0].seat, 1);
    await feed.webSocketMessage(g, new Uint8Array([4, 1]).buffer);
    assert.deepEqual(g.closed, [1003, "bad chunk"], "no kind past 3");
    // A lobby room's feed: kind 3 is a bad chunk.
    const ctx = new FakeCtx(new FakeStorage());
    const plain = new Feed(ctx, {});
    await ctx.ready;
    const T = "11".repeat(16);
    await plain.arm(9, 30, { [T]: 1 });
    await plain.fetch(new Request(`https://x/feed/9?up=${T}`, { headers: { Upgrade: "websocket" } }));
    const h = ctx.sockets.at(-1);
    await plain.webSocketMessage(h, wide);
    assert.deepEqual(h.closed, [1003, "bad chunk"]);
});

// A page watching an Imperial server's feed, from its start.
async function watcher(feed, room) {
    assert.equal((await feed.fetch(new Request(`https://jediknight.zone/feed/${room}`, { headers: { Upgrade: "websocket" } }))).status, 101);
    const p = feed.ctx.sockets.at(-1);
    p.take();
    return p;
}
async function hostOf(feed, room, token) {
    const up = new Request(`https://jediknight.zone/feed/${room}?up=${token}`, { headers: { Upgrade: "websocket" } });
    assert.equal((await feed.fetch(up)).status, 101);
    const g = feed.ctx.sockets.at(-1);
    g.take();
    return g;
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(res => setImmediate(res)); };

await check("the server empties: pages watching get the match's last seconds, then \"room ended\"; off ends at once", async () => {
    const w = await new World().start();
    const { room, token } = (await w.ask({ delay: 30 })).json;
    const feed = w.feeds.of(room);
    const g = await hostOf(feed, room, token);
    const p = await watcher(feed, room);
    const head = new TextEncoder().encode('JKF1{"v":1,"game":"jk1","episode":"JK1CTF","map":"c3.jkl","host":1}');
    const key = new Uint8Array(1 + head.length);
    key[0] = 1;
    key.set(head, 1);
    await feed.webSocketMessage(g, key.buffer);
    await feed.webSocketMessage(g, new Uint8Array([3, 2, 0, 0, 0, 2, 0, 0xaa, 0xbb]).buffer);
    assert.equal((await w.ask({ end: true })).status, 200);
    await settle();
    assert.equal((await w.status()).imp, undefined, "no longer listed");
    assert.equal(feed.ending, "room ended", "still playing out what it has");
    assert.ok(!p.take().some(l => typeof l === "string" && l.startsWith("feed ended")));
    // Its last chunk comes of age: the page gets it, then the end.
    const realNow = Date.now;
    try {
        const t = realNow() + 31 * 1000;
        Date.now = () => t;
        feed.flush();
    } finally {
        Date.now = realNow;
    }
    const got = p.take();
    assert.ok(got.some(l => typeof l !== "string"), "the match's last seconds");
    assert.ok(got.includes("feed ended room ended"));
    // Asked for again (someone joined): a new room while that one played out.
    const again = (await w.ask({})).json;
    assert.notEqual(again.room, room);
    // Watching turned off: the pages are told at once.
    const f2 = w.feeds.of(again.room);
    const g2 = await hostOf(f2, again.room, again.token);
    const p2 = await watcher(f2, again.room);
    await f2.webSocketMessage(g2, key.buffer);
    await w.ask({ end: true, off: true });
    await settle();
    assert.ok(p2.take().includes("feed ended watching off"));
});

await check("a server that didn't say it sends files or takes messages: games watching are told at once", async () => {
    const w = await new World().start();
    const { room, token } = (await w.ask({})).json;
    const feed = w.feeds.of(room);
    const g = await hostOf(feed, room, token);
    const p = await watcher(feed, room);
    const FP = "ab".repeat(32);
    await feed.webSocketMessage(p, "mod " + FP);
    assert.deepEqual(p.take(), ["feed no-files"]);
    const heard = () => g.take().filter(l => l !== "key");   // a page with no keyframe yet asks for one
    assert.deepEqual(heard(), [], "the server hears nothing");
    await feed.webSocketMessage(p, "say Kyle\thello");
    assert.deepEqual(p.take(), ["feed no-say"]);
    assert.deepEqual(heard(), []);
    // It says it does (asking again): as a lobby room's host.
    await w.ask({ files: true, say: true });
    assert.equal(g.closed, null, "its socket stays open on asking again");
    const host = { take: heard };
    await feed.webSocketMessage(p, "mod " + FP);
    assert.deepEqual(host.take(), ["mod " + FP]);
    const later = Date.now() + 10 * 1000;
    const realNow = Date.now;
    try {
        Date.now = () => later;
        await feed.webSocketMessage(p, "say Kyle\thello");
    } finally {
        Date.now = realNow;
    }
    assert.deepEqual(host.take(), ["say Kyle (watching): hello"]);
    assert.deepEqual(p.take(), []);
});

console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
