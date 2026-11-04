// Checks room passwords in src/lobby.js: the lobby checks them for games that
// connect with pw=1, keeps only a verifier, and older games (no pw=1) go on
// as before for a room an older game hosts while PASSWORDS_FOR_OLD_GAMES lets
// them. Runs the Lobby itself in Node.js on test/cfstub.mjs, with the lobby
// from before passwords (git show LIVE_REF:cloudflare/src/lobby.js, 7a4d7ca by
// default) for the deploy and a rollback. Needs Node.js 22 or newer and git.
//
//   node test/passwords.mjs
//
// Games act as the engine does. An "old" one (cloudflare-89) checks the
// listed password itself, with the box shown only for sessionFlags 0x400,
// and sends a bare join. A "new" one connects with pw=1 and, when the lobby
// said pw, sends join <room> <hex of the typed password> instead (bare when
// the box is empty). Hosts of both send their password in every entry.
// It prints a line for each check and exits 1 if one fails.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const stubUrl = new URL("./cfstub.mjs", import.meta.url).href;
// cloudflare:workers is the stub, and the lobby's modules are ES modules
// (package.json doesn't say).
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const { FakeStorage, FakeCtx } = await import("./cfstub.mjs");
const { Lobby } = await import("../src/lobby.js");

// The lobby before passwords, with the modules it imports, from git.
const LIVE_REF = process.env.LIVE_REF || "7a4d7ca";
let LiveLobby = null;
const dir = mkdtempSync(join(tmpdir(), "lobby-live-"));
try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: new URL(".", import.meta.url) }).toString().trim();
    for (const f of ["lobby.js", "moved.js", "summary.js", "imperial.js"])
        writeFileSync(join(dir, f), execFileSync("git", ["show", `${LIVE_REF}:cloudflare/src/${f}`], { cwd: top }));
    ({ Lobby: LiveLobby } = await import(pathToFileURL(join(dir, "lobby.js")).href));
} catch (e) {
    console.log(`can't load the lobby from ${LIVE_REF} (${e.message.split("\n")[0]}): the deploy and rollback checks are skipped`);
}

// The lobby's log, kept to check no password gets into it.
const logged = [];
const realLog = console.log;
console.log = (...a) => {
    const line = a.join(" ");
    if (line.startsWith("relay:")) {
        logged.push(line);
        if (process.env.VERBOSE)
            realLog(line);
    } else {
        realLog(...a);
    }
};

// Time, moved on by hand for the rate limit and PASSWORDS_FOR_OLD_GAMES_UNTIL.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

// crypto.subtle, held back while a check makes things happen meanwhile: what
// starts after hold() waits until release(), what starts after stop() doesn't.
const subtle = globalThis.crypto.subtle;
const realSign = subtle.sign.bind(subtle);
const realImport = subtle.importKey.bind(subtle);
let held = null;
subtle.importKey = (...a) => held ? held.then(() => realImport(...a)) : realImport(...a);
subtle.sign = (...a) => held ? held.then(() => realSign(...a)) : realSign(...a);
function hold() {
    let open;
    const gate = new Promise(r => open = r);
    held = gate;
    const stop = () => {
        if (held === gate)
            held = null;
    };
    return { stop, release: () => { stop(); open(); } };
}

const PASSWORD = "letmein";
const hexPw = pw => Buffer.from(pw, "utf16le").toString("hex");
const TAIL = "4a4b4d4402010861626364";
// A jkMultiEntry (types.h in the OpenJKDF2 fork) in hex, then a tail. flag is
// sessionFlags 0x400, which the host's game sets with a password and keeps
// (it's sticky) after.
function entry({ name = "t_Room", password = "", flag = !!password, tail = "" } = {}) {
    const b = Buffer.alloc(240);
    b.writeUInt32LE(0x4a4b4852, 8);
    b.writeInt32LE(8, 16);
    b.write(name, 24, "utf16le");
    b.write("JK1MP", 88, "latin1");
    b.write("01narshadda.jkl", 120, "latin1");
    b.write(password, 152, "utf16le");
    b.writeInt32LE(flag ? 0x400 | 0x8 : 0x8, 216);
    b.writeInt32LE(10, 224);
    return b.toString("hex") + tail;
}
function decode(hex) {
    const b = Buffer.from(hex.slice(0, 480), "hex");
    return { name: b.toString("utf16le", 24, 88).replace(/\0.*$/s, ""), pw: b.toString("utf16le", 152, 216).replace(/\0.*$/s, ""),
             box: (b.readInt32LE(216) & 0x400) !== 0, flags: b.readInt32LE(216), raw: b };
}

