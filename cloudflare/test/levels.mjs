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
import { deflateRawSync, gunzipSync } from "node:zlib";

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
const parts = await import("../src/levels-parts.js");
const { LevelJob, levelsRoute, gobTable } = await import("../src/levels.js");
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
// A colormap: "CMP ", version 30, no transparency, 52 bytes, then 256 colors.
const CMP = new Uint8Array(64 + 768 + 64 * 256);
CMP.set(enc("CMP "));
CMP[4] = 30;
for (let i = 0; i < 768; i++)
    CMP[64 + i] = i & 255;
const JKL = "SECTION: JK\n".repeat(50) + "\nSECTION: GEORESOURCE\n\n# colormaps\nWorld Colormaps 2\n0:\tLev6000.CMP\n1:\tdflt.cmp\n";
const GOB = makeGob([{ name: "episode.jk", data: EPISODE }, { name: "jkl\\6000.jkl", data: JKL },
                     { name: "mat\\Wall6000.mat", data: "MAT " }, { name: "misc\\cmp\\lev6000.cmp", data: CMP }]);
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
    assert.deepEqual(files.map(f => f.name), ["episode.jk", "jkl/6000.jkl", "mat/Wall6000.mat", "misc/cmp/lev6000.cmp"]);
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
    async delete(key) {
        this.m.delete(key);
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

// The 3D preview's data for 6000.zip, as 3dpreview.massassi.net sends it.
const PV_ZIP = "https://www.massassi.net/media/levels/files/jkmp/6000.zip";
const PV_MAP = JSON.stringify({ surfaces: [{ vertices: [[[0, 0, 0], [0, 0], 1], [[1, 0, 0], [1, 0], 1], [[1, 1, 0], [1, 1], 1]], material: 0 }],
                                model_surfaces: [], sky_surfaces: [], material_colors: ["#858559"], spawn_points: [{ pos: [0, 0, 0], rot: [0, 90, 0] }] });
const PV_MAT = JSON.stringify([{ data: "data:image/png;base64,iVBORw0KGgo=", name: "3do/mat/dflt.mat" }]);
const pvUrl = (what, zip, ep) => `pv:/level/${what}.json?version=14&url=${zip || PV_ZIP}&episode=${ep || 0}`;
const gunzip = b => new TextDecoder().decode(gunzipSync(b));
// The preview's page for 6000.zip: of its episode's two levels, one loads.
const VIEWER1 = `<script>var maps = JSON.parse("[[\\"6000\\", \\"?url=${PV_ZIP}\\u0026episode=0\\"]]");</script>`;

function fakeMassassi(extra) {
    const seen = [];
    const routes = Object.assign({
        [`pv:/level/?url=${PV_ZIP}`]: () => new Response(VIEWER1),
        [pvUrl("map")]: () => new Response(PV_MAP),
        [pvUrl("mat")]: () => new Response(PV_MAT),
        "/levels/jkmp/?num=9999": () => new Response(LIST),
        "/levels/files/323.shtml": () => new Response(PAGE),
        "/media/levels/files/jkmp/6000.zip": () => new Response(ZIP, { headers: { "Content-Length": String(ZIP.length) } }),
        "/media/levels/screenshots/323_1.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 1])),
        "/media/levels/screenshots/323_2.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 2])),
    }, extra || {});
    globalThis.fetch = async (url, init) => {
        const u = new URL(url);
        assert.ok(["https://www.massassi.net", "https://3dpreview.massassi.net", "https://www.jkdf2.net"].includes(u.origin), u.origin);
        assert.match(init.headers["User-Agent"], /^Mozilla\/5\.0 \(compatible; level-index/);
        const p = (u.origin.startsWith("https://3d") ? "pv:" : u.origin.includes("jkdf2") ? "df2:" : "") + u.pathname + u.search;
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
    // jkdf2.net's part of the job is off unless a check turns it on.
    const env = { LEVELS: new FakeR2(), LEVELS_PACE_MS: "1000", LEVELS_DF2: "0", ...vars };
    const job = new LevelJob(new Ctx(), env);
    env.LEVELJOB = { idFromName: () => 1, get: () => ({ fetch: r => job.fetch(new Request(r)) }) };
    return { job, env };
}

async function runUntilIdle(job, max) {
    for (let i = 0; i < (max || 50); i++) {
        const before = job.kv("req_total") + "/" + job.kv("steps");
        await job.alarm();
        if (job.kv("req_total") + "/" + job.kv("steps") === before)
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
        // Its episode has two levels: the preview's page, for the ones it has.
        `pv:/level/?url=${PV_ZIP}`, pvUrl("map"), pvUrl("mat"),
        "/levels/files/400.shtml",
    ]);
    // Never the download link.
    assert.ok(!seen.some(p => p.includes("/levels/download/")));
    assert.equal(seen.filter(p => p.includes("num=9999")).length, 8);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.listed, 2);
    assert.equal(idx.left, 0);
    assert.equal(idx.levels.length, 1);
    const l = idx.levels[0];
    assert.deepEqual([l.id, l.k, l.t, l.a, l.rel, l.rp, l.src, l.add, l.sz, l.dl, l.sh, l.z, l.h],
                     [323, "mp", "6000 Block", "Brian Lozier", "1999-10-16", "d", "r", "2000-06-02", ZIP.length, 5231, 2, "6000.zip", sha(ZIP)]);
    assert.deepEqual(l.g, [{ n: "6000.gob", h: sha(GOB), b: GOB.length, ep: "6000 Block", ty: 2, lv: ["6000.jkl", "6000s.jkl"] }]);
    // Its 3D data, a map and its textures, kept gzip.
    assert.deepEqual(l.pv, ["6000"]);
    assert.equal(gunzip(env.LEVELS.m.get("pv/323-0.map.json").bytes), PV_MAP);
    assert.equal(gunzip(env.LEVELS.m.get("pv/323-0.mat.json").bytes), PV_MAT);
    assert.equal(env.LEVELS.m.get("pv/323-0.map.json").httpMetadata.contentEncoding, "gzip");
    // And, from the zip in the bucket, what the page needs for the textures.
    const tex = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("pv/323.tex.json").bytes));
    assert.deepEqual(tex.own, ["mat/wall6000.mat"]);
    assert.deepEqual(tex.cmp, { 6000: "lev6000.cmp" });
    assert.deepEqual(Object.keys(tex.pal), ["lev6000.cmp"]);
    assert.deepEqual([...Buffer.from(tex.pal["lev6000.cmp"], "base64")], [...CMP.subarray(64, 64 + 768)]);
    assert.equal(job.sql.exec("SELECT pv_tex FROM lv WHERE id = 323").toArray()[0].pv_tex, 1);
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
    assert.equal(st.requests_total, 16);
    assert.deepEqual(st.not_ready, [{ st: "gone", n: 1 }]);
    const mp = st.by_list.find(b => b.cat === "jkmp");
    assert.deepEqual([mp.previews, mp.previews_left, mp.previews_none], [1, 0, 0]);
    assert.ok(mp.preview_bytes > 0);
    // The 3D data counts toward its own cap, not the levels'.
    assert.equal(st.stored_bytes, ZIP.length + 6);
    assert.equal(st.preview_bytes, mp.preview_bytes);
});

await check("both games' lists side by side: each one's most downloaded first", async () => {
    const MOTS = LIST.replace("/levels/files/323.shtml", "/levels/files/900.shtml").replace("5231", "50")
                     .replace("/levels/files/400.shtml", "/levels/files/901.shtml").replace("> 10<", "> 20<");
    const seen = fakeMassassi({ "/levels/motsmp/?num=9999": () => new Response(MOTS) });
    const { job } = newJob();
    await runUntilIdle(job, 80);
    const pages = seen.filter(p => /^\/levels\/files\/\d+\.shtml$/.test(p)).map(p => +p.match(/\d+/)[0]);
    // MotS's first comes after JK's first, not after all of JK's.
    assert.deepEqual(pages, [323, 900, 901, 400]);
    assert.deepEqual(job.sql.exec("SELECT id, rk FROM lv ORDER BY id").toArray().map(r => [r.id, r.rk]), [[323, 0], [400, 1], [900, 0], [901, 1]]);
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
    assert.equal(seen.length, 8);
    assert.ok(seen.every(p => p.endsWith("?num=9999")));
});

await check("Massassi busy: everything waits, and the level isn't charged", async () => {
    const seen = fakeMassassi({ "/levels/files/323.shtml": () => new Response("busy", { status: 503 }) });
    const { job } = newJob();
    for (let i = 0; i < 9; i++)
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
    assert.equal(JSON.parse(await r.text()).requests_total, 16);
    r = await get("/levels/p/323.tex.json");
    assert.equal(r.status, 200);
    // It changes when the job makes a level's parts: kept for an hour.
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=3600");
    assert.deepEqual(JSON.parse(await r.text()).cmp, { 6000: "lev6000.cmp" });
    r = await get("/levels/p/323-0.map.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Encoding"), "gzip");
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=86400");
    assert.equal(gunzip(new Uint8Array(await r.arrayBuffer())), PV_MAP);
    r = await get("/levels/p/323-0.mat.json");
    assert.equal(gunzip(new Uint8Array(await r.arrayBuffer())), PV_MAT);
    assert.equal((await get("/levels/p/323-1.map.json")).status, 404);
    assert.equal((await get("/levels/p/323-0.png.json")).status, 404);
    assert.equal(await levelsRoute(new Request("https://b/levels/jk1.json"), {}, new URL("https://b/levels/jk1.json")), null);
});

// A zip with two GOBs: two maps, which the preview's own page lists.
const GOB2 = makeGob([{ name: "episode.jk", data: EPISODE.replace(/6000/g, "7000") }, { name: "jkl\\7000.jkl", data: "SECTION: JK\n" }]);
const ZIP2 = makeZip([{ name: "6000.gob", data: GOB, date: "1999-10-15" }, { name: "7000.gob", data: GOB2, date: "1999-10-15" },
                      { name: "6000.txt", data: README, date: "1999-10-16" }]);
const VIEWER = `<script>var maps = JSON.parse("[[\\"sixk\\", \\"?url=${PV_ZIP}\\u0026episode=0\\"], [\\"sevenk\\", \\"?url=${PV_ZIP}\\u0026episode=1\\"]]");</script>`;

await check("the 3D data: a zip of two maps asks the preview's page, then each map", async () => {
    const seen = fakeMassassi({
        "/media/levels/files/jkmp/6000.zip": () => new Response(ZIP2),
        [`pv:/level/?url=${PV_ZIP}`]: () => new Response(VIEWER),
        [pvUrl("map", 0, 1)]: () => new Response(PV_MAP.replace("#858559", "#000001")),
        [pvUrl("mat", 0, 1)]: () => new Response(PV_MAT),
    });
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.deepEqual(seen.filter(p => p.startsWith("pv:")),
                     [`pv:/level/?url=${PV_ZIP}`, pvUrl("map"), pvUrl("mat"), pvUrl("map", 0, 1), pvUrl("mat", 0, 1)]);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.deepEqual(idx.levels[0].pv, ["sixk", "sevenk"]);
    assert.match(gunzip(env.LEVELS.m.get("pv/323-1.map.json").bytes), /#000001/);
});

await check("the 3D data: one GOB of one level goes straight to its map, named for the level", async () => {
    const one = makeGob([{ name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: JKL }]);
    const seen = fakeMassassi({ "/media/levels/files/jkmp/6000.zip": () => new Response(makeZip([{ name: "6000.gob", data: one }])) });
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.deepEqual(seen.filter(p => p.startsWith("pv:")), [pvUrl("map"), pvUrl("mat")]);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.deepEqual(idx.levels[0].pv, ["6000"]);
    // The level's colormap isn't in its GOB: the game's own, which the page has.
    const tex = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("pv/323.tex.json").bytes));
    assert.deepEqual(tex, { own: [], cmp: { 6000: "lev6000.cmp" }, pal: {}, parts: [] });
});

