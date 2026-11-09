#!/usr/bin/env node
// Makes a deploy kit's public/ folder from two engine builds and the page,
// keeping the files of the last kits, so the Worker (src/engine.js) can send
// every engine file brotli-compressed at its best and browsers can keep them
// for good. Node.js 22 or newer, nothing else.
//
//   node tools/build-kit.mjs public --asyncify <dir> --jspi <dir> --page <index.html>
//        --prev <previous kit's public/> --out <kit folder> [--label cloudflare-93] [--keep 3]
//   node tools/build-kit.mjs sums <kit folder>
//   node tools/build-kit.mjs check <kit folder>
//
// public: --asyncify and --jspi are build web/ folders (openjkdf2.js and
// openjkdf2.wasm each). --page is packaging/wasm/index.html; its folder also
// gives unzip.js, move-out.html and the room pictures the page names
// (rooms/<key>.<8 hex>.<ext>). --prev is the public/ of the kit deployed
// before this one (it says which kits' files it kept, in kit-files.json; a
// kit from before this script, cloudflare-92, is read by its fixed names).
// It writes <out>/public/ (which must not be there yet) and <out>/SHA256SUMS:
//
//   index.html             the page, with ENGINE_FILES (the JSON between its
//                          /* kit-files */ and /* /kit-files */ marks) naming
//                          the files below; nothing else in it changes
//   e/openjkdf2.<h>.js     the Asyncify engine, <h> = the first 12 hex digits
//   e/openjkdf2.<h>.wasm   of the file's SHA-256, each with <name>.br beside
//   e/jspi/openjkdf2.<h>.* it: brotli quality 11, window 24
//   e/unzip.<h>.js         the page's unzip worker, also with a .br
//   rooms/...              the room pictures, as the page names them
//   move-out.html          as it is (it's opened by name, from the old address)
//   _headers               a year for rooms/ and e/ (e/ goes through the
//                          Worker, which says the same)
//   .assetsignore          keeps kit-files.json out of the upload
//   kit-files.json         which files each kept kit's page loads, newest
//                          first: the next kit's --prev reads it
//   ...and the files of the last --keep kits before this one (default 3),
//   copied from --prev at their own paths, so a tab opened before the deploy
//   still gets its own engine. Unchanged files cost no upload: Cloudflare
//   keeps assets by content.
//
// The same inputs give the same kit, byte for byte (with the same Node.js:
// its brotli makes the .br files; for a file the previous kit has too, its
// .br is kept as deployed when it unpacks to that file). Nothing is written
// when an input is wrong: a page without its one table, or one that names an
// engine file outside it, an engine script that doesn't ask locateFile for
// its wasm, an engine given as the other one (the JSPI engine's script wraps
// its wasm's imports in WebAssembly.Suspending, the Asyncify one's doesn't),
// a wasm that doesn't compile or imports from a module its script doesn't
// give it, one wasm for both engines, a room picture whose content doesn't
// match its name, a kept file that isn't in --prev, or two different files
// under one name.
//
// sums rewrites <kit>/SHA256SUMS for every file in the kit (not node_modules,
// .wrangler or SHA256SUMS itself), after README.md, src/ and the rest are in.
// check reads a kit back: every file the page names is there (its room
// pictures too), each .br unpacks to its file, names under e/ and rooms/
// match their content, the page's two engines are the kinds it names them
// and each one's wasm takes its script's imports, SHA256SUMS matches.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const HASH_HEX = 12;
const IMMUTABLE = "public, max-age=31536000, immutable";
const MAX_FILE = 25 * 1024 * 1024;      // Cloudflare's limit per static asset file
const MAX_FILES = 20000;                // and per Worker version on the free plan
const MARK_OPEN = "/* kit-files */";
const MARK_CLOSE = "/* /kit-files */";
// cloudflare-92 and before: what their pages load, by fixed name.
const LEGACY = ["openjkdf2.js", "openjkdf2.wasm", "jspi/openjkdf2.js", "jspi/openjkdf2.wasm", "unzip.js"];
const LEGACY_LABEL = "before build-kit.mjs";
const MANIFEST = "kit-files.json";
// A kept file's path in public/: folders and a file name of letters, digits,
// - and _ with single dots between (so no "", "." or "..", and nothing that
// starts with a dot), as the Worker's e/ names are (src/engine.js).
const KEPT_RE = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
// Files a kit makes itself, never kept from another.
const OWN = new Set(["index.html", "move-out.html", MANIFEST, "_headers", ".assetsignore"]);
const OPTIONS = { public: ["asyncify", "jspi", "page", "prev", "out", "label", "keep"], sums: [], check: [] };

