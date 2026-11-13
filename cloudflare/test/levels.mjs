// Checks the Level Library's job (src/levels.js, src/levels-read.js): reading
// Massassi's lists and pages, opening zips and GOBs, release dates, and the
// job itself run against a stand-in for Massassi, with the Durable Object's
// SQLite stood in for by Node's own and R2 by a map. Needs Node.js 22.5 or
// newer.
//
//   node test/levels.mjs
//
// It prints a line for each check and exits 1 if one fails.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";

const stubUrl = new URL("./cfstub.mjs", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const realResponse = globalThis.Response;
const { FakeStorage } = await import("./cfstub.mjs");
// The stub's Response is for the lobby's 101; these routes need the real one.
globalThis.Response = realResponse;
const read = await import("../src/levels-read.js");
const { LevelJob, levelsRoute } = await import("../src/levels.js");
const { JkUnzip } = await import("../src/vendor/jkunzip.js");

let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log("ok  ", name);
    } catch (e) {
        failed++;
        console.log("FAIL", name);
        console.log(e && e.stack || e);
    }
}

const sha = b => createHash("sha256").update(b).digest("hex");
const enc = s => new TextEncoder().encode(s);

// ---- Building zips and GOBs for the checks

function crc32(b) {
    return JkUnzip.crc32(b);
}

function dosDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return ((y - 1980) << 9) | (m << 5) | d;
}

// files: [{ name, data, date, store }]
function makeZip(files) {
    const parts = [], cd = [];
    let at = 0;
    for (const f of files) {
        const data = typeof f.data === "string" ? enc(f.data) : f.data;
        const comp = f.store ? data : new Uint8Array(deflateRawSync(data));
        const method = f.store ? 0 : 8;
        const name = enc(f.name);
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true);
        h.setUint16(10, 0, true); h.setUint16(12, dosDate(f.date || "1999-10-15"), true);
        h.setUint32(14, crc32(data), true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true);
        h.setUint16(26, name.length, true);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true);
        c.setUint16(14, dosDate(f.date || "1999-10-15"), true); c.setUint32(16, crc32(data), true);
        c.setUint32(20, comp.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
        c.setUint32(42, at, true);
        parts.push(new Uint8Array(h.buffer), name, comp);
        cd.push(new Uint8Array(c.buffer), name);
        at += 30 + name.length + comp.length;
    }
    const cdLen = cd.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdLen, true); e.setUint32(16, at, true);
    return new Uint8Array(Buffer.concat([...parts, ...cd, new Uint8Array(e.buffer)]));
}

function makeGob(files) {
    const datas = files.map(f => typeof f.data === "string" ? enc(f.data) : f.data);
    const headLen = 12;
    let at = headLen;
    const offs = datas.map(d => { const o = at; at += d.length; return o; });
    const table = new Uint8Array(4 + files.length * 136);
    const tv = new DataView(table.buffer);
    tv.setUint32(0, files.length, true);
    files.forEach((f, i) => {
        tv.setUint32(4 + i * 136, offs[i], true);
        tv.setUint32(8 + i * 136, datas[i].length, true);
        table.set(enc(f.name), 12 + i * 136);
    });
    const head = new Uint8Array(12);
    head.set(enc("GOB "));
    new DataView(head.buffer).setUint32(4, 20, true);
    new DataView(head.buffer).setUint32(8, at, true);
    return new Uint8Array(Buffer.concat([head, ...datas, table]));
}

const EPISODE = `"6000 Block"
# a comment
TYPE 2
SEQ 2
10: 0 0 LEVEL 6000.jkl 0 0 -1 -1
20: 0 0 LEVEL 6000s.jkl 0 0 -1 -1
`;
const GOB = makeGob([{ name: "episode.jk", data: EPISODE }, { name: "jkl\\6000.jkl", data: "SECTION: JK\n".repeat(50) }]);
const README = `6000 Block
Title                   : 6000 Block
Author                  : Brian Lozier
Date of Release         : October 16, 1999
`;
const ZIP = makeZip([{ name: "6000.gob", data: GOB, date: "1999-10-15" }, { name: "6000.txt", data: README, date: "1999-10-16" }]);

// ---- Reading

