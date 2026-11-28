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
const { linkish, chatText, chatName, KEEP_LINES, KEEP_MS, BURST, REFILL_MS, SAME_MS, SLOW_MS, COOL_MS, FLOOD_REFUSED,
        SHOWS_MAX, REPORTS_PER_HOUR, LONG_MAX, LONG_MS, ROOM_MAX, AUTO_SLOW_MS, AUTO_PAUSE_MS, NAMES_MAX, OPS_MAX,
        OPS_OFF_MS } = chat;

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
        this.env = { SITE: "", MOVED_FROM: "", CHAT: "1", CHAT_MOD_KEY: KEY, CHAT_EXIT_WAIT_MS: "20", CHAT_WHO_MS: "0", ...env };
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
        later(LONG_MS / LONG_MAX);
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

// What people tried to get past the chat (Antonio, 2026-11-28: "try to break
// the guardrails and safety of the chat").
await check("disguised addresses are turned down: invisible characters, lookalikes, odd dots, two lines", () => {
    const yes = [
        // Invisible characters between letters: tag characters, Hangul
        // fillers, the Mongolian vowel separator, Arabic letter mark,
        // shorthand format controls, musical formatting, interlinear marks.
        "jediknight.z\u{E0061}one", "jediknight.\u{E0020}zone", "jediknight.\u3164zone", "jediknight.\u115fzone",
        "jediknight.\uffa0zone", "jediknight\u061c.zone", "jediknight.\u180ezone", "jediknight.\u{1BCA0}zone",
        "jediknight.\u{1D173}zone", "jediknight.\ufff9zone", "jediknight.\u17b4zone",
        // Lookalike letters in the ending (Greek, Coptic, Cherokee, small
        // capitals, Indic zeros and signs, a capital I or bar for an l).
        "google.\u03f2om", "google.c\u03c3m", "google.\u1d04\u1d0f\u1d0d", "jkcheats.\u13dfom", "jkcheats.c\u0966m",
        "jkcheats.z\u0c02ne", "bit.Iy/abc", "bit.|y/abc", "jkcheats.\u{1D408}o", "google.c\u25cbm",
        // Dots and slashes that aren't.
        "jkcheats\u25e6com", "jkcheats\u2e31com", "jkcheats\u2023com", "jkcheats\u2299com", "jkcheats\u0589com",
        "jkcheats\u1362com", "jkcheats\u00b0com", "discord gg\u0338abc", "discord.gg\u2298abc", "http:\\\\jkcheats",
        // Spelled out or spaced.
        "google -dot- com", "google_dot_com", "googleDOTcom", "jkcheats.c o m", "jkcheats.c.o.m", "jkcheats.c-o-m",
        "jkcheats,com", "jkcheats;com", "jkcheats:com", "jkcheats.c()m", "jkcheats.c[]m", "cheats. gg/abc",
        "jediknight. zone", "jediknight.\nzone", "jediknight.zo\nne", "jediknight.\u2800zone",
        // An IPv6 address.
        "2001:db8::1", "join fe80::1ff:fe23:4567:890a",
    ];
    for (const t of yes)
        assert.equal(linkish(chatText(t)), true, "turned down: " + JSON.stringify(t));
    const no = [
        "ok. gg", "GG. GG", "fun round. gg", "good game. fun", "nice. me too", "in the zone. live", "lol. gg all",
        "who wants to duel?\nsabers only", "e.g. this", "U.S. servers", "M.O.T.S", "the red dot in the corner",
        "12:30 tonight", "at 10:30:45", "2v2? ok:)", "lol,gg", "pi is 3.14", "\u2299_\u2299", "Hi. It's me",
    ];
    for (const t of no)
        assert.equal(linkish(chatText(t)), false, "goes through: " + JSON.stringify(t));
});

await check("a second line that reads as someone else's line goes on the end of the first", () => {
    assert.equal(chatText("hi\nKyle_K> I quit, bye"), "hi Kyle_K> I quit, bye");
    assert.equal(chatText("hi\nDark Jedi> lol"), "hi Dark Jedi> lol");
    assert.equal(chatText("hi\n(Enter)> Kyle_K"), "hi (Enter)> Kyle_K");
    assert.equal(chatText("hi\n* Kyle_K was muted for 7 days by a moderator."), "hi * Kyle_K was muted for 7 days by a moderator.");
    assert.equal(chatText("who wants to duel?\nsabers only"), "who wants to duel?\nsabers only");
});