class KitError extends Error {}
const fail = msg => { throw new KitError(msg); };
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const read = p => {
    try {
        return fs.readFileSync(p);
    } catch (e) {
        fail(`can't read ${p}: ${e.code || e.message}`);
    }
};
const readJson = p => {
    try {
        return JSON.parse(read(p).toString("utf8"));
    } catch (e) {
        if (e instanceof KitError)
            throw e;
        fail(`${p} isn't JSON (${e.message})`);
    }
};

function brotli(buf) {
    const C = zlib.constants;
    const br = zlib.brotliCompressSync(buf, { params: {
        [C.BROTLI_PARAM_QUALITY]: 11, [C.BROTLI_PARAM_LGWIN]: 24, [C.BROTLI_PARAM_SIZE_HINT]: buf.length,
        [C.BROTLI_PARAM_MODE]: C.BROTLI_MODE_GENERIC } });
    if (!zlib.brotliDecompressSync(br).equals(buf))
        fail("brotli didn't give back what it was given");
    return br;
}

// "openjkdf2.js" -> "openjkdf2.<h>.js"; "openjkdf2.wasm" -> "openjkdf2.<h>.wasm".
function hashedName(name, buf) {
    const dot = name.indexOf(".");
    return name.slice(0, dot) + "." + sha256(buf).slice(0, HASH_HEX) + name.slice(dot);
}

// The JSON between the page's two kit-files marks, and where it is.
function findTable(html, where) {
    const a = html.indexOf(MARK_OPEN), b = html.indexOf(MARK_CLOSE);
    if (a < 0 || b < a || html.indexOf(MARK_OPEN, a + 1) >= 0 || html.indexOf(MARK_CLOSE, b + 1) >= 0)
        fail(`${where}: no single ${MARK_OPEN} ... ${MARK_CLOSE} table (ENGINE_FILES) in it`);
    let table;
    try {
        table = JSON.parse(html.slice(a + MARK_OPEN.length, b));
    } catch (e) {
        fail(`${where}: the kit-files table isn't JSON (${e.message})`);
    }
    const keys = o => o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : "";
    const str = v => typeof v === "string" && v.length > 0 && !v.startsWith("/");
    if (keys(table) !== "asyncify,jspi,unzip" || keys(table.jspi) !== "js,wasm" || keys(table.asyncify) !== "js,wasm" ||
        ![table.jspi.js, table.jspi.wasm, table.asyncify.js, table.asyncify.wasm, table.unzip].every(str))
        fail(`${where}: the kit-files table isn't { jspi: { js, wasm }, asyncify: { js, wasm }, unzip }`);
    return { table, start: a, end: b + MARK_CLOSE.length };
}
const tableFiles = t => [t.asyncify.js, t.asyncify.wasm, t.jspi.js, t.jspi.wasm, t.unzip];

// The room pictures a page names (rooms/<key>.<8 hex of SHA-256>.<ext>).
const roomsIn = html => [...new Set(html.match(/\brooms\/[A-Za-z0-9_-]+\.[0-9a-f]{8}\.(?:webp|jpg|png|avif)\b/g) || [])].sort();

// A kept file's path, as kit-files.json gives it.
function keptPath(f, where) {
    if (typeof f !== "string" || !KEPT_RE.test(f) || OWN.has(f) || /\.br$/i.test(f))
        fail(`${where}: ${JSON.stringify(f)} isn't a file a kit keeps`);
    return f;
}

// The kits whose files the previous kit's public/ kept, newest first:
// [{ label, files }].
function previousKits(prev) {
    const manifest = path.join(prev, MANIFEST);
    if (fs.existsSync(manifest)) {
        const m = readJson(manifest);
        if (!m || !Array.isArray(m.kits) || !m.kits.length)
            fail(`${manifest}: no kits list`);
        return m.kits.map((k, i) => {
            if (!k || typeof k.label !== "string" || !k.label || !Array.isArray(k.files))
                fail(`${manifest}: kit ${i} isn't { label, files: [...] }`);
            return { label: k.label, files: k.files.map(f => keptPath(f, `${manifest} (${k.label})`)) };
        });
    }
    // A kit from before this script (cloudflare-92): its page loads these by
    // name; it has no table.
    const html = read(path.join(prev, "index.html")).toString("utf8");
    if (html.includes(MARK_OPEN))
        fail(`${prev}: its page has a kit-files table but there's no ${MANIFEST}: not a kit this script made`);
    const files = LEGACY.filter(f => fs.existsSync(path.join(prev, f))).concat(roomsIn(html));
    if (!files.includes("openjkdf2.js"))
        fail(`${prev}: neither ${MANIFEST} nor openjkdf2.js: is it a kit's public/?`);
    return [{ label: LEGACY_LABEL, files }];
}

