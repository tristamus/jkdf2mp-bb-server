// Checks a room's people in src/lobby.js: a page watching the lobby says
// when its player has one of the rooms open (look <game> [<name>]), is told
// once the status counts it (looking), and is counted as a player in that
// game, not in a match, by its name when it gave one, until it says look,
// closes or goes quiet. Runs the Lobby itself in Node.js on test/cfstub.mjs.
// Needs Node.js 22 or newer.
//
//   node test/look.mjs
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

const heard = ws => ws.take().filter(l => l.startsWith("status ")).map(statusOf);
const lookingOf = ws => ws.sent.filter(l => l.startsWith("looking"));

await check("the lobby says it takes look on connect", async () => {
    const w = await new World().start();
    const ws = await w.connect();
    assert.match(ws.lobbyLine, /^lobby .*\blook\b/);
    assert.match(ws.lobbyLine, /\blinks\b.*\bpw\b.*\bspect\b/, "and still what it said before");
});

await check("a page in a room is counted in its game, by name, and hears it after the status", async () => {
    const w = await new World().start();
    const other = await w.page();
    const p = await w.page();
    heard(other);
    p.take();
    await w.say(p, `look jk1 ${b64("Rogue Nine")}`);
    const out = p.take();
    const at = out.findIndex(l => l.startsWith("status "));
    assert.ok(at >= 0, "the page hears the new status");
    assert.deepEqual(out.slice(at + 1), [`looking jk1 ${b64("Rogue Nine")}`], "then looking, last");
    const s = statusOf(out[at]);
    assert.equal(s.online, 1);
    assert.deepEqual(s.lobby, ["Rogue Nine"]);
    assert.deepEqual(s.byGame.jk1, { online: 1, lobby: ["Rogue Nine"] });
    assert.deepEqual(s.byGame.mots, { online: 0, lobby: [] });
    assert.deepEqual(heard(other).pop().byGame.jk1.lobby, ["Rogue Nine"], "and so does everyone else, at once");
});

await check("a page in a room without a name is counted, not named", async () => {
    const w = await new World().start();
    const p = await w.page();
    p.take();
    await w.say(p, "look mots");
    const out = p.take();
    assert.deepEqual(out.at(-1), "looking mots");
    const s = statusOf(out.find(l => l.startsWith("status ")));
    assert.deepEqual([s.online, s.lobby, s.byGame.mots], [1, [], { online: 1, lobby: [] }]);
});

await check("players in the lobby and in rooms add up with the pages in a room", async () => {
    const w = await new World().start();
    const H = await w.host("Maw");
    const g = await w.connect();
    await w.say(g, `hello jk1 ${b64("Boc")}`);
    const m = await w.connect();
    await w.say(m, `hello mots ${b64("Dash_R")}`);
    const p = await w.page();
    await w.say(p, `look jk1 ${b64("Kyle")}`);
    const q = await w.page();
    await w.say(q, "look jk1");
    const s = await w.status();
    assert.equal(s.online, 5, "Maw in a room, Boc and Dash_R in the lobby, Kyle and a page without a name");
    assert.deepEqual(s.lobby, ["Boc", "Dash_R", "Kyle"]);
    assert.deepEqual(s.byGame.jk1, { online: 4, lobby: ["Boc", "Kyle"] });
    assert.deepEqual(s.byGame.mots, { online: 1, lobby: ["Dash_R"] });
    assert.deepEqual(s.games.find(x => x.id === H.room).names, ["Maw"], "a page takes no seat");
});

await check("look on its own, another room, closing and a restart", async () => {
    const w = await new World().start();
    const p = await w.page();
    await w.say(p, `look jk1 ${b64("Kyle")}`);
    await w.say(p, `look mots ${b64("Kyle")}`);
    let s = await w.status();
    assert.deepEqual([s.byGame.jk1.online, s.byGame.mots.online, s.byGame.mots.lobby], [0, 1, ["Kyle"]]);
    // The same again changes nothing, so no new status goes out, but it's told again.
    p.take();
    await w.say(p, `look mots ${b64("Kyle")}`);
    assert.deepEqual(p.take(), [`looking mots ${b64("Kyle")}`]);
    await w.say(p, "look");
    assert.equal(lookingOf(p).at(-1), "looking off");
    s = await w.status();
    assert.deepEqual([s.online, s.lobby], [0, []]);
    await w.say(p, `look jk1 ${b64("Kyle")}`);
    // Kept through the lobby restarting (the socket's attachment).
    const w2 = await new World(w.env, w.storage).start(w.ctx.sockets);
    s = await w2.status();
    assert.deepEqual([s.online, s.lobby], [1, ["Kyle"]]);
    await w2.close(p);
    s = await w2.status();
    assert.deepEqual([s.online, s.lobby], [0, []], "a page that closes is gone at once");
});

await check("only a page watching the lobby can say look, and only as it should", async () => {
    const w = await new World().start();
    const ws = await w.connect();
    await w.say(ws, "look jk1");
    assert.deepEqual(ws.take(), ["error bad-request"], "a game isn't a page");
    for (const bad of ["look jk2", "look x", `look jk1 ${b64("a")} more`, "look jk1 !!!", `look ${b64("Kyle")}`]) {
        const p = await w.page();
        p.take();
        await w.say(p, bad);
        assert.deepEqual(p.take(), ["error bad-request"], bad);
    }
    assert.equal((await w.status()).online, 0);
});

await check("a name is cleaned as hello's is, and the page hears it as taken", async () => {
    const w = await new World().start();
    const p = await w.page();
    p.take();
    await w.say(p, `look jk1 ${b64("  A_very_long_player_name_here  ")}`);
    const said = lookingOf(p).at(-1);
    const taken = Buffer.from(said.split(" ")[2], "base64").toString();
    assert.ok(taken.length <= 15, taken);
    assert.deepEqual((await w.status()).lobby, [taken]);
});

await check("a quiet page is let go, as any connection", async () => {
    const w = await new World().start();
    const p = await w.page();
    await w.say(p, `look jk1 ${b64("Kyle")}`);
    const since = w.lobby.conn(p).since;
    w.lobby.heard.set(p, since);
    const realNow = Date.now;
    try {
        Date.now = () => since + 3 * 60 * 1000;
        w.lobby.sweep();
    } finally {
        Date.now = realNow;
    }
    assert.equal(w.lobby.conns.has(p), false);
    const s = await w.status();
    assert.deepEqual([s.online, s.lobby], [0, []]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
