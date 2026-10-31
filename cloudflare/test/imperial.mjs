// Checks how src/imperial.js reads the Imperial Network Protocol relay's game
// list and what it hands the page, from a reply the real relay sent (31 Oct
// 2026) and made-up ones. Needs Node.js 22 or newer.
//
//   node test/imperial.mjs
//
// test/imperial-route.mjs checks the route itself, against a made-up relay.

import assert from "node:assert/strict";
import { parseListReply, gamesAnswer, parsePinned, relayUrl, splitName, modName, cleanText } from "../src/imperial.js";

// lobby.jkjunkie.com's LISTREPLY on 31 Oct 2026, 19:0x UTC: one game,
// Coruscant, a dedicated server at 162.248.94.121:27960, through the gateway.
const REAL = "4a524b3122010700c5a4623d020000000100010013e5dd93743f59055bbf297508845b2b" +
    "c000006820000000010000000215cf8a180000000a000000140000001743006f00720075007300630061006e0074003a" +
    "004a004b0031004300540046003a00630033002e006a006b006c00795ef8a2386d0100";
const bytes = h => Uint8Array.from(Buffer.from(h, "hex"));
const NOW = new Date("2026-10-31T19:00:00Z");
const PINNED = parsePinned("jk1 162.248.94.121:27960 Coruscant");
const SERVER = "lobby.jkjunkie.com";

// A LISTREPLY made up from games: { guid, flags, max, cur, name, addr, laFlags, tail }.
function reply(games, { flags = 7, total = games.length, seq = 2 } = {}) {
    const parts = [];
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x314B524A, 0);
    head[4] = 34; head[5] = 1;
    head.writeUInt16LE(flags, 6);
    head.writeUInt32LE(seq, 12);
    head.writeUInt16LE(total, 16);
    head.writeUInt16LE(games.length, 18);
    parts.push(head);
    for (const g of games) {
        const d = Buffer.alloc(45);
        Buffer.from(g.guid || "00112233445566778899aabbccddeeff", "hex").copy(d, 0);
        d.writeUInt32LE(g.flags >>> 0, 16);
        d.writeUInt32LE(g.max, 20);
        d.writeUInt32LE(g.cur, 24);
        d[44] = g.name.length;
        parts.push(d, Buffer.from(g.name, "utf16le"));
        if (flags & 1) {
            const a = Buffer.alloc(7);
            if (g.addr) {
                const [ip, port] = g.addr.split(":");
                a.writeUInt32LE(ip.split(".").reduce((n, x) => n * 256 + Number(x), 0) >>> 0, 0);
                a.writeUInt16LE(Number(port), 4);
                a[6] = g.laFlags ?? 1;
            }
            parts.push(a);
        }
        if (flags & 2)
            parts.push(Buffer.from([(g.tail || "").length]), Buffer.from(g.tail || "", "latin1"));
    }
    return Uint8Array.from(Buffer.concat(parts));
}
const WIRE = 0x20000000, XFER = 0x08000000, PASSWORD = 0x400, JOINDISABLED = 0x20;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("the real relay's reply", () => {
    const list = parseListReply(bytes(REAL));
    assert.equal(list.total, 1);
    assert.equal(list.flags, 7);
    assert.equal(list.games.length, 1);
    const g = list.games[0];
    assert.equal(g.guid, "13e5dd93743f59055bbf297508845b2b");
    assert.equal(g.name, "Coruscant:JK1CTF:c3.jkl");
    assert.equal(g.addr, "162.248.94.121:27960");
    assert.equal(g.max, 32);
    assert.equal(g.cur, 1);
    assert.equal(g.tail, "");
});

test("Coruscant is pinned first, its own slot off the counts", () => {
    const a = gamesAnswer(parseListReply(bytes(REAL)), SERVER, PINNED, NOW);
    assert.deepEqual(a, {
        state: "live", server: SERVER, checked: "2026-10-31T19:00:00.000Z",
        games: [{ key: "13e5dd93743f59055bbf297508845b2b", name: "Coruscant", game: "jk1", map: "c3.jkl",
                  episode: "JK1CTF", mod: "", locked: false, players: 0, max: 31, dedicated: true, pinned: true,
                  listed: true, joinable: true, why: "" }],
    });
});