await check("a map not found (the preview let its zip go): the preview's page once more, then the map", async () => {
    // One GOB of one level: straight to its map, which the preview has only
    // once its page is opened.
    const one = makeGob([{ name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: JKL }]);
    let opened = false;
    const seen = fakeMassassi({
        "/media/levels/files/jkmp/6000.zip": () => new Response(makeZip([{ name: "6000.gob", data: one }])),
        [`pv:/level/?url=${PV_ZIP}`]: () => (opened = true, new Response(VIEWER1)),
        [pvUrl("map")]: () => opened ? new Response(PV_MAP) : new Response("Not found", { status: 404 }),
    });
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.deepEqual(seen.filter(p => p.startsWith("pv:")), [pvUrl("map"), `pv:/level/?url=${PV_ZIP}`, pvUrl("map"), pvUrl("mat")]);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.deepEqual(idx.levels[0].pv, ["6000"]);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "ok");
    // A part not found again after that: the level goes without.
    let n = 0;
    fakeMassassi({ [pvUrl("map")]: () => (n++, new Response("Not found", { status: 404 })) });
    job.sql.exec("UPDATE lv SET pv_st = NULL, pv_got = 0 WHERE id = 323");
    await runUntilIdle(job);
    assert.equal(n, 1);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "none");
});

await check("levels that went without 3D data are asked for it again, once; mods aren't", async () => {
    const seen = fakeMassassi({ [pvUrl("map")]: () => new Response("Not found", { status: 404 }) });
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "none");
    job.sql.exec(`INSERT INTO lv (id, cat, game, prio, name, page_st, zip_st, pv_st) VALUES (9, 'jkmod', 'jk1', 1, 'm', 'ok', 'ok', 'none')`);
    job.sql.exec("DELETE FROM kv WHERE k = 'pv_again'");
    fakeMassassi();
    const again = new LevelJob(job.ctx, env);
    const rows = again.sql.exec("SELECT id, pv_st, pv_maps FROM lv WHERE id IN (9, 323) ORDER BY id").toArray();
    assert.deepEqual(rows.map(r => [r.id, r.pv_st, r.pv_maps]), [[9, "none", null], [323, null, null]]);
    await runUntilIdle(again);
    assert.equal(again.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "ok");
    // Once only.
    again.sql.exec("UPDATE lv SET pv_st = 'none' WHERE id = 323");
    new LevelJob(job.ctx, env);
    assert.equal(again.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "none");
});

await check("levels with their 3D data from before get the textures' list, without asking Massassi", async () => {
    const seen = fakeMassassi();
    const { job, env } = newJob();
    await runUntilIdle(job);
    env.LEVELS.m.delete("pv/323.tex.json");
    job.sql.exec("UPDATE lv SET pv_tex = 0");
    seen.length = 0;
    await runUntilIdle(job);
    assert.deepEqual(seen, []);
    assert.ok(env.LEVELS.m.has("pv/323.tex.json"));
    // Its step doesn't wait the pace.
    job.sql.exec("UPDATE lv SET pv_tex = 0");
    const before = Date.now();
    await job.alarm();
    assert.ok(await job.ctx.storage.getAlarm() < before + 5000);
});

await check("3D data copied before the levels' names: renamed, or asked for again", async () => {
    // As the job left them before: a GOB of two levels, its first map only,
    // named for the GOB.
    const seen = fakeMassassi();
    const { job, env } = newJob();
    await runUntilIdle(job);
    const old = () => {
        job.sql.exec("UPDATE lv SET pv_maps = ?, pv_st = 'ok', pv_got = 2 WHERE id = 323", JSON.stringify([{ n: "6000", e: 0 }]));
        job.sql.exec("DELETE FROM kv WHERE k = 'pv_names'");
    };
    old();
    // The new job, on the same storage, asks the preview's page for its levels.
    const again = new LevelJob(job.ctx, env);
    let row = again.sql.exec("SELECT pv_st, pv_maps, pv_got, pv_size FROM lv WHERE id = 323").toArray()[0];
    assert.deepEqual([row.pv_st, row.pv_maps, row.pv_got, row.pv_size], [null, null, 0, 0]);
    seen.length = 0;
    await runUntilIdle(again);
    assert.deepEqual(seen.filter(p => p.startsWith("pv:")), ["pv:/level/?url=" + PV_ZIP, pvUrl("map"), pvUrl("mat")]);
    // Once only.
    seen.length = 0;
    new LevelJob(job.ctx, env);
    await runUntilIdle(again);
    assert.deepEqual(seen, []);
    // A GOB of one level, in a folder: its map renamed for the level, nothing asked.
    const one = makeGob([{ name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: JKL }]);
    const seen2 = fakeMassassi({ "/media/levels/files/jkmp/6000.zip": () => new Response(makeZip([{ name: "Sub/six.gob", data: one }])) });
    const j2 = newJob();
    await runUntilIdle(j2.job);
    j2.job.sql.exec("UPDATE lv SET pv_maps = ? WHERE id = 323", JSON.stringify([{ n: "Sub/six", e: 0 }]));
    j2.job.sql.exec("DELETE FROM kv WHERE k = 'pv_names'");
    seen2.length = 0;
    const j2b = new LevelJob(j2.job.ctx, j2.env);
    row = j2b.sql.exec("SELECT pv_st, pv_maps FROM lv WHERE id = 323").toArray()[0];
    assert.deepEqual([row.pv_st, JSON.parse(row.pv_maps)], ["ok", [{ n: "6000", e: 0 }]]);
    await runUntilIdle(j2b);
    assert.deepEqual(seen2.filter(p => p.startsWith("pv:")), []);
    const idx = JSON.parse(new TextDecoder().decode(j2.env.LEVELS.m.get("index/jk1.json").bytes));
    assert.deepEqual(idx.levels[0].pv, ["6000"]);
});

await check("a .jkl's master colormap", async () => {
    assert.equal(read.worldColormap(enc("World Colormaps 1\r\n0:\tA.CMP\r\n")), "a.cmp");
    assert.equal(read.worldColormap(enc("world colormaps 2\n 0: dflt.cmp # main\n1: x.cmp")), "dflt.cmp");
    assert.equal(read.worldColormap(enc("World Colormaps 0\n")), null);
    assert.equal(read.worldColormap(enc("SECTION: JK\n")), null);
});

await check("the preview's page parsed: names and episodes, once each", async () => {
    assert.deepEqual(read.previewMaps(VIEWER), [{ n: "sixk", e: 0 }, { n: "sevenk", e: 1 }]);
    assert.deepEqual(read.previewMaps("<p>no script</p>"), []);
    assert.deepEqual(read.previewMaps('var maps = JSON.parse("not json")'), []);
});

await check("no 3D data for a level (404): it's in the library without it", async () => {
    const seen = fakeMassassi({ [pvUrl("map")]: () => new Response("Not found", { status: 404 }) });
    const { job, env } = newJob();
    await runUntilIdle(job);
    // Its map not found, the preview's page once more, then the map again.
    assert.deepEqual(seen.filter(p => p.startsWith("pv:")), [`pv:/level/?url=${PV_ZIP}`, pvUrl("map"), `pv:/level/?url=${PV_ZIP}`, pvUrl("map")]);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.levels.length, 1);
    assert.equal(idx.levels[0].pv, undefined);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "none");
    assert.equal((await job.status()).by_list.find(b => b.cat === "jkmp").previews_none, 1);
});

await check("the preview failing on a level (500) is that level's: no backoff, two tries", async () => {
    let n = 0;
    const seen = fakeMassassi({ [pvUrl("map")]: () => (n++, new Response("converter crashed", { status: 500 })) });
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.equal(job.kv("backoff_until"), null);
    assert.equal(n, 1);
    let r = job.sql.exec("SELECT tries, retry_at, pv_st FROM lv WHERE id = 323").toArray()[0];
    assert.deepEqual([r.tries, r.pv_st], [1, null]);
    assert.ok(r.retry_at > Date.now() + 50 * 60 * 1000);
    // The level is in the library meanwhile.
    let idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.equal(idx.levels.length, 1);
    job.sql.exec("UPDATE lv SET retry_at = 0 WHERE id = 323");
    await runUntilIdle(job);
    assert.equal(n, 2);
    r = job.sql.exec("SELECT tries, pv_st FROM lv WHERE id = 323").toArray()[0];
    assert.deepEqual([r.tries, r.pv_st], [0, "error"]);
    await runUntilIdle(job);
    assert.equal(n, 2);
    assert.ok(seen.includes("/levels/files/400.shtml"));
});

await check("3D data that isn't the preview's, or too big", async () => {
    fakeMassassi({ [pvUrl("map")]: () => new Response("<html>Internal error</html>") });
    let { job } = newJob();
    await job.fetch(new Request("https://levels/kick"));
    await runUntilIdle(job);
    let r = job.sql.exec("SELECT tries, pv_st, err FROM lv WHERE id = 323").toArray()[0];
    assert.deepEqual([r.tries, r.pv_st], [1, null]);
    assert.match(r.err, /isn't the preview's/);
    fakeMassassi({ [pvUrl("map")]: () => new Response("{}", { headers: { "Content-Length": String(65 * 1024 * 1024) } }) });
    ({ job } = newJob());
    await runUntilIdle(job);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "big");
    // Too big found only while reading it (no Content-Length).
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    fakeMassassi({ [pvUrl("map")]: () => new Response(new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode('{"surfaces": ['));
            for (let i = 0; i < 65; i++) c.enqueue(chunk);
            c.close();
        },
    })) });
    ({ job } = newJob());
    await runUntilIdle(job);
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, "big");
});

await check("past LEVELS_PREVIEW_GB no more 3D data is copied, and the levels go on", async () => {
    const seen = fakeMassassi();
    const { job, env } = newJob({ LEVELS_PREVIEW_GB: "0.000000001" });
    job.sql.exec("INSERT INTO lv (id, cat, game, prio, title, pv_size) VALUES (9, 'jkmp', 'jk1', 0, 'x', 100)");
    await runUntilIdle(job);
    assert.ok(!seen.some(p => p.startsWith("pv:")));
    assert.ok(env.LEVELS.m.has("zip/323.zip"));
});

await check("LEVELS_PREVIEW = \"0\": no 3D data, the rest as before", async () => {
    const seen = fakeMassassi();
    const { job, env } = newJob({ LEVELS_PREVIEW: "0" });
    await runUntilIdle(job);
    assert.ok(!seen.some(p => p.startsWith("pv:")));
    assert.ok(env.LEVELS.m.has("zip/323.zip"));
    assert.equal(job.sql.exec("SELECT pv_st FROM lv WHERE id = 323").toArray()[0].pv_st, null);
});

