// Checks a watched match's feed (src/feed.js) and the lobby's part in it
// (feed in src/lobby.js): who may send, the delay, keyframes, what pages
// get, and when the lobby turns a feed on and off. Runs the Feed and the
// Lobby in Node.js on test/cfstub.mjs. Needs Node.js 22 or newer.
//
//   node test/feed.mjs
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
const { Feed, feedRoute } = await import("../src/feed.js");
const lobbyModule = await import("../src/lobby.js");
const { Lobby } = lobbyModule;

const realLog = console.log;
console.log = (...a) => {
    const line = a.join(" ");
    if (!line.startsWith("relay:") && !line.startsWith("ladder:"))
        realLog(...a);
    else if (process.env.VERBOSE)
        realLog(line);
};

// The feed's clock, moved by hand. Its look-again timer is never run by
// itself here: checks flush when they move the clock.
const realNow = Date.now;
let clock = null;
Date.now = () => clock === null ? realNow() : clock;
globalThis.setTimeout = (fn, ms) => ({ fn, ms });
globalThis.clearTimeout = () => {};

let failed = 0, passed = 0;
async function check(name, fn) {
    clock = null;
    try {
        await fn();
        passed++;
        console.log(`ok    ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split("\n").join("\n      ")}`);
    }
}

const T1 = "11111111111111111111111111111111";
const T2 = "22222222222222222222222222222222";
const ws101 = r => assert.equal(r.status, 101, `status ${r.status}`);

async function newFeed(env = {}) {
    const ctx = new FakeCtx(new FakeStorage());
    const feed = new Feed(ctx, env);
    await ctx.ready;
    feed.ctx = ctx;
    return feed;
}
function req(path, upgrade = true) {
    return new Request("https://lobby.test" + path, upgrade ? { headers: { Upgrade: "websocket" } } : {});
}
async function game(feed, token) {
    ws101(await feed.fetch(req("/feed/7?up=" + token)));
    return feed.ctx.sockets.at(-1);
}
async function page(feed) {
    ws101(await feed.fetch(req("/feed/7")));
    return feed.ctx.sockets.at(-1);
}
// A game's chunk: its kind, then its packets.
const chunk = (kind, ...bytes) => new Uint8Array([kind, ...bytes]).buffer;
// The records in what a page got: [{t, kind, seat, packets: [..]}].
function records(sent) {
    const out = [];
    for (const m of sent) {
        if (typeof m === "string")
            continue;
        const b = new Uint8Array(m), dv = new DataView(m);
        for (let at = 0; at < b.length;) {
            const len = dv.getUint32(at, true);
            out.push({ t: dv.getUint32(at + 4, true), kind: b[at + 8], seat: b[at + 9], packets: [...b.subarray(at + 10, at + 4 + len)] });
            at += 4 + len;
        }
    }
    return out;
}
const texts = sent => sent.filter(m => typeof m === "string");

await check("a feed nobody armed has nothing, for games or pages", async () => {
    const feed = await newFeed();
    assert.equal((await feed.fetch(req("/feed/7"))).status, 404);
    assert.equal((await feed.fetch(req("/feed/7?up=" + T1))).status, 404);
    assert.equal((await feed.fetch(req("/feed/7", false))).status, 426);
});

await check("a page that comes with no keyframe here has the feed ask the host's game for one, at most every 10 s", async () => {
    clock = 2_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const host = await game(feed, T1), other = await game(feed, T2);
    host.take();
    other.take();
    let p = await page(feed);
    assert.deepEqual(p.take(), ["feed 30", "feed waiting"]);
    assert.deepEqual(host.take(), ["key"], "the host's game is asked");
    assert.deepEqual(other.take(), [], "not a joiner's");
    await page(feed);
    clock += 5000;
    await page(feed);
    assert.deepEqual(host.take(), [], "not again within 10 s");
    clock += 6000;
    await page(feed);
    assert.deepEqual(host.take(), ["key"]);
    // One on its way (not yet of age) is enough.
    await feed.webSocketMessage(host, chunk(1, 1));
    clock += 20_000;
    p = await page(feed);
    assert.deepEqual(p.take(), ["feed 30", "feed waiting"]);
    assert.deepEqual(host.take(), []);
    // No host's game in the feed: nobody to ask.
    const lone = await newFeed();
    await lone.arm(7, 30, { [T2]: 2 });
    const g = await game(lone, T2);
    g.take();
    await page(lone);
    assert.deepEqual(g.take(), []);
});

await check("only a game with a token the lobby gave sends, as its seat", async () => {
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2, nope: 3, ["3".repeat(32)]: 99 });
    assert.deepEqual(feed.cfg.tokens, { [T1]: 1, [T2]: 2 }, "bad tokens and seats are dropped");
    assert.equal((await feed.fetch(req("/feed/7?up=" + "f".repeat(32)))).status, 403);
    assert.equal((await feed.fetch(req("/feed/7?up=x"))).status, 403);
    const g = await game(feed, T2);
    assert.deepEqual(feed.socks.get(g), { seat: 2 });
    assert.deepEqual(g.att, { seat: 2 }, "kept on the socket, for after hibernation");
});

