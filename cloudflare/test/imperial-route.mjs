// Checks /imperial-games (src/imperial.js) against a made-up Imperial
// Network Protocol relay that this starts on a port of its own, with
// `wrangler dev` pointed at it. Needs Node.js 22 or newer.
//
//   npx wrangler dev --port 8797 --var IMPERIAL_LIST:127.0.0.1:8799 --var IMPERIAL_TIMEOUT_MS:1500 \
//       --var IMPERIAL_CACHE_S:2
//   node test/imperial-route.mjs http://127.0.0.1:8797 8799
//
// Answers are cached, so each step waits for the last one to run out: 2 s
// for a list, 4 s for a relay that didn't answer (IMPERIAL_CACHE_S, set
// short here). With "off" after the port, it only checks that a lobby run
// with IMPERIAL_LIST empty answers 404:
//
//   npx wrangler dev --port 8797 --var IMPERIAL_LIST:
//   node test/imperial-route.mjs http://127.0.0.1:8797 8799 off
//
// It prints a line for each check and exits 1 if one fails.
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const base = new URL(process.argv[2] || "http://127.0.0.1:8797");
const relayPort = Number(process.argv[3] || 8799);
const off = process.argv[4] === "off";
const CACHE_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Waits out the cached answer of the step before.
let keptUntil = 0;
const fresh = () => sleep(Math.max(0, keptUntil - Date.now()) + 200);

// The real relay's WELCOME and LISTREPLY on 31 Oct 2026 (seq 1 and 2): one
// game, Coruscant, through the gateway.
const WELCOME = "4a524b3120010000c5a4623d01000000c5a4623d";
const CORUSCANT = "4a524b3122010700c5a4623d020000000100010013e5dd93743f59055bbf297508845b2b" +
    "c000006820000000010000000215cf8a180000000a000000140000001743006f00720075007300630061006e0074003a" +
    "004a004b0031004300540046003a00630033002e006a006b006c00795ef8a2386d0100";

// A list reply of games hosted on the relay (no addresses, no tails).
function listReply(seq, total, names) {
    const parts = [Buffer.alloc(20)];
    parts[0].writeUInt32LE(0x314B524A, 0);
    parts[0][4] = 34; parts[0][5] = 1;
    parts[0].writeUInt16LE(7, 6);
    parts[0].writeUInt32LE(seq, 12);
    parts[0].writeUInt16LE(total, 16);
    parts[0].writeUInt16LE(names.length, 18);
    names.forEach((name, i) => {
        const d = Buffer.alloc(45);
        d[0] = 0x10 + i;
        d.writeUInt32LE(0x20000000, 16);
        d.writeUInt32LE(8, 20);
        d.writeUInt32LE(2, 24);
        d[44] = name.length;
        parts.push(d, Buffer.from(name, "utf16le"), Buffer.alloc(7), Buffer.from([0]));
    });
    return Buffer.concat(parts);
}