await check("a table from before the 3D data gets its columns", async () => {
    const ctx = new Ctx();
    ctx.storage.sql.exec("CREATE TABLE lv (id INTEGER PRIMARY KEY, cat TEXT)");
    new LevelJob(ctx, { LEVELS: new FakeR2() });
    new LevelJob(ctx, { LEVELS: new FakeR2() });
    const cols = ctx.storage.sql.exec("SELECT name FROM pragma_table_info('lv')").toArray().map(c => c.name);
    for (const c of ["pv_st", "pv_at", "pv_maps", "pv_got", "pv_size"])
        assert.ok(cols.includes(c), c);
});

await check("LEVELS_FETCH = \"0\" stops the job", async () => {
    const seen = fakeMassassi();
    const { job } = newJob({ LEVELS_FETCH: "0" });
    await job.fetch(new Request("https://levels/kick"));
    assert.equal(await job.ctx.storage.getAlarm(), null);
    await job.alarm();
    assert.equal(seen.length, 0);
});

// ---- The parts of models the preview leaves out (src/levels-parts.js)

// A model of two parts side by side at the top of its tree, as The Death
// Star's Falcon has nine: the preview keeps the last (part1), the job makes
// the first. part0's three faces: one of the preview's textures, one the
// level ships, one of the game's.
const model3do = (name0, name1) => `# a model
SECTION: HEADER
3DO 2.1

SECTION: MODELRESOURCE
MATERIALS 3
0:      known.mat
1:      OwnMat.mat
2:      game.mat

SECTION: GEOMETRYDEF
RADIUS 1.0
INSERT OFFSET 0.0 0.0 0.0
GEOSETS 1
GEOSET 0
MESHES 2

MESH 0
NAME ${name0}
RADIUS 1.0
GEOMETRYMODE 4
LIGHTINGMODE 3
TEXTUREMODE 3
VERTICES 3
0:  1.000000  0.000000  0.000000  0.0000
1:  0.000000  1.000000  0.000000  0.0000
2:  0.000000  0.000000  1.000000  0.0000
TEXTURE VERTICES 3
0:  0.000000  0.000000
1:  32.000000  0.000000
2:  32.000000  16.000000
VERTEX NORMALS
0:  0.0 0.0 1.0
1:  0.0 0.0 1.0
2:  0.0 0.0 1.0
FACES 3
#  num:  material:   type:  geo:  light:   tex:  extralight:  verts:
0:  0  0x0  4  3  3  0.0000  3  0, 0  1, 1  2, 2
1:  1  0x0  4  3  3  0.0000  3  0, 0  1, 1  2, 2
2:  2  0x0  4  3  3  0.0000  3  0, 0  1, 1  2, 2
FACE NORMALS
0:  0.0 0.0 1.0
1:  0.0 0.0 1.0
2:  0.0 0.0 1.0

MESH 1
NAME ${name1}
RADIUS 1.0
GEOMETRYMODE 4
LIGHTINGMODE 3
TEXTUREMODE 3
VERTICES 3
0:  0.000000  0.000000  0.000000  0.0000
1:  2.000000  0.000000  0.000000  0.0000
2:  0.000000  2.000000  0.000000  0.0000
TEXTURE VERTICES 3
0:  0.000000  0.000000
1:  16.000000  0.000000
2:  0.000000  8.000000
VERTEX NORMALS
0:  0.0 0.0 1.0
1:  0.0 0.0 1.0
2:  0.0 0.0 1.0
FACES 1
0:  0  0x0  4  3  3  0.0000  3  0, 0  1, 1  2, 2
FACE NORMALS
0:  0.0 0.0 1.0

SECTION: HIERARCHYDEF
HIERARCHY NODES 2
0:  0x0  0x1  0  -1  -1  -1  0  0.500000  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  0.250000  ${name0}
1:  0x0  0x1  1  -1  -1  -1  0  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  0.000000  ${name1}
`;
// The same model with one part at the top: nothing cut.
const ONE_ROOT = model3do("a", "b").replace(/\n1:  0x0  0x1  1  -1 /, "\n1:  0x0  0x1  1  0 ");
// Falcon at (1, 2, 3) turned 90 to the left; the tree has the name of one of
// the games' own (the preview draws the game's); falcon2 is in a sector the
// level doesn't have; the box has one part at the top.
const PARTS_JKL = `SECTION: JK
Version 1

SECTION: MATERIALS
World materials 1
0:      dflt.mat        1.000000        1.000000
end

SECTION: GEORESOURCE
World Colormaps 1
0:      lev6000.cmp

SECTION: SECTORS
World sectors 1
SECTOR  0
FLAGS   0x0

SECTION: TEMPLATES
World templates 3
falcon          none            model3d=falcon.3do
tree            none            model3d=tree.3do
box             none            model3d=box.3do
end

SECTION: THINGS
World things 4
#num template    name     X        Y        Z        Pitch    Yaw      Roll     Sector
0:   falcon      falcon   1.000000 2.000000 3.000000 0.000000 90.000000 0.000000 0  thingflags=0x0
1:   tree        tree     0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0
2:   falcon      falcon2  0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 5
3:   box         box      0.000000 0.000000 0.000000 0.000000 0.000000 0.000000 0
end
`;
// A MAT of 64 x 32: "MAT ", version 50, type 2 (textures), one texture.
const OWN_MAT = new Uint8Array(76 + 40 + 24 + 64 * 32);
OWN_MAT.set(enc("MAT "));
new DataView(OWN_MAT.buffer).setUint32(4, 50, true);
new DataView(OWN_MAT.buffer).setUint32(8, 2, true);
new DataView(OWN_MAT.buffer).setUint32(12, 1, true);
new DataView(OWN_MAT.buffer).setUint32(116, 64, true);
new DataView(OWN_MAT.buffer).setUint32(120, 32, true);
// A PNG's start, as far as its size: 32 x 16.
const png = (w, h) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return "data:image/png;base64," + b.toString("base64");
};
const PARTS_MAT = [{ name: "3do/mat/dflt.mat", data: png(8, 8) }, { name: "3do/mat/known.mat", data: png(32, 16) }];
const PARTS_GOB = makeGob([
    { name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: PARTS_JKL },
    { name: "3do\\falcon.3do", data: model3do("hull", "sensors") }, { name: "3do\\tree.3do", data: model3do("trunk", "leaves") },
    { name: "3do\\box.3do", data: ONE_ROOT }, { name: "3do\\mat\\OwnMat.mat", data: OWN_MAT },
    { name: "misc\\cmp\\lev6000.cmp", data: CMP },
]);
const partsFiles = () => parts.gobFinder([PARTS_GOB], read.parseGob);
const OFFICIAL = new Set(["tree"]);
// The falcon's hull: placed by its node's offset (0.5, 0, 0) and pivot
// (0, 0, 0.25), then by the thing: (x, y, z) -> (-y, x, z) + (1, 2, 3).
const HULL = [[1, 3.5, 3.25], [0, 2.5, 3.25], [1, 2.5, 4.25]];

await check("parts: a model's top-level parts but the last, placed and textured as the preview does the rest", async () => {
    const p = parts.levelParts(partsFiles(), "jkl/6000.jkl", PARTS_MAT, "left", OFFICIAL);
    assert.equal(p.v, 1);
    assert.equal(p.base, 2);
    // The level's own MAT, with its size; the game's, raw.
    assert.deepEqual(p.mats, [{ name: "3do/mat/OwnMat.mat", mat: Buffer.from(OWN_MAT).toString("base64") }, { name: "mat/game.mat", raw: true }]);
    assert.deepEqual(p.model_surfaces, [
        // The preview's known.mat, 32 x 16.
        { vertices: [[HULL[0], [0, 0]], [HULL[1], [1, 0]], [HULL[2], [1, 1]]], material: 1 },
        // The level's, 64 x 32.
        { vertices: [[HULL[0], [0, 0]], [HULL[1], [0.5, 0]], [HULL[2], [0.5, 0.5]]], material: 2 },
        // The game's: the page divides by its size.
        { vertices: [[HULL[0], [0, 0]], [HULL[1], [32, 0]], [HULL[2], [32, 16]]], material: 3 },
    ]);
});

await check("parts: the one the preview keeps, made the same way (what the checks against its data compare)", async () => {
    const p = parts.levelParts(partsFiles(), "jkl/6000.jkl", PARTS_MAT, "kept", OFFICIAL);
    assert.deepEqual(p.mats, []);
    assert.deepEqual(p.model_surfaces, [{ vertices: [[[1, 2, 3], [0, 0]], [[1, 4, 3], [0.5, 0]], [[-1, 2, 3], [0, 0.5]]], material: 1 }]);
});

await check("parts: none for the games' own models, one-part models, or a level without models", async () => {
    // Without the official list, the tree is made too (at 0, 0, 0, unturned).
    const all = parts.levelParts(partsFiles(), "jkl/6000.jkl", PARTS_MAT, "left", null);
    assert.equal(all.model_surfaces.length, 6);
    assert.deepEqual(all.model_surfaces[3].vertices[0][0], [1.5, 0, 0.25]);
    const files = parts.gobFinder([makeGob([{ name: "jkl\\6000.jkl", data: PARTS_JKL.replace(/falcon\.3do|tree\.3do/g, "box.3do") },
                                            { name: "3do\\box.3do", data: ONE_ROOT }])], read.parseGob);
    assert.equal(parts.levelParts(files, "jkl/6000.jkl", PARTS_MAT, "left", OFFICIAL), null);
    assert.equal(parts.levelParts(partsFiles(), "jkl/other.jkl", PARTS_MAT, "left", OFFICIAL), null);
    // A model the preview can't read (no HIERARCHYDEF) it has none of.
    const bad = parts.gobFinder([makeGob([{ name: "jkl\\6000.jkl", data: PARTS_JKL },
                                          { name: "3do\\falcon.3do", data: model3do("a", "b").replace(/SECTION: HIERARCHYDEF[^]*/, "") }])], read.parseGob);
    assert.equal(parts.levelParts(bad, "jkl/6000.jkl", PARTS_MAT, "left", OFFICIAL), null);
});

await check("parts: the job makes them with the textures' step, and the route sends them", async () => {
    const zip = makeZip([{ name: "6000.gob", data: PARTS_GOB }]);
    fakeMassassi({
        "/media/levels/files/jkmp/6000.zip": () => new Response(zip, { headers: { "Content-Length": String(zip.length) } }),
        [pvUrl("mat")]: () => new Response(JSON.stringify(PARTS_MAT)),
    });
    const { job, env } = newJob();
    await runUntilIdle(job);
    const tex = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("pv/323.tex.json").bytes));
    assert.deepEqual(tex.parts, [0]);
    const o = env.LEVELS.m.get("pv/323-0.parts.json");
    assert.equal(o.httpMetadata.contentEncoding, "gzip");
    const p = JSON.parse(gunzip(o.bytes));
    assert.equal(p.base, 2);
    assert.equal(p.model_surfaces.length, 3);
    assert.deepEqual(p.model_surfaces[0].vertices[0][0], HULL[0]);
    assert.equal(job.kv("last_parts_error"), null);
    const get = path => levelsRoute(new Request("https://beta.example" + path), env, new URL("https://beta.example" + path));
    const r = await get("/levels/p/323-0.parts.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Encoding"), "gzip");
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(gunzip(new Uint8Array(await r.arrayBuffer()))), p);
    assert.equal((await get("/levels/p/323-1.parts.json")).status, 404);
    // The textures' step again, with nothing cut now: its parts.json goes.
    job.sql.exec("UPDATE lv SET pv_tex = 0");
    const gob1 = makeGob([{ name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: PARTS_JKL },
                            { name: "3do\\falcon.3do", data: ONE_ROOT }]);
    const zip2 = makeZip([{ name: "6000.gob", data: gob1 }]);
    await env.LEVELS.put("zip/323.zip", zip2, { customMetadata: { sha256: sha(zip2) } });
    await runUntilIdle(job);
    assert.ok(!env.LEVELS.m.has("pv/323-0.parts.json"));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("pv/323.tex.json").bytes)).parts, []);
});