await check("pages get what was sent once it's the delay old, from a keyframe on", async () => {
    clock = 1_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const host = await game(feed, T1), other = await game(feed, T2);
    const p = await page(feed);
    assert.deepEqual(p.take(), ["feed 30", "feed waiting"]);
    await feed.webSocketMessage(other, chunk(0, 9, 9));       // before any keyframe: of no use
    clock += 1000;
    await feed.webSocketMessage(host, chunk(1, 1, 2, 3));
    await feed.webSocketMessage(host, chunk(2, 4, 5));
    clock += 250;
    await feed.webSocketMessage(other, chunk(0, 6));
    await feed.webSocketMessage(host, chunk(0, 7, 8));
    assert.deepEqual(p.take(), [], "nothing before it's 30 s old");
    clock += 29_000;
    feed.flush();
    assert.deepEqual(p.take(), [], "still 750 ms short");
    clock += 1000;
    feed.flush();
    const got = records(p.take());
    assert.deepEqual(got.map(r => [r.kind, r.seat, r.packets]),
                     [[1, 1, [1, 2, 3]], [2, 1, [4, 5]], [0, 2, [6]], [0, 1, [7, 8]]]);
    assert.deepEqual(got.map(r => r.t), [1000, 1000, 1250, 1250], "ms since the feed began, when each came");
    // Then each chunk as it comes of age, once.
    await feed.webSocketMessage(host, chunk(0, 10));
    clock += 30_000;
    feed.flush();
    feed.flush();
    assert.deepEqual(records(p.take()).map(r => r.packets), [[10]]);
});

await check("a page that comes later starts at the latest keyframe of age, and the rest is dropped", async () => {
    clock = 5_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1 });
    const host = await game(feed, T1);
    await feed.webSocketMessage(host, chunk(1, 1));
    await feed.webSocketMessage(host, chunk(0, 2));
    clock += 10_000;
    await feed.webSocketMessage(host, chunk(1, 3));
    await feed.webSocketMessage(host, chunk(0, 4));
    clock += 10_000;
    await feed.webSocketMessage(host, chunk(0, 5));          // not of age yet
    clock += 21_000;
    const p = await page(feed);
    assert.deepEqual(records(p.take()).map(r => r.packets), [[3], [4]], "from the newer keyframe");
    assert.equal((await feed.info()).chunks, 3, "the older keyframe and what followed it are gone");
    clock += 10_000;
    feed.flush();
    assert.deepEqual(records(p.take()).map(r => r.packets), [[5]]);
});

await check("a game's chunks: binary, a known kind, not too big, not too often", async () => {
    clock = 9_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    let g = await game(feed, T1);
    await feed.webSocketMessage(g, "hello");
    assert.equal(g.closed, null, "text is ignored");
    await feed.webSocketMessage(g, chunk(3, 1));
    assert.deepEqual(g.closed, [1003, "bad chunk"]);
    g = await game(feed, T1);
    await feed.webSocketMessage(g, new Uint8Array(64 * 1024 + 1).buffer);
    assert.deepEqual(g.closed, [1003, "bad chunk"]);
    g = await game(feed, T1);
    await feed.webSocketMessage(g, chunk(0));
    assert.deepEqual(g.closed, [1003, "bad chunk"], "a kind and no packets");
    g = await game(feed, T2);
    for (let i = 0; i < 100; i++)
        await feed.webSocketMessage(g, chunk(0, i));
    assert.equal(g.closed, null, "20 a second for 5 s is fine");
    await feed.webSocketMessage(g, chunk(0, 1));
    assert.deepEqual(g.closed, [1008, "too many"]);
    // A page has nothing to say.
    const p = await page(feed);
    await feed.webSocketMessage(p, chunk(1, 1));
    assert.equal((await feed.info()).chunks, 100);
});

await check("a game that reconnects takes its seat's place, and one the lobby drops is closed", async () => {
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const a = await game(feed, T1);
    const b = await game(feed, T1);
    assert.deepEqual(a.closed, [4002, "replaced"]);
    const c = await game(feed, T2);
    await feed.arm(7, 90, { [T1]: 1 });
    assert.deepEqual(c.closed, [4001, "not sending"]);
    assert.equal(b.closed, null);
    assert.equal(feed.cfg.delay, 90);
    assert.equal((await feed.fetch(req("/feed/7?up=" + T2))).status, 403);
});

await check("ending a feed (watching off) tells its pages at once, closes everything and keeps nothing", async () => {
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1 });
    const g = await game(feed, T1);
    const p = await page(feed);
    p.take();
    await feed.webSocketMessage(g, chunk(1, 1));
    await feed.end("watching off");
    assert.deepEqual(p.take(), ["feed ended watching off"]);
    assert.ok(p.closed && g.closed);
    assert.equal(feed.ctx.storage.m.size, 0);
    assert.equal(feed.ctx.storage.alarm, null);
    assert.equal((await feed.fetch(req("/feed/7"))).status, 404);
});

