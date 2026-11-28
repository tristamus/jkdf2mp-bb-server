// Checks the room chat (src/chat.js): who may say what, how often, the web
// addresses it turns down however they're written, what's kept and for how
// long, Enter and Exit, reports and the moderators' tools. Runs the Lobby
// itself in Node.js on test/cfstub.mjs. Needs Node.js 22 or newer.
//
//   node test/chat.mjs
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
const chat = await import("../src/chat.js");
const { linkish, chatText, KEEP_LINES, KEEP_MS, BURST, REFILL_MS, SAME_MS, SLOW_MS, COOL_MS, FLOOD_REFUSED } = chat;

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

const b64 = text => Buffer.from(text, "utf8").toString("base64");
const unb64 = text => JSON.parse(Buffer.from(text, "base64").toString("utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = "0123456789abcdef0123456789abcdef";
let bids = 0;
const bid = () => (++bids).toString(16).padStart(32, "a");

// The clock, moved by hand (Date.now) for what takes minutes or days.
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const later = ms => { shift += ms; };

class World {
    constructor(env = {}, storage = new FakeStorage()) {
        this.env = { SITE: "", MOVED_FROM: "", CHAT: "1", CHAT_MOD_KEY: KEY, CHAT_EXIT_WAIT_MS: "20", ...env };
        this.storage = storage;
    }
    async start(sockets = []) {
        this.ctx = new FakeCtx(this.storage, sockets);
        this.lobby = new Lobby(this.ctx, this.env);
        await this.ctx.ready;
        return this;
    }
    // A page watching the lobby, from an address.
    async page(ip = "203.0.113.7") {
        await this.lobby.fetch(new Request("https://lobby.test/relay?net=0&pw=1", { headers: { "CF-Connecting-IP": ip } }));
        const ws = this.ctx.sockets.at(-1);
        ws.lobbyLine = ws.take().find(l => l.startsWith("lobby ")) || "";
        await this.say(ws, "watch");
        ws.take();
        ws.bid = bid();
        return ws;
    }
    say(ws, line) {
        return this.lobby.webSocketMessage(ws, line);
    }
    async close(ws) {
        ws.close(1000, "bye");
        await this.lobby.webSocketClose(ws, 1000, "bye", true);
    }
    // A page in a room's chat, by a name.
    async in(name, { room = "nar-shaddaa", ip, page } = {}) {
        const ws = page || await this.page(ip);
        await this.say(ws, `chat in ${room} ${ws.bid}` + (name ? " " + b64(name) : ""));
        return ws;
    }
    async talk(ws, text) {
        await this.say(ws, "chat say " + b64(text));
        return ws.take();
    }
}

// The chat lines in what a page was sent: [op, value].
function chatOf(lines) {
    return lines.filter(l => l.startsWith("chat ")).map(l => {
        const [, op, arg, n] = l.split(" ");
        if (["log", "line", "state", "who", "you", "mods"].includes(op))
            return [op, unb64(arg)];
        return [op, arg, n].filter(x => x !== undefined);
    });
}
const said = lines => chatOf(lines).filter(([op, v]) => op === "line" && !v.kind).map(([, v]) => `${v.name}> ${v.text}`);
const refused = lines => chatOf(lines).filter(([op]) => op === "no").map(([, why]) => why);

await check("the lobby says chat on connect only where CHAT is 1", async () => {
    let w = await new World().start();
    assert.match((await w.page()).lobbyLine, /^lobby .*\blook chat$/);
    w = await new World({ CHAT: "" }).start();
    const p = await w.page();
    assert.doesNotMatch(p.lobbyLine, /\bchat\b/);
    await w.say(p, `chat in nar-shaddaa ${p.bid} ${b64("Kyle")}`);
    assert.deepEqual(p.take().filter(l => l.startsWith("chat")), [], "and takes none of it");
});

await check("web addresses are turned down however they're written", () => {
    const yes = [
        "go to http://example.org", "HTTPS://EXAMPLE.ORG", "hxxp://bad.site", "h t t p s : / / x", "see www.example",
        "w w w . site", "example.com", "Example.Com/path", "example . com", "example .com", "example dot com",
        "example DOT net", "example(dot)com", "example [dot] org", "example{.}gg", "e x a m p l e . c o m",
        "e x a m p l e dot c o m", "ex​ample.com", "example．com", "ｅｘａｍｐｌｅ.com",
        "exampлe.cоm", "google.c0m", "join discord.gg/abc", "discord gg/abc", "bit ly/xyz", "youtu be/abc",
        "mail me at someone@mail.example", "server 162.248.94.121:27960", "my site is example. com", "example. com/abc",
        "jediknight.zone", "beta.jediknight.zone/levels", "пример.рф",
        "mod.zip", "site。com", "dsc.gg/x", "example․com", "nice.example.co.uk",
    ];
    const no = [
        "gg everyone, that last round was close", "anyone up for CTF later tonight?", "hosting no mods on Boss 17 at 9",
        "e.g. the Canyon Oasis one", "i.e. no mods", "3.5 seconds", "version 1.0.2 is out", "gg. next map?",
        "ok... me too", "Thanks. Me too", "Vamos. Com certeza", "fiz um ponto com o sabre", "lol.", "wait...what",
        "jk_ctf.zip from the library", "m10.jkl is a good one", "teams of 1, 2, 3, 4", "a b c", "gold 6, red 4",
        "at this point net code is fine", "who's in? me/you/Kyle", "Good game. Net was laggy though",
        "alguém é brasileiro ae?", "DSbr_Stnuc> JEB HACKS", "no dot here", "1.2.3", "Dark Forces 2.0",
    ];
    for (const t of yes)
        assert.equal(linkish(t), true, "turned down: " + JSON.stringify(t));
    for (const t of no)
        assert.equal(linkish(t), false, "goes through: " + JSON.stringify(t));
});

await check("lines are at most two, with no invisible characters or piled-up accents", () => {
    assert.equal(chatText("  one\n\ntwo\nthree \r\n four "), "one\ntwo three four");
    assert.equal(chatText("a‮b​c   d"), "abc d");
    assert.equal(chatText("Z\u0301\u0302\u0303\u0304\u0305o").normalize("NFD"), "Z\u0301\u0302o");
    assert.equal(chatText("\n \t\n"), "");
});

await check("a page comes in, hears the room's lines and who's there, and everyone hears it talk", async () => {
    const w = await new World().start();
    const a = await w.in("Kyle_K");
    const log = chatOf(a.take()).find(([op]) => op === "log")[1];
    assert.deepEqual([log.room, log.lines, log.slow, log.paused, log.you], ["nar-shaddaa", [], false, false, { name: "Kyle_K", muted: 0, mod: 0 }]);
    const b = await w.in("MaraJade");
    const ina = chatOf(a.take());
    assert.ok(ina.some(([op, v]) => op === "line" && v.kind === "enter" && v.name === "MaraJade"), "(Enter)> MaraJade");
    assert.deepEqual(ina.filter(([op]) => op === "who").pop()[1], { names: ["Kyle_K", "MaraJade"], n: 2 });
    b.take();
    assert.deepEqual(await w.talk(b, "hi all").then(said), ["MaraJade> hi all"]);
    assert.deepEqual(said(a.take()), ["MaraJade> hi all"]);
    const other = await w.in("Corran_H", { room: "sith-asteroid" });
    other.take();
    await w.talk(a, "only here");
    assert.deepEqual(said(other.take()), [], "another room hears nothing");
    const c = await w.in("Late");
    const log2 = chatOf(c.take()).find(([op]) => op === "log")[1];
    assert.deepEqual(log2.lines.map(l => `${l.name}> ${l.text}`), ["MaraJade> hi all", "Kyle_K> only here"]);
    assert.ok(log2.lines.every(l => !("b" in l) && !("h" in l)), "never who sent it beyond the name");
});

await check("a name is needed, and one someone else in the room has can't be taken", async () => {
    const w = await new World().start();
    const a = await w.in("");
    assert.deepEqual(refused(await w.talk(a, "hello")), ["name"]);
    const k = await w.in("Kyle_K");
    k.take();
    const b = await w.in("kyle_k");
    const out = chatOf(b.take());
    assert.ok(out.some(([op, why]) => op === "no" && why === "taken"));
    assert.equal(out.find(([op]) => op === "log")[1].you.name, "", "in without one");
    assert.deepEqual(refused(await w.talk(b, "it's me")), ["name"]);
    // The same browser in another tab may.
    const t = await w.page();
    t.bid = k.bid;
    await w.in("Kyle_K", { page: t });
    assert.ok(!refused(t.take()).includes("taken"));
});

await check("no web addresses, at most 400 characters", async () => {
    const w = await new World().start();
    const a = await w.in("Kyle_K");
    const b = await w.in("MaraJade");
    a.take(); b.take();
    assert.deepEqual(refused(await w.talk(a, "it is on levelsite dot com")), ["link"]);
    assert.deepEqual(said(b.take()), [], "nobody else sees it");
    assert.deepEqual(refused(await w.talk(a, "x".repeat(401))), ["long"]);
    const ok = await w.talk(a, "y".repeat(400));
    assert.ok(chatOf(ok).some(([op]) => op === "ok"));
});

await check("four lines at once, then one every 3 s; the same line not twice in a minute", async () => {
    const w = await new World().start();
    const a = await w.in("Kyle_K");
    a.take();
    for (let i = 0; i < BURST; i++)
        assert.deepEqual(refused(await w.talk(a, "line " + i)), []);
    const out = chatOf(await w.talk(a, "one more"));
    assert.deepEqual(out.filter(([op]) => op === "no"), [["no", "fast", "3"]]);
    later(REFILL_MS);
    assert.deepEqual(refused(await w.talk(a, "one more")), []);
    later(REFILL_MS);
    assert.deepEqual(refused(await w.talk(a, "One  more")), ["same"]);
    later(SAME_MS);
    assert.deepEqual(refused(await w.talk(a, "one more")), []);
});

await check("limits count by address: another tab or browser there gets no more", async () => {
    const w = await new World().start();
    const a = await w.in("Kyle_K", { ip: "198.51.100.4" });
    const b = await w.in("Kyle_2", { ip: "198.51.100.4" });
    const c = await w.in("Other", { ip: "198.51.100.99" });
    for (let i = 0; i < BURST; i++)
        await w.talk(i % 2 ? a : b, "spam " + i);
    assert.deepEqual(refused(await w.talk(b, "more")), ["fast"]);
    assert.deepEqual(refused(await w.talk(c, "not me")), [], "another address isn't held up");
});

await check("someone who keeps pushing is held back 2 minutes, then 10", async () => {
    const w = await new World().start();
    const a = await w.in("Spammer", { ip: "198.51.100.5" });
    for (let i = 0; i < BURST; i++)
        await w.talk(a, "s" + i);
    let out;
    for (let i = 0; i < FLOOD_REFUSED; i++)
        out = chatOf(await w.talk(a, "x" + i));
    assert.deepEqual(out.at(-1), ["no", "fast", String(COOL_MS[0] / 1000)]);
    later(COOL_MS[0] + 20 * REFILL_MS);
    assert.deepEqual(refused(await w.talk(a, "back")), []);
    for (let i = 0; i < BURST + FLOOD_REFUSED; i++)
        out = chatOf(await w.talk(a, "y" + i));
    assert.deepEqual(out.at(-1), ["no", "fast", String(COOL_MS[1] / 1000)]);
});

await check("kept: the last 100 lines a room, none older than 48 hours, through a restart", async () => {
    const w = await new World().start();
    const a = await w.in("Kyle_K");
    for (let i = 0; i < KEEP_LINES + 5; i++) {
        later(REFILL_MS);
        await w.talk(a, "n" + i);
    }
    const w2 = await new World(w.env, w.storage).start();
    let p = await w2.in("Reader");
    let lines = chatOf(p.take()).find(([op]) => op === "log")[1].lines;
    assert.equal(lines.length, KEEP_LINES);
    assert.equal(lines[0].text, "n5");
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("chatl:")).length, KEEP_LINES, "and only those in storage");
    later(KEEP_MS);
    await w2.lobby.alarm();
    p = await w2.in("Reader2");
    lines = chatOf(p.take()).find(([op]) => op === "log")[1].lines;
    assert.deepEqual(lines, []);
    assert.equal([...w.storage.m.keys()].filter(k => k.startsWith("chatl:")).length, 0);
});