// A lobby and its storage, which a restart, a deploy or a rollback hands on.
class World {
    constructor(LobbyClass, env, storage = new FakeStorage()) {
        this.LobbyClass = LobbyClass;
        this.env = env;
        this.storage = storage;
    }
    // sockets: those still open (a restart), none for an update.
    async start(sockets = []) {
        this.ctx = new FakeCtx(this.storage, sockets);
        this.lobby = new this.LobbyClass(this.ctx, this.env);
        await this.ctx.ready;
        return this;
    }
    // Over this one's storage, as another lobby (a deploy or a rollback).
    async next(LobbyClass, env = this.env, sockets = []) {
        return new World(LobbyClass, env, this.storage).start(sockets);
    }
    async connect(kind, ip) {
        const headers = ip ? { "CF-Connecting-IP": ip } : {};
        await this.lobby.fetch(new Request("https://lobby.test/relay?net=0" + (kind === "new" ? "&pw=1" : ""), { headers }));
        const ws = this.ctx.sockets.at(-1);
        ws.kind = kind;
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
    async host(kind, opts = {}) {
        const H = await this.connect(kind, opts.ip);
        H.entry = entry(opts);
        await this.say(H, "host " + H.entry);
        const out = H.take();
        assert.match(out[0] || "", /^hosted \d+$/, `host: ${out}`);
        H.room = Number(out[0].split(" ")[1]);
        H.key = out[1].split(" ")[3];
        return H;
    }
    async listed(ws, room) {
        await this.say(ws, "list");
        const items = ws.take().find(l => l.startsWith("list")).split(" ").slice(1);
        for (let i = 0; i < items.length; i += 3) {
            if (Number(items[i]) === room)
                return { ...decode(items[i + 2]), hex: items[i + 2] };
        }
        return null;
    }
    // What a game's player sees joining room with typed in the password box.
    async tryJoin(kind, room, typed, ip) {
        const J = await this.connect(kind, ip);
        const sees = await this.joinAs(J, room, typed);
        if (sees === "JOINED")
            await this.say(J, "leave");
        return sees;
    }
    async joinAs(J, room, typed) {
        const listed = await this.listed(J, room);
        if (!listed)
            return "not listed";
        // The engine snapshots the lobby line with each list.
        if (J.kind === "new" && J.lobbyLine.split(" ").includes("pw")) {
            await this.say(J, `join ${room}` + (typed ? " " + hexPw(typed) : ""));
        } else {
            // The box is cleared when the join screen opens, and hidden
            // without the flag.
            if (listed.pw !== (listed.box ? typed : ""))
                return "wrong password (its own check)";
            await this.say(J, `join ${room}`);
        }
        return seen(J.take());
    }
    status = async () => {
        const W = await this.connect("old");
        await this.say(W, "watch");
        const line = W.take().filter(l => l.startsWith("status ")).pop();
        await this.close(W);
        return { json: Buffer.from(line.slice(7), "base64").toString(), data: JSON.parse(Buffer.from(line.slice(7), "base64").toString()) };
    };
}

function seen(lines) {
    if (lines.some(l => l.startsWith("seat ")))
        return "JOINED";
    return lines.find(l => l.startsWith("error ")) || "nothing";
}

let failed = 0, passed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed++;
        realLog("ok   " + name);
    } catch (e) {
        failed++;
        realLog("FAIL " + name + "\n" + (e.stack || e));
    }
}

const HOUR = 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();
// The transition settings, and whether older games still check the password
// of a room an older game hosts with each.
const MODES = [
    ["unset", {}, true],
    ["host", { PASSWORDS_FOR_OLD_GAMES: "host" }, true],
    ["none", { PASSWORDS_FOR_OLD_GAMES: "none" }, false],
    ["host until a time past", { PASSWORDS_FOR_OLD_GAMES: "host", PASSWORDS_FOR_OLD_GAMES_UNTIL: iso(realNow() - HOUR) }, false],
    ["unset until a time to come", { PASSWORDS_FOR_OLD_GAMES_UNTIL: iso(realNow() + HOUR) }, true],
    ["none until a time to come", { PASSWORDS_FOR_OLD_GAMES: "none", PASSWORDS_FOR_OLD_GAMES_UNTIL: iso(realNow() + HOUR) }, false],
];
const TYPED = [PASSWORD, "wrong", ""];

// What a player should see: a game that sends passwords is checked by the
// lobby; an older one checks a room an older game hosts itself while the
// lobby lets it, and hears "newer version" for any other room with a password.
function expected(hostKind, joinerKind, typed, keeps) {
    if (joinerKind === "new")
        return typed === PASSWORD ? "JOINED" : "error password";
    if (hostKind === "old" && keeps)
        return typed === PASSWORD ? "JOINED" : "wrong password (its own check)";
    return "error version newer";
}

// Passwords nowhere in storage but in the entries of rooms older games still
// check themselves.
function storageHolds(storage, text) {
    const hex = hexPw(text);
    return [...storage.m].filter(([, v]) => {
        const s = JSON.stringify(v);
        return s.includes(hex) || s.includes(text);
    }).map(([k]) => k);
}

