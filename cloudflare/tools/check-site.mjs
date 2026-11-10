#!/usr/bin/env node
// After a deploy: checks how the site sends the page and the engine files, against the kit just
// deployed. Node.js 22 or newer, nothing else. In the kit's folder:
//
//   node tools/check-site.mjs https://beta.jediknight.zone
//   node tools/check-site.mjs https://jediknight.zone
//
// (a second argument names another public/ than ./public). It asks as a browser would (Accept:
// text/html for the page; Accept-Encoding as Chrome sends it, or CHECK_AE) and reads the bytes as
// they come, unpacking them only to compare. Each line says ok, or BAD and what's wrong with the
// kit's files or how the Worker sends them, or "zone" for something the kit can't change: the
// page's ETag (and so its 304) depends on the zone's settings, so a missing one is a zone line,
// not a fault of the kit. A few dozen requests, all GET or HEAD, about 4 MB.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// CHECK_AE=br for wrangler dev, which answers with the first coding listed (gzip for Chrome's).
export const CHROME_AE = "gzip, deflate, br, zstd";
const YEAR = /max-age=31536000/;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

// The bytes as the browser would read them, or null for a coding this Node.js can't unpack.
function unpack(r) {
    const ce = (r.h["content-encoding"] || "identity").toLowerCase();
    try {
        if (ce === "identity") return r.body;
        if (ce === "br") return zlib.brotliDecompressSync(r.body);
        if (ce === "gzip") return zlib.gunzipSync(r.body);
        if (ce === "deflate") return zlib.inflateSync(r.body);
        if (ce === "zstd" && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(r.body);
    } catch (e) {}
    return null;
}

function nodeGet(base) {
    return (p, headers = {}, method = "GET") => {
        const url = new URL(p, base);
        const lib = url.protocol === "https:" ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request(url, { method, headers: { "User-Agent": "jkdf2mp check-site", ...headers } }, res => {
                const chunks = [];
                res.on("data", c => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(chunks) }));
            });
            req.on("error", reject);
            req.setTimeout(30000, () => req.destroy(new Error("no answer in 30 s")));
            req.end();
        });
    };
}