await check("a level list's rows", async () => {
    const html = `<div class="level-list-grid-container">
        <div class="level-list-screenshot"><a href="/levels/files/1436.shtml"><img src="/x.jpg"></a></div>
        <div class="level-list-item">
            <strong><a href="/levels/files/1436.shtml">Base Assault CTF</a></strong><br>
            <span class="mute">By:</span> Berlick B&#x27;ja<br>
            <span class="mute">Added:</span> 2001-04-08<br>
        </div>
        <div class="level-list-details">
            <span class="mute">Rating:</span>
                <strong><span class="level-good">7</span></strong>
            <span class="mute">(4 votes)</span><br>
            <span class="mute">Comments: 11</span><br>
            <span class="mute">Downloads:</span> 2351
        </div>
        <div class="level-list-screenshot"><a href="/levels/files/2766.shtml"></a></div>
        <div class="level-list-item">
            <strong><a href="/levels/files/2766.shtml">Battle &amp; CTF</a></strong><br>
            <span class="mute">By:</span> [SF]PJB<br>
            <span class="mute">Added:</span> 2003-08-12<br>
        </div>
        <div class="level-list-details"><span class="mute">Rating:</span> <span class="mute">(0 votes)</span><br>
            <span class="mute">Downloads:</span> 866</div>`;
    assert.deepEqual(read.parseList(html), [
        { id: 1436, title: "Base Assault CTF", author: "Berlick B'ja", added: "2001-04-08", rating: 7, votes: 4, comments: 11, dl: 2351 },
        { id: 2766, title: "Battle & CTF", author: "[SF]PJB", added: "2003-08-12", rating: null, votes: 0, comments: 0, dl: 866 },
    ]);
});

const PAGE = `<nav><h1>Resources</h1></nav><div id="content">
    <h1>6000 Block</h1>
    <p class="crumb"><a href="/">The Massassi Temple</a> &raquo; <a href="/levels/">Levels/Mods</a> &raquo;
        <a href="/levels/jkmp/">Jedi Knight Multiplayer Level</a> &raquo; <a href="/levels/files/323.shtml">6000 Block</a></p>
    <div class="level-description">
        <h2>Description</h2>
        <p>6000 Block is the sequel to 5600 Block.<br>Force jump is recommended.</p>
    </div>
    <div class="level-screenshots"><h2>Screenshots</h2>
        <a href="/media/levels/screenshots/323_1.jpg"><img src="/media/CACHE/a.jpg"></a>
        <a href="/media/levels/screenshots/323_2.jpg"><img src="/media/CACHE/b.jpg"></a>
    </div>
    <div class="level-info">
        <div class="level-info-item-name">Download:</div>
        <div class="level-info-item-value"><a href="/levels/download/323/">6000 Block</a></div>
        <div class="level-info-item-name">File Size:</div>
        <div class="level-info-item-value">226.0&nbsp;KiB</div>
        <div class="level-info-item-name">Date:</div>
        <div class="level-info-item-value">2000-06-02</div>
        <div class="level-info-item-name">Author:</div>
        <div class="level-info-item-value">Brian Lozier</div>
        <div class="level-info-item-name">Downloads:</div>
        <div class="level-info-item-value">5231</div>
    </div>
    <div class="level-info">
        <div class="level-info-item-name">Score (0-10):</div>
        <div class="level-info-item-value">  8  </div>
        <div class="level-info-item-name"># of Ratings:</div>
        <div class="level-info-item-value">33</div>
    </div>
    <div class="level-3d-preview"><h2>3D Preview</h2>
        <iframe src="https://3dpreview.massassi.net/level/?ownsgame=1&amp;url=https://www.massassi.net/media/levels/files/jkmp/6000.zip"></iframe>
    </div></div>`;

await check("a level's page, and the zip's direct address from its 3D Preview", async () => {
    const p = read.parsePage(PAGE, 323);
    assert.equal(p.title, "6000 Block");
    assert.equal(p.cat, "jkmp");
    assert.equal(p.desc, "6000 Block is the sequel to 5600 Block.\nForce jump is recommended.");
    assert.deepEqual(p.shots, ["/media/levels/screenshots/323_1.jpg", "/media/levels/screenshots/323_2.jpg"]);
    assert.equal(p.size, "226.0 KiB");
    assert.equal(read.sizeBytes(p.size), 231424);
    assert.equal(p.date, "2000-06-02");
    assert.equal(p.author, "Brian Lozier");
    assert.equal(p.dl, 5231);
    assert.equal(p.rating, 8);
    assert.equal(p.votes, 33);
    assert.equal(p.zip, "https://www.massassi.net/media/levels/files/jkmp/6000.zip");
});