await check("when the room ends, pages get the match's last seconds as they come of age, then it ends", async () => {
    clock = 5_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const host = await game(feed, T1), other = await game(feed, T2);
    const p = await page(feed);
    p.take();
    await feed.webSocketMessage(host, chunk(1, 1));
    clock += 10_000;
    await feed.webSocketMessage(other, chunk(0, 2));
    clock += 10_000;
    await feed.end("room ended");
    assert.ok(host.closed && other.closed, "the games are done sending");
    assert.equal(feed.ctx.storage.m.size, 0, "nothing kept");
    assert.equal(feed.ctx.storage.alarm, null);
    assert.equal((await feed.fetch(req("/feed/7?up=" + T1))).status, 403, "nor can a game send again");
    assert.deepEqual(p.take(), [], "not yet");
    assert.equal(p.closed, null);
    clock += 10_000;
    feed.flush();
    assert.deepEqual(records(p.take()).map(r => r.packets), [[1]], "the keyframe, 30 s on");
    assert.equal(p.closed, null);
    // A page that comes now starts at that keyframe too.
    const late = await page(feed);
    assert.deepEqual(late.take().slice(0, 1), ["feed 30"]);
    clock += 10_000;
    feed.flush();
    assert.deepEqual(p.take().map(m => typeof m === "string" ? m : records([m]).map(r => r.packets)),
                     [[[2]], "feed ended room ended"]);
    assert.ok(p.closed && late.closed);
    assert.equal(feed.cfg, null);
    assert.equal((await feed.fetch(req("/feed/7"))).status, 404);
});

await check("a room that ends with nothing left for its pages ends the feed at once; the last page leaving ends it too", async () => {
    clock = 6_000_000;
    let feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1 });
    let g = await game(feed, T1);
    let p = await page(feed);
    p.take();
    await feed.end("room ended");
    assert.deepEqual(p.take(), ["feed ended room ended"], "no keyframe: nothing it could get");
    assert.equal(feed.cfg, null);

    feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1 });
    g = await game(feed, T1);
    p = await page(feed);
    await feed.webSocketMessage(g, chunk(1, 1));
    await feed.end("room ended");
    assert.ok(feed.cfg, "a keyframe on its way");
    await feed.webSocketClose(p);
    assert.equal(feed.cfg, null, "nobody left to get it");
});

await check("a feed nothing is sent to ends itself after 10 minutes", async () => {
    clock = 20_000_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1 });
    assert.equal(feed.ctx.storage.alarm, clock + 600_000);
    const g = await game(feed, T1);
    clock += 300_000;
    await feed.webSocketMessage(g, chunk(1, 1));
    clock += 300_000;
    await feed.alarm();
    assert.ok(feed.cfg, "sent to 5 min ago: still on");
    assert.equal(feed.ctx.storage.alarm, clock + 300_000);
    clock += 300_000;
    await feed.alarm();
    assert.equal(feed.cfg, null);
    assert.ok(g.closed);
});

await check("an armed feed survives being evicted; what it held doesn't", async () => {
    const feed = await newFeed();
    await feed.arm(7, 45, { [T1]: 1 });
    const g = await game(feed, T1);
    const p = await page(feed);
    await feed.webSocketMessage(g, chunk(1, 1));
    const again = new Feed(new FakeCtx(feed.ctx.storage, feed.ctx.sockets), {});
    await again.ctx.ready;
    assert.equal(again.cfg.delay, 45);
    assert.deepEqual(again.socks.get(g), { seat: 1 });
    assert.deepEqual(again.socks.get(p), { next: -1 }, "pages wait for the next keyframe");
    assert.equal((await again.info()).chunks, 0);
});

await check("the feed tells the lobby how many pages watch, 2 s after one comes or goes", async () => {
    const told = [];
    const LOBBY = { idFromName: n => n, get: n => ({ feedPages: async (room, count) => { told.push([n, room, count]); return true; } }) };
    const feed = await newFeed({ LOBBY });
    await feed.arm(7, 30, { [T1]: 1 });
    const g = await game(feed, T1);
    assert.equal(feed.pagesTimer, null, "a game isn't a page");
    const p1 = await page(feed);
    const timer = feed.pagesTimer;
    assert.equal(timer.ms, 2000);
    await page(feed);
    assert.equal(feed.pagesTimer, timer, "one wait for a crowd");
    timer.fn();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(told, [["lobby", 7, 2]]);
    assert.equal(feed.pagesTimer, null);
    await feed.webSocketClose(p1);
    feed.pagesTimer.fn();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(told.at(-1), ["lobby", 7, 1]);
    // A page that comes and goes in the wait: nothing new to say.
    const p3 = await page(feed);
    await feed.webSocketError(p3);
    feed.pagesTimer.fn();
    await new Promise(r => setImmediate(r));
    assert.equal(told.length, 2);
    await feed.webSocketClose(g);
    assert.equal(feed.pagesTimer, null, "nor a game leaving");
    // A lobby that doesn't answer is told again the next time.
    const failing = await newFeed({ LOBBY: { idFromName: n => n, get: () => ({ feedPages: async () => { throw new Error("away"); } }) } });
    await failing.arm(7, 30, {});
    await page(failing);
    await failing.pagesSay();
    assert.equal(failing.pagesTold, -1);
    // Without the LOBBY binding, nobody is told.
    const alone = await newFeed();
    await alone.arm(7, 30, {});
    await page(alone);
    assert.equal(alone.pagesTimer, null);
});

