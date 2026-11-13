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
        assert.ok(["https://www.massassi.net", "https://3dpreview.massassi.net"].includes(u.origin), u.origin);
        assert.match(init.headers["User-Agent"], /^Mozilla\/5\.0 \(compatible; level-index/);
        const p = (u.origin.startsWith("https://3d") ? "pv:" : "") + u.pathname + u.search;
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
    assert.equal(seen.filter(p => p.includes("num=9999")).length, 6);
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
    assert.equal(st.requests_total, 14);
    assert.deepEqual(st.not_ready, [{ st: "gone", n: 1 }]);
    const mp = st.by_list.find(b => b.cat === "jkmp");
    assert.deepEqual([mp.previews, mp.previews_left, mp.previews_none], [1, 0, 0]);
    assert.ok(mp.preview_bytes > 0);
    // The 3D data counts toward its own cap, not the levels'.
    assert.equal(st.stored_bytes, ZIP.length + 6);
    assert.equal(st.preview_bytes, mp.preview_bytes);
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
    assert.equal(JSON.parse(await r.text()).requests_total, 14);
    r = await get("/levels/p/323.tex.json");
    assert.equal(r.status, 200);
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
    assert.deepEqual(tex, { own: [], cmp: { 6000: "lev6000.cmp" }, pal: {} });
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
    assert.ok(!seen.includes(pvUrl("mat")));
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

if (failed) {
    console.log(`${failed} failed`);
    process.exit(1);
}
console.log("all ok");