await check("Exit waits, a page reloading shows neither, Enter and Exit at most every 2 minutes", async () => {
    const w = await new World().start();
    const watcher = await w.in("Watcher");
    watcher.take();
    const a = await w.in("Kyle_K");
    const kinds = () => chatOf(watcher.take()).filter(([op, v]) => op === "line" && v.kind).map(([, v]) => v.kind + " " + v.name);
    assert.deepEqual(kinds(), ["enter Kyle_K"]);
    await w.close(a);
    const again = await w.page();
    again.bid = a.bid;
    await w.in("Kyle_K", { page: again });
    await sleep(40);
    assert.deepEqual(kinds(), [], "a reload: nothing");
    await w.say(again, "chat out");
    await sleep(40);
    assert.deepEqual(kinds(), ["exit Kyle_K"]);
    await w.in("Kyle_K", { page: again });
    assert.deepEqual(kinds(), [], "Enter showed under 2 minutes ago");
    later(2 * 60 * 1000);
    await w.say(again, "chat out");
    await sleep(40);
    await w.in("Kyle_K", { page: again });
    assert.deepEqual(kinds(), ["exit Kyle_K", "enter Kyle_K"]);
});

await check("a moderator's key: a wrong one is turned down, a few at most", async () => {
    const w = await new World().start();
    const a = await w.in("Guesser", { ip: "198.51.100.8" });
    a.take();
    await w.say(a, "chat mod " + b64("nope"));
    assert.deepEqual(chatOf(a.take()), [["no", "mod"]]);
    for (let i = 0; i < 6; i++)
        await w.say(a, "chat mod " + b64("nope" + i));
    a.take();
    await w.say(a, "chat mod " + b64(KEY));
    assert.deepEqual(chatOf(a.take()), [["no", "mod"]], "even the right one, after too many wrong");
    const b = await w.in("Rogue_Nine", { ip: "198.51.100.9" });
    b.take();
    await w.say(b, "chat mod " + b64(KEY));
    const out = chatOf(b.take());
    assert.deepEqual(out[0], ["you", { name: "Rogue_Nine", muted: 0, mod: 1 }]);
    assert.deepEqual(out[1], ["mods", { mutes: [], reports: [] }]);
    // Its lines carry the tag, and it isn't held to the limits.
    for (let i = 0; i < BURST + 3; i++)
        assert.deepEqual(refused(await w.talk(b, "mod " + i)), []);
    const p = await w.in("Reader");
    assert.equal(chatOf(p.take()).find(([op]) => op === "log")[1].lines.at(-1).mod, 1);
    assert.deepEqual(refused(await w.talk(b, "see example.com")), ["link"], "no links from anyone");
});