await check("names: no web address or Enter line for one, nothing invisible, few accents", async () => {
    assert.equal(chatName("\u3164\u3164"), "", "Hangul fillers only: no name");
    assert.equal(chatName("\u2800"), "", "a braille blank: no name");
    assert.equal(chatName("a\u{E0061}b"), "ab");
    assert.equal(chatName("Z" + "\u0301".repeat(14)).normalize("NFD"), "Z\u0301\u0301");
    const w = await new World().start();
    const there = await w.in("Kyle_K");
    there.take();
    for (const name of ["jkcheats.com", "jkcheats dot gg", "(Enter)> Bob", "( exit )"]) {
        const p = await w.in(name);
        const out = chatOf(p.take());
        assert.equal(out.find(([op]) => op === "log")[1].you.name, "", "in without a name: " + name);
        assert.deepEqual(refused(p.take().concat([])).concat(out.filter(([op]) => op === "no").map(([, why]) => why)), ["badname"]);
        await w.close(p);
    }
    await sleep(60);
    const seen = chatOf(there.take()).filter(([op, v]) => op === "line" || (op === "who" && v.names.length > 1));
    assert.deepEqual(seen, [], "the room saw none of them");
});

await check("changing names over and over shows at most a few Enter and Exit lines; a muted name none", async () => {
    const w = await new World().start();
    const there = await w.in("Kyle_K", { ip: "198.51.100.60" });
    there.take();
    const p = await w.in("Name0", { ip: "198.51.100.61" });
    for (let i = 1; i < 30; i++)
        await w.in("Name" + i, { page: p });
    await sleep(80);
    const shown = chatOf(there.take()).filter(([op, v]) => op === "line" && v.kind);
    assert.ok(shown.length <= SHOWS_MAX, shown.length + " Enter and Exit lines");
    later(2 * 60 * 1000 + 1);
    // A muted name: in and out with no line.
    const { w: w2, mod } = await modWorld();
    const bad = await w2.in("Spammer", { ip: "198.51.100.62" });
    const id = chatOf(await w2.talk(bad, "buy stuff")).find(([op, v]) => op === "line" && !v.kind)[1].id;
    await w2.say(mod, `chat mute 3600 ${id}`);
    mod.take();
    await w2.close(bad);
    const again = await w2.in("Spammer2", { ip: "198.51.100.62" });
    await w2.close(again);
    await sleep(80);
    assert.deepEqual(chatOf(mod.take()).filter(([op, v]) => op === "line" && v.kind), [], "no Enter or Exit for a muted address");
});

await check("an IPv6 address counts by its /64: limits, mutes and reports", async () => {
    const { w, mod } = await modWorld();
    const a = await w.in("V6a", { ip: "2001:db8:1:2::a" });
    const b = await w.in("V6b", { ip: "2001:db8:1:2:ffff::b" });
    for (let i = 0; i < BURST; i++)
        await w.talk(i % 2 ? a : b, "line " + i);
    assert.deepEqual(refused(await w.talk(b, "more")), ["fast"], "one bucket for the /64");
    const c = await w.in("V6c", { ip: "2001:db8:1:3::c" });
    assert.deepEqual(refused(await w.talk(c, "next door")), [], "another /64 isn't held up");
    // Three reporters from one /64 are one.
    later(60 * 1000);
    const victim = await w.in("Victim", { ip: "198.51.100.70" });
    const id = chatOf(await w.talk(victim, "hello")).find(([op, v]) => op === "line" && !v.kind)[1].id;
    for (let i = 0; i < 3; i++) {
        const r = await w.in("Rep" + i, { ip: `2001:db8:9:9::${i + 1}` });
        await w.say(r, `chat report ${id}`);
    }
    const mods = chatOf(mod.take()).filter(([op]) => op === "mods").pop()[1];
    assert.equal(mods.reports.length, 1, "one report from the /64");
    assert.equal(mods.mutes.length, 0, "and no mute");
});