await check("parts: a map the job can't read is noted, and the rest of the step goes on", async () => {
    const gob = makeGob([{ name: "episode.jk", data: EPISODE.replace(/\n20:.*\n/, "\n") }, { name: "jkl\\6000.jkl", data: PARTS_JKL },
                         { name: "3do\\falcon.3do", data: model3do("hull", "sensors") }]);
    const zip = makeZip([{ name: "6000.gob", data: gob }]);
    fakeMassassi({
        "/media/levels/files/jkmp/6000.zip": () => new Response(zip, { headers: { "Content-Length": String(zip.length) } }),
        [pvUrl("mat")]: () => new Response("{ not json"),
    });
    const { job, env } = newJob();
    await runUntilIdle(job);
    // The preview's mat.json wasn't JSON: no 3D data, so no parts.
    assert.ok(!env.LEVELS.m.has("pv/323-0.parts.json"));
    // A mat.json in the bucket that isn't gzip: noted, tex.json still written.
    job.sql.exec("UPDATE lv SET pv_st = 'ok', pv_maps = ?, pv_tex = 0, tries = 0, retry_at = NULL WHERE id = 323", JSON.stringify([{ n: "6000", e: 0 }]));
    await env.LEVELS.put("pv/323-0.mat.json", "[]");
    await runUntilIdle(job);
    assert.match(job.kv("last_parts_error"), /level 323 map 0/);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("pv/323.tex.json").bytes)).parts, []);
});

await check("parts: once, every level with 3D data goes through the textures' step again", async () => {
    fakeMassassi();
    const { job, env } = newJob();
    await runUntilIdle(job);
    assert.equal(job.sql.exec("SELECT pv_tex FROM lv WHERE id = 323").toArray()[0].pv_tex, 1);
    job.sql.exec("DELETE FROM kv WHERE k = 'tex_v'");
    let again = new LevelJob(job.ctx, env);
    assert.equal(again.sql.exec("SELECT pv_tex FROM lv WHERE id = 323").toArray()[0].pv_tex, 0);
    await runUntilIdle(again);
    assert.equal(again.sql.exec("SELECT pv_tex FROM lv WHERE id = 323").toArray()[0].pv_tex, 1);
    again = new LevelJob(job.ctx, env);
    assert.equal(again.sql.exec("SELECT pv_tex FROM lv WHERE id = 323").toArray()[0].pv_tex, 1);
});


// ---- Mods

const DL_PAGE = id => `<div id="content"><h1>Black and Yellow Flame Saber</h1>
    <meta http-equiv="Refresh" content="2; URL=/media/levels/files/jkmod/blackyellow.zip">
    <p style="margin: 1em;">Your download should begin automatically in 2 seconds. If it doesn't, please <a
            href="/media/levels/files/jkmod/blackyellow.zip">click here</a>.</p></div>`;

await check("mods: the zip's address on a mod's download page", async () => {
    assert.equal(read.downloadZip(DL_PAGE(634)), "https://www.massassi.net/media/levels/files/jkmod/blackyellow.zip");
    // The link alone will do.
    assert.equal(read.downloadZip('<a href="/media/levels/files/motsmod/x%20y.zip">click here</a>'),
                 "https://www.massassi.net/media/levels/files/motsmod/x%20y.zip");
    // Only Massassi's own files.
    assert.equal(read.downloadZip('<meta http-equiv="Refresh" content="0; URL=https://evil.example/media/levels/files/jkmod/a.zip">'), null);
    assert.equal(read.downloadZip('<meta http-equiv="Refresh" content="0; URL=/levels/files/634.shtml">'), null);
    assert.equal(read.downloadZip(""), null);
});

await check("mods: what goes into the mod's folder, and what's an episode", async () => {
    const e = names => names.map(n => ({ name: n, dir: n.endsWith("/") }));
    let plan = read.modPlan(e(["SBX/SBX-JK v31.gob", "SBX/readme.txt", "SBX/SBX Launcher.exe", "SBX/shot.jpg"]), "gob", []);
    assert.deepEqual(plan.files, [["SBX/SBX-JK v31.gob", "SBX-JK v31.gob"]]);
    assert.deepEqual(plan.left.programs, ["SBX/SBX Launcher.exe"]);
    assert.equal(plan.left.other, 0);
    // Loose files go under the first of the game's folders in their path;
    // a second copy somewhere else is left out.
    plan = read.modPlan(e(["Saber/", "Saber/Resource/cog/a.cog", "Saber/Resource/3do/mat/b.mat", "Saber/Resource/misc/pup/c.pup",
                           "Saber/Optional/cog/a.cog", "__MACOSX/Saber/._a.cog", "Saber/notes.doc", "Saber/x.dat"]), "gob", []);
    assert.deepEqual(plan.files, [["Saber/Resource/cog/a.cog", "cog/a.cog"], ["Saber/Resource/3do/mat/b.mat", "3do/mat/b.mat"],
                                  ["Saber/Resource/misc/pup/c.pup", "misc/pup/c.pup"]]);
    assert.equal(plan.left.other, 2);
    assert.deepEqual(plan.left.others, ["Saber/x.dat", "Saber/Optional/cog/a.cog"]);
    // A GOB with an episode.jk goes into episode/, the rest into the mod.
    plan = read.modPlan(e(["swoop.gob", "Resource/swoopres.gob", "a.goo"]), "gob", ["swoop.gob"]);
    assert.deepEqual(plan.files, [["Resource/swoopres.gob", "swoopres.gob"]]);
    assert.deepEqual(plan.episodes, ["swoop.gob"]);
    assert.equal(plan.left.other, 1);
    // MotS: GOOs.
    plan = read.modPlan(e(["mod.goo", "mod.gob"]), "goo", []);
    assert.deepEqual(plan.files, [["mod.goo", "mod.goo"]]);
});

await check("mods: files loose outside the game's folders go by their kind", async () => {
    const e = names => names.map(n => ({ name: n, dir: n.endsWith("/") }));
    // A 1997 skin: the model, its textures and its sounds at the top of the zip.
    let plan = read.modPlan(e(["predh2h.3do", "pred.snd", "sole.mat", "PRED.MAT", "growl.wav", "readme.txt", "kyle.key", "x.dat"]), "gob", []);
    assert.deepEqual(plan.files, [["predh2h.3do", "3do/predh2h.3do"], ["pred.snd", "misc/snd/pred.snd"], ["sole.mat", "mat/sole.mat"],
                                  ["PRED.MAT", "mat/PRED.MAT"], ["growl.wav", "sound/growl.wav"], ["kyle.key", "3do/key/kyle.key"]]);
    assert.equal(plan.typed, true);
    assert.deepEqual([plan.left.other, plan.left.others], [1, ["x.dat"]]);
    // The folder with the most of them; a second of the same name is left out.
    plan = read.modPlan(e(["Pack/a.cog", "Pack/b.cog", "Pack/Old/a.cog", "c.cog"]), "gob", []);
    assert.deepEqual(plan.files, [["Pack/a.cog", "cog/a.cog"], ["Pack/b.cog", "cog/b.cog"]]);
    // Not with a program (a tool, most likely), nor when it has a GOB or the game's folders.
    plan = read.modPlan(e(["makebots.exe", "weapons/0.3do"]), "gob", []);
    assert.deepEqual([plan.files, plan.typed], [[], false]);
    plan = read.modPlan(e(["mod.gob", "extra.cog"]), "gob", []);
    assert.deepEqual([plan.files, plan.typed], [[["mod.gob", "mod.gob"]], false]);
    plan = read.modPlan(e(["Resource/cog/a.cog", "b.3do"]), "gob", []);
    assert.deepEqual([plan.files, plan.typed], [[["Resource/cog/a.cog", "cog/a.cog"]], false]);
});

await check("mods: their kind, guessed from their files", async () => {
    assert.equal(read.modKind(["cog/force_lightning.cog", "cog/weap_bryar.cog", "3do/bryv.3do"], []), "gameplay");
    assert.equal(read.modKind(["3do/ky.3do", "3do/mat/kyhead.mat", "cog/kyle.cog"], []), "characters");
    assert.equal(read.modKind(["mat/dflt.mat", "ui/bm/bkmain.bm"], []), "graphics");
    assert.equal(read.modKind(["sound/thrmlpu2.wav"], []), "other");
    assert.equal(read.modKind(["jkl/01narshadda.jkl", "cog/x.cog"], [{ ty: 1 }]), "campaign");
    assert.equal(read.modKind(["jkl/swoop.jkl"], [{ ty: 2 }]), "gameplay");
    assert.equal(read.modKind(["3do/a.3do"], [], "JK HD Models.gob"), "graphics");
});

await check("mods: versions of one mod go together", async () => {
    const g = read.modGroup;
    assert.equal(g("Saber Battle X - JK v3.1", "SBX Team"), g("Saber Battle X - JK v1.0", "SBX Team"));
    assert.equal(g("James Bond 007 v2.0 Beta", "Q"), g("James Bond 007", "Q"));
    assert.equal(g("Power Weapons Pack 2 (preview)", "Z"), g("Power Weapons Pack 2", "Z"));
    assert.notEqual(g("Jango Fett", "One"), g("Jango Fett", "Two"));
    assert.notEqual(g("Ultimate Skin Pack 2", "A"), g("Ultimate Skin Pack 3", "A"));
});

const MOD_LIST = `<div class="level-list-screenshot"></div><div class="level-list-item">
    <strong><a href="/levels/files/634.shtml">Black and Yellow Flame Saber</a></strong><br>
    <span class="mute">By:</span> Vindicare<br><span class="mute">Added:</span> 2000-06-02<br></div>
    <div class="level-list-details"><span class="mute">Downloads:</span> 9000</div>`;
const MOD_PAGE = PAGE.replace(/323/g, "634").replace("6000 Block</h1>", "Black and Yellow Flame Saber</h1>")
    .replace('href="/levels/jkmp/">Jedi Knight Multiplayer Level', 'href="/levels/jkmod/">Jedi Knight Mod')
    .replace(/<div class="level-3d-preview">[\s\S]*?<\/iframe>\s*<\/div>/, "")
    .replace("226.0&nbsp;KiB", "2.9&nbsp;KiB");
const MOD_GOB = makeGob([{ name: "cog\\kyle.cog", data: "# kyle" }, { name: "cog\\force_lightning.cog", data: "# lightning" },
                         { name: "3do\\saberyellow.3do", data: "3DO" }]);
const MOD_ZIP = makeZip([{ name: "Flame Saber/flame.gob", data: MOD_GOB, date: "1998-03-01" },
                         { name: "Flame Saber/Resource/mat/saberyellow0.mat", data: "MAT ", date: "1998-03-02" },
                         { name: "Flame Saber/readme.txt", data: "Flame saber by Vindicare. Put it in Resource.", date: "1998-03-02" },
                         { name: "Flame Saber/install.bat", data: "copy *.* ..", date: "1998-03-02" }]);