async function modWorld() {
    const w = await new World().start();
    const mod = await w.in("Rogue_Nine", { ip: "198.51.100.10" });
    await w.say(mod, "chat mod " + b64(KEY));
    mod.take();
    return { w, mod };
}

await check("muting a line's sender: the name, the browser and the address, in every room, till it runs out", async () => {
    const { w, mod } = await modWorld();
    const bad = await w.in("DarkJedi_7", { ip: "198.51.100.11" });
    await w.talk(bad, "red team is trash lol");
    const id = chatOf(mod.take()).find(([op, v]) => op === "line" && !v.kind && v.name === "DarkJedi_7")[1].id;
    const notMod = await w.in("Nomad_42", { ip: "198.51.100.12" });
    await w.say(notMod, `chat mute 3600 ${id}`);
    assert.equal(refused(await w.talk(bad, "still here")).length, 0, "only a moderator mutes");
    await w.say(mod, `chat mute 3600 ${id}`);
    const lines = chatOf(mod.take());
    assert.ok(lines.some(([op, v]) => op === "line" && v.kind === "note" && v.text === "DarkJedi_7 was muted for 1 hour by a moderator."));
    const mods = lines.filter(([op]) => op === "mods").pop()[1];
    assert.deepEqual(mods.mutes.map(m => [m.name, m.by]), [["DarkJedi_7", "mod"]]);
    const you = chatOf(bad.take()).filter(([op]) => op === "you").pop()[1];
    assert.ok(you.muted > Date.now(), "told until when");
    assert.equal(refused(await w.talk(bad, "hello?"))[0], "muted");
    // Another name from the same address, or the same name elsewhere.
    const alt = await w.in("NewName", { ip: "198.51.100.11" });
    assert.equal(refused(await w.talk(alt, "it's not me"))[0], "muted");
    const elsewhere = await w.in("DarkJedi_7", { ip: "198.51.100.77", room: "sith-asteroid" });
    assert.equal(refused(await w.talk(elsewhere, "hi"))[0], "muted");
    later(3600 * 1000);
    await w.lobby.alarm();
    later(REFILL_MS);
    assert.deepEqual(refused(await w.talk(bad, "back")), []);
});