// The made-up relay: a WebSocket server that answers HELLO and LIST the way
// mode says.
const relay = { mode: "normal", connections: 0, lists: [] };
function answer(ws, p) {
    const type = p[4], seq = p.readUInt32LE(12);
    if (relay.mode === "silent")
        return;
    if (relay.mode === "garbage")
        return send(ws, Buffer.from("not a relay at all"));
    if (type === 1)
        return send(ws, Buffer.from(WELCOME, "hex"));
    if (type !== 3)
        return;
    const start = p.readUInt32LE(16 + 16);
    relay.lists.push({ start, flags: p.readUInt32LE(16 + 20), guid: p.subarray(16, 32).toString("hex") });
    if (relay.mode === "oversized")
        return send(ws, Buffer.concat([Buffer.from(CORUSCANT, "hex"), Buffer.alloc(2100)]));
    if (relay.mode === "paged") {
        // Three games, two to a reply, after a keepalive the route has to skip.
        const keepalive = Buffer.alloc(16);
        keepalive.writeUInt32LE(0x314B524A, 0); keepalive[4] = 65; keepalive[5] = 1;
        send(ws, keepalive);
        return send(ws, listReply(seq, 3, ["Duels:JK1MP.gob:01narshadda.jkl", "Asteroid:JKM_MP.goo:jkm_mp.jkl",
                                           "FFA:JK1MP.gob:01narshadda.jkl"].slice(start, start + 2)));
    }
    const reply = Buffer.from(CORUSCANT, "hex");
    reply.writeUInt32LE(seq, 12);
    send(ws, reply);
}
function send(socket, data) {
    const head = data.length < 126 ? Buffer.from([0x82, data.length])
        : data.length < 65536 ? Buffer.from([0x82, 126, data.length >> 8, data.length & 255])
        : null;
    socket.write(Buffer.concat([head, data]));
}
const server = http.createServer((req, res) => { res.writeHead(426); res.end("WebSocket only"); });
server.on("upgrade", (req, socket) => {
    relay.connections++;
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                 `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const op = buf[0] & 15, masked = buf[1] & 128;
            let len = buf[1] & 127, at = 2;
            if (len === 126) { len = buf.readUInt16BE(2); at = 4; }
            if (len === 127) { len = Number(buf.readBigUInt64BE(2)); at = 10; }
            const need = at + (masked ? 4 : 0) + len;
            if (buf.length < need) return;
            const mask = masked ? buf.subarray(at, at + 4) : null;
            const payload = Buffer.from(buf.subarray(at + (masked ? 4 : 0), need));
            if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            buf = buf.subarray(need);
            if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
            if (op === 2) answer(socket, payload);
        }
    });
    socket.on("error", () => {});
});
await new Promise(resolve => server.listen(relayPort, "127.0.0.1", resolve));

// { status, headers, json, ms } for /imperial-games.
async function ask(method = "GET") {
    const t0 = Date.now();
    const res = await fetch(new URL("/imperial-games", base), { method });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    if (json)
        keptUntil = Date.now() + (json.state === "live" ? CACHE_MS : 2 * CACHE_MS);
    return { status: res.status, headers: Object.fromEntries(res.headers), json, ms: Date.now() - t0 };
}

let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log("ok   " + name);
    } catch (e) {
        failed++;
        console.log("FAIL " + name + "\n" + (e.stack || e));
    }
}

if (off) {
    await check("without IMPERIAL_LIST the route is off", async () => {
        const r = await ask();
        assert.equal(r.status, 404);
        assert.equal(relay.connections, 0);
    });
} else {
    await check("the relay's list, Coruscant pinned first", async () => {
        const r = await ask();
        assert.equal(r.status, 200);
        assert.match(r.headers["content-type"], /^application\/json/);
        assert.equal(r.headers["cache-control"], "no-store");
        assert.equal(r.json.state, "live");
        assert.equal(r.json.server, "127.0.0.1:8799");
        assert.deepEqual(r.json.games.map(g => [g.name, g.key, g.pinned, g.listed, g.joinable, g.players, g.max, g.map]),
                         [["Coruscant", "13e5dd93743f59055bbf297508845b2b", true, true, true, 0, 31, "c3.jkl"]]);
        assert.equal(relay.connections, 1);
        assert.deepEqual(relay.lists, [{ start: 0, flags: 7, guid: "c01306bf79ded01199c900a02476ad4b" }]);
    });

    await check("asked again while it's kept, it comes from the cache", async () => {
        const r = await ask();
        assert.equal(r.json.state, "live");
        assert.equal(r.headers["cache-control"], "no-store");
        assert.equal(relay.connections, 1);
    });

    await check("a list over two replies, with a keepalive between", async () => {
        await fresh();
        relay.mode = "paged";
        relay.lists = [];
        const r = await ask();
        assert.equal(r.json.state, "live");
        assert.deepEqual(r.json.games.map(g => [g.name, g.game, g.listed, g.why]), [
            ["Coruscant", "jk1", false, "not-listed"], ["Duels", "jk1", true, ""], ["Asteroid", "mots", true, ""],
            ["FFA", "jk1", true, ""]]);
        assert.deepEqual(relay.lists.map(l => l.start), [0, 2]);
    });

    for (const [mode, what] of [["silent", "a relay that never answers"], ["garbage", "a relay that answers garbage"],
                                ["oversized", "a reply too big to be one"]]) {
        await check(what + ": down, Coruscant greyed out", async () => {
            await fresh();
            relay.mode = mode;
            const r = await ask();
            assert.equal(r.status, 200);
            assert.equal(r.json.state, "down");
            assert.deepEqual(r.json.games.map(g => [g.name, g.listed, g.joinable, g.why]),
                             [["Coruscant", false, false, "relay-down"]]);
            assert.ok(r.ms < 5000, `answered in ${r.ms} ms`);
        });
    }

    await check("a relay that isn't there at all: down", async () => {
        await fresh();
        relay.mode = "normal";
        server.close();
        server.closeAllConnections();
        await sleep(100);
        const r = await ask();
        assert.equal(r.json.state, "down");
    });

    await check("only GET and HEAD", async () => {
        const r = await ask("POST");
        assert.equal(r.status, 405);
    });
}

server.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