await check("the game in a viewing page's box (?box=1) gets the feed but isn't counted: the lobby counts its page", async () => {
    const told = [];
    const LOBBY = { idFromName: n => n, get: n => ({ feedPages: async (room, count) => { told.push(count); return true; } }) };
    const feed = await newFeed({ LOBBY });
    await feed.arm(7, 30, { [T1]: 1 });
    ws101(await feed.fetch(req("/feed/7?box=1")));
    const b = feed.ctx.sockets.at(-1);
    assert.deepEqual(feed.socks.get(b), { next: -1, box: 1 });
    assert.deepEqual(texts(b.sent).slice(0, 2), ["feed 30", "feed waiting"], "it watches like any page");
    assert.equal(feed.pagesTimer, null, "nothing for the lobby to hear");
    assert.equal(feed.pageCount(), 1, "still one of the most that may watch");
    assert.equal(feed.pageCount(false), 0);
    // An in-game page next to it is counted, the box's game still isn't.
    const p = await page(feed);
    feed.pagesTimer.fn();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(told, [1]);
    // The box's game leaving (its game starts again into the host's mod): nothing changes.
    await feed.webSocketClose(b);
    assert.equal(feed.pagesTimer, null);
    // Kept as a box's game through an eviction.
    ws101(await feed.fetch(req("/feed/7?box=1")));
    const b2 = feed.ctx.sockets.at(-1);
    const again = new Feed(new FakeCtx(feed.ctx.storage, feed.ctx.sockets), { LOBBY });
    await again.ctx.ready;
    assert.deepEqual(again.socks.get(b2), { next: -1, box: 1 });
    assert.equal(again.pageCount(false), 1, "only the in-game page");
    await feed.webSocketClose(p);
    feed.pagesTimer.fn();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(told, [1, 0]);
    // Anything else after box= is a page like any other.
    ws101(await feed.fetch(req("/feed/7?box=yes")));
    assert.deepEqual(feed.socks.get(feed.ctx.sockets.at(-1)), { next: -1 });
});

// ---- The lobby's part.

function entry({ name = "t_Room", episode = "JK1MP", map = "m2.jkl", password = "" } = {}) {
    const b = Buffer.alloc(240);
    b.writeUInt32LE(0x4a4b4852, 8);
    b.writeInt32LE(8, 16);
    b.write(name, 24, "utf16le");
    b.write(episode, 88, "latin1");
    b.write(map, 120, "latin1");
    b.write(password, 152, "utf16le");
    b.writeInt32LE(password ? 0x400 | 0x8 : 0x8, 216);
    b.writeInt32LE(10, 224);
    b.writeInt32LE(4, 236);
    return b.toString("hex");
}
const b64 = text => Buffer.from(text, "utf8").toString("base64");
const statusOf = line => JSON.parse(Buffer.from(line.slice(7), "base64").toString());

// FEED as the Worker has it: one Feed per name, run here.
class Feeds {
    constructor(env = {}) { this.byName = new Map(); this.env = env; }
    idFromName(n) { return n; }
    get(n) {
        if (!this.byName.has(n)) {
            const ctx = new FakeCtx(new FakeStorage());
            const f = new Feed(ctx, this.env);
            f.ctx = ctx;
            this.byName.set(n, f);
        }
        return this.byName.get(n);
    }
    of(room) { return this.byName.get("room:" + room); }
}

class World {
    constructor(env = {}, storage = new FakeStorage()) {
        this.feeds = env.FEED || new Feeds();
        this.env = { SITE: "", MOVED_FROM: "", FEED: this.feeds, ...env };
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
    async say(ws, line) {
        await this.lobby.webSocketMessage(ws, line);
        await this.settle();
    }
    // Waits for the lobby's calls to every room's feed.
    async settle() {
        for (const room of this.lobby.rooms.values())
            await room.feedChain;
        for (let i = 0; i < 3; i++)
            await new Promise(r => setImmediate(r));
    }
    async close(ws) {
        ws.close(1000, "bye");
        await this.lobby.webSocketClose(ws, 1000, "bye", true);
        await this.settle();
    }
    async host(name, opts = {}) {
        const ws = await this.connect();
        await this.say(ws, `hello jk1 ${b64(name)}`);
        await this.say(ws, "host " + entry(opts));
        const out = ws.take();
        assert.match(out[0] || "", /^hosted \d+$/, `host: ${out}`);
        ws.room = Number(out[0].split(" ")[1]);
        return ws;
    }
    async joiner(name, room) {
        const ws = await this.connect();
        await this.say(ws, `hello jk1 ${b64(name)}`);
        await this.say(ws, `join ${room}`);
        ws.take();
        return ws;
    }
    async page() {
        const ws = await this.connect();
        await this.say(ws, "watch");
        ws.take();
        return ws;
    }
    async status() {
        const ws = await this.connect();
        await this.lobby.webSocketMessage(ws, "watch");
        const line = ws.take().filter(l => l.startsWith("status ")).pop();
        ws.close(1000, "bye");
        await this.lobby.webSocketClose(ws, 1000, "bye", true);
        return statusOf(line);
    }
}
const feedLines = ws => ws.take().filter(l => l.startsWith("feed"));

await check("the lobby says feed on connect only with a FEED binding", async () => {
    let w = await new World().start();
    assert.match((await w.connect()).lobbyLine, /\bspect feed$/);
    w = await new World({ FEED: undefined }).start();
    const ws = await w.connect();
    assert.doesNotMatch(ws.lobbyLine, /\bfeed\b/);
    const H = await w.host("Maw");
    await w.say(H, "feed");
    assert.deepEqual(H.take(), ["error bad-request"], "and doesn't take it");
});

await check("with FEED_ONLY_WATCHED, a game in a room asks to take part; the feed starts once a page watches", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    const loner = await w.connect();
    await w.say(loner, "feed");
    assert.deepEqual(loner.take(), ["error bad-request"], "not in a room");
    const H = await w.host("Maw");
    await w.say(H, "feed now");
    assert.deepEqual(H.take(), ["error bad-request"]);
    await w.say(H, "feed");
    assert.deepEqual(H.take(), [], "nobody watching: no feed");
    assert.equal(w.feeds.of(H.room), undefined);
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    const lines = feedLines(H);
    assert.equal(lines.length, 1);
    const [, room, token] = lines[0].split(" ");
    assert.equal(Number(room), H.room);
    assert.match(token, /^[0-9a-f]{32}$/);
    const feed = w.feeds.of(H.room);
    assert.deepEqual(feed.cfg.tokens, { [token]: 1 });
    assert.equal(feed.cfg.delay, 30);
    assert.equal((await w.status()).games.find(g => g.id === H.room).feed, 1);
    // The game can send with it, through the Worker's route.
    const env = w.env;
    const r = await feedRoute(new Request(`https://lobby.test/feed/${H.room}?up=${token}`, { headers: { Upgrade: "websocket" } }), env,
                              new URL(`https://lobby.test/feed/${H.room}?up=${token}`));
    assert.equal(r.status, 101);
    // Saying it again changes nothing.
    await w.say(H, "feed");
    assert.deepEqual(feedLines(H), []);
});