// The JSPI engine's script wraps the wasm's imports in WebAssembly.Suspending;
// the Asyncify engine's never names it.
const isJspiScript = js => js.toString("utf8").includes("new WebAssembly.Suspending(");

// Checks an engine build's script finds its wasm the way the page tells it,
// and is the engine it's given as.
function checkEngineScript(js, where, kind) {
    const text = js.toString("utf8");
    if (!text.includes('locateFile("openjkdf2.wasm")') || !text.includes('Module["locateFile"]'))
        fail(`${where}: doesn't ask Module.locateFile for openjkdf2.wasm, so it wouldn't find its hashed wasm`);
    if (isJspiScript(js) !== (kind === "jspi"))
        fail(isJspiScript(js) ? `${where} is the JSPI engine's script (it wraps its wasm's imports in ` +
                                `WebAssembly.Suspending), given as --${kind}` :
                                `${where} is the Asyncify engine's script (it doesn't wrap its wasm's imports in ` +
                                `WebAssembly.Suspending), given as --${kind}`);
    if (!text.includes('Module["instantiateWasm"]'))
        console.warn(`warning: ${where} doesn't read Module.instantiateWasm (the page's early compile won't be used)`);
}

// The modules an engine script gives its wasm's imports from: the keys of the
// object emscripten's getWasmImports() makes ({a:wasmImports} when the import
// names are minified, as in the Asyncify build; {env:wasmImports,
// wasi_snapshot_preview1:wasmImports} in the JSPI one), or null.
function scriptModules(js) {
    const text = js.toString("utf8");
    const at = text.indexOf("function getWasmImports(");
    const m = at < 0 ? null : /(?:\bvar\s+imports\s*=|\breturn)\s*\{([^{}]*)\}/.exec(text.slice(at, at + 2000));
    const keys = m ? [...m[1].matchAll(/(?:^|,)\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*wasmImports\b/g)]
        .map(k => k[1] || k[2]) : [];
    return keys.length ? keys : null;
}

// Why an engine's script and wasm aren't one build's, or null: the wasm has
// to compile, and import only from modules the script gives it (else the
// browser can't start it).
function engineMismatch(js, wasm, jsWhere, wasmWhere) {
    const given = scriptModules(js);
    if (!given)
        return `${jsWhere}: can't find which modules it gives its wasm's imports from (getWasmImports)`;
    let mod;
    try {
        mod = new WebAssembly.Module(wasm);
    } catch (e) {
        return `${wasmWhere} doesn't compile in Node.js ${process.versions.node} (${e.message})`;
    }
    const missing = [...new Set(WebAssembly.Module.imports(mod).map(i => i.module))].filter(m => !given.includes(m));
    return missing.length ? `${wasmWhere} imports from ${missing.join(", ")}, which ${jsWhere} doesn't give it ` +
                            `(it gives ${given.join(", ")}): they aren't one build's` : null;
}