for (const withKey of [false, true]) {
    for (const [label, mode, keeps] of MODES) {
        const env = { HOLD_MS: "60000", ...mode, ...(withKey ? { PASSWORD_KEY: "a secret" } : {}) };
        const what = `${label}${withKey ? ", PASSWORD_KEY set" : ""}`;
        await check(`${what}: old and new hosts x old and new joiners x right, wrong and empty password`, async () => {
            const w = await new World(Lobby, env).start();
            for (const hostKind of ["old", "new"]) {
                const H = await w.host(hostKind, { password: PASSWORD });
                for (const joinerKind of ["old", "new"]) {
                    for (const typed of TYPED) {
                        assert.equal(await w.tryJoin(joinerKind, H.room, typed), expected(hostKind, joinerKind, typed, keeps),
                                     `${hostKind} host, ${joinerKind} joiner typed ${JSON.stringify(typed)}`);
                    }
                }
                const pw = w.storage.m.get("pw:" + H.room);
                assert.deepEqual(Object.keys(pw).sort(), ["legacy", "mac", "salt"]);
                assert.equal(pw.legacy, hostKind === "old");
                const stored = decode(w.storage.m.get("room:" + H.room));
                assert.equal(stored.pw, hostKind === "old" && keeps ? PASSWORD : "", "the stored entry's password");
            }
        });
        await check(`${what}: rooms without a password let everyone in, and a password sent to one is left out`, async () => {
            const w = await new World(Lobby, env).start();
            for (const hostKind of ["old", "new"]) {
                for (const flag of [false, true]) {
                    const H = await w.host(hostKind, { flag });
                    for (const joinerKind of ["old", "new"]) {
                        // An older game's own check runs against the box it
                        // shows (the sticky flag), so only an empty one passes.
                        for (const typed of joinerKind === "new" ? ["", "stale text"] : [""])
                            assert.equal(await w.tryJoin(joinerKind, H.room, typed), "JOINED", `${hostKind} ${flag} ${joinerKind} ${typed}`);
                    }
                    assert.equal(w.storage.m.get("pw:" + H.room), undefined);
                }
            }
        });
    }
}

await check("the lobby says pw on connect, after links and turn", async () => {
    let w = await new World(Lobby, {}).start();
    assert.equal((await w.connect("old")).lobbyLine, "lobby links pw");
    assert.equal((await w.connect("new")).lobbyLine, "lobby links pw");
    w = await new World(Lobby, { TURN_KEY_ID: "id", TURN_KEY_API_TOKEN: "token" }).start();
    assert.equal((await w.connect("new")).lobbyLine, "lobby links turn pw");
});

await check("a game that sends passwords gets the password box exactly for rooms with a password, never a password", async () => {
    const w = await new World(Lobby, {}).start();
    const rooms = {
        locked: await w.host("new", { password: PASSWORD }),
        lockedNoFlag: await w.host("new", { password: PASSWORD, flag: false }),
        oldLocked: await w.host("old", { password: PASSWORD }),
        sticky: await w.host("new", { flag: true }),
        open: await w.host("old"),
    };
    const N = await w.connect("new");
    const want = { locked: true, lockedNoFlag: true, oldLocked: true, sticky: false, open: false };
    for (const [k, H] of Object.entries(rooms)) {
        const l = await w.listed(N, H.room);
        assert.equal(l.pw, "", k);
        assert.equal(l.box, want[k], k);
        // Everything else as the host sent it.
        const sent = decode(H.entry);
        assert.equal(l.flags & ~0x400, sent.flags & ~0x400, k);
        assert.equal(l.hex.slice(0, 304), H.entry.slice(0, 304), k);
        assert.equal(l.hex.slice(440), H.entry.slice(440), k);
    }
});

await check("an older game gets a checked room without its password or box, an older game's room as before", async () => {
    const w = await new World(Lobby, {}).start();
    const checked = await w.host("new", { password: PASSWORD, tail: TAIL });
    const legacy = await w.host("old", { password: PASSWORD, tail: TAIL });
    const sticky = await w.host("new", { flag: true });
    const O = await w.connect("old");
    let l = await w.listed(O, checked.room);
    assert.equal(l.pw, "");
    assert.equal(l.box, false);
    assert.equal(l.hex.slice(440), checked.entry.slice(440));
    l = await w.listed(O, legacy.room);
    assert.equal(l.hex, legacy.entry);
    // An open room whose host's box was left on, as before.
    l = await w.listed(O, sticky.room);
    assert.equal(l.hex, sticky.entry);
});

await check("welcome never carries the password, to either kind of game, in any room", async () => {
    const w = await new World(Lobby, {}).start();
    for (const hostKind of ["old", "new"]) {
        const H = await w.host(hostKind, { password: PASSWORD, tail: TAIL });
        // An older game only gets into an older game's room.
        for (const kind of hostKind === "old" ? ["old", "new"] : ["new"]) {
            const J = await w.connect(kind);
            assert.equal(await w.joinAs(J, H.room, PASSWORD), "JOINED");
            const id = H.take().find(l => l.startsWith("peer-joined")).split(" ")[1];
            await w.say(H, `welcome ${id} ${H.entry}`);
            const [line] = J.take();
            const [op, wid, e] = line.split(" ");
            assert.equal(op + " " + wid, `welcome ${id}`);
            assert.equal(decode(e).pw, "");
            assert.equal(e.slice(0, 304), H.entry.slice(0, 304));
            assert.equal(e.slice(432), H.entry.slice(432));
            await w.say(J, "leave");
        }
    }
});