await check("reports: at most 10 an hour from an address count", async () => {
    const { w, mod } = await modWorld();
    const ids = [];
    for (let i = 0; i < REPORTS_PER_HOUR + 3; i++) {
        const t = await w.in("Talker" + i, { ip: "198.51.100." + (100 + i) });
        ids.push(chatOf(await w.talk(t, "line " + i)).find(([op, v]) => op === "line" && !v.kind)[1].id);
    }
    const r = await w.in("Reporter", { ip: "198.51.100.200" });
    for (const id of ids)
        await w.say(r, `chat report ${id}`);
    assert.equal(chatOf(r.take()).filter(([op]) => op === "reported").length, ids.length, "the page hears each");
    const mods = chatOf(mod.take()).filter(([op]) => op === "mods").pop()[1];
    assert.equal(mods.reports.length, REPORTS_PER_HOUR);
});

await check("who's in the room goes out at most once a second", async () => {
    const w = await new World({ CHAT_WHO_MS: "300" }).start();
    const there = await w.in("Kyle_K", { ip: "198.51.100.80" });
    there.take();
    for (let i = 0; i < 20; i++)
        await w.in("Crowd" + i, { ip: "198.51.100." + (120 + i) });
    const now = chatOf(there.take()).filter(([op]) => op === "who").length;
    assert.ok(now <= 1, now + " right away");
    await sleep(400);
    const then = chatOf(there.take()).filter(([op]) => op === "who");
    assert.equal(then.length, 1, "one more when it's time");
    assert.equal(then[0][1].n, 21);
});