function buildPublic(o) {
    for (const k of ["asyncify", "jspi", "page", "prev", "out"])
        if (!o[k]) fail(`--${k} is needed`);
    const out = path.resolve(o.out), pub = path.join(out, "public");
    if (fs.existsSync(pub) && (!fs.statSync(pub).isDirectory() || fs.readdirSync(pub).length))
        fail(`${pub} is already there; this makes a new one`);
    const keep = o.keep === undefined ? 3 : /^[0-9]+$/.test(o.keep) ? Number(o.keep) : NaN;
    if (!Number.isSafeInteger(keep))
        fail("--keep is a number of kits");
    const label = o.label || path.basename(out);
    const pageDir = path.dirname(path.resolve(o.page));
    const files = new Map();            // public path -> Buffer
    const put = (p, buf, why) => {
        const had = files.get(p);
        if (had && !had.equals(buf))
            fail(`${p}: two different files (${why})`);
        files.set(p, buf);
    };

    // The engines, unzip.js, and their .br.
    const table = { jspi: {}, asyncify: {} };
    for (const [kind, dir, sub] of [["asyncify", o.asyncify, "e/"], ["jspi", o.jspi, "e/jspi/"]]) {
        const js = read(path.join(dir, "openjkdf2.js")), wasm = read(path.join(dir, "openjkdf2.wasm"));
        checkEngineScript(js, path.join(dir, "openjkdf2.js"), kind);
        if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d)
            fail(`${path.join(dir, "openjkdf2.wasm")} isn't a wasm file`);
        const mismatch = engineMismatch(js, wasm, path.join(dir, "openjkdf2.js"), path.join(dir, "openjkdf2.wasm"));
        if (mismatch)
            fail(mismatch);
        table[kind].js = sub + hashedName("openjkdf2.js", js);
        table[kind].wasm = sub + hashedName("openjkdf2.wasm", wasm);
        put(table[kind].js, js, kind);
        put(table[kind].wasm, wasm, kind);
    }
    const unzip = read(path.join(pageDir, "unzip.js"));
    table.unzip = "e/" + hashedName("unzip.js", unzip);
    put(table.unzip, unzip, "unzip");
    if (table.asyncify.wasm === table.jspi.wasm.replace("e/jspi/", "e/"))
        fail(`${path.join(o.asyncify, "openjkdf2.wasm")} and ${path.join(o.jspi, "openjkdf2.wasm")} are the same file: ` +
             "each engine is a build of its own");
    const brSizes = {};
    for (const p of tableFiles(table)) {
        const br = brotli(files.get(p));
        put(p + ".br", br, "brotli");
        brSizes[p] = [files.get(p).length, br.length];
    }

    // The page, with its table filled in, and what else it names.
    const html = read(o.page).toString("utf8");
    const t = findTable(html, o.page);
    const literal = /['"`](?:jspi\/openjkdf2\.(?:js|wasm)|openjkdf2\.js|unzip\.js)['"`]/g;
    const outside = (html.slice(0, t.start) + html.slice(t.end)).match(literal);
    if (outside)
        fail(`${o.page}: names ${[...new Set(outside)].join(", ")} outside the kit-files table, which a kit renames`);
    const indent = html.slice(html.lastIndexOf("\n", t.start) + 1, t.start).match(/^ */)[0];
    const json = JSON.stringify(table, null, 2).replace(/\n/g, "\n" + indent);
    const page = html.slice(0, t.start) + MARK_OPEN + " " + json + " " + MARK_CLOSE + html.slice(t.end);
    findTable(page, "the kit's page");
    put("index.html", Buffer.from(page, "utf8"), "page");
    const rooms = roomsIn(page);
    for (const r of rooms) {
        const buf = read(path.join(pageDir, r));
        const want = r.split(".").slice(-2, -1)[0];
        if (sha256(buf).slice(0, 8) !== want)
            fail(`${r}: its content's SHA-256 doesn't start with ${want}`);
        put(r, buf, "room picture");
    }
    put("move-out.html", read(path.join(pageDir, "move-out.html")), "move-out");

    // What this kit's page loads, and the last kits'.
    const mine = tableFiles(table).concat(rooms);
    const before = previousKits(o.prev).slice(0, keep);
    if (before.some(k => k.label === label))
        fail(`--label ${label}: a kept kit has that name already`);
    for (const kit of before) {
        for (const f of kit.files) {
            put(f, read(path.join(o.prev, f)), "kept from " + kit.label);
            const brPath = path.join(o.prev, f + ".br");
            if (!fs.existsSync(brPath))
                continue;
            // For a file this kit has too, the .br that's deployed, when it
            // unpacks to that file: another Node.js's brotli may have written
            // other bytes for it.
            const kept = read(brPath);
            let same = false;
            try {
                same = files.has(f + ".br") && zlib.brotliDecompressSync(kept).equals(files.get(f));
            } catch (e) {}
            if (same) {
                files.set(f + ".br", kept);
                if (brSizes[f])
                    brSizes[f][1] = kept.length;
            } else {
                put(f + ".br", kept, "kept from " + kit.label);
            }
        }
    }
    const kits = [{ label, page: table, files: mine }].concat(before);
    put(MANIFEST, Buffer.from(JSON.stringify({ made_by: "tools/build-kit.mjs", kits }, null, 2) + "\n"), "manifest");
    put(".assetsignore", Buffer.from(`# Not uploaded: for the next kit's tools/build-kit.mjs --prev.\n/${MANIFEST}\n`), "assetsignore");
    put("_headers", Buffer.from(
        "# Made by tools/build-kit.mjs. Files named by their content: kept a year.\n" +
        "# e/ goes through the Worker (run_worker_first, src/engine.js), which says\n" +
        "# the same; its 404s, and those of a room picture that isn't there, say\n" +
        "# no-store (src/lobby.js).\n" +
        `/e/*\n  Cache-Control: ${IMMUTABLE}\n/rooms/*\n  Cache-Control: ${IMMUTABLE}\n`), "headers");

    if (files.size > MAX_FILES)
        fail(`${files.size} files, more than Cloudflare takes (${MAX_FILES})`);
    for (const [p, buf] of files)
        if (buf.length > MAX_FILE)
            fail(`${p}: ${buf.length} bytes, more than Cloudflare takes per file`);
    for (const [p, buf] of [...files].sort()) {
        fs.mkdirSync(path.dirname(path.join(pub, p)), { recursive: true });
        fs.writeFileSync(path.join(pub, p), buf);
    }
    writeSums(out);
    console.log(`${pub}: ${files.size} files, ${[...files.values()].reduce((n, b) => n + b.length, 0)} bytes ` +
                `(Node.js ${process.versions.node}, brotli ${process.versions.brotli})`);
    for (const [p, [raw, br]] of Object.entries(brSizes))
        console.log(`  ${p}  ${raw} B, ${br} B brotli 11`);
    for (const r of rooms)
        console.log(`  ${r}`);
    for (const kit of before)
        console.log(`  kept from ${kit.label}: ${kit.files.join(", ")}`);
    checkKit(out);
}