await check("only Massassi's level files are taken as a zip's address", async () => {
    assert.equal(read.directZip("https://evil.example/media/levels/files/jkmp/a.zip"), null);
    assert.equal(read.directZip("https://www.massassi.net/levels/download/323/"), null);
    assert.equal(read.directZip("https://www.massassi.net/media/levels/files/jkmp/a.zip?x=1"), null);
    assert.equal(read.directZip("http://massassi.net/media/levels/files/motsmp/a.zip"),
                 "https://www.massassi.net/media/levels/files/motsmp/a.zip");
    assert.equal(read.parsePage(PAGE.replace(/<div class="level-3d-preview">[\s\S]*$/, ""), 323).zip, null);
});

await check("a zip's entries, a GOB's files and its episode", async () => {
    const z = await read.openZip(read.memReader(ZIP));
    assert.deepEqual(z.entries.map(e => [e.name, e.size, e.date]), [["6000.gob", GOB.length, "1999-10-15"], ["6000.txt", README.length, "1999-10-16"]]);
    const gob = await read.readEntry(z, z.entries[0]);
    assert.equal(sha(gob), sha(GOB));
    const files = read.parseGob(gob);
    assert.deepEqual(files.map(f => f.name), ["episode.jk", "jkl/6000.jkl"]);
    const ep = read.parseEpisode(new TextDecoder().decode(gob.subarray(files[0].offset, files[0].offset + files[0].size)));
    assert.deepEqual(ep, { title: "6000 Block", type: 2, levels: ["6000.jkl", "6000s.jkl"] });
});

await check("stored entries, and a bad CRC is refused", async () => {
    const zs = makeZip([{ name: "a.gob", data: GOB, store: true }]);
    const z = await read.openZip(read.memReader(zs));
    assert.equal(sha(await read.readEntry(z, z.entries[0])), sha(GOB));
    z.entries[0].crc ^= 1;
    await assert.rejects(read.readEntry(z, z.entries[0]), /CRC/);
});

await check("readmes: UTF-8, Windows-1252, the DOS code page, and Word files", async () => {
    assert.equal(read.decodeText(enc("Café")), "Café");
    assert.equal(read.decodeText(new Uint8Array([0x93, 0x68, 0x69, 0x94])), "“hi”");
    assert.equal(read.decodeText(new Uint8Array([0x81, 0x20, 0xb0])), "ü ░");
    const doc = new Uint8Array(400);
    doc.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    doc.set(enc("Title : Some Level Date of Release : March 4, 2001"), 100);
    const t = read.decodeText(doc);
    assert.match(t, /\nRelease : March 4, 2001/);
    assert.equal(read.releaseDate([{ name: "r.doc", text: t }], [], null, "2026-11-13").date, "2001-03-04");
});

const T = "2026-11-13";
const rd = (text, files, massassi) => read.releaseDate([{ name: "readme.txt", text }], files || [], massassi || null, T);

await check("release dates: a labelled readme date first", async () => {
    let r = rd("Date of Release : October 16, 1999", ["1999-10-15"], "2000-06-02");
    assert.deepEqual([r.date, r.precision, r.source, r.flags], ["1999-10-16", "day", "readme", []]);
    r = rd("Date of Release: 26/10/1999", ["1999-10-26"]);
    assert.deepEqual([r.date, r.precision], ["1999-10-26", "day"]);
    r = rd("Release Date: September 1999", ["1999-09-26"]);
    assert.deepEqual([r.date, r.precision, r.sort], ["1999-09-01", "month", "1999-09-26"]);
    r = rd("Release date: IV 2002", []);
    assert.deepEqual([r.date, r.precision], ["2002-04-01", "month"]);
    r = rd("Date of release: May/2004", []);
    assert.deepEqual([r.date, r.precision], ["2004-05-01", "month"]);
    r = rd("Released: march 18/03", []);
    assert.deepEqual([r.date, r.precision], ["2003-03-18", "day"]);
});