function fakeMods(extra) {
    return fakeMassassi(Object.assign({
        "/levels/jkmod/?num=9999": () => new Response(MOD_LIST),
        "/levels/files/634.shtml": () => new Response(MOD_PAGE),
        "/levels/download/634/": () => new Response(DL_PAGE(634)),
        "/media/levels/files/jkmod/blackyellow.zip": () => new Response(MOD_ZIP),
        "/media/levels/screenshots/634_1.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 3])),
        "/media/levels/screenshots/634_2.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 4])),
    }, extra || {}));
}

await check("mods: page, download page (once), zip and pictures, in an index of their own", async () => {
    const seen = fakeMods();
    const { job, env } = newJob();
    await runUntilIdle(job, 80);
    const mine = seen.filter(p => /634|jkmod|blackyellow/.test(p));
    assert.deepEqual(mine, ["/levels/jkmod/?num=9999", "/levels/files/634.shtml", "/levels/download/634/",
                            "/media/levels/files/jkmod/blackyellow.zip",
                            "/media/levels/screenshots/634_1.jpg", "/media/levels/screenshots/634_2.jpg"]);
    // Never the 3D preview for a mod.
    assert.ok(!seen.some(p => p.startsWith("pv:") && p.includes("blackyellow")));
    // The levels' index has only levels.
    const lv = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1.json").bytes));
    assert.deepEqual(lv.levels.map(l => l.id), [323]);
    assert.equal(lv.listed, 2);
    const idx = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1-mods.json").bytes));
    assert.equal(idx.listed, 1);
    assert.equal(idx.left, 0);
    assert.equal(idx.mods.length, 1);
    const m = idx.mods[0];
    assert.deepEqual([m.id, m.k, m.t, m.a, m.sz, m.dl, m.sh, m.z, m.h, m.n, m.ep, m.x, m.gp],
                     [634, "gameplay", "Black and Yellow Flame Saber", "Brian Lozier", MOD_ZIP.length, 9000, 2, "blackyellow.zip",
                      sha(MOD_ZIP), 4, undefined, 1, undefined]);
    assert.equal(m.gk, read.modGroup(m.t, m.a));
    assert.deepEqual(m.g, [{ n: "Flame Saber/flame.gob", h: sha(MOD_GOB), b: MOD_GOB.length }]);
    // The files' dates, as no readme gives one.
    assert.equal(m.rel, "1998-03-02");
    const d = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("detail/634.json").bytes));
    assert.deepEqual(d.mod.plan, { inner: null, episodes: [],
                                   files: [["Flame Saber/flame.gob", "flame.gob"], ["Flame Saber/Resource/mat/saberyellow0.mat", "mat/saberyellow0.mat"]] });
    assert.deepEqual(d.mod.inside["Flame Saber/flame.gob"], [["cog/kyle.cog", 6], ["cog/force_lightning.cog", 11], ["3do/saberyellow.3do", 3]]);
    assert.deepEqual(d.mod.programs, ["Flame Saber/install.bat"]);
    assert.equal(d.mod.kind, "gameplay");
    assert.equal(d.texts[0].n, "Flame Saber/readme.txt");
    const st = await job.status();
    assert.equal(st.download_pages, 1);
    assert.deepEqual(st.mod_kinds, [{ game: "jk1", kind: "gameplay", n: 1 }]);
    assert.equal(st.by_list.find(b => b.cat === "jkmod").zips, 1);
    // A day later, and when its page is read again: no download page again.
    seen.length = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + 100 * 24 * 3600 * 1000;
    try {
        await runUntilIdle(job, 80);
    } finally {
        Date.now = realNow;
    }
    assert.ok(seen.includes("/levels/files/634.shtml"));
    assert.ok(!seen.includes("/levels/download/634/"));
    assert.equal((await job.status()).download_pages, 1);
});

await check("mods: a zip of another size on its page is asked for again", async () => {
    const seen = fakeMods();
    const { job } = newJob();
    await runUntilIdle(job, 80);
    seen.length = 0;
    fakeMods({ "/levels/files/634.shtml": () => new Response(MOD_PAGE.replace("2.9&nbsp;KiB", "3.1&nbsp;KiB")) });
    const realNow = Date.now;
    Date.now = () => realNow() + 100 * 24 * 3600 * 1000;
    try {
        await runUntilIdle(job, 80);
    } finally {
        Date.now = realNow;
    }
    assert.equal((await job.status()).download_pages, 2);
    assert.equal(job.sql.exec("SELECT zip_st FROM lv WHERE id = 634").toArray()[0].zip_st, "ok");
});

await check("mods: one with nothing for the game, or no zip on its download page, stays out", async () => {
    fakeMods({ "/media/levels/files/jkmod/blackyellow.zip": () => new Response(makeZip([{ name: "setup.exe", data: "MZ" },
                                                                                        { name: "readme.txt", data: "run setup" }])) });
    let { job, env } = newJob();
    await runUntilIdle(job, 80);
    assert.equal(job.sql.exec("SELECT zip_st FROM lv WHERE id = 634").toArray()[0].zip_st, "nomod");
    assert.equal(JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1-mods.json").bytes)).mods.length, 0);
    fakeMods({ "/levels/download/634/": () => new Response("<p>Sorry.</p>") });
    ({ job, env } = newJob());
    await runUntilIdle(job, 80);
    const row = job.sql.exec("SELECT zip_st, err FROM lv WHERE id = 634").toArray()[0];
    assert.deepEqual([row.zip_st, row.err], ["none", "no zip address on its download page"]);
});

await check("mods: loose files only, and a zip inside the zip", async () => {
    const loose = makeZip([{ name: "cog/weap_bryar.cog", data: "# b" }, { name: "cog/weap_rifle.cog", data: "# r" }]);
    fakeMods({ "/media/levels/files/jkmod/blackyellow.zip": () => new Response(makeZip([{ name: "readme.txt", data: "x" },
                                                                                        { name: "mod.zip", data: loose, store: true }])) });
    const { job, env } = newJob();
    await runUntilIdle(job, 80);
    assert.deepEqual(job.sql.exec("SELECT zip_st, err FROM lv WHERE id = 634").toArray()[0], { zip_st: "ok", err: null });
    const d = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("detail/634.json").bytes));
    assert.deepEqual(d.mod.plan, { inner: "mod.zip", episodes: [], files: [["cog/weap_bryar.cog", "cog/weap_bryar.cog"], ["cog/weap_rifle.cog", "cog/weap_rifle.cog"]] });
    const m = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1-mods.json").bytes)).mods[0];
    assert.deepEqual([m.k, m.n], ["gameplay", 2]);
});

await check("mods: a graphics pack, and MotS's list", async () => {
    const pack = makeZip([{ name: "JK HD Models.gob", data: makeGob([{ name: "3do\\ky.3do", data: "3DO" }]) }]);
    const MOTS = MOD_LIST.replace(/634/g, "844");
    fakeMods({
        "/media/levels/files/jkmod/blackyellow.zip": () => new Response(pack),
        "/levels/motsmod/?num=9999": () => new Response(MOTS),
        "/levels/files/844.shtml": () => new Response(MOD_PAGE.replace(/634/g, "844")),
        "/levels/download/844/": () => new Response(DL_PAGE(844).replace(/jkmod\/blackyellow/g, "motsmod/gold")),
        "/media/levels/files/motsmod/gold.zip": () => new Response(makeZip([{ name: "gold.goo", data: makeGob([{ name: "cog\\a.cog", data: "a" }]) }])),
    });
    const { job, env } = newJob();
    await runUntilIdle(job, 120);
    const jk = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/jk1-mods.json").bytes)).mods[0];
    assert.deepEqual([jk.k, jk.gp], ["graphics", "JK HD Models.gob"]);
    const mots = JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("index/mots-mods.json").bytes)).mods[0];
    assert.deepEqual([mots.id, mots.k, mots.n], [844, "gameplay", 1]);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(env.LEVELS.m.get("detail/844.json").bytes)).mod.plan.files, [["gold.goo", "gold.goo"]]);
});

await check("mods: a big GOB's file table, read as it streams by", async () => {
    const gob = makeGob([{ name: "cog\\a.cog", data: "x".repeat(5000) }, { name: "3do\\b.3do", data: "y".repeat(7000) }]);
    const t = gobTable();
    const chunks = [];
    for (let i = 0; i < gob.length; i += 1000)
        chunks.push(gob.subarray(i, i + 1000));
    await new Blob(chunks).stream().pipeThrough(t.stream).pipeTo(new WritableStream());
    assert.deepEqual(t.files(), [{ name: "cog/a.cog", size: 5000 }, { name: "3do/b.3do", size: 7000 }]);
    const notGob = gobTable();
    await new Blob([enc("not a gob at all")]).stream().pipeThrough(notGob.stream).pipeTo(new WritableStream());
    assert.equal(notGob.files(), null);
});

await check("mods: the route serves each game's mods", async () => {
    fakeMods();
    const { job, env } = newJob();
    await runUntilIdle(job, 80);
    const get = p => levelsRoute(new Request("https://beta.example" + p), env, new URL("https://beta.example" + p));
    let r = await get("/levels/mods/jk1.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(JSON.parse(await r.text()).mods[0].id, 634);
    r = await get("/levels/mods/mots.json");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(await r.text()).mods, []);
    assert.equal((await get("/levels/mods/df2.json")).status, 404);
    // Its zip, details and pictures go by the levels' routes.
    assert.equal(sha(new Uint8Array(await (await get("/levels/z/634.zip")).arrayBuffer())), sha(MOD_ZIP));
    assert.equal(JSON.parse(await (await get("/levels/d/634.json")).text()).mod.kind, "gameplay");
    assert.equal((await get("/levels/s/634-2.jpg")).status, 200);
});

// ---- jkdf2.net: the levels in its archive that Massassi doesn't have

// A folder of jkdf2.net's archive (Directory Lister), as its page has it.
function df2Folder(dir, files) {
    const li = (name, href, size, date, icon) => `
                                    <li data-name="${name}" data-href="${href}">
                        <a href="${href}" class="clearfix" data-name="${name}">
                            <div class="row">
                                <span class="file-name col-md-7 col-sm-6 col-xs-9">
                                    <i class="fa ${icon} fa-fw"></i>
                                    ${name}                                </span>
                                <span class="file-size col-md-2 col-sm-2 col-xs-3 text-right">
                                    ${size}                                </span>
                                <span class="file-modified col-md-3 col-sm-4 hidden-xs text-right">
                                    ${date}                                </span>
                            </div>
                        </a>
                    </li>`;
    return `<ul id="directory-listing" class="nav nav-pills nav-stacked">` +
        li("..", "https://www.jkdf2.net/JKBot/JKArchive/?dir=JKDF2%2FJKDF2%2FGame%20Files", "-", "2021-12-07 04:27:19", "fa-level-up") +
        li("info", `?dir=JKDF2/JKDF2/Game%20Files/${dir}/info`, "-", "2021-12-07 04:27:19", "fa-folder") +
        files.map(f => li(f.name.replace(/&/g, "&amp;"), `JKDF2/JKDF2/Game%20Files/${dir}/${encodeURIComponent(f.name)}`,
                          f.size, f.date || "2011-05-28 17:41:37", "fa-file-archive-o")).join("") + "</ul>";
}
const kb = b => (b.length / 1024).toFixed(2) + "KB";
const DF2_DIR = dir => `df2:/JKBot/JKArchive/?dir=JKDF2/JKDF2/Game%20Files/${dir}`;
const DF2_FILE = (dir, name) => `df2:/JKBot/JKArchive/JKDF2/JKDF2/Game%20Files/${dir}/${encodeURIComponent(name)}`;