test("a relay that didn't answer: the pinned card only, marked down", () => {
    const a = gamesAnswer(null, SERVER, PINNED, NOW);
    assert.equal(a.state, "down");
    assert.deepEqual(a.games, [{ key: "", name: "Coruscant", game: "jk1", map: "", episode: "", mod: "", locked: false,
                                 players: 0, max: 0, dedicated: true, pinned: true, listed: false, joinable: false,
                                 why: "relay-down" }]);
});

test("a pinned server the relay doesn't list", () => {
    const a = gamesAnswer(parseListReply(reply([])), SERVER, PINNED, NOW);
    assert.equal(a.state, "live");
    assert.equal(a.games.length, 1);
    assert.equal(a.games[0].why, "not-listed");
    assert.equal(a.games[0].joinable, false);
});

test("pinned by address, not by name", () => {
    const list = parseListReply(reply([
        { guid: "aa".repeat(16), flags: WIRE, max: 8, cur: 2, name: "Coruscant:JK1MP.gob:01narshadda.jkl" },
        { guid: "bb".repeat(16), flags: WIRE, max: 32, cur: 5, name: "Coruscant:JK1CTF:c3.jkl", addr: "162.248.94.121:27960" },
    ]));
    const a = gamesAnswer(list, SERVER, PINNED, NOW);
    assert.deepEqual(a.games.map(g => [g.key.slice(0, 2), g.pinned, g.dedicated, g.players, g.max]),
                     [["bb", true, true, 4, 31], ["aa", false, false, 2, 8]]);
});

test("games hosted on the relay: password, MotS, mods, desktop-only and closed", () => {
    const tail = Buffer.concat([Buffer.from("JKMD"), Buffer.from([2, 1, 3]), Buffer.alloc(32, 0xab), Buffer.from("SBX")]).toString("hex");
    const list = parseListReply(reply([
        { guid: "01".repeat(16), flags: WIRE | PASSWORD, max: 4, cur: 1, name: "Duels:JK1MP.gob:01narshadda.jkl" },
        { guid: "02".repeat(16), flags: WIRE | XFER, max: 8, cur: 3, name: "Asteroid:JKM_MP.goo:jkm_mp.jkl" },
        { guid: "03".repeat(16), flags: WIRE, max: 8, cur: 2, name: "Sabers:JK1MP.gob:01narshadda.jkl", tail },
        { guid: "04".repeat(16), flags: 0, max: 8, cur: 1, name: "Old desktop:JK1MP.gob:01narshadda.jkl" },
        { guid: "05".repeat(16), flags: WIRE | JOINDISABLED, max: 8, cur: 1, name: "Closed:JK1MP.gob:01narshadda.jkl" },
    ]));
    const a = gamesAnswer(list, SERVER, [], NOW);
    assert.deepEqual(a.games.map(g => [g.name, g.game, g.locked, g.mod, g.joinable, g.why, g.players, g.max, g.dedicated]), [
        ["Duels", "jk1", true, "", true, "", 1, 4, false],
        ["Asteroid", "mots", false, "", true, "", 3, 8, false],
        ["Sabers", "jk1", false, "SBX", true, "", 2, 8, false],
        ["Old desktop", "jk1", false, "", false, "desktop", 1, 8, false],
        ["Closed", "jk1", false, "", false, "closed", 1, 8, false],
    ]);
});

test("a dedicated server without the gateway is left out, as the game does", () => {
    const list = parseListReply(reply([
        { guid: "bb".repeat(16), flags: WIRE, max: 32, cur: 5, name: "Coruscant:JK1CTF:c3.jkl", addr: "162.248.94.121:27960" },
        { guid: "aa".repeat(16), flags: WIRE, max: 8, cur: 2, name: "Here:JK1MP.gob:01narshadda.jkl" },
    ], { flags: 3 }));
    const a = gamesAnswer(list, SERVER, PINNED, NOW);
    assert.deepEqual(a.games.map(g => [g.name, g.listed]), [["Coruscant", false], ["Here", true]]);
});

