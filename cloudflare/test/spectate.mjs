// Checks watching a match (spectating) in src/lobby.js: a page watching the
// lobby says which room's match it watches (spectate), the status says
// whether each room can be watched (spect) and how many pages watch it
// (watching), and a room's host's game can turn it on or off (spectators).
// Runs the Lobby itself in Node.js on test/cfstub.mjs. Needs Node.js 22 or
// newer.
//
//   node test/spectate.mjs
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
const { Lobby } = await import("../src/lobby.js");

const realLog = console.log;
console.log = (...a) => {
    const line = a.join(" ");
    if (!line.startsWith("relay:") && !line.startsWith("ladder:"))
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

// A host's entry: a 240-byte jkMultiEntry.
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

class World {
    constructor(env = {}, storage = new FakeStorage()) {
        this.env = { SITE: "", MOVED_FROM: "", ...env };
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
    async host(name, opts = {}) {
        const ws = await this.connect();
        await this.say(ws, `hello jk1 ${b64(name)}`);
        await this.say(ws, "host " + entry(opts));
        const out = ws.take();
        assert.match(out[0] || "", /^hosted \d+$/, `host: ${out}`);
        ws.room = Number(out[0].split(" ")[1]);
        return ws;
    }
    // A page watching the lobby, as the landing page does.
    async page() {
        const ws = await this.connect();
        await this.say(ws, "watch");
        return ws;
    }
    // The status as a page that just came would have it.
    async status() {
        const ws = await this.page();
        const line = ws.take().filter(l => l.startsWith("status ")).pop();
        await this.close(ws);
        return statusOf(line);
    }
    async game(room) {
        return (await this.status()).games.find(g => g.id === room);
    }
}

await check("the lobby says it takes spectators on connect", async () => {
    const w = await new World().start();
    const ws = await w.connect();
    assert.match(ws.lobbyLine, /^lobby .*\bspect\b/);
    assert.match(ws.lobbyLine, /\blinks\b.*\bpw\b/, "and still what it said before");
});

await check("a game can be watched unless it has a password, until its host says", async () => {
    const w = await new World().start();
    const open = await w.host("Maw");
    const locked = await w.host("Jerec", { password: "sith" });
    const s = await w.status();
    const g = id => s.games.find(x => x.id === id);
    assert.equal(g(open.room).spect, 1);
    assert.equal(g(locked.room).spect, 0);
    assert.equal("watching" in g(open.room), false, "nobody watching: no count");
});

await check("a page watching a room's match is counted in it, and only while it watches", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const other = await w.host("Boc");
    const p1 = await w.page(), p2 = await w.page();
    const heard = ws => ws.take().filter(l => l.startsWith("status ")).map(statusOf);
    heard(p1);
    await w.say(p1, `spectate ${H.room}`);
    let s = heard(p1).pop();
    assert.ok(s, "every watching page hears the new count");
    assert.equal(s.games.find(g => g.id === H.room).watching, 1);
    assert.equal(heard(p2).pop().games.find(g => g.id === H.room).watching, 1);
    await w.say(p2, `spectate ${H.room}`);
    assert.equal((await w.game(H.room)).watching, 2);
    // Saying the same again changes nothing, so no new status goes out.
    heard(p1);
    await w.say(p2, `spectate ${H.room}`);
    assert.deepEqual(heard(p1), []);
    // A page watches one match at a time.
    await w.say(p2, `spectate ${other.room}`);
    assert.equal((await w.game(H.room)).watching, 1);
    assert.equal((await w.game(other.room)).watching, 1);
    await w.say(p1, "spectate 0");
    assert.equal("watching" in await w.game(H.room), false);
    // A page that closes stops watching.
    await w.close(p2);
    assert.equal("watching" in await w.game(other.room), false);
    // Watching takes no seat and no place among the players.
    const g = await w.game(H.room);
    assert.deepEqual([g.players, g.names], [1, ["Maw"]]);
});

await check("only a page watching the lobby can watch a match, and only one that's there", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const ws = await w.connect();
    await w.say(ws, `spectate ${H.room}`);
    assert.deepEqual(ws.take(), ["error bad-request"], "a game isn't a page");
    for (const bad of ["spectate", "spectate x", `spectate ${H.room} 2`, "spectate -1"]) {
        const p = await w.page();
        p.take();
        await w.say(p, bad);
        assert.deepEqual(p.take(), ["error bad-request"], bad);
    }
    const p = await w.page();
    await w.say(p, "spectate 999");
    assert.equal(w.lobby.conn(p).spect || 0, 0, "a room that isn't there is none");
    assert.equal("watching" in await w.game(H.room), false);
});