await check("the landing page shows every password room locked, and never a password", async () => {
    const w = await new World(Lobby, {}).start();
    await w.host("new", { name: "t_Checked", password: PASSWORD });
    await w.host("old", { name: "t_Legacy", password: PASSWORD });
    await w.host("new", { name: "t_Sticky", flag: true });
    await w.host("old", { name: "t_Open" });
    const { json, data } = await w.status();
    const locked = Object.fromEntries(data.games.map(g => [g.name, g.locked]));
    assert.deepEqual(locked, { t_Checked: true, t_Legacy: true, t_Sticky: false, t_Open: false });
    assert.ok(!json.includes(PASSWORD) && !json.includes(hexPw(PASSWORD)));
});

await check("storage never holds a checked room's password, nor does the log", async () => {
    for (const env of [{}, { PASSWORDS_FOR_OLD_GAMES: "none" }]) {
        const w = await new World(Lobby, env).start();
        const checked = await w.host("new", { password: "sekrit-new" });
        const legacy = await w.host("old", { password: "sekrit-old" });
        await w.say(checked, "update " + entry({ password: "sekrit-new", name: "t_Moved" }));
        await w.say(legacy, "update " + entry({ password: "sekrit-old", name: "t_Moved" }));
        assert.deepEqual(storageHolds(w.storage, "sekrit-new"), []);
        assert.deepEqual(storageHolds(w.storage, "sekrit-old"), env.PASSWORDS_FOR_OLD_GAMES ? [] : ["room:" + legacy.room]);
        assert.ok(w.storage.m.get("pw:" + checked.room).mac.length === 64);
    }
    assert.ok(!logged.some(l => /sekrit|letmein/.test(l) || l.includes(hexPw("sekrit")) || l.includes(hexPw(PASSWORD))));
});

await check("a join's password must be 1 to 31 code units of hex, none 0, or it's a bad request", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const J = await w.connect("new");
    const bad = ["abc", "41", "410", "41004", "zz00", "4100 4100", "0000", "41000000", "00004100", "4100".repeat(32),
                 "41\u00000", "-410"];
    for (const hex of bad) {
        await w.say(J, `join ${H.room} ${hex}`);
        assert.deepEqual(J.take(), ["error bad-request"], JSON.stringify(hex));
    }
    await w.say(J, `join ${H.room} ${"4100".repeat(31)}`);
    assert.deepEqual(J.take(), ["error password"]);
    await w.say(J, `join ${H.room} ${hexPw(PASSWORD).toUpperCase()}`);
    assert.equal(seen(J.take()), "JOINED");
    // A malformed one doesn't take a seated player out of its room.
    await w.say(J, `join ${H.room} 41`);
    assert.deepEqual(J.take(), ["error bad-request"]);
    assert.equal(w.lobby.conn(J).room, H.room);
    H.take();
    // 31 code units, as the host's box keeps.
    const long = "x".repeat(31);
    const L = await w.host("new", { password: long });
    assert.equal(await w.tryJoin("new", L.room, long), "JOINED");
    assert.equal(await w.tryJoin("new", L.room, long.slice(1)), "error password");
});

await check("rate limit: 10 wrong passwords a minute per room and address, then wait, even with the right one", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const Other = await w.host("new", { password: PASSWORD });
    const A = await w.connect("new", "203.0.113.1");
    for (let i = 0; i < 10; i++) {
        await w.say(A, `join ${H.room} ${hexPw("guess" + i)}`);
        assert.deepEqual(A.take(), ["error password"], `guess ${i}`);
    }
    await w.say(A, `join ${H.room} ${hexPw("guess10")}`);
    assert.deepEqual(A.take(), ["error password wait"]);
    await w.say(A, `join ${H.room} ${hexPw(PASSWORD)}`);
    assert.deepEqual(A.take(), ["error password wait"]);
    // An empty box counts for nothing, but waits too.
    await w.say(A, `join ${H.room}`);
    assert.deepEqual(A.take(), ["error password wait"]);
    // Coming back on a new connection from the same address.
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "203.0.113.1"), "error password wait");
    // Another address, and another room, aren't held up.
    assert.equal(await w.tryJoin("new", H.room, "wrong", "203.0.113.2"), "error password");
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "203.0.113.2"), "JOINED");
    assert.equal(await w.tryJoin("new", Other.room, PASSWORD, "203.0.113.1"), "JOINED");
    // An older game in a room it checks itself isn't counted at all.
    const L = await w.host("old", { password: PASSWORD });
    assert.equal(await w.tryJoin("old", L.room, PASSWORD, "203.0.113.1"), "JOINED");
    // Half a minute on, still waiting; a minute after the first, one more try.
    skew += 30 * 1000;
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "203.0.113.1"), "error password wait");
    skew += 30 * 1000;
    assert.equal(await w.tryJoin("new", H.room, "wrong", "203.0.113.1"), "error password");
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "203.0.113.1"), "JOINED");
    // The sweep forgets them once they're over a minute old (the hosts say
    // something first, or they'd be gone as quiet).
    skew += 61 * 1000;
    for (const host of [H, Other])
        await w.say(host, "list");
    await w.lobby.alarm();
    assert.equal(w.lobby.pwTries.size, 0);
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "203.0.113.1"), "JOINED");
    // A room that ends takes its counts with it.
    for (let i = 0; i < 3; i++)
        await w.tryJoin("new", Other.room, "wrong", "203.0.113.3");
    assert.ok(w.lobby.pwTries.has(Other.room));
    await w.say(Other, "leave");
    assert.ok(!w.lobby.pwTries.has(Other.room));
});