await check("each game taking part has its own token; the host's delay goes to the feed", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    const H = await w.host("Maw");
    const J = await w.joiner("Kyle_K", H.room);
    const quiet = await w.joiner("Jerec", H.room);
    await w.say(H, "feed");
    await w.say(J, "feed");
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    const th = feedLines(H)[0].split(" ")[2], tj = feedLines(J)[0].split(" ")[2];
    assert.notEqual(th, tj);
    assert.deepEqual(feedLines(quiet), [], "a game that didn't ask isn't told");
    const feed = w.feeds.of(H.room);
    assert.deepEqual(feed.cfg.tokens, { [th]: 1, [tj]: 2 });
    await w.say(H, "spectators on 90");
    assert.equal(feed.cfg.delay, 90);
    assert.deepEqual(feedLines(H).concat(feedLines(J)), [], "the same tokens");
    // A player who leaves loses theirs.
    await w.say(J, "leave");
    assert.deepEqual(feed.cfg.tokens, { [th]: 1 });
});

await check("with FEED_ONLY_WATCHED, a feed nobody watches goes on for 2 minutes, then ends", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    const H = await w.host("Maw");
    await w.say(H, "feed");
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    H.take();
    await w.say(p, "spectate 0");
    const room = w.lobby.rooms.get(H.room);
    assert.ok(room.feed && room.feed.idle, "still on, nobody watching since now");
    w.lobby.sweep();
    await w.settle();
    assert.ok(w.feeds.of(H.room).cfg, "not yet");
    // A page watching again in time keeps it, with no new token.
    await w.say(p, `spectate ${H.room}`);
    assert.equal(room.feed.idle, 0);
    assert.deepEqual(feedLines(H), []);
    await w.say(p, "spectate 0");
    room.feed.idle = Date.now() - 2 * 60 * 1000 - 1;
    w.lobby.sweep();
    await w.settle();
    assert.deepEqual(feedLines(H), ["feed off"]);
    assert.equal(w.feeds.of(H.room).cfg, null);
    assert.equal(room.feed, null);
    assert.equal("feed" in (await w.status()).games.find(g => g.id === H.room), false);
    assert.equal(w.storage.m.has("feed:" + H.room), false);
});

await check("watching off, or a password, means no feed", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    const H = await w.host("Maw");
    await w.say(H, "feed");
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    H.take();
    await w.say(H, "spectators off");
    assert.deepEqual(feedLines(H), ["feed off"]);
    assert.equal(w.feeds.of(H.room).cfg, null);
    const L = await w.host("Jerec", { password: "sith" });
    await w.say(L, "feed");
    await w.say(p, `spectate ${L.room}`);
    assert.deepEqual(feedLines(L), []);
    assert.equal(w.feeds.of(L.room), undefined);
    // Unless its host turns watching on.
    await w.say(L, "spectators on");
    assert.equal(feedLines(L).length, 1);
});

await check("by default, a watchable match's feed is on whether watched or not", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    await w.say(H, "feed");
    assert.equal(feedLines(H).length, 1);
    const room = w.lobby.rooms.get(H.room);
    assert.equal(room.feed.idle, 0);
    room.feed.idle = 1;     // even one that somehow lingered
    w.lobby.sweep();
    await w.settle();
    assert.ok(room.feed);
    // Still none for a password game, and none once its host turns watching off.
    const L = await w.host("Jerec", { password: "sith" });
    await w.say(L, "feed");
    assert.deepEqual(feedLines(L), []);
    await w.say(H, "spectators off");
    assert.deepEqual(feedLines(H), ["feed off"]);
    assert.equal(room.feed, null);
});