await check("a host's game turns watching off and on, with how far behind live", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const L = await w.host("Jerec", { password: "sith" });
    const p = await w.page();
    await w.say(p, `spectate ${H.room}`);
    await w.say(H, "spectators off");
    let g = await w.game(H.room);
    assert.equal(g.spect, 0);
    assert.equal("watching" in g, false, "no count for a match that can't be watched");
    await w.say(H, "spectators on 90");
    g = await w.game(H.room);
    assert.deepEqual([g.spect, g.watching], [1, 1], "the page still watching is counted again");
    assert.deepEqual(w.lobby.rooms.get(H.room).spect, { on: true, delay: 90 });
    // A host can make its password game watchable.
    await w.say(L, "spectators on");
    assert.equal((await w.game(L.room)).spect, 1);
    assert.deepEqual(w.lobby.rooms.get(L.room).spect, { on: true, delay: 30 }, "30 s when it doesn't say");
    // Never closer to live than 30 s, nor more than 5 min behind.
    await w.say(L, "spectators on 5");
    assert.equal(w.lobby.rooms.get(L.room).spect.delay, 30);
    await w.say(L, "spectators on 9999");
    assert.equal(w.lobby.rooms.get(L.room).spect.delay, 300);
    for (const bad of ["spectators", "spectators maybe", "spectators on x", "spectators on 1 2", "spectators on 99999"]) {
        H.take();
        await w.say(H, bad);
        assert.deepEqual(H.take(), ["error bad-request"], bad);
    }
});

await check("only the room's host says whether it can be watched", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const joiner = await w.connect();
    await w.say(joiner, `hello jk1 ${b64("Kyle_K")}`);
    await w.say(joiner, `join ${H.room}`);
    await w.say(joiner, "spectators off");
    const loner = await w.connect();
    await w.say(loner, "spectators off");
    assert.equal((await w.game(H.room)).spect, 1);
    assert.equal(w.lobby.rooms.get(H.room).spect, null);
});

await check("what a host said, and who's watching, last through the lobby restarting", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const p = await w.page();
    await w.say(H, "spectators on 90");
    await w.say(p, `spectate ${H.room}`);
    const w2 = await new World(w.env, w.storage).start(w.ctx.sockets);
    const g = await w2.game(H.room);
    assert.deepEqual([g.spect, g.watching], [1, 1]);
    assert.deepEqual(w2.lobby.rooms.get(H.room).spect, { on: true, delay: 90 });
    await w2.say(H, "spectators off");
    const w3 = await new World(w.env, w.storage).start(w.ctx.sockets);
    assert.equal((await w3.game(H.room)).spect, 0);
});

await check("a room that ends takes its host's word with it", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const p = await w.page();
    await w.say(H, "spectators off");
    await w.say(p, `spectate ${H.room}`);
    assert.ok(w.storage.m.has("spect:" + H.room));
    await w.say(H, "leave");
    assert.equal(w.storage.m.has("spect:" + H.room), false);
    const H2 = await w.host("Maw");
    assert.notEqual(H2.room, H.room, "room numbers aren't used again");
    const g = await w.game(H2.room);
    assert.deepEqual([g.spect, "watching" in g], [1, false], "the page watching the old room isn't counted in the new");
    // Its storage is cleaned up after a restart too, for a room gone while
    // the object was away.
    w.storage.m.set("spect:999", { on: false, delay: 30 });
    await new World(w.env, w.storage).start(w.ctx.sockets);
    assert.equal(w.storage.m.has("spect:999"), false);
});

console.log(failed ? `${failed} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