await check("release dates: 5/8/99 read the way the files' date says", async () => {
    let r = rd("Date of Release: 5/8/99", ["1999-08-04"]);
    assert.equal(r.date, "1999-08-05");
    r = rd("Date of Release: 5/8/99", ["1999-05-07"]);
    assert.equal(r.date, "1999-05-08");
    r = rd("Date of Release: 5/8/99", []);
    assert.deepEqual([r.date, r.flags], ["1999-05-08", ["dd/mm unclear"]]);
    r = rd("Date of Release: 3/20", ["2001-03-22"]);
    assert.equal(r.date, "2001-03-20");
});

await check("release dates: the files' date when the readme has none, or only a start date", async () => {
    let r = rd("No date here at all", ["2001-03-04", "2001-02-27"], "2001-03-10");
    assert.deepEqual([r.date, r.source, r.how], ["2001-03-04", "files", "file dates only"]);
    r = rd("Started on 25th January 2001", ["2001-03-04"]);
    assert.deepEqual([r.date, r.source, r.flags], ["2001-03-04", "files", ["unlabeled readme date"]]);
    r = read.releaseDate([], [], "2000-06-02", T);
    assert.deepEqual([r.date, r.source], [null, null]);
    r = read.releaseDate([], [], "2003-05-01", T);
    assert.deepEqual([r.date, r.source], ["2003-05-01", "massassi"]);
});

// ---- The job, against a stand-in for Massassi

class FakeSql {
    constructor() {
        this.db = new DatabaseSync(":memory:");
    }
    exec(sql, ...params) {
        if (!params.length && sql.split(";").filter(s => s.trim()).length > 1) {
            this.db.exec(sql);
            return { toArray: () => [] };
        }
        const st = this.db.prepare(sql);
        const rows = /^\s*SELECT/i.test(sql) ? st.all(...params) : (st.run(...params), []);
        return { toArray: () => rows.map(r => ({ ...r })) };
    }
}