await check("a room that ends ends its feed; a lobby restart keeps the tokens", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    const H = await w.host("Maw");
    await w.say(H, "feed");
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    const token = feedLines(H)[0].split(" ")[2];
    assert.ok(w.storage.m.has("feed:" + H.room));
    const w2 = await new World({ FEED: w.feeds }, w.storage).start(w.ctx.sockets);
    w2.lobby.statusChanged();
    await w2.settle();
    assert.deepEqual(feedLines(H), [], "no new token after a restart");
    assert.deepEqual(w.feeds.of(H.room).cfg.tokens, { [token]: 1 });
    await w2.say(H, "leave");
    assert.equal(w.feeds.of(H.room).cfg, null);
    assert.equal(w.storage.m.has("feed:" + H.room), false);
});

await check("games watching from inside the game count in the room's watching, and keep a watched-only feed on", async () => {
    const w = await new World({ FEED_ONLY_WATCHED: "1" }).start();
    w.feeds.env.LOBBY = { idFromName: n => n, get: () => w.lobby };
    const watchingOf = async room => (await w.status()).games.find(g => g.id === room).watching;
    const H = await w.host("Maw");
    await w.say(H, "feed");
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    H.take();
    const feed = w.feeds.of(H.room), room = w.lobby.rooms.get(H.room);
    const v1 = await page(feed), v2 = await page(feed);
    feed.pagesTimer.fn();
    await w.settle();
    assert.equal(room.feed.pages, 2);
    assert.equal(await watchingOf(H.room), 3, "the page and the two games");
    assert.equal(w.storage.m.get("feed:" + H.room).pages, 2, "kept for a restart");
    // The page stops watching: the games watching keep the feed on.
    await w.say(p, "spectate 0");
    assert.equal(room.feed.idle, 0);
    assert.equal(await watchingOf(H.room), 2);
    await feed.webSocketClose(v1);
    await feed.webSocketClose(v2);
    feed.pagesTimer.fn();
    await w.settle();
    assert.equal(await watchingOf(H.room), undefined);
    assert.ok(room.feed.idle > 0, "nobody watching: it lingers");
    // Only a number from a room with a feed.
    assert.equal(await w.lobby.feedPages(H.room + 99, 1), false);
    assert.equal(await w.lobby.feedPages(H.room, -1), false);
    assert.equal(await w.lobby.feedPages(H.room, 1.5), false);
    assert.equal(await w.lobby.feedPages(String(H.room), 1), true);
    assert.equal(room.feed.pages, 1);
    // A room that can't be watched shows no count.
    await w.say(H, "spectators off");
    assert.equal(await w.lobby.feedPages(H.room, 1), false, "its feed has ended");
    assert.equal(await watchingOf(H.room), undefined);
});

// A bucket like R2's, for the host's mod: objects by key.
class FakeBucket {
    constructor() { this.m = new Map(); this.lists = 0; }
    async put(key, body, opts) {
        this.m.set(key, { bytes: new Uint8Array(body instanceof ArrayBuffer ? body : body.buffer.slice(0)), type: opts && opts.httpMetadata && opts.httpMetadata.contentType });
    }
    async get(key) {
        const o = this.m.get(key);
        return o ? { body: o.bytes, type: o.type } : null;
    }
    async list({ prefix, cursor }) {
        this.lists++;
        // Two at a time, to go by the cursor.
        const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).sort();
        const from = cursor ? Number(cursor) : 0;
        return { objects: keys.slice(from, from + 2).map(key => ({ key })), truncated: from + 2 < keys.length, cursor: String(from + 2) };
    }
    async delete(keys) {
        for (const k of [].concat(keys))
            this.m.delete(k);
    }
}
const FP = "ab".repeat(32), FP2 = "cd".repeat(32), FP3 = "ef".repeat(32);
const bytes = n => new Uint8Array(n).fill(7).buffer;

await check("a game watching asks for the host's mod: the host's game is asked, once every 20 s for each mod", async () => {
    clock = 3_000_000;
    const feed = await newFeed({ SHOTS: new FakeBucket() });
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const host = await game(feed, T1), other = await game(feed, T2);
    const p = await page(feed);
    host.take();
    await feed.webSocketMessage(p, "mod " + FP);
    assert.deepEqual(host.take(), ["mod " + FP]);
    assert.deepEqual(other.take(), [], "only the host's game");
    await feed.webSocketMessage(p, "mod " + FP);
    clock += 19_000;
    await feed.webSocketMessage(p, "mod " + FP);
    assert.deepEqual(host.take(), [], "not again within 20 s");
    await feed.webSocketMessage(p, "mod " + FP2);
    assert.deepEqual(host.take(), ["mod " + FP2], "another mod is its own");
    clock += 2000;
    await feed.webSocketMessage(p, "mod " + FP);
    assert.deepEqual(host.take(), ["mod " + FP]);
    // Anything else is nothing, and a game's text too.
    await feed.webSocketMessage(p, "mod nope");
    await feed.webSocketMessage(other, "mod " + FP3);
    assert.deepEqual(host.take(), []);
    // A page that says too much is closed.
    const q = await page(feed);
    for (let i = 0; i < 11; i++)
        await feed.webSocketMessage(q, "hi");
    assert.deepEqual(q.closed, [1008, "too many"]);
});