const DIRGE_GOB = makeGob([{ name: "episode.jk", data: `"Square Dirge"\nTYPE 2\nSEQ 1\n10: 0 0 LEVEL dirge.jkl 0 0 -1 -1\n` },
                           { name: "jkl\\dirge.jkl", data: "SECTION: JK\n" }]);
const DIRGE_ZIP = makeZip([{ name: "DIRGE.gob", data: DIRGE_GOB, date: "2001-03-02" },
                           { name: "DIRGE_Readme.txt", data: "Square Dirge\r\nAuthor: Some Body (some@body.example)\r\nDate of Release : March 3, 2001\r\n",
                             date: "2001-03-03" }]);
const QAT_GOB = makeGob([{ name: "episode.jk", data: `"Qat Crystac"\nTYPE 2\nSEQ 1\n10: 0 0 LEVEL qat.jkl 0 0 -1 -1\n` },
                         { name: "jkl\\qat.jkl", data: "SECTION: JK\n" }]);
const QAT_ZIP = makeZip([{ name: "Qat.goo", data: QAT_GOB, date: "2000-08-01" }]);
// Massassi's 6000 Block under another name: the same GOB.
const COPY_ZIP = makeZip([{ name: "six.gob", data: GOB, date: "1999-10-15" }]);

function fakeDf2(extra) {
    // Massassi's preview fetches a zip from jkdf2.net only when its page is
    // opened: the map and textures aren't found before.
    const dirge = encodeURIComponent(DIRGE_URL);
    let opened = false;
    const viewer = `<script>var maps = JSON.parse("[[\\"dirge\\", \\"?url=${DIRGE_URL}\\u0026episode=0\\"]]");</script>`;
    const notYet = () => new Response("Not found", { status: 404 });
    return fakeMassassi(Object.assign({
        [`pv:/level/?url=${dirge}`]: () => (opened = true, new Response(viewer)),
        [DF2_DIR("jkmp")]: () => new Response(df2Folder("jkmp", [
            // Massassi's, and a second download of it: never asked for.
            { name: "6000.zip", size: kb(ZIP) }, { name: "6000[1].zip", size: kb(ZIP) },
            { name: "DIRGE.zip", size: kb(DIRGE_ZIP), date: "2014-12-01 10:13:09" },
            // The same file again in the archive.
            { name: "DIRGE (2).zip", size: kb(DIRGE_ZIP) },
            { name: "copy6000.zip", size: kb(COPY_ZIP) },
            { name: "huge & big.zip", size: "40.00MB" },
            { name: "notes.txt", size: "1.00KB" },
        ])),
        [DF2_DIR("jkctf")]: () => new Response(df2Folder("jkctf", [])),
        [DF2_DIR("motsmp")]: () => new Response(df2Folder("motsmp", [{ name: "qat.zip", size: kb(QAT_ZIP) }])),
        [DF2_DIR("motskfy")]: () => new Response(df2Folder("motskfy", [])),
        // The mods' folders: none in these checks (an "info" folder inside).
        [DF2_DIR("jkmod")]: () => new Response(df2Folder("jkmod", [])),
        [DF2_DIR("motsmod")]: () => new Response(df2Folder("motsmod", [])),
        [DF2_FILE("jkmp", "DIRGE.zip")]: () => new Response(DIRGE_ZIP, { headers: { "Content-Length": String(DIRGE_ZIP.length) } }),
        [DF2_FILE("jkmp", "copy6000.zip")]: () => new Response(COPY_ZIP),
        [DF2_FILE("motsmp", "qat.zip")]: () => new Response(QAT_ZIP),
        [pvUrl("map", dirge)]: () => opened ? new Response(PV_MAP) : notYet(),
        [pvUrl("mat", dirge)]: () => opened ? new Response(PV_MAT) : notYet(),
    }, extra || {}));
}
const idxOf = (env, key) => JSON.parse(new TextDecoder().decode(env.LEVELS.m.get(key).bytes));
// Massassi's 3D preview reads jkdf2.net's zips as it reads Massassi's.
const DIRGE_URL = "https://www.jkdf2.net/JKBot/JKArchive/JKDF2/JKDF2/Game%20Files/jkmp/DIRGE.zip";

await check("jkdf2.net: a folder of its archive, names, sizes, readme authors and titles", async () => {
    const files = read.parseArchive(df2Folder("motskfy", [{ name: "KFY.zip", size: "380.21KB" }, { name: "a & b.zip", size: "2.74MB", date: "-" }]));
    assert.deepEqual(files, [
        { name: "KFY.zip", href: "JKDF2/JKDF2/Game%20Files/motskfy/KFY.zip", size: "380.21KB", date: "2011-05-28 17:41:37" },
        { name: "a & b.zip", href: "JKDF2/JKDF2/Game%20Files/motskfy/a%20%26%20b.zip", size: "2.74MB", date: null },
    ]);
    assert.equal(read.zipKey("DPclean[1].zip"), "dpclean.zip");
    assert.equal(read.zipKey("Dirge (2).ZIP"), "dirge.zip");
    assert.equal(read.zipKey("v2 (final).zip"), "v2 (final).zip");
    assert.equal(read.sizeSlack("380.21KB"), 7);
    assert.equal(read.sizeSlack("226.0 KiB"), 53);
    assert.equal(read.sizeSlack(""), 0);
    assert.equal(read.readmeAuthor([{ text: "Title: Foo\nAuthor(s) : Brian Lozier <brian@example.com>\n" }]), "Brian Lozier");
    assert.equal(read.readmeAuthor([{ text: null }, { text: "A level\nCreated by: PSXPat\n" }]), "PSXPat");
    assert.equal(read.readmeAuthor([{ text: "by the way, have fun" }]), null);
    assert.equal(read.df2Title("  Square   Dirge ", "DIRGE.zip"), "Square Dirge");
    assert.equal(read.df2Title(null, "nicks_bridge.zip"), "nicks bridge");
});

await check("jkdf2.net: the zips Massassi doesn't have, slowly, in an index of their own", async () => {
    const seen = fakeDf2();
    const { job, env } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job, 80);
    const df2 = seen.filter(p => p.startsWith("df2:"));
    // Each folder, then the zips: never Massassi's (by name, or by a second
    // download's name), nor the big one, nor a second copy.
    assert.deepEqual(df2.slice(0, 6), ["jkmp", "jkctf", "motsmp", "motskfy", "jkmod", "motsmod"].map(DF2_DIR));
    assert.deepEqual(df2.slice(6).sort(), [DF2_FILE("jkmp", "DIRGE.zip"), DF2_FILE("jkmp", "copy6000.zip"), DF2_FILE("motsmp", "qat.zip")].sort());
    // Jedi Knight's only once Massassi's pages for it have all been read.
    const lastPage = seen.indexOf("/levels/files/400.shtml");
    assert.ok(lastPage > 0);
    assert.ok(seen.indexOf(DF2_FILE("jkmp", "DIRGE.zip")) > lastPage);
    assert.ok(seen.indexOf(DF2_FILE("jkmp", "copy6000.zip")) > lastPage);
    // The levels' index is Massassi's alone, as before.
    const jk = idxOf(env, "index/jk1.json");
    assert.deepEqual(jk.levels.map(l => l.id), [323]);
    assert.equal(jk.listed, 2);
    // Both, in the other.
    const all = idxOf(env, "index/jk1-all.json");
    assert.deepEqual(all.sources, ["https://www.massassi.net", "https://www.jkdf2.net"]);
    assert.deepEqual(all.levels.map(l => l.t), ["6000 Block", "Square Dirge"]);
    const d = all.levels[1];
    assert.ok(d.id > 1000000);
    assert.deepEqual([d.o, d.k, d.a, d.rel, d.rp, d.src, d.z, d.h, d.sz, d.sh], ["jkdf2.net", "mp", "Some Body", "2001-03-03", "d", "r",
                                                                              "DIRGE.zip", sha(DIRGE_ZIP), DIRGE_ZIP.length, 0]);
    // No Massassi date, rating or downloads; its 3D view from Massassi's preview.
    assert.deepEqual([d.add, d.r, d.v, d.dl], [undefined, undefined, undefined, undefined]);
    assert.deepEqual(d.pv, ["dirge"]);
    assert.equal(gunzip(env.LEVELS.m.get(`pv/${d.id}-0.map.json`).bytes), PV_MAP);
    assert.ok(env.LEVELS.m.has(`pv/${d.id}.tex.json`));
    // The preview's page first: a jkdf2.net zip is fetched by the preview only then.
    const dirge = encodeURIComponent(DIRGE_URL);
    assert.deepEqual(seen.filter(p => p.startsWith("pv:") && p.includes("DIRGE")),
                     [`pv:/level/?url=${dirge}`, pvUrl("map", dirge), pvUrl("mat", dirge)]);
    assert.deepEqual(d.g, [{ n: "DIRGE.gob", h: sha(DIRGE_GOB), b: DIRGE_GOB.length, ep: "Square Dirge", ty: 2, lv: ["dirge.jkl"] }]);
    assert.equal(all.left, 0);
    assert.deepEqual(all.from, { "jkdf2.net": 1 });
    // 323, 400 (gone), DIRGE, and the big one waiting.
    assert.equal(all.listed, 4);
    const mots = idxOf(env, "index/mots-all.json");
    assert.deepEqual(mots.levels.map(l => [l.t, l.o, l.z]), [["Qat Crystac", "jkdf2.net", "qat.zip"]]);
    assert.deepEqual(idxOf(env, "index/mots.json").levels, []);
    // Its detail says where it came from.
    const det = idxOf(env, `detail/${d.id}.json`);
    assert.deepEqual([det.from, det.url, det.massassi, det.title, det.author],
                     ["jkdf2.net", "https://www.jkdf2.net/JKBot/JKArchive/JKDF2/JKDF2/Game%20Files/jkmp/DIRGE.zip", undefined,
                      "Square Dirge", "Some Body"]);
    // The copy of 6000 Block was read and let go.
    const rows = job.sql.exec("SELECT name, zip_st, info FROM lv WHERE id > 1000000 ORDER BY name").toArray();
    assert.deepEqual(rows.map(r => [r.name, r.zip_st]), [["6000.zip", "dupe"], ["DIRGE.zip", "ok"], ["copy6000.zip", "dupe"],
                                                         ["huge & big.zip", "big"], ["qat.zip", "ok"]]);
    assert.equal(JSON.parse(rows[0].info).mas, 323);
    assert.equal(JSON.parse(rows[2].info).same, 323);
    const copyId = job.sql.exec("SELECT id FROM lv WHERE name = 'copy6000.zip'").toArray()[0].id;
    assert.ok(!env.LEVELS.m.has(`zip/${copyId}.zip`));
    assert.ok(!env.LEVELS.m.has(`detail/${copyId}.json`));
    const st = await job.status();
    assert.deepEqual([st.jkdf2.on, st.jkdf2.today, st.jkdf2.total, st.jkdf2.per_day, st.jkdf2.max_mb], [true, 3, 3, 300, 32]);
    assert.deepEqual([st.lists.df2jkmp.n, st.lists.df2jkmp.same_as_massassi, st.lists.df2jkmp.copies], [6, 0, 2]);
    assert.deepEqual(st.jkdf2.dupes, [{ game: "jk1", mods: 0, by_name: 1, by_gobs: 1, by_zip: 0 }]);
    // The next day's look at the folder knows 6000.zip by name now.
    job.kv("list_at:df2jkmp", 0);
    seen.length = 0;
    await runUntilIdle(job, 20);
    assert.deepEqual(seen.filter(p => p.startsWith("df2:")), [DF2_DIR("jkmp")]);
    assert.equal((await job.status()).lists.df2jkmp.same_as_massassi, 1);
    // The routes.
    const get = p => levelsRoute(new Request("https://beta.example" + p), env, new URL("https://beta.example" + p));
    let r = await get("/levels/all/jk1.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(JSON.parse(await r.text()).levels.length, 2);
    assert.equal((await get("/levels/all/mots.json")).status, 200);
    assert.equal((await get("/levels/all/df2.json")).status, 404);
    r = await get(`/levels/z/${d.id}.zip?h=${d.h}`);
    assert.equal(sha(new Uint8Array(await r.arrayBuffer())), sha(DIRGE_ZIP));
    assert.equal(r.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});

await check("jkdf2.net: at most LEVELS_DF2_PER_DAY zips a day, smallest first, and the big ones once the cap is raised", async () => {
    const seen = fakeDf2();
    const { job, env } = newJob({ LEVELS_DF2: "1", LEVELS_DF2_PER_DAY: "1" });
    await runUntilIdle(job, 80);
    const zips = seen.filter(p => p.startsWith("df2:") && p.endsWith(".zip"));
    // MotS's has no Massassi pages to wait for: its first.
    assert.deepEqual(zips, [DF2_FILE("motsmp", "qat.zip")]);
    const st = await job.status();
    assert.equal(st.jkdf2.today, 1);
    // 6000.zip (Massassi's, as it will find), DIRGE.zip and copy6000.zip; not the big one.
    assert.equal(idxOf(env, "index/jk1-all.json").left, 3);
    // A new day.
    job.kv("df2_day", "2000-01-01");
    env.LEVELS_DF2_PER_DAY = "5";
    seen.length = 0;
    await runUntilIdle(job, 40);
    assert.deepEqual(seen.filter(p => p.startsWith("df2:")), [DF2_FILE("jkmp", "DIRGE.zip"), DF2_FILE("jkmp", "copy6000.zip")]);
    // The big one waits for a higher cap, and comes at the folder's next look.
    env.LEVELS_DF2_MAX_MB = "64";
    const BIG = makeZip([{ name: "big.gob", data: makeGob([{ name: "episode.jk", data: `"Big One"\nTYPE 2\n10: 0 0 LEVEL big.jkl 0 0 -1 -1\n` }]) }]);
    const seen2 = fakeDf2({ [DF2_FILE("jkmp", "huge & big.zip")]: () => new Response(BIG) });
    job.kv("list_at:df2jkmp", 0);
    await runUntilIdle(job, 40);
    assert.deepEqual(seen2.filter(p => p.startsWith("df2:")), [DF2_DIR("jkmp"), DF2_FILE("jkmp", "huge & big.zip")]);
    assert.ok(idxOf(env, "index/jk1-all.json").levels.some(l => l.t === "Big One"));
});

await check("jkdf2.net busy: only its own work waits; LEVELS_DF2 = \"0\" asks it nothing", async () => {
    const seen = fakeDf2({ [DF2_FILE("motsmp", "qat.zip")]: () => new Response("busy", { status: 503 }) });
    const { job } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job, 80);
    assert.ok(Number(job.kv("df2_backoff_until")) > Date.now());
    assert.ok(!job.kv("backoff_until") || Number(job.kv("backoff_until")) < Date.now());
    assert.equal(job.sql.exec("SELECT tries, zip_st FROM lv WHERE name = 'qat.zip'").toArray()[0].zip_st, null);
    // Massassi's levels went on.
    assert.ok(seen.includes("/levels/files/400.shtml"));
    const off = fakeDf2();
    const { job: job2 } = newJob();
    await runUntilIdle(job2, 80);
    assert.ok(!off.some(p => p.startsWith("df2:")));
    assert.equal((await job2.status()).jkdf2.on, false);
});