test("names are cleaned and cut, and never carry addresses", () => {
    const list = parseListReply(reply([
        { flags: WIRE, max: 8, cur: 1, name: "\u202eevil\u0007 name that is far too long for a table:JK1MP.gob:01narshadda.jkl" },
        { flags: WIRE, max: 8, cur: 1, name: "a:b:JK1MP.gob:map\u00e9.jkl" },
        { flags: WIRE, max: 8, cur: 1, name: "no colons" },
    ]));
    const a = gamesAnswer(list, SERVER, [], NOW);
    assert.equal(a.games[0].name, "evil name that is far too long f");
    assert.equal(a.games[1].name, "a:b");
    assert.equal(a.games[1].map, "map?.jkl");
    assert.deepEqual([a.games[2].name, a.games[2].episode, a.games[2].map], ["no colons", "", ""]);
    assert.ok(!JSON.stringify(a).includes("addr"));
});

test("counts are kept in bounds", () => {
    const list = parseListReply(reply([
        { flags: WIRE, max: 4000000000, cur: 4000000000, name: "Huge:JK1MP.gob:01narshadda.jkl" },
        { flags: WIRE, max: 32, cur: 0, name: "Empty:JK1CTF:c3.jkl", addr: "1.2.3.4:5" },
    ]));
    const a = gamesAnswer(list, SERVER, [], NOW);
    assert.deepEqual(a.games.map(g => [g.players, g.max]), [[64, 64], [0, 31]]);
});

test("replies that are cut short, too big or not list replies are refused", () => {
    const good = bytes(REAL);
    for (let n = 16; n < good.length; n += 7)
        assert.throws(() => parseListReply(good.subarray(0, n)), /cut short|wrong size/, `${n} bytes`);
    assert.throws(() => parseListReply(new Uint8Array(2049)), /wrong size/);
    const welcome = good.slice(); welcome[4] = 32;
    assert.throws(() => parseListReply(welcome), /not a list reply/);
    const magic = good.slice(); magic[0] = 0;
    assert.throws(() => parseListReply(magic), /not a list reply/);
    const many = good.slice(); many[18] = 200;
    assert.throws(() => parseListReply(many), /200 games/);
    const longName = good.slice(); longName[20 + 44] = 255;
    assert.throws(() => parseListReply(longName), /cut short/);
});

test("pinned servers from the setting", () => {
    assert.deepEqual(parsePinned("jk1 162.248.94.121:27960 Coruscant, mots 1.2.3.4:27960 Sith House , bad, jk1 x:1 No"), [
        { game: "jk1", addr: "162.248.94.121:27960", name: "Coruscant" },
        { game: "mots", addr: "1.2.3.4:27960", name: "Sith House" },
    ]);
    assert.deepEqual(parsePinned(""), []);
    assert.deepEqual(parsePinned(undefined), []);
});

test("the relay's address, as the game names servers", () => {
    assert.equal(relayUrl("lobby.jkjunkie.com"), "https://lobby.jkjunkie.com/imperial");
    assert.equal(relayUrl("127.0.0.1:8799"), "http://127.0.0.1:8799/");
    assert.equal(relayUrl("ws://127.0.0.1:8799/x"), "http://127.0.0.1:8799/x");
    assert.equal(relayUrl("wss://example.org/imperial"), "https://example.org/imperial");
});

test("names, mods and text helpers", () => {
    assert.deepEqual(splitName("Coruscant:JK1CTF:c3.jkl"), { server: "Coruscant", episode: "JK1CTF", map: "c3.jkl" });
    assert.equal(modName(""), "");
    assert.equal(modName("zz"), "");
    assert.equal(modName(Buffer.concat([Buffer.from("JKMD"), Buffer.from([2, 2, 0]), Buffer.alloc(16)]).toString("hex")),
                 "Remastered pack");
    assert.equal(cleanText("  \u200bhi\u0000 ", 32), "hi");
});

let failed = 0;
for (const t of tests) {
    try {
        t.fn();
        console.log("ok   " + t.name);
    } catch (e) {
        failed++;
        console.log("FAIL " + t.name + "\n" + e.stack);
    }
}
console.log(`${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