function listFiles(dir, base = dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        fail(`can't read ${dir}: ${e.code || e.message}`);
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (dir === base && (e.name === "node_modules" || e.name === ".wrangler"))
                continue;
            out.push(...listFiles(p, base));
        } else if (e.isFile() && !(dir === base && e.name === "SHA256SUMS")) {
            out.push(path.relative(base, p).split(path.sep).join("/"));
        }
    }
    return out.sort();
}

function writeSums(kit) {
    const lines = listFiles(kit).map(f => `${sha256(read(path.join(kit, f)))}  ${f}\n`);
    fs.writeFileSync(path.join(kit, "SHA256SUMS"), lines.join(""));
    return lines.length;
}

function checkKit(kit) {
    const pub = path.join(kit, "public");
    const problems = [];
    const page = read(path.join(pub, "index.html")).toString("utf8");
    const { table } = findTable(page, path.join(pub, "index.html"));
    const manifest = readJson(path.join(pub, MANIFEST));
    if (!manifest || !Array.isArray(manifest.kits) || !manifest.kits.length ||
        !manifest.kits.every(k => k && Array.isArray(k.files)))
        fail(`${path.join(pub, MANIFEST)}: no kits list`);
    if (JSON.stringify(manifest.kits[0].page) !== JSON.stringify(table))
        problems.push(`${MANIFEST} doesn't name the page's own files first`);
    const named = new Set();
    for (const kit of manifest.kits)
        for (const f of kit.files) {
            named.add(f);
            if (!fs.existsSync(path.join(pub, f)))
                problems.push(`${f} (${kit.label}) isn't there`);
        }
    // The page's room pictures are this kit's, so the loop above found them
    // there, and the next kit keeps them.
    for (const r of roomsIn(page))
        if (!manifest.kits[0].files.includes(r))
            problems.push(`${r}: the page names it, ${MANIFEST} doesn't` +
                          (fs.existsSync(path.join(pub, r)) ? "" : ", and it isn't there"));
    for (const f of tableFiles(table))
        if (!named.has(f))
            problems.push(`${f}: the page names it, ${MANIFEST} doesn't`);
    for (const kind of ["asyncify", "jspi"]) {
        const js = path.join(pub, table[kind].js), wasm = path.join(pub, table[kind].wasm);
        if (fs.existsSync(js) && isJspiScript(read(js)) !== (kind === "jspi"))
            problems.push(`${table[kind].js}: not the ${kind === "jspi" ? "JSPI" : "Asyncify"} engine's script`);
        const mismatch = fs.existsSync(js) && fs.existsSync(wasm) &&
            engineMismatch(read(js), read(wasm), table[kind].js, table[kind].wasm);
        if (mismatch)
            problems.push(mismatch);
    }
    if (!/^\/kit-files\.json$/m.test(fs.existsSync(path.join(pub, ".assetsignore")) ?
                                      read(path.join(pub, ".assetsignore")).toString("utf8") : ""))
        problems.push(`.assetsignore doesn't keep /${MANIFEST} out of the upload`);
    if (!fs.existsSync(path.join(pub, "_headers")))
        problems.push("no _headers");
    for (const f of listFiles(pub)) {
        if (!f.startsWith("e/")) {
            // The asset server would send it as it is, with no Content-Encoding.
            if (/\.br$/i.test(f))
                problems.push(`${f}: a .br outside e/`);
            // Kept a year (_headers), so named by their content too.
            const room = /^rooms\/[A-Za-z0-9_-]+\.([0-9a-f]{8})\.(?:webp|jpg|png|avif)$/.exec(f);
            if (f.startsWith("rooms/") && !room)
                problems.push(`${f}: under rooms/ but not named by its content`);
            else if (room && sha256(read(path.join(pub, f))).slice(0, 8) !== room[1])
                problems.push(`${f}: its content doesn't match its name`);
            continue;
        }
        const m = /\.([0-9a-f]{12})\.(js|wasm)(\.br)?$/.exec(f);
        const plain = m && m[3] ? f.slice(0, -3) : f;
        if (!m || !KEPT_RE.test(plain)) {
            problems.push(`${f}: under e/ but not named by its content`);
        } else if (!m[3]) {
            if (sha256(read(path.join(pub, f))).slice(0, HASH_HEX) !== m[1])
                problems.push(`${f}: its content doesn't match its name`);
            if (!fs.existsSync(path.join(pub, f + ".br")))
                problems.push(`${f}: no .br beside it`);
            if (!named.has(f))
                problems.push(`${f}: no kit in ${MANIFEST} loads it`);
        } else if (!fs.existsSync(path.join(pub, plain))) {
            problems.push(`${f}: no ${plain} beside it`);
        } else {
            let unpacked = null;
            try {
                unpacked = zlib.brotliDecompressSync(read(path.join(pub, f)));
            } catch (e) {}
            if (!unpacked || !unpacked.equals(read(path.join(pub, plain))))
                problems.push(`${f}: doesn't unpack to ${plain}`);
        }
    }
    const sums = read(path.join(kit, "SHA256SUMS")).toString("utf8").trim().split("\n");
    const listed = new Set();
    for (const line of sums) {
        const [sum, f] = line.split("  ");
        listed.add(f);
        if (!f || !fs.existsSync(path.join(kit, f)) || sha256(read(path.join(kit, f))) !== sum)
            problems.push(`SHA256SUMS: ${f} doesn't match`);
    }
    for (const f of listFiles(kit))
        if (!listed.has(f))
            problems.push(`SHA256SUMS doesn't list ${f}`);
    if (problems.length)
        fail(`${kit}:\n  ` + problems.join("\n  "));
    console.log(`${kit}: checked (${listFiles(pub).length} files in public/, ${sums.length} in SHA256SUMS)`);
}

function args(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            const k = argv[i].slice(2);
            if (!(OPTIONS[o._[0]] || []).includes(k))
                fail(`--${k}: not an option${o._[0] in OPTIONS ? " of " + o._[0] : ""}`);
            if (k in o)
                fail(`--${k} given twice`);
            if (i + 1 >= argv.length) fail(`--${k} needs a value`);
            o[k] = argv[++i];
        } else {
            o._.push(argv[i]);
        }
    }
    return o;
}

try {
    const o = args(process.argv.slice(2));
    const cmd = o._[0];
    if (cmd === "public" && o._.length === 1)
        buildPublic(o);
    else if (cmd === "sums" && o._.length === 2)
        console.log(`${path.join(o._[1], "SHA256SUMS")}: ${writeSums(o._[1])} files`);
    else if (cmd === "check" && o._.length === 2)
        checkKit(o._[1]);
    else
        fail("usage: build-kit.mjs public --asyncify <dir> --jspi <dir> --page <index.html> --prev <public/> --out <kit> " +
             "[--label <name>] [--keep <kits>] | sums <kit> | check <kit>");
} catch (e) {
    if (!(e instanceof KitError))
        throw e;
    console.error("build-kit: " + e.message);
    process.exit(1);
}