await check("rate limit: tries still being checked count, so many at once from one address get only 10 answers", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const games = [];
    for (let i = 0; i < 14; i++)
        games.push(await w.connect("new", "198.51.100.7"));
    const gate = hold();
    const pending = games.map((J, i) => w.say(J, `join ${H.room} ${hexPw("try" + i)}`));
    gate.release();
    await Promise.all(pending);
    const answers = games.map(J => J.take().join());
    assert.equal(answers.filter(a => a === "error password").length, 10);
    assert.equal(answers.filter(a => a === "error password wait").length, 4);
});

await check("rate limit: without an address, it's counted by connection", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const A = await w.connect("new");
    for (let i = 0; i < 10; i++)
        await w.say(A, `join ${H.room} ${hexPw("guess" + i)}`);
    A.take();
    await w.say(A, `join ${H.room} ${hexPw(PASSWORD)}`);
    assert.deepEqual(A.take(), ["error password wait"]);
    assert.equal(await w.tryJoin("new", H.room, PASSWORD), "JOINED");
});

await check("rate limit: an IPv6 address counts by its /64, so changing address within it doesn't help", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    // Ten addresses in one /64, written every which way.
    const in64 = ["2001:db8:1:2::1", "2001:DB8:1:2::2", "2001:db8:1:2:0:0:0:3", "2001:0db8:0001:0002::4",
                  "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2:1::", "2001:db8:1:2::7%eth0",
                  "2001:db8:1:2:abcd::8", "2001:db8:1:2::9", "2001:db8:1:2::a"];
    for (const [i, ip] of in64.entries())
        assert.equal(await w.tryJoin("new", H.room, "guess" + i, ip), "error password", ip);
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "2001:db8:1:2::b"), "error password wait");
    // The next /64 over isn't held up.
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "2001:db8:1:3::1"), "JOINED");
    // An IPv4 address mapped into IPv6 is that IPv4 address.
    for (let i = 0; i < 10; i++)
        assert.equal(await w.tryJoin("new", H.room, "guess" + i, i % 2 ? "198.51.100.9" : "::ffff:198.51.100.9"), "error password");
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "::ffff:c633:6409"), "error password wait");
    assert.equal(await w.tryJoin("new", H.room, PASSWORD, "198.51.100.10"), "JOINED");
});

await check("a room or its host gone while a password is checked: error no-room", async () => {
    const w = await new World(Lobby, {}).start();
    // The host leaves.
    let H = await w.host("new", { password: PASSWORD });
    let J = await w.connect("new");
    let gate = hold();
    let p = w.say(J, `join ${H.room} ${hexPw(PASSWORD)}`);
    await w.say(H, "leave");
    gate.release();
    await p;
    assert.deepEqual(J.take(), ["error no-room"]);
    // The host's socket drops: its seat is held, nobody can join meanwhile.
    H = await w.host("new", { password: PASSWORD });
    J = await w.connect("new");
    gate = hold();
    p = w.say(J, `join ${H.room} ${hexPw(PASSWORD)}`);
    await w.close(H);
    gate.release();
    await p;
    assert.deepEqual(J.take(), ["error no-room"]);
    // The host takes its seat back meanwhile: still there, so the join goes on.
    const H2 = await w.host("new", { password: PASSWORD });
    J = await w.connect("new");
    gate = hold();
    p = w.say(J, `join ${H2.room} ${hexPw(PASSWORD)}`);
    gate.stop();
    await w.close(H2);
    const H3 = await w.connect("new");
    await w.say(H3, `rehost ${H2.room} ${H2.key} ${H2.entry}`);
    assert.deepEqual(H3.take(), [`rehosted ${H2.room}`]);
    gate.release();
    await p;
    assert.equal(seen(J.take()), "JOINED");
    assert.match(H3.take().join(), /^peer-joined 2$/);
    // The host's password changes meanwhile: checked against the new one.
    const H4 = await w.host("new", { password: PASSWORD });
    J = await w.connect("new");
    gate = hold();
    p = w.say(J, `join ${H4.room} ${hexPw(PASSWORD)}`);
    gate.stop();
    await w.say(H4, "update " + entry({ password: "another" }));
    gate.release();
    await p;
    assert.deepEqual(J.take(), ["error password"]);
    assert.equal(await w.tryJoin("new", H4.room, "another"), "JOINED");
});