await check("unmute, delete a line, clear the room, slow mode and pause", async () => {
    const { w, mod } = await modWorld();
    const a = await w.in("Kyle_K", { ip: "198.51.100.20" });
    await w.talk(a, "first");
    await w.talk(a, "second");
    const ids = chatOf(mod.take()).filter(([op, v]) => op === "line" && !v.kind).map(([, v]) => v.id);
    await w.say(mod, `chat mute 86400 n${b64("Kyle_K")}`);
    const muteId = chatOf(mod.take()).filter(([op]) => op === "mods").pop()[1].mutes[0].id;
    assert.equal(refused(await w.talk(a, "x"))[0], "muted");
    await w.say(mod, `chat unmute ${muteId}`);
    later(REFILL_MS * 3);
    assert.deepEqual(refused(await w.talk(a, "x")), []);
    a.take();
    await w.say(mod, `chat del ${ids[0]}`);
    assert.deepEqual(chatOf(a.take()), [["del", String(ids[0])]]);
    let p = await w.in("Reader");
    assert.deepEqual(chatOf(p.take()).find(([op]) => op === "log")[1].lines.filter(l => !l.kind).map(l => l.text), ["second", "x"]);
    await w.say(mod, "chat slow on");
    const st = chatOf(a.take());
    assert.deepEqual(st.find(([op]) => op === "state")[1], { slow: true, paused: false });
    later(SLOW_MS);
    assert.deepEqual(refused(await w.talk(a, "slow 1")), []);
    assert.deepEqual(refused(await w.talk(a, "slow 2")), ["fast"]);
    later(SLOW_MS);
    assert.deepEqual(refused(await w.talk(a, "slow 3")), []);
    await w.say(mod, "chat pause on");
    later(SLOW_MS);
    assert.deepEqual(refused(await w.talk(a, "paused?")), ["paused"]);
    assert.deepEqual(refused(await w.talk(mod, "only me")), []);
    await w.say(mod, "chat clear");
    p = await w.in("Reader2");
    const lines = chatOf(p.take()).find(([op]) => op === "log")[1].lines;
    assert.deepEqual(lines.map(l => l.text), ["A moderator cleared the chat."]);
    // Kept through a restart.
    const w2 = await new World(w.env, w.storage).start();
    const q = await w2.in("Reader3");
    const log = chatOf(q.take()).find(([op]) => op === "log")[1];
    assert.deepEqual([log.slow, log.paused], [true, true]);
});