// get(path, headers, method) -> { status, h: { lowercased name: value }, body: Buffer }.
// Returns the counts: { bad, zone }.
export async function checkSite({ pub, get, ae = CHROME_AE, log = console.log }) {
    const kits = JSON.parse(fs.readFileSync(path.join(pub, "kit-files.json"), "utf8")).kits;
    const table = kits[0].page;
    const counts = { bad: 0, zone: 0 };
    const line = (ok, what, detail, kind = "BAD ") => {
        if (!ok) counts[kind === "zone" ? "zone" : "bad"]++;
        log(`${ok ? "ok  " : kind} ${what}${detail ? ": " + detail : ""}`);
    };
    const coding = r => r.h["content-encoding"] || "identity";
    const cc = r => r.h["cache-control"] || "no Cache-Control";

    // The page: this kit's, and its ETag and 304 (L5, the zone's settings).
    const page = await get("/", { Accept: "text/html", "Accept-Encoding": ae });
    line(page.status === 200, "page", `HTTP ${page.status}, ${coding(page)}, ${page.body.length} B`);
    const kitPage = fs.readFileSync(path.join(pub, "index.html"));
    // A coding this Node.js can't unpack (zstd before 22.15): once more as gzip, to read it.
    const served = unpack(page) ?? unpack(await get("/", { Accept: "text/html", "Accept-Encoding": "gzip" }));
    const names = [table.jspi.js, table.jspi.wasm, table.asyncify.js, table.asyncify.wasm, table.unzip];
    line(served !== null && names.every(n => served.includes(n)), "page names this kit's engine files",
         served === null ? `can't unpack ${coding(page)} here` : table.jspi.wasm);
    if (served !== null)
        log(`     page is the kit's ${served.equals(kitPage) ? "byte for byte" :
            `with ${served.length - kitPage.length} B more or less (Cloudflare adds to it: Web Analytics?)`}`);
    const etag = page.h.etag;
    if (!etag) {
        line(false, "page ETag", "none: the zone takes it off (Email Obfuscation, Automatic HTTPS Rewrites, " +
             "Rocket Loader or Web Analytics' automatic setup), so every visit downloads the page again", "zone");
    } else {
        const again = await get("/", { Accept: "text/html", "Accept-Encoding": ae, "If-None-Match": etag });
        line(again.status === 304, "page asked again with its ETag", `${etag} -> HTTP ${again.status}`, "zone");
    }

    // Each engine file: the kit's .br to a browser that takes br, the plain file otherwise, kept a year.
    for (const [what, file] of [["JSPI wasm", table.jspi.wasm], ["JSPI script", table.jspi.js],
                                ["Asyncify wasm", table.asyncify.wasm], ["Asyncify script", table.asyncify.js],
                                ["unzip.js", table.unzip]]) {
        const br = fs.readFileSync(path.join(pub, file + ".br"));
        const plain = fs.readFileSync(path.join(pub, file));
        const type = file.endsWith(".wasm") ? "application/wasm" : "text/javascript";
        const r = await get("/" + file, { "Accept-Encoding": ae });
        const same = sha(r.body) === sha(br);
        line(r.status === 200 && r.h["content-encoding"] === "br" && same, `${what}, browser takes br`,
             `HTTP ${r.status}, ${coding(r)}, ${r.body.length} B` +
             (same ? " (the kit's .br, byte for byte)" : ` (kit's .br: ${br.length} B)`));
        line((r.h["content-type"] || "").startsWith(type), `${what} type`, r.h["content-type"]);
        line(YEAR.test(cc(r)) && /immutable/.test(cc(r)) && /no-transform/.test(cc(r)), `${what} kept a year`, cc(r));
        const g = await get("/" + file, { "Accept-Encoding": "gzip" });
        const got = unpack(g);
        line(g.status === 200 && g.h["content-encoding"] !== "br" && got !== null && got.equals(plain),
             `${what}, browser without br`, `HTTP ${g.status}, ${coding(g)}, ${g.body.length} B` +
             (got !== null && !got.equals(plain) ? " (NOT the kit's file)" : ""));
        line(YEAR.test(cc(g)) && /immutable/.test(cc(g)), `${what} without br kept a year`, cc(g));
    }

    // Names that aren't there, and a .br by its own name: 404 that nothing keeps.
    for (const [what, p] of [["a name that isn't there", table.jspi.wasm.replace(/[0-9a-f]{12}/, "ffffffffffff")],
                             ["a .br by its own name", table.jspi.wasm + ".br"],
                             ["a room picture that isn't there", "rooms/nar-shaddaa.00000000.webp"]]) {
        const r = await get("/" + p, { "Accept-Encoding": ae });
        line(r.status === 404 && /no-store/.test(cc(r)) && !r.h["content-encoding"], what,
             `HTTP ${r.status}, ${cc(r)}`);
    }

    // The room pictures, and the kept kits' files.
    for (const f of kits[0].files.filter(f => f.startsWith("rooms/"))) {
        const r = await get("/" + f, { "Accept-Encoding": ae }, "HEAD");
        line(r.status === 200 && YEAR.test(cc(r)) && /immutable/.test(cc(r)), f, `HTTP ${r.status}, ${cc(r)}`);
    }
    for (const kit of kits.slice(1))
        for (const f of kit.files) {
            const r = await get("/" + f, { "Accept-Encoding": ae }, "HEAD");
            line(r.status === 200, `kept (${kit.label}) ${f}`, `HTTP ${r.status}`);
        }

    log(counts.bad ? `${counts.bad} to look at` : "all ok" +
        (counts.zone ? `; ${counts.zone} for the zone's settings (not the kit)` : ""));
    return counts;
}

// Run as a command, not imported (test/build-kit.mjs imports checkSite). node gives this file's URL
// with the links in its path (a symlink, or a junction on Windows) replaced by their targets, but
// process.argv[1] as typed, so through a link the two never matched and the check printed nothing
// at all. Both go through realpath first (the system's, then node's own), compared without case on
// Windows, where a \\server\share's name comes back lowercased.
function runAsCommand() {
    if (!process.argv[1]) return false;
    const a = path.resolve(process.argv[1]), b = fileURLToPath(import.meta.url);
    const same = (x, y) => process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
    for (const real of [fs.realpathSync.native, fs.realpathSync])
        try {
            if (same(real(a), real(b))) return true;
        } catch (e) {}
    return same(a, b);
}

if (runAsCommand()) {
    let base;
    try {
        base = new URL(process.argv[2]);
    } catch (e) {}
    if (!base || !/^https?:$/.test(base.protocol)) {
        console.error("usage: node tools/check-site.mjs https://<site> [<kit's public/>]");
        process.exit(2);
    }
    const pub = path.resolve(process.argv[3] || "public");
    const { bad } = await checkSite({ pub, get: nodeGet(base), ae: process.env.CHECK_AE || CHROME_AE });
    process.exit(bad ? 1 : 0);
}