await check("a spectator's message goes to the host's game as the chat shows it, one every 3 s from each", async () => {
    clock = 3_500_000;
    const feed = await newFeed();
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    const p = await page(feed), box = (ws101(await feed.fetch(req("/feed/7?box=1"))), feed.ctx.sockets.at(-1));
    await feed.webSocketMessage(p, "say Rogue\thello there");
    const host = await game(feed, T1), other = await game(feed, T2);
    host.take();
    await feed.webSocketMessage(p, "say Rogue\thello there");
    assert.deepEqual(host.take(), ["say Rogue (watching): hello there"]);
    assert.deepEqual(other.take(), [], "only the host's game");
    clock += 2999;
    await feed.webSocketMessage(p, "say Rogue\tagain");
    assert.deepEqual(host.take(), [], "not within 3 s");
    await feed.webSocketMessage(box, "say  Kyle   Katarn \t  gg   wp\u00e9\u0007 ");
    assert.deepEqual(host.take(), ["say Kyle Katarn (watching): gg wp??"], "another socket is its own; cleaned");
    clock += 1;
    await feed.webSocketMessage(p, "say Rogue\tagain");
    assert.deepEqual(host.take(), ["say Rogue (watching): again"]);
    clock += 3000;
    await feed.webSocketMessage(p, "say " + "N".repeat(40) + "\t" + "x".repeat(200));
    assert.deepEqual(host.take(), ["say " + "N".repeat(16) + " (watching): " + "x".repeat(96)], "no longer than the chat");
    assert.ok(("N".repeat(16) + " (watching): " + "x".repeat(96)).length < 127);
    clock += 3000;
    await feed.webSocketMessage(p, "say \thi");
    assert.deepEqual(host.take(), ["say Someone (watching): hi"]);
    // Nothing: no text, no tab, a game's text, or once the feed is ending.
    clock += 3000;
    await feed.webSocketMessage(p, "say Rogue\t   ");
    await feed.webSocketMessage(p, "say Rogue hi");
    await feed.webSocketMessage(other, "say Rogue\thi");
    assert.deepEqual(host.take(), []);
    await feed.end("room ended");
    clock += 3000;
    await feed.webSocketMessage(p, "say Rogue\thi");
    assert.deepEqual(host.take().filter(m => typeof m === "string" && m.startsWith("say")), []);
});

await check("the host's game puts its mod: only the host's, only one asked for, so much and so often", async () => {
    clock = 4_000_000;
    const shots = new FakeBucket();
    const feed = await newFeed({ SHOTS: shots });
    assert.equal((await feed.modPut(T1, FP, "info", bytes(10))).status, 404, "not armed");
    await feed.arm(7, 30, { [T1]: 1, [T2]: 2 });
    await game(feed, T1);
    const p = await page(feed);
    assert.equal((await feed.modPut(T1, FP, "info", bytes(10))).status, 403, "nobody asked for it");
    await feed.webSocketMessage(p, "mod " + FP);
    assert.equal((await feed.modPut(T2, FP, "info", bytes(10))).status, 403, "not the host's game");
    assert.equal((await feed.modPut("x", FP, "info", bytes(10))).status, 403);
    assert.equal((await feed.modPut(T1, "ab", "info", bytes(10))).status, 400);
    assert.equal((await feed.modPut(T1, FP, "1100", bytes(10))).status, 400, "past the most blocks");
    assert.equal((await feed.modPut(T1, FP, "x", bytes(10))).status, 400);
    assert.equal((await feed.modPut(T1, FP, "info", bytes(64 * 1024 + 1))).status, 413);
    assert.equal((await feed.modPut(T1, FP, "0", bytes(1024 * 1024 + 65))).status, 413);
    assert.equal((await feed.modPut(T1, FP, "0", bytes(0))).status, 413);
    assert.equal((await feed.modPut(T1, FP, "info", bytes(10))).status, 200);
    assert.equal((await feed.modPut(T1, FP, "0", bytes(1024 * 1024 + 1))).status, 200);
    const info = shots.m.get("feed-mods/7/" + FP + "/info");
    assert.equal(info.type, "application/json");
    assert.equal(info.bytes.length, 10);
    assert.equal(shots.m.get("feed-mods/7/" + FP + "/0").type, "application/octet-stream");
    assert.deepEqual(feed.ctx.storage.m.get("mods"), { [FP]: 10 + 1024 * 1024 + 1 });
    // At most 10 a second, over 5 s.
    for (let i = 1; i < 49; i++)
        assert.equal((await feed.modPut(T1, FP, String(i), bytes(100))).status, 200, "part " + i);
    assert.equal((await feed.modPut(T1, FP, "49", bytes(100))).status, 429);
    clock += 5001;
    assert.equal((await feed.modPut(T1, FP, "49", bytes(100))).status, 200);
    // Two mods at most, and 1.25 GiB in all.
    await feed.webSocketMessage(p, "mod " + FP2);
    await feed.webSocketMessage(p, "mod " + FP3);
    assert.equal((await feed.modPut(T1, FP2, "info", bytes(10))).status, 200);
    assert.equal((await feed.modPut(T1, FP3, "info", bytes(10))).status, 403, "a third mod");
    feed.mods[FP2] = 1280 * 1024 * 1024 - feed.mods[FP] - 10;
    assert.equal((await feed.modPut(T1, FP2, "1", bytes(11))).status, 413);
    assert.equal((await feed.modPut(T1, FP2, "1", bytes(10))).status, 200);
});