await check("reports: once each, to the moderators; three people in 15 minutes mute for an hour", async () => {
    const { w, mod } = await modWorld();
    const bad = await w.in("DarkJedi_7", { ip: "198.51.100.30" });
    const id = chatOf(await w.talk(bad, "red team is trash lol")).find(([op, v]) => op === "line" && !v.kind)[1].id;
    const r = [];
    for (let i = 0; i < 3; i++)
        r.push(await w.in("Player" + i, { ip: "198.51.100." + (40 + i) }));
    await w.say(bad, `chat report ${id}`);
    mod.take();
    assert.deepEqual(chatOf(bad.take()).filter(([op]) => op === "reported"), [], "not your own");
    await w.say(r[0], `chat report ${id}`);
    await w.say(r[0], `chat report ${id}`);
    assert.deepEqual(chatOf(r[0].take()).filter(([op]) => op === "reported").length, 2);
    let mods = chatOf(mod.take()).filter(([op]) => op === "mods").pop()[1];
    assert.equal(mods.reports.length, 1, "once per address");
    assert.deepEqual([mods.reports[0].name, mods.reports[0].text, mods.reports[0].by], ["DarkJedi_7", "red team is trash lol", "Player0"]);
    await w.say(r[1], `chat report ${id}`);
    assert.equal(refused(await w.talk(bad, "still talking")).length, 0, "two aren't enough");
    await w.say(r[2], `chat report ${id}`);
    const out = chatOf(mod.take());
    assert.ok(out.some(([op, v]) => op === "line" && v.text === "DarkJedi_7 was muted for 1 hour after reports from players."));
    mods = out.filter(([op]) => op === "mods").pop()[1];
    assert.deepEqual(mods.mutes.map(m => [m.name, m.by]), [["DarkJedi_7", "reports"]]);
    assert.equal(refused(await w.talk(bad, "hey"))[0], "muted");
    // A moderator's Mute 24 h from the report, and Dismiss.
    await w.say(mod, `chat mute 86400 r${mods.reports[0].id}`);
    await w.say(mod, `chat dismiss ${mods.reports[0].id}`);
    mods = chatOf(mod.take()).filter(([op]) => op === "mods").pop()[1];
    assert.equal(mods.reports.length, 2);
    assert.equal(mods.mutes.length, 2);
});

await check("only a page watching the lobby, with a proper room and browser id", async () => {
    const w = await new World().start();
    await w.lobby.fetch(new Request("https://lobby.test/relay?net=0"));
    const game = w.ctx.sockets.at(-1);
    game.take();
    await w.say(game, `chat in nar-shaddaa ${bid()} ${b64("Game")}`);
    assert.deepEqual(game.take(), ["error bad-request"]);
    const p = await w.page();
    await w.say(p, `chat in the-cantina ${p.bid}`);
    await w.say(p, `chat in nar-shaddaa nothex`);
    assert.deepEqual(chatOf(p.take()), [["no", "room"], ["no", "room"]]);
    await w.say(p, "chat say " + b64("not in a room"));
    assert.deepEqual(p.take(), []);
});

Date.now = realNow;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