await check("jkdf2.net: one Massassi gets later, with the same GOBs, leaves the index of both", async () => {
    const seen = fakeDf2();
    const { job, env } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job, 80);
    assert.ok(idxOf(env, "index/jk1-all.json").levels.some(l => l.t === "Square Dirge"));
    // Massassi adds it, under another name.
    const page = PAGE.replace(/323/g, "500").replace("6000 Block</h1>", "Square Dirge</h1>").replace(/jkmp\/6000\.zip/g, "jkmp/sqdirge.zip");
    const list = LIST + `<div class="level-list-screenshot"></div><div class="level-list-item">
    <strong><a href="/levels/files/500.shtml">Square Dirge</a></strong><br>
    <span class="mute">By:</span> Some Body<br><span class="mute">Added:</span> 2026-11-20<br></div>
    <div class="level-list-details"><span class="mute">Downloads:</span> 3</div>`;
    const MAS_DIRGE = makeZip([{ name: "dirge.gob", data: DIRGE_GOB }]);
    fakeDf2({
        "/levels/jkmp/?num=9999": () => new Response(list),
        "/levels/files/500.shtml": () => new Response(page),
        "/media/levels/files/jkmp/sqdirge.zip": () => new Response(MAS_DIRGE),
    });
    job.kv("list_at:jkmp", 0);
    await runUntilIdle(job, 80);
    const all = idxOf(env, "index/jk1-all.json");
    assert.deepEqual(all.levels.map(l => [l.id, l.o]), [[323, undefined], [500, undefined]]);
    assert.deepEqual(all.from, { "jkdf2.net": 0 });
});

// ---- jkdf2.net: the mods in its archive that Massassi doesn't have

const SABERS_GOB = makeGob([{ name: "cog\\force_saber.cog", data: "# saber" }, { name: "mat\\shiny.mat", data: "MAT " }]);
const SABERS_ZIP = makeZip([{ name: "SABERS.GOB", data: SABERS_GOB, date: "1998-01-10" },
                            { name: "SABERS.TXT", data: "Title           : Shiny Sabers\r\nAuthor          : A. Person\r\n", date: "1998-01-10" }]);
const NINJA_ZIP = makeZip([{ name: "Resource/3do/ninja.3do", data: "3DO", date: "1998-02-01" },
                           { name: "Resource/mat/ninja.mat", data: "MAT ", date: "1998-02-01" }]);
const HEAL_GOO = makeGob([{ name: "cog\\force_heal.cog", data: "# heal" }]);
const HEAL_ZIP = makeZip([{ name: "Force Heal All.goo", data: HEAL_GOO, date: "1999-01-01" },
                          { name: "readme.txt", data: "Title                   : Force Heal All\n", date: "1999-01-01" }]);
// A mods folder of jkdf2.net's, with folders inside it (subs).
const df2ModFolder = (dir, files, subs) => df2Folder(dir, files).replace("</ul>", (subs || []).map(n =>
    `<li data-name="${n}" data-href="?dir=JKDF2/JKDF2/Game%20Files/${dir}/${encodeURIComponent(n)}"><a href="?dir=x">${n}</a></li>`)
    .join("") + "</ul>");

function fakeDf2Mods(extra) {
    return fakeDf2(Object.assign({
        "/levels/jkmod/?num=9999": () => new Response(MOD_LIST),
        "/levels/files/634.shtml": () => new Response(MOD_PAGE),
        "/levels/download/634/": () => new Response(DL_PAGE(634)),
        "/media/levels/files/jkmod/blackyellow.zip": () => new Response(MOD_ZIP),
        "/media/levels/screenshots/634_1.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 3])),
        "/media/levels/screenshots/634_2.jpg": () => new Response(new Uint8Array([0xff, 0xd8, 4])),
        [DF2_DIR("jkmod")]: () => new Response(df2ModFolder("jkmod", [
            // Massassi's by name; Massassi's under another name; a new one; one it can't open.
            { name: "blackyellow.zip", size: kb(MOD_ZIP) }, { name: "renamed.zip", size: kb(MOD_ZIP) },
            { name: "SABERS.ZIP", size: kb(SABERS_ZIP) }, { name: "pack.rar", size: "1.00KB" },
        ], ["skins", "Old Mod (prior versions)"])),
        [DF2_DIR("jkmod/skins")]: () => new Response(df2Folder("jkmod/skins", [{ name: "ninja.zip", size: kb(NINJA_ZIP) }])),
        [DF2_DIR("motsmod")]: () => new Response(df2Folder("motsmod", [{ name: "Fhealmots.zip", size: kb(HEAL_ZIP) }])),
        [DF2_FILE("jkmod", "renamed.zip")]: () => new Response(MOD_ZIP),
        [DF2_FILE("jkmod", "SABERS.ZIP")]: () => new Response(SABERS_ZIP),
        [DF2_FILE("jkmod/skins", "ninja.zip")]: () => new Response(NINJA_ZIP),
        [DF2_FILE("motsmod", "Fhealmots.zip")]: () => new Response(HEAL_ZIP),
    }, extra || {}));
}

await check("jkdf2.net mods: a readme's title, and the folders inside a folder", async () => {
    assert.equal(read.readmeTitle([{ text: "Title\t\t: JediSaber\r\nAuthor\t\t: Chris James\r\n" }]), "JediSaber");
    assert.equal(read.readmeTitle([{ text: null }, { text: "Mod Title: \"Force Push\"\n" }]), "Force Push");
    assert.equal(read.readmeTitle([{ text: "Title                   : \nAuthor: x\n" }]), null);
    assert.equal(read.readmeTitle([{ text: "The title of this mod is long" }]), null);
    const html = df2ModFolder("jkmod", [], ["ai skins", "Killing Time (prior versions)"]);
    assert.deepEqual(read.parseArchiveDirs(html, "jkmod"), [
        { name: "info", dir: "jkmod/info" }, { name: "ai skins", dir: "jkmod/ai%20skins" },
        { name: "Killing Time (prior versions)", dir: "jkmod/Killing%20Time%20(prior%20versions)" },
    ]);
    // Not a folder of another's, and not the one above.
    assert.deepEqual(read.parseArchiveDirs(html, "motsmod"), []);
});

await check("jkdf2.net mods: a title, description and words from a readme or the zip's name", async () => {
    assert.equal(read.readmeFirstLine([{ text: "11/17/98\r\n\r\nBIG FLUFFY PACK 2\r\nMOTSBFP2\r\n" }]), "BIG FLUFFY PACK 2");
    assert.equal(read.readmeFirstLine([{ text: "Rbots - Make new character wizard\n----\n" }]), "Rbots - Make new character wizard");
    assert.equal(read.readmeFirstLine([{ text: "File: anipod-1.zip\nAuthor: Zymotico\n" }]), null);
    assert.equal(read.readmeFirstLine([{ text: "==JEDI KNIGHT ADDON MISSION====\nTitle      : \n" }]), null);
    assert.equal(read.readmeFirstLine([{ text: "This file contains a GOB for you to see for yourself what the pod looks like.\n" }]), null);
    assert.equal(read.nameTitle("SPYPACK.ZIP"), "Spypack");
    assert.equal(read.nameTitle("BOBA_SP.ZIP"), "Boba Sp");
    assert.equal(read.nameTitle("Obi Wan.ZIP"), "Obi Wan");
    assert.equal(read.nameTitle("predh2h.zip"), "Predh2h");
    assert.equal(read.nameTitle("homing_raildet.zip"), "Homing Raildet");
    assert.equal(read.nameTitle("JK-Cars.zip"), "JK-Cars");
    assert.deepEqual(read.modWords(["mat/a.mat", "cog/kyle.cog", "3do/skeletor.3do", "3do/heman.3do", "sound/yah.wav", "3do/HEMAN.3do"]),
                     ["skeletor", "heman", "kyle", "yah"]);
    assert.equal(read.readmeDesc([{ text: "Title : X\nDescription      : This patch adds several MP skins\n                   based on Episode II.\n\nCredits : me\n" }]),
                 "This patch adds several MP skins based on Episode II.");
    assert.equal(read.readmeDesc([{ text: "nothing here" }]), null);
});