await check("a game that moved on or closed while its password was checked hears nothing", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const open = await w.host("new");
    // Its socket closes.
    let J = await w.connect("new");
    let gate = hold();
    let p = w.say(J, `join ${H.room} ${hexPw(PASSWORD)}`);
    await w.close(J);
    gate.release();
    await p;
    assert.deepEqual(J.take(), []);
    assert.equal(H.take().length, 0);
    // It leaves.
    J = await w.connect("new");
    gate = hold();
    p = w.say(J, `join ${H.room} ${hexPw(PASSWORD)}`);
    await w.say(J, "leave");
    gate.release();
    await p;
    assert.deepEqual(J.take(), []);
    // It joins another room meanwhile: only that join counts.
    J = await w.connect("new");
    gate = hold();
    p = w.say(J, `join ${H.room} ${hexPw("wrong")}`);
    await w.say(J, `join ${open.room}`);
    gate.release();
    await p;
    const got = J.take();
    assert.equal(got.length, 1);
    assert.match(got[0], new RegExp(`^seat ${open.room} 2 `));
    assert.equal(H.take().length, 0);
    assert.equal(w.lobby.conn(J).room, open.room);
});

await check("a host's room with a password opens once its verifier is made, unless the game moved on", async () => {
    const w = await new World(Lobby, {}).start();
    // Two hosts in a row: only the last one opens a room.
    const H = await w.connect("new");
    let gate = hold();
    const p1 = w.say(H, "host " + entry({ password: "one" }));
    const p2 = w.say(H, "host " + entry({ password: "two" }));
    gate.release();
    await Promise.all([p1, p2]);
    const out = H.take();
    assert.equal(out.filter(l => l.startsWith("hosted")).length, 1);
    const room = Number(out[0].split(" ")[1]);
    assert.equal(w.lobby.rooms.size, 1);
    assert.equal(await w.tryJoin("new", room, "two"), "JOINED");
    // A host whose socket closes before then opens nothing.
    const G = await w.connect("new");
    gate = hold();
    const p3 = w.say(G, "host " + entry({ password: "three" }));
    await w.close(G);
    gate.release();
    await p3;
    assert.equal(w.lobby.rooms.size, 1);
    assert.deepEqual([...w.storage.m.keys()].filter(k => k.startsWith("room:")), ["room:" + room]);
});

await check("update: a password added, changed and taken away", async () => {
    for (const kind of ["new", "old"]) {
        const w = await new World(Lobby, {}).start();
        const H = await w.host(kind, { name: "t_Up" });
        assert.equal((await w.status()).data.games[0].locked, false);
        await w.say(H, "update " + entry({ name: "t_Up", password: PASSWORD }));
        const pw = w.storage.m.get("pw:" + H.room);
        assert.equal(pw.legacy, kind === "old");
        assert.equal((await w.status()).data.games[0].locked, true);
        assert.equal(await w.tryJoin("new", H.room, ""), "error password");
        assert.equal(await w.tryJoin("new", H.room, PASSWORD), "JOINED");
        assert.equal(await w.tryJoin("old", H.room, PASSWORD), kind === "old" ? "JOINED" : "error version newer");
        // The same password again keeps its verifier.
        await w.say(H, "update " + entry({ name: "t_Up2", password: PASSWORD }));
        assert.deepEqual(w.storage.m.get("pw:" + H.room), pw);
        assert.equal(decode(w.storage.m.get("room:" + H.room)).name, "t_Up2");
        // Another one.
        await w.say(H, "update " + entry({ name: "t_Up2", password: "another" }));
        assert.notEqual(w.storage.m.get("pw:" + H.room).salt, pw.salt);
        assert.equal(await w.tryJoin("new", H.room, PASSWORD), "error password");
        assert.equal(await w.tryJoin("new", H.room, "another"), "JOINED");
        // None, with the box's flag still on (sticky): open to all.
        await w.say(H, "update " + entry({ name: "t_Up2", flag: true }));
        assert.equal(w.storage.m.get("pw:" + H.room), undefined);
        assert.equal((await w.status()).data.games[0].locked, false);
        assert.equal(await w.tryJoin("new", H.room, ""), "JOINED");
        assert.equal(await w.tryJoin("old", H.room, ""), "JOINED");
        const l = await w.listed(await w.connect("new"), H.room);
        assert.equal(l.box, false);
    }
});