class FakeR2 {
    constructor() {
        this.m = new Map();
    }
    async put(key, body, opts) {
        let bytes;
        if (body instanceof Uint8Array) bytes = body;
        else if (typeof body === "string") bytes = enc(body);
        else bytes = new Uint8Array(await new Response(body).arrayBuffer());
        this.m.set(key, { bytes, httpMetadata: (opts && opts.httpMetadata) || {}, customMetadata: (opts && opts.customMetadata) || {} });
    }
    obj(key, o, range) {
        const b = range ? o.bytes.subarray(range.offset, range.offset + range.length) : o.bytes;
        return {
            size: o.bytes.length, httpEtag: `"${sha(o.bytes).slice(0, 16)}"`, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata,
            body: new Blob([b]).stream(), arrayBuffer: async () => b.slice().buffer, json: async () => JSON.parse(new TextDecoder().decode(b)),
        };
    }
    async get(key, opts) {
        const o = this.m.get(key);
        if (!o) return null;
        const r = this.obj(key, o, opts && opts.range);
        if (opts && opts.onlyIf && opts.onlyIf.etagDoesNotMatch === r.httpEtag.replace(/"/g, ""))
            r.body = null;
        return r;
    }
    async head(key) {
        const o = this.m.get(key);
        return o ? { ...this.obj(key, o), body: undefined } : null;
    }
}

const LIST = `<div class="level-list-screenshot"></div><div class="level-list-item">
    <strong><a href="/levels/files/323.shtml">6000 Block</a></strong><br>
    <span class="mute">By:</span> Brian Lozier<br><span class="mute">Added:</span> 2000-06-02<br></div>
    <div class="level-list-details"><span class="mute">Downloads:</span> 5231</div>
    <div class="level-list-screenshot"></div><div class="level-list-item">
    <strong><a href="/levels/files/400.shtml">Gone Level</a></strong><br>
    <span class="mute">By:</span> X<br><span class="mute">Added:</span> 2001-01-01<br></div>
    <div class="level-list-details"><span class="mute">Downloads:</span> 10</div>`;

function fakeMassassi(extra) {
    const seen = [];
    const routes = Object.assign({
        "/levels/jkmp/?num=9999": () => new Response(LIST),
        "/levels/files/323.shtml": () => new Response(PAGE),
        "/media/levels/files/jkmp/6000.zip": () => new Response(ZIP, { headers: { "Content-Length": String(ZIP.length) } }),
        "/media/levels/screenshots/323_1.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 1])),
        "/media/levels/screenshots/323_2.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 2])),
    }, extra || {});
    globalThis.fetch = async (url, init) => {
        const u = new URL(url);
        assert.equal(u.origin, "https://www.massassi.net");
        assert.match(init.headers["User-Agent"], /^Mozilla\/5\.0 \(compatible; level-index/);
        const p = u.pathname + u.search;
        seen.push(p);
        const r = routes[p];
        if (r) return r();
        if (/^\/levels\/[a-z]+\/\?num=9999$/.test(p)) return new Response("<p>No levels.</p>");
        return new Response("Not found", { status: 404 });
    };
    return seen;
}

class Ctx {
    constructor() {
        this.storage = new FakeStorage();
        this.storage.sql = new FakeSql();
    }
}

function newJob(vars) {
    const env = { LEVELS: new FakeR2(), LEVELS_PACE_MS: "1000", ...vars };
    const job = new LevelJob(new Ctx(), env);
    env.LEVELJOB = { idFromName: () => 1, get: () => ({ fetch: r => job.fetch(new Request(r)) }) };
    return { job, env };
}

async function runUntilIdle(job, max) {
    for (let i = 0; i < (max || 50); i++) {
        const before = job.kv("req_total");
        await job.alarm();
        if (job.kv("req_total") === before)
            return i;
    }
    throw new Error("still busy");
}

await check("the job: lists, then each level's page, zip and pictures, then the index", async () => {
    const seen = fakeMassassi();
    const { job, env } = newJob();
    await job.fetch(new Request("https://levels/kick"));
    assert.ok(await job.ctx.storage.getAlarm());
    await runUntilIdle(job);
    assert.deepEqual(seen.filter(p => !p.includes("num=9999") || p.startsWith("/levels/jkmp")), [
        "/levels/jkmp/?num=9999",
        "/levels/files/323.shtml", "/media/levels/files/jkmp/6000.zip",
        "/media/levels/screenshots/323_1.jpg", "/media/levels/screenshots/323_2.jpg",
        "/levels/files/400.shtml",
    ]);
    // Never the download link.
    assert.ok(!seen.some(p => p.includes("/levels/download/")));
    assert.equal(seen.filter(p => p.includes("num=9999")).length, 6);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.listed, 2);
    assert.equal(idx.left, 0);
    assert.equal(idx.levels.length, 1);
    const l = idx.levels[0];
    assert.deepEqual([l.id, l.k, l.t, l.a, l.rel, l.rp, l.src, l.add, l.sz, l.dl, l.sh, l.z, l.h],
                     [323, "mp", "6000 Block", "Brian Lozier", "1999-10-16", "d", "r", "2000-06-02", ZIP.length, 5231, 2, "6000.zip", sha(ZIP)]);
    assert.deepEqual(l.g, [{ n: "6000.gob", h: sha(GOB), b: GOB.length, ep: "6000 Block", ty: 2, lv: ["6000.jkl", "6000s.jkl"] }]);
    const d = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("detail/323.json").bytes));
    assert.equal(d.desc, "6000 Block is the sequel to 5600 Block.\nForce jump is recommended.");
    assert.equal(d.texts[0].n, "6000.txt");
    assert.match(d.texts[0].t, /Date of Release/);
    assert.equal(d.date.line, "Date of Release         : October 16, 1999");
    assert.deepEqual(d.files.map(f => f.n), ["6000.gob", "6000.txt"]);
    assert.deepEqual([...env.LEVELS.m.get("zip/323.zip").bytes], [...ZIP]);
    assert.equal(env.LEVELS.m.get("zip/323.zip").customMetadata.sha256, sha(ZIP));
    assert.ok(env.LEVELS.m.has("shot/323-2"));
    const st = await job.status();
    assert.equal(st.requests_total, 11);
    assert.deepEqual(st.not_ready, [{ st: "gone", n: 1 }]);
});

await check("the job asks Massassi again only for what's new", async () => {
    let seen = fakeMassassi();
    const { job } = newJob();
    await runUntilIdle(job);
    seen.length = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + 13 * 3600 * 1000;
    try {
        await runUntilIdle(job);
    } finally {
        Date.now = realNow;
    }
    assert.equal(seen.length, 6);
    assert.ok(seen.every(p => p.endsWith("?num=9999")));
});