await check("a mod the host's game was putting goes on after the feed is evicted, and goes when it ends", async () => {
    clock = 5_000_000;
    const shots = new FakeBucket();
    const storage = new FakeStorage();
    const ctx = new FakeCtx(storage);
    let feed = new Feed(ctx, { SHOTS: shots });
    await ctx.ready;
    await feed.arm(7, 30, { [T1]: 1 });
    ws101(await feed.fetch(req("/feed/7?up=" + T1)));
    ws101(await feed.fetch(req("/feed/7")));
    await feed.webSocketMessage(ctx.sockets.at(-1), "mod " + FP);
    for (const part of ["info", "0", "1", "2", "3"])
        assert.equal((await feed.modPut(T1, FP, part, bytes(5))).status, 200);
    shots.m.set("feed-mods/70/x", { bytes: new Uint8Array(1) });
    // Evicted: what it was asked is gone, what it put isn't.
    feed = new Feed(new FakeCtx(storage, ctx.sockets), { SHOTS: shots });
    await feed.ctx.ready;
    assert.equal((await feed.modPut(T1, FP, "4", bytes(5))).status, 200);
    assert.equal(shots.m.size, 7);
    await feed.end("room ended");
    assert.deepEqual([...shots.m.keys()], ["feed-mods/70/x"], "only this room's are deleted");
    assert.equal(storage.m.size, 0);
    // A feed that never had one doesn't look.
    const lists = shots.lists;
    const other = await newFeed({ SHOTS: shots });
    await other.arm(8, 30, { [T1]: 1 });
    await other.end("watching off");
    assert.equal(shots.lists, lists);
});

await check("the Worker's mod route: the host's game puts through its feed, anyone gets from the bucket", async () => {
    clock = 6_000_000;
    const shots = new FakeBucket();
    const feeds = new Feeds({ SHOTS: shots });
    const env = { FEED: feeds, SHOTS: shots };
    const at = path => "https://lobby.test/feed/12/mod/" + FP + "/" + path;
    const put = (path, body, headers = {}) => feedRoute(new Request(at(path), { method: "PUT", body, headers }), env, new URL(at(path)));
    const get = (path, method = "GET") => feedRoute(new Request(at(path), { method }), env, new URL(at(path)));
    assert.equal((await feedRoute(new Request(at("info")), { FEED: feeds }, new URL(at("info")))).status, 404, "no bucket");
    assert.equal(await feedRoute(new Request("https://lobby.test/feed/12/mod/ab/info"), env, new URL("https://lobby.test/feed/12/mod/ab/info")), null);
    assert.equal((await get("info")).status, 404);
    assert.equal((await put("info?up=" + T1, "{}")).status, 404, "no feed armed");
    const feed = feeds.get("room:12");
    await feed.arm(12, 30, { [T1]: 1 });
    ws101(await feed.fetch(req("/feed/12?up=" + T1)));
    ws101(await feed.fetch(req("/feed/12")));
    await feed.webSocketMessage(feed.ctx.sockets.at(-1), "mod " + FP);
    assert.equal((await put("info?up=" + T2, "{}")).status, 403);
    assert.equal((await put("info?up=" + T1, "x".repeat(64 * 1024 + 1))).status, 413);
    assert.equal((await put("info?up=" + T1, "{}", { "Content-Length": "99999999" })).status, 413, "by its length first");
    assert.equal((await put("info?up=" + T1, "")).status, 400);
    const r = await put("info?up=" + T1, '{"status":"ok"}');
    assert.equal(r.status, 200);
    const g = await get("info");
    assert.equal(g.status, 200);
    assert.equal(g.headers["Content-Type"], "application/json");
    assert.equal(g.headers["Cache-Control"], "no-store");
    assert.equal(new TextDecoder().decode(g.body), '{"status":"ok"}');
    assert.equal((await get("info", "HEAD")).body, null);
    assert.equal((await put("0?up=" + T1, new Uint8Array([1, 2, 3]))).status, 200);
    assert.deepEqual([...(await get("0")).body], [1, 2, 3]);
    assert.equal((await get("1")).status, 404);
    assert.equal((await get("info", "DELETE")).status, 405);
    // The Worker sends them there too.
    const w = await lobbyModule.default.fetch(new Request(at("0")), { ...env, SITE: "", MOVED_FROM: "" }, {});
    assert.equal(w.status, 200);
});

await check("the Worker's /feed/ route", async () => {
    const url = path => new URL("https://lobby.test" + path);
    assert.equal(await feedRoute(req("/feedx/1"), {}, url("/feedx/1")), null);
    assert.equal(await feedRoute(req("/feed/abc"), {}, url("/feed/abc")), null);
    assert.equal((await feedRoute(req("/feed/1"), {}, url("/feed/1"))).status, 404, "no FEED binding");
    const feeds = new Feeds();
    assert.equal((await feedRoute(req("/feed/1", false), { FEED: feeds }, url("/feed/1"))).status, 426);
    assert.equal((await feedRoute(req("/feed/0012"), { FEED: feeds }, url("/feed/0012"))).status, 404);
    assert.ok(feeds.of(12), "room 0012 is room 12's feed");
    // And the Worker sends /feed/ there before anything else.
    const r = await lobbyModule.default.fetch(req("/feed/12"), { FEED: feeds, SITE: "", MOVED_FROM: "" }, {});
    assert.equal(r.status, 404);
});

console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