await check("PASSWORDS_FOR_OLD_GAMES_UNTIL passing while the lobby runs: older games stop getting passwords", async () => {
    const env = { PASSWORDS_FOR_OLD_GAMES_UNTIL: iso(Date.now() + 30 * 1000) };
    const w = await new World(Lobby, env).start();
    const H = await w.host("old", { password: PASSWORD });
    const O = await w.connect("old");
    assert.equal((await w.listed(O, H.room)).pw, PASSWORD);
    assert.equal(await w.tryJoin("old", H.room, PASSWORD), "JOINED");
    skew += 60 * 1000;
    const l = await w.listed(O, H.room);
    assert.equal(l.pw, "");
    assert.equal(l.box, false);
    assert.equal(await w.tryJoin("old", H.room, PASSWORD), "error version newer");
    assert.equal(await w.tryJoin("new", H.room, PASSWORD), "JOINED");
    // The sweep takes it out of storage.
    await w.lobby.alarm();
    assert.deepEqual(storageHolds(w.storage, PASSWORD), []);
    assert.equal((await w.status()).data.games[0].locked, true);
});

await check("a restart keeps a checked room's verifier, and its players", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    const P = await w.connect("new");
    assert.equal(await w.joinAs(P, H.room, PASSWORD), "JOINED");
    const w2 = await w.next(Lobby, w.env, w.ctx.getWebSockets());
    assert.equal(await w2.tryJoin("new", H.room, PASSWORD), "JOINED");
    assert.equal(await w2.tryJoin("new", H.room, "wrong"), "error password");
    assert.equal(await w2.tryJoin("old", H.room, PASSWORD), "error version newer");
    assert.equal(w2.lobby.conn(P).room, H.room);
    assert.deepEqual(storageHolds(w2.storage, PASSWORD), []);
});

await check("a rehost into a room that has no verifier makes one, instead of opening the room", async () => {
    const joins = async (w, kind, room) => {
        assert.equal(w.storage.m.get("pw:" + room).legacy, kind === "old");
        assert.equal(await w.tryJoin("new", room, ""), "error password");
        assert.equal(await w.tryJoin("new", room, "wrong"), "error password");
        assert.equal(await w.tryJoin("new", room, PASSWORD), "JOINED");
        assert.equal(await w.tryJoin("old", room, ""), kind === "old" ? "wrong password (its own check)" : "error version newer");
        assert.equal(await w.tryJoin("old", room, PASSWORD), kind === "old" ? "JOINED" : "error version newer");
        assert.equal((await w.status()).data.games.find(g => g.id === room).locked, true);
    };
    for (const kind of ["new", "old"]) {
        // The host's update with a password never got here (its socket
        // dropped first), and its tab rehosts with that entry.
        const w = await new World(Lobby, {}).start();
        const H = await w.host(kind);
        await w.close(H);
        const back = await w.connect(kind);
        await w.say(back, `rehost ${H.room} ${H.key} ${entry({ password: PASSWORD })}`);
        assert.deepEqual(back.take(), [`rehosted ${H.room}`]);
        await joins(w, kind, H.room);
        // A room that was open when the lobby went down: its host's tab
        // rehosts with the entry it has now, which has a password.
        const v = await new World(Lobby, {}).start();
        const G = await v.host(kind);
        const v2 = await v.next(Lobby);
        assert.equal(v2.lobby.rooms.get(G.room).pw, null);
        const G2 = await v2.connect(kind);
        await v2.say(G2, `rehost ${G.room} ${G.key} ${entry({ password: PASSWORD })}`);
        assert.deepEqual(G2.take(), [`rehosted ${G.room}`]);
        await joins(v2, kind, G.room);
    }
});

await check("a room rebuilt from its sockets alone, its entry lost from storage, still checks joins", async () => {
    const w = await new World(Lobby, {}).start();
    const H = await w.host("new", { password: PASSWORD });
    w.storage.m.delete("room:" + H.room);
    const w2 = await w.next(Lobby, w.env, w.ctx.getWebSockets());
    assert.ok(w2.lobby.rooms.get(H.room).pw);
    const J = await w2.connect("new");
    await w2.say(J, `join ${H.room}`);
    assert.deepEqual(J.take(), ["error password"]);
    await w2.say(J, `join ${H.room} ${hexPw("wrong")}`);
    assert.deepEqual(J.take(), ["error password"]);
    await w2.say(J, `join ${H.room} ${hexPw(PASSWORD)}`);
    assert.equal(seen(J.take()), "JOINED");
    const O = await w2.connect("old");
    await w2.say(O, `join ${H.room}`);
    assert.deepEqual(O.take(), ["error version newer"]);
});