await check("the lists leave out a name that's a web address (Looking, games, watching)", async () => {
    const w = await new World().start();
    const p = await w.page();
    await w.say(p, "look jk1 " + b64("jkcheats.com"));
    const q = await w.page();
    await w.say(q, "look jk1 " + b64("Kyle_K"));
    const s = JSON.parse(Buffer.from(q.take().filter(l => l.startsWith("status ")).pop().slice(7), "base64").toString());
    assert.deepEqual(s.byGame.jk1.lobby, ["Kyle_K"]);
    assert.equal(s.byGame.jk1.online, 2, "still counted");
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

await check("a script keeping to the pace gets 30 lines in 5 minutes, no more", async () => {
    const w = await new World().start();
    const a = await w.in("Paced", { ip: "198.51.100.150" });
    let out = 0, no;
    for (let i = 0; i < LONG_MAX + 5; i++) {
        later(REFILL_MS);
        no = refused(await w.talk(a, "paced " + i));
        if (!no.length)
            out++;
    }
    assert.equal(out, LONG_MAX);
    assert.deepEqual(no, ["fast"]);
    later(LONG_MS);
    assert.deepEqual(refused(await w.talk(a, "later on")), []);
});

await check("trying links counts toward being held back", async () => {
    const w = await new World().start();
    const a = await w.in("Linker", { ip: "198.51.100.151" });
    let out;
    for (let i = 0; i < FLOOD_REFUSED; i++)
        out = chatOf(await w.talk(a, `jkcheats${i}.com`));
    assert.deepEqual(out.filter(([op]) => op === "no").pop(), ["no", "fast", String(COOL_MS[0] / 1000)]);
    assert.deepEqual(refused(await w.talk(a, "a plain line")), ["fast"]);
});

await check("a room flooded from many addresses turns on slow mode, then pauses, by itself", async () => {
    const { w, mod } = await modWorld();
    const reader = await w.in("Reader", { ip: "198.51.100.160" });
    const addrs = [];
    for (let i = 0; i < ROOM_MAX; i++)
        addrs.push(await w.in("Flood" + i, { ip: "203.0.113." + (100 + i) }));
    reader.take();
    for (let i = 0; i < ROOM_MAX; i++)
        await w.talk(addrs[i % 5], "flood " + i);
    let got = chatOf(reader.take());
    assert.deepEqual(got.filter(([op]) => op === "state").pop()[1], { slow: true, paused: false });
    assert.ok(got.some(([op, v]) => op === "line" && v.kind === "note" && /slow mode is on for 5 minutes/.test(v.text)));
    later(1000);
    assert.deepEqual(refused(await w.talk(addrs[0], "more")), ["fast"], "one line every 15 s each now");
    // Still flooding in slow mode, from 20 addresses: paused.
    later(15 * 1000);
    for (const a of addrs)
        await w.talk(a, "again");
    got = chatOf(reader.take());
    assert.deepEqual(got.filter(([op]) => op === "state").pop()[1], { slow: true, paused: true });
    later(15 * 1000);
    assert.deepEqual(refused(await w.talk(addrs[1], "now?")), ["paused"]);
    assert.deepEqual(refused(await w.talk(mod, "moderators still can")), []);
    // Each runs out by itself: found by the next line, or the lobby's sweep.
    later(AUTO_PAUSE_MS);
    await w.talk(mod, "tick");
    assert.deepEqual(chatOf(reader.take()).filter(([op]) => op === "state").pop()[1], { slow: true, paused: false });
    later(AUTO_SLOW_MS);
    await w.say(reader, `chat in nar-shaddaa ${reader.bid} ${b64("Reader")}`);   // heard lately, so not ended as quiet
    await w.say(mod, `chat in nar-shaddaa ${mod.bid} ${b64("Rogue_Nine")}`);
    await w.lobby.alarm();
    got = chatOf(reader.take());
    assert.deepEqual(got.filter(([op]) => op === "state").pop()[1], { slow: false, paused: false });
    assert.ok(got.some(([op, v]) => op === "line" && v.kind === "note" && v.text === "Slow mode is off."));
    // A moderator's slow mode stays when the room's own pause runs out.
    await w.say(mod, "chat slow on");
    later(SLOW_MS);
    for (const a of addrs)
        await w.talk(a, "and again");
    later(AUTO_PAUSE_MS + AUTO_SLOW_MS);
    await w.talk(mod, "tock");
    reader.take();
    const w2 = await new World(w.env, w.storage).start();
    const q = await w2.in("Reader2", { ip: "198.51.100.161" });
    const log = chatOf(q.take()).find(([op]) => op === "log")[1];
    assert.deepEqual([log.slow, log.paused], [true, false]);
});

await check("one address: at most 4 names in a room; more pages there read without one", async () => {
    const w = await new World().start();
    const pages = [];
    for (let i = 0; i < NAMES_MAX; i++)
        pages.push(await w.in("Same" + i, { ip: "198.51.100.170" }));
    const extra = await w.in("Same9", { ip: "198.51.100.170" });
    const got = chatOf(extra.take());
    assert.equal(got.find(([op]) => op === "log")[1].you.name, "");
    assert.deepEqual(got.filter(([op]) => op === "no"), [["no", "crowd"]]);
    const tab = await w.page("198.51.100.170");
    tab.bid = pages[0].bid;
    await w.in("Same0", { page: tab });
    assert.equal(chatOf(tab.take()).find(([op]) => op === "log")[1].you.name, "Same0", "another tab of a name already there is fine");
    const other = await w.in("Elsewhere", { ip: "198.51.100.171" });
    assert.equal(chatOf(other.take()).find(([op]) => op === "log")[1].you.name, "Elsewhere");
    const sith = await w.in("Same9", { ip: "198.51.100.170", room: "sith-asteroid" });
    assert.equal(chatOf(sith.take()).find(([op]) => op === "log")[1].you.name, "Same9", "another room counts apart");
});

await check("a page sending chat messages nonstop isn't listened to for a minute (not a moderator's)", async () => {
    const { w, mod } = await modWorld();
    const a = await w.in("Hammer", { ip: "198.51.100.180" });
    a.take();
    for (let i = 0; i < OPS_MAX + 20; i++)
        await w.say(a, "chat say " + b64(`go to jkcheats${i}.com`));
    const got = chatOf(a.take()).filter(([op]) => op === "no");
    assert.equal(got.length, OPS_MAX, "answers stop after " + OPS_MAX);
    assert.deepEqual(got.at(-1), ["no", "fast", String(OPS_OFF_MS / 1000)]);
    later(OPS_OFF_MS);
    await w.say(a, "chat say " + b64("hello"));
    assert.ok(chatOf(a.take()).some(([op]) => op === "no"), "answered again a minute on");
    mod.take();
    for (let i = 0; i < OPS_MAX + 5; i++)
        await w.say(mod, "chat say " + b64("mod line " + i));
    assert.equal(chatOf(mod.take()).filter(([op]) => op === "ok").length, OPS_MAX + 5);
});

Date.now = realNow;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