await check("Massassi busy: everything waits, and the level isn't charged", async () => {
    const seen = fakeMassassi({ "/levels/files/323.shtml": () => new Response("busy", { status: 503 }) });
    const { job } = newJob();
    for (let i = 0; i < 7; i++)
        await job.alarm();
    const before = seen.length;
    await job.alarm();
    await job.alarm();
    assert.equal(seen.length, before);
    assert.ok(Number(job.kv("backoff_until")) > Date.now() + 9 * 60 * 1000);
    assert.equal(job.sql.exec("SELECT tries FROM lv WHERE id = 323").toArray()[0].tries, 0);
});

await check("a zip that isn't one is kept as bad, and stays out of the index", async () => {
    fakeMassassi({ "/media/levels/files/jkmp/6000.zip": () => new Response("<html>not a zip</html>") });
    const { job, env } = newJob();
    await runUntilIdle(job);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.levels.length, 0);
    assert.equal(job.sql.exec("SELECT zip_st FROM lv WHERE id = 323").toArray()[0].zip_st, "bad");
});

await check("a GOB in a zip inside the zip", async () => {
    const outer = makeZip([{ name: "readme.txt", data: "Release Date: 12/2000" }, { name: "inner.zip", data: ZIP, store: true }]);
    fakeMassassi({ "/media/levels/files/jkmp/6000.zip": () => new Response(outer) });
    const { job, env } = newJob();
    await runUntilIdle(job);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.levels[0].g[0].in, "inner.zip");
    assert.equal(idx.levels[0].g[0].h, sha(GOB));
    // Both readmes count: a day ("October 16, 1999") before a month.
    assert.equal(idx.levels[0].rel, "1999-10-16");
});

await check("past LEVELS_MAX_GB no more zips are copied", async () => {
    fakeMassassi();
    const { job, env } = newJob({ LEVELS_MAX_GB: "0.0000001" });
    await runUntilIdle(job);
    assert.equal(job.sql.exec("SELECT zip_st FROM lv WHERE id = 323").toArray()[0].zip_st, "full");
    assert.ok(!env.LEVELS.m.has("zip/323.zip"));
});

await check("the routes serve the index, details, zips and pictures", async () => {
    fakeMassassi();
    const { job, env } = newJob();
    await runUntilIdle(job);
    const get = (p, h) => levelsRoute(new Request("https://beta.example" + p, { headers: h }), env, new URL("https://beta.example" + p));
    let r = await get("/levels/jk1.json");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(await r.text()).levels[0].id, 323);
    r = await get("/levels/jk1.json", { "If-None-Match": r.headers.get("ETag") });
    assert.equal(r.status, 304);
    r = await get("/levels/z/323.zip?h=" + sha(ZIP));
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(sha(new Uint8Array(await r.arrayBuffer())), sha(ZIP));
    r = await get("/levels/z/323.zip?h=" + "0".repeat(64));
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=3600");
    r = await get("/levels/s/323-1.jpg");
    assert.equal(r.headers.get("Content-Type"), "image/jpeg");
    r = await get("/levels/d/323.json");
    assert.equal(JSON.parse(await r.text()).id, 323);
    assert.equal((await get("/levels/d/999.json")).status, 404);
    assert.equal((await get("/levels/z/323.zip/x")).status, 404);
    assert.equal(await get("/levels/../x"), null);
    r = await get("/levels/status");
    assert.equal(JSON.parse(await r.text()).requests_total, 11);
    assert.equal(await levelsRoute(new Request("https://b/levels/jk1.json"), {}, new URL("https://b/levels/jk1.json")), null);
});

await check("LEVELS_FETCH = \"0\" stops the job", async () => {
    const seen = fakeMassassi();
    const { job } = newJob({ LEVELS_FETCH: "0" });
    await job.fetch(new Request("https://levels/kick"));
    assert.equal(await job.ctx.storage.getAlarm(), null);
    await job.alarm();
    assert.equal(seen.length, 0);
});

if (failed) {
    console.log(`${failed} failed`);
    process.exit(1);
}
console.log("all ok");