if (LiveLobby) {
    for (const [label, mode, keeps] of MODES.slice(1, 4)) {
        await check(`deploy over the lobby before passwords (${label}): its rooms, then rehost`, async () => {
            const live = await new World(LiveLobby, { HOLD_MS: "60000", ...mode }).start();
            const H = await live.host("old", { password: PASSWORD, tail: TAIL });
            const open = await live.host("old");
            const sticky = await live.host("old", { flag: true });
            // A new engine hosting on the old lobby (the engine went out
            // first): it can't tell, so the lobby takes it for an older game.
            const N = await live.host("new", { password: PASSWORD });
            const P = await live.connect("old");
            assert.equal(await live.joinAs(P, H.room, PASSWORD), "JOINED");
            assert.equal(decode(live.storage.m.get("room:" + H.room)).pw, PASSWORD);
            // The update closes every socket.
            const w = await live.next(Lobby);
            for (const r of [H, N]) {
                assert.equal(w.storage.m.get("pw:" + r.room).legacy, true);
                assert.equal(decode(w.storage.m.get("room:" + r.room)).pw, keeps ? PASSWORD : "");
            }
            assert.equal(w.storage.m.get("pw:" + open.room), undefined);
            assert.equal(w.storage.m.get("pw:" + sticky.room), undefined);
            // Nothing's listed while the hosts are away.
            assert.equal(await w.listed(await w.connect("new"), H.room), null);
            // They come back with the entries their tabs kept.
            for (const r of [H, N, open, sticky]) {
                const back = await w.connect(r.kind);
                await w.say(back, `rehost ${r.room} ${r.key} ${r.entry}`);
                assert.deepEqual(back.take(), [`rehosted ${r.room}`]);
            }
            for (const joinerKind of ["old", "new"]) {
                for (const typed of TYPED)
                    assert.equal(await w.tryJoin(joinerKind, H.room, typed), expected("old", joinerKind, typed, keeps));
            }
            // The new engine's room is its own once it's back with pw=1.
            assert.equal(w.storage.m.get("pw:" + N.room).legacy, false);
            for (const joinerKind of ["old", "new"]) {
                for (const typed of TYPED)
                    assert.equal(await w.tryJoin(joinerKind, N.room, typed), expected("new", joinerKind, typed, keeps));
            }
            for (const r of [open, sticky]) {
                assert.equal(await w.tryJoin("old", r.room, ""), "JOINED");
                assert.equal(await w.tryJoin("new", r.room, ""), "JOINED");
            }
            assert.deepEqual(storageHolds(w.storage, PASSWORD), keeps ? ["room:" + H.room] : []);
            const { data } = await w.status();
            assert.deepEqual(data.games.map(g => g.locked), [true, false, false, true]);
            // A restart after that keeps all of it.
            const w2 = await w.next(Lobby, w.env, w.ctx.getWebSockets());
            assert.equal(await w2.tryJoin("new", H.room, PASSWORD), "JOINED");
            assert.equal(await w2.tryJoin("new", N.room, "wrong"), "error password");
            assert.equal(await w2.tryJoin("old", N.room, PASSWORD), "error version newer");
        });
    }

    await check("rollback to the lobby before passwords: the host's rehost brings its password back", async () => {
        const w = await new World(Lobby, { PASSWORDS_FOR_OLD_GAMES: "none" }).start();
        const N = await w.host("new", { password: PASSWORD });
        const O = await w.host("old", { password: PASSWORD });
        assert.deepEqual(storageHolds(w.storage, PASSWORD), []);
        const live = await w.next(LiveLobby);
        // While the hosts are away, the old lobby doesn't list their rooms.
        const S = await live.connect("old");
        assert.equal(await live.listed(S, N.room), null);
        for (const r of [N, O]) {
            const back = await live.connect(r.kind);
            assert.equal(back.lobbyLine, "lobby links");
            await live.say(back, `rehost ${r.room} ${r.key} ${r.entry}`);
            assert.deepEqual(back.take(), [`rehosted ${r.room}`]);
            r.back = back;
        }
        for (const r of [N, O]) {
            assert.equal((await live.listed(S, r.room)).pw, PASSWORD);
            // Both kinds check it themselves against this lobby.
            for (const kind of ["old", "new"]) {
                assert.equal(await live.tryJoin(kind, r.room, PASSWORD), "JOINED");
                assert.equal(await live.tryJoin(kind, r.room, "wrong"), "wrong password (its own check)");
            }
        }
        // A new engine that listed from this lobby just before the rollback
        // sends its password with join once: the old lobby turns it down.
        const late = await live.connect("new");
        await live.say(late, `join ${N.room} ${hexPw(PASSWORD)}`);
        assert.deepEqual(late.take(), ["error bad-request"]);
        // And forward again: the verifiers the old lobby left behind still
        // fit, and the passwords leave storage once more.
        const again = await live.next(Lobby, { PASSWORDS_FOR_OLD_GAMES: "none" });
        assert.equal(again.storage.m.get("pw:" + N.room).legacy, false);
        assert.deepEqual(storageHolds(again.storage, PASSWORD), []);
        for (const r of [N, O]) {
            const back = await again.connect(r.kind);
            await again.say(back, `rehost ${r.room} ${r.key} ${r.entry}`);
            assert.deepEqual(back.take(), [`rehosted ${r.room}`]);
            assert.equal(await again.tryJoin("new", r.room, PASSWORD), "JOINED");
            assert.equal(await again.tryJoin("old", r.room, PASSWORD), "error version newer");
        }
    });
}

rmSync(dir, { recursive: true, force: true });
console.log = realLog;
console.log(failed ? `${failed} check(s) failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