await check("jkdf2.net mods: one of loose files, named by its zip and found by its files' names", async () => {
    const MOTU_ZIP = makeZip([{ name: "skeletor.3do", data: "3DO", date: "1998-05-01" }, { name: "heman.3do", data: "3DO", date: "1998-05-01" },
                              { name: "sktchest.mat", data: "MAT ", date: "1998-05-01" }]);
    const seen = fakeDf2Mods({
        [DF2_DIR("jkmod/skins")]: () => new Response(df2Folder("jkmod/skins", [{ name: "MASTERS.ZIP", size: kb(MOTU_ZIP) }])),
        [DF2_FILE("jkmod/skins", "MASTERS.ZIP")]: () => new Response(MOTU_ZIP),
    });
    const { job, env } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job, 150);
    assert.ok(seen.includes(DF2_FILE("jkmod/skins", "MASTERS.ZIP")));
    const m = idxOf(env, "index/jk1-mods-all.json").mods.find(x => x.z === "MASTERS.ZIP");
    assert.deepEqual([m.t, m.k, m.n, m.ty, m.f, m.o], ["Masters", "characters", 3, true, ["skeletor", "heman"], "jkdf2.net"]);
    const det = idxOf(env, `detail/${m.id}.json`);
    assert.deepEqual(det.mod.plan.files, [["skeletor.3do", "3do/skeletor.3do"], ["heman.3do", "3do/heman.3do"], ["sktchest.mat", "mat/sktchest.mat"]]);
    assert.equal(det.mod.plan.typed, true);
    // The one with a readme: its title, author and description from it.
    const s2 = idxOf(env, "index/jk1-mods-all.json").mods.find(x => x.z === "SABERS.ZIP");
    assert.deepEqual([s2.t, s2.a, s2.f], ["Shiny Sabers", "A. Person", ["force_saber"]]);
});

await check("mods: Massassi's with nothing for the game before are read again, once, for files loose in their zip", async () => {
    const LOOSE = makeZip([{ name: "flame.cog", data: "# flame" }, { name: "readme.txt", data: "Put flame.cog in your cog folder." }]);
    fakeMods({ "/media/levels/files/jkmod/blackyellow.zip": () => new Response(LOOSE) });
    const { job, env } = newJob();
    await runUntilIdle(job, 80);
    assert.equal(job.sql.exec("SELECT zip_st FROM lv WHERE id = 634").toArray()[0].zip_st, "ok");
    // As a job from before modPlan placed them left it.
    job.sql.exec("UPDATE lv SET zip_st = 'nomod' WHERE id = 634");
    job.kv("typed_plan", 0);
    const seen = fakeMods({ "/media/levels/files/jkmod/blackyellow.zip": () => new Response(LOOSE) });
    const again = new LevelJob(job.ctx, env);
    await runUntilIdle(again, 80);
    assert.equal(again.sql.exec("SELECT zip_st FROM lv WHERE id = 634").toArray()[0].zip_st, "ok");
    // The zip again (its address known: not its download page).
    assert.deepEqual(seen.filter(p => /634|blackyellow/.test(p)), ["/media/levels/files/jkmod/blackyellow.zip"]);
    assert.equal(again.kv("typed_plan"), "1");
});

await check("jkdf2.net mods: the ones Massassi doesn't have, in the levels' queue, in an index of their own", async () => {
    const seen = fakeDf2Mods();
    const { job, env } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job, 150);
    const df2 = seen.filter(p => p.startsWith("df2:"));
    // The mods' folders and the one inside (not its readmes, nor a mod's older versions).
    assert.ok(df2.includes(DF2_DIR("jkmod")) && df2.includes(DF2_DIR("jkmod/skins")) && df2.includes(DF2_DIR("motsmod")));
    assert.ok(!df2.some(p => /info|prior/.test(p)), df2.join(" "));
    // Never Massassi's by name, nor one it can't open.
    assert.ok(!df2.includes(DF2_FILE("jkmod", "blackyellow.zip")));
    assert.ok(!df2.some(p => p.endsWith(".rar")));
    // Jedi Knight's only once Massassi's mods have had their download page read.
    const dl = seen.indexOf("/levels/download/634/");
    assert.ok(dl > 0);
    for (const f of [DF2_FILE("jkmod", "renamed.zip"), DF2_FILE("jkmod", "SABERS.ZIP"), DF2_FILE("jkmod/skins", "ninja.zip")])
        assert.ok(seen.indexOf(f) > dl, f);
    // Never the 3D preview for a mod.
    assert.ok(!seen.some(p => p.startsWith("pv:") && /SABERS|ninja|Fheal|renamed/.test(p)));
    // The mods' index is Massassi's alone, as before; the levels' have no mods.
    assert.deepEqual(idxOf(env, "index/jk1-mods.json").mods.map(m => m.id), [634]);
    assert.ok(!idxOf(env, "index/jk1-all.json").levels.some(l => /Sabers|ninja/.test(l.t)));
    // Both, in the other: the renamed copy of 634 left out.
    const all = idxOf(env, "index/jk1-mods-all.json");
    assert.deepEqual(all.sources, ["https://www.massassi.net", "https://www.jkdf2.net"]);
    assert.deepEqual(all.mods.map(m => [m.t, m.o]), [["Black and Yellow Flame Saber", undefined], ["Ninja", "jkdf2.net"],
                                                     ["Shiny Sabers", "jkdf2.net"]]);
    assert.deepEqual(all.from, { "jkdf2.net": 2 });
    assert.equal(all.left, 0);
    const m = all.mods[2];
    assert.ok(m.id > 1000000);
    // Its title and author from its readme; no Massassi date, rating or downloads.
    assert.deepEqual([m.a, m.k, m.z, m.h, m.sz, m.n, m.rel], ["A. Person", "gameplay", "SABERS.ZIP", sha(SABERS_ZIP), SABERS_ZIP.length, 2,
                                                              "1998-01-10"]);
    assert.deepEqual([m.add, m.r, m.v, m.dl], [undefined, undefined, undefined, undefined]);
    assert.equal(all.mods[1].k, "characters");
    const det = idxOf(env, `detail/${m.id}.json`);
    assert.deepEqual([det.from, det.url, det.massassi, det.title, det.author, det.mod.kind],
                     ["jkdf2.net", "https://www.jkdf2.net/JKBot/JKArchive/JKDF2/JKDF2/Game%20Files/jkmod/SABERS.ZIP", undefined,
                      "Shiny Sabers", "A. Person", "gameplay"]);
    assert.deepEqual(det.mod.plan.files, [["SABERS.GOB", "SABERS.GOB"]]);
    // The renamed copy: the very zip of Massassi's, so not kept (when it came
    // after Massassi's), or left out of the index (when before).
    const copy = job.sql.exec("SELECT id, zip_st, info FROM lv WHERE name = 'renamed.zip'").toArray()[0];
    assert.ok(copy.zip_st === "dupe" ? JSON.parse(copy.info).same_zip === 634 : copy.zip_st === "ok", copy.zip_st);
    // MotS's: no Massassi mods to wait for.
    assert.deepEqual(idxOf(env, "index/mots-mods-all.json").mods.map(x => [x.t, x.o, x.k]), [["Force Heal All", "jkdf2.net", "gameplay"]]);
    assert.deepEqual(idxOf(env, "index/mots-mods.json").mods, []);
    const st = await job.status();
    // One day's count for levels and mods: DIRGE, copy6000, qat, and the four mods.
    assert.deepEqual([st.jkdf2.mods, st.jkdf2.today], [true, 7]);
    // Massassi's zip wasn't known by name at the folder's first read: found
    // to be Massassi's before it was asked for.
    assert.deepEqual([st.lists.df2jkmod.n, st.lists.df2jkmod.same_as_massassi, st.lists["df2jkmod/skins"].n, st.lists.df2motsmod.n],
                     [3, 0, 1, 1]);
    const by = job.sql.exec("SELECT zip_st, info FROM lv WHERE name = 'blackyellow.zip'").toArray()[0];
    assert.deepEqual([by.zip_st, JSON.parse(by.info).mas], ["dupe", 634]);
    assert.ok(st.mod_kinds.some(k => k.game === "mots" && k.kind === "gameplay"));
    // The routes.
    const get = p => levelsRoute(new Request("https://beta.example" + p), env, new URL("https://beta.example" + p));
    const r = await get("/levels/mods/all/jk1.json");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(JSON.parse(await r.text()).mods.length, 3);
    assert.equal((await get("/levels/mods/all/mots.json")).status, 200);
    assert.equal((await get("/levels/mods/all/df2.json")).status, 404);
    assert.equal(sha(new Uint8Array(await (await get(`/levels/z/${m.id}.zip?h=${m.h}`)).arrayBuffer())), sha(SABERS_ZIP));
});

await check("jkdf2.net mods: the same day's count as its levels, smallest first", async () => {
    const seen = fakeDf2Mods();
    const { job } = newJob({ LEVELS_DF2: "1", LEVELS_DF2_PER_DAY: "2" });
    await runUntilIdle(job, 150);
    const zips = () => seen.filter(p => p.startsWith("df2:") && !p.includes("?dir="));
    // Two zips in all, levels and mods together.
    assert.equal(zips().length, 2);
    assert.equal((await job.status()).jkdf2.today, 2);
    // The rest the next day.
    job.kv("df2_day", "2000-01-01");
    job.env.LEVELS_DF2_PER_DAY = "50";
    await runUntilIdle(job, 150);
    assert.equal(zips().length, 7);
});

await check("jkdf2.net mods: LEVELS_DF2_MODS = \"0\" leaves them alone; a folder inside that's gone isn't asked again", async () => {
    const seen = fakeDf2Mods();
    const { job } = newJob({ LEVELS_DF2: "1", LEVELS_DF2_MODS: "0" });
    await runUntilIdle(job, 150);
    assert.ok(!seen.some(p => /jkmod|motsmod/.test(p) && p.startsWith("df2:")));
    assert.ok(seen.includes(DF2_FILE("jkmp", "DIRGE.zip")));
    assert.equal((await job.status()).jkdf2.mods, false);
    // The skins folder goes away.
    const seen2 = fakeDf2Mods({ [DF2_DIR("jkmod/skins")]: () => new Response("Not found", { status: 404 }) });
    const { job: job2 } = newJob({ LEVELS_DF2: "1" });
    await runUntilIdle(job2, 150);
    assert.equal(seen2.filter(p => p === DF2_DIR("jkmod/skins")).length, 1);
    assert.ok(!job2.kv("df2_backoff_until") || Number(job2.kv("df2_backoff_until")) < Date.now());
    assert.ok(!(await job2.status()).lists["df2jkmod/skins"]);
    assert.ok(seen2.includes(DF2_FILE("jkmod", "SABERS.ZIP")));
});

if (failed) {
    console.log(`${failed} failed`);
    process.exit(1);
}
console.log("all ok");
