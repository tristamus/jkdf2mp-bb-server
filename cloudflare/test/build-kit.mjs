// Checks tools/build-kit.mjs with made-up engine builds, page and kit 92,
// in a folder of its own under the system's temporary folder (TMPDIR): the
// kit it makes, that the same inputs make the same kit, how it keeps the
// last kits, what it refuses (writing nothing), and what check finds in a
// kit that was changed afterwards. Then tools/check-site.mjs reads a kit back
// through the Worker's router (src/lobby.js, src/engine.js) in this process,
// over a stand-in for the asset server serving the kit's public/: no ports.
// Needs Node.js 22 or newer.
//
//   node test/build-kit.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const lobby = (await import("../src/lobby.js")).default;
const { checkSite } = await import("../tools/check-site.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "..", "tools", "build-kit.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "build-kit-test-"));
const at = (...p) => path.join(TMP, ...p);
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const write = (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
};
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]).sort();
function run(...args) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

// An engine build's web/ folder: a script that asks locateFile for its wasm
// (as emscripten's do), and a wasm.
function engine(dir, mark) {
    const js = `var Module = typeof Module != "undefined" ? Module : {}; // ${mark}\n` +
               `function findWasmBinary(){return locateFile("openjkdf2.wasm")}\n` +
               `if (Module["locateFile"]) {} if (Module["instantiateWasm"]) {}\n` + `// ${mark}\n`.repeat(300);
    write(path.join(dir, "openjkdf2.js"), js);
    write(path.join(dir, "openjkdf2.wasm"), Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
                                                           Buffer.alloc(4000, mark.length)]));
}
const ROOM = Buffer.from("RIFF a picture of Nar Shaddaa");
const ROOM_NAME = `rooms/nar-shaddaa.${sha(ROOM).slice(0, 8)}.webp`;
const TABLE = `var ENGINE_FILES = /* kit-files */ {
        "jspi": { "js": "jspi/openjkdf2.js", "wasm": "jspi/openjkdf2.wasm" },
        "asyncify": { "js": "openjkdf2.js", "wasm": "openjkdf2.wasm" },
        "unzip": "unzip.js"
      } /* /kit-files */;`;
const PAGE = `<!doctype html>
<style>:root { --backdrop: url("${ROOM_NAME}"); }</style>
<script>
      ${TABLE}
      Module.locateFile = function(path, dir) {
        return path === 'openjkdf2.wasm' ? new URL(ENGINE_FILES[ENGINE].wasm, document.baseURI).href : dir + path;
      };
      var worker = new Worker(ENGINE_FILES.unzip);
      data.src = 'openjkdf2_data.js';
</script>
`;
// A page folder (packaging/wasm/), with page as its index.html.
function pageDir(dir, page = PAGE) {
    write(path.join(dir, "index.html"), page);
    write(path.join(dir, "unzip.js"), "onmessage = function() {};\n".repeat(50));
    write(path.join(dir, "move-out.html"), "<!doctype html><p>move out</p>\n");
    write(path.join(dir, ROOM_NAME), ROOM);
    return path.join(dir, "index.html");
}
engine(at("asy"), "asyncify");
engine(at("jspi"), "jspi");
const page = pageDir(at("page"));
// Kit 92's public/: fixed names, no table, no kit-files.json.
for (const [f, data] of [["index.html", "<!doctype html><script>engine.src = 'openjkdf2.js';</script>"],
                         ["openjkdf2.js", "kit 92 asyncify"], ["openjkdf2.wasm", "kit 92 asyncify wasm"],
                         ["jspi/openjkdf2.js", "kit 92 jspi"], ["jspi/openjkdf2.wasm", "kit 92 jspi wasm"],
                         ["unzip.js", "kit 92 unzip"], ["move-out.html", "kit 92 move-out"]])
    write(at("k92", "public", f), data);
const build = (out, extra = [], o = {}) => run("public", "--asyncify", o.asy || at("asy"), "--jspi", o.jspi || at("jspi"),
                                              "--page", o.page || page, "--prev", o.prev || at("k92", "public"),
                                              "--out", out, ...extra);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let table93;
test("public: the page with its table filled in, the hashed files and their .br, kit 92's kept", () => {
    const r = build(at("k93"), ["--label", "cloudflare-93"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, "");
    const pub = at("k93", "public");
    const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
    const a = html.indexOf("/* kit-files */"), b = html.indexOf("/* /kit-files */") + "/* /kit-files */".length;
    // Nothing else in the page changes.
    const src = fs.readFileSync(page, "utf8");
    assert.equal(html.slice(0, a), src.slice(0, src.indexOf("/* kit-files */")));
    assert.equal(html.slice(b), src.slice(src.indexOf("/* /kit-files */") + "/* /kit-files */".length));
    table93 = JSON.parse(html.slice(a + "/* kit-files */".length, b - "/* /kit-files */".length));
    const h = f => sha(fs.readFileSync(f)).slice(0, 12);
    assert.deepEqual(table93, {
        jspi: { js: `e/jspi/openjkdf2.${h(at("jspi", "openjkdf2.js"))}.js`,
                wasm: `e/jspi/openjkdf2.${h(at("jspi", "openjkdf2.wasm"))}.wasm` },
        asyncify: { js: `e/openjkdf2.${h(at("asy", "openjkdf2.js"))}.js`,
                    wasm: `e/openjkdf2.${h(at("asy", "openjkdf2.wasm"))}.wasm` },
        unzip: `e/unzip.${h(at("page", "unzip.js"))}.js`,
    });
    const engineFiles = [table93.asyncify.js, table93.asyncify.wasm, table93.jspi.js, table93.jspi.wasm, table93.unzip];
    const kept92 = ["openjkdf2.js", "openjkdf2.wasm", "jspi/openjkdf2.js", "jspi/openjkdf2.wasm", "unzip.js"];
    assert.deepEqual(listFiles(pub), [...engineFiles, ...engineFiles.map(f => f + ".br"), ...kept92, ROOM_NAME,
                                      "index.html", "move-out.html", "_headers", ".assetsignore", "kit-files.json"].sort());
    for (const f of engineFiles)
        assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(pub, f + ".br"))), fs.readFileSync(path.join(pub, f)));
    for (const f of kept92)
        assert.deepEqual(fs.readFileSync(path.join(pub, f)), fs.readFileSync(at("k92", "public", f)));
    assert.match(fs.readFileSync(path.join(pub, "_headers"), "utf8"),
                 /^\/e\/\*\n  Cache-Control: public, max-age=31536000, immutable\n\/rooms\/\*\n  Cache-Control: public, max-age=31536000, immutable\n$/m);
    assert.match(fs.readFileSync(path.join(pub, ".assetsignore"), "utf8"), /^\/kit-files\.json$/m);
    const manifest = JSON.parse(fs.readFileSync(path.join(pub, "kit-files.json"), "utf8"));
    assert.deepEqual(manifest.kits.map(k => k.label), ["cloudflare-93", "before build-kit.mjs"]);
    assert.deepEqual(manifest.kits[0].page, table93);
    assert.deepEqual(manifest.kits[0].files, [...engineFiles, ROOM_NAME]);
    assert.deepEqual(manifest.kits[1].files, kept92);
    const sums = fs.readFileSync(at("k93", "SHA256SUMS"), "utf8");
    assert.deepEqual(sums.trim().split("\n").map(l => l.split("  ")[1]), listFiles(pub).map(f => "public/" + f).sort());
    assert.match(r.out, /checked \(21 files in public\/, 21 in SHA256SUMS\)/);
});

test("the same inputs make the same kit, wherever the previous kit and the new one are", () => {
    fs.cpSync(at("k92"), at("elsewhere", "kit-92-copy"), { recursive: true });
    const r = build(at("elsewhere", "k93"), ["--label", "cloudflare-93"], { prev: at("elsewhere", "kit-92-copy", "public") });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(at("elsewhere", "k93", "SHA256SUMS"), "utf8"), fs.readFileSync(at("k93", "SHA256SUMS"), "utf8"));
    // Without --label, the kit's folder name.
    const n = build(at("elsewhere", "cloudflare-93"), [], { prev: at("elsewhere", "kit-92-copy", "public") });
    assert.equal(n.code, 0, n.err);
    assert.equal(fs.readFileSync(at("elsewhere", "cloudflare-93", "SHA256SUMS"), "utf8"),
                 fs.readFileSync(at("k93", "SHA256SUMS"), "utf8"));
});

test("each kit keeps the last 3 before it (--keep), with their .br, and drops older ones", () => {
    let prev = at("k93", "public");
    for (const n of [94, 95, 96]) {
        engine(at(`jspi${n}`), `jspi ${n}`);
        const r = build(at(`k${n}`), ["--label", `cloudflare-${n}`], { prev, jspi: at(`jspi${n}`) });
        assert.equal(r.code, 0, r.err);
        prev = at(`k${n}`, "public");
    }
    const labels = k => JSON.parse(fs.readFileSync(at(k, "public", "kit-files.json"), "utf8")).kits.map(x => x.label);
    assert.deepEqual(labels("k94"), ["cloudflare-94", "cloudflare-93", "before build-kit.mjs"]);
    assert.deepEqual(labels("k95"), ["cloudflare-95", "cloudflare-94", "cloudflare-93", "before build-kit.mjs"]);
    assert.deepEqual(labels("k96"), ["cloudflare-96", "cloudflare-95", "cloudflare-94", "cloudflare-93"]);
    const pub96 = at("k96", "public");
    assert.ok(fs.existsSync(path.join(pub96, table93.jspi.js)));
    assert.ok(fs.existsSync(path.join(pub96, table93.jspi.js + ".br")));
    assert.ok(!fs.existsSync(path.join(pub96, "openjkdf2.js")));
    assert.ok(!fs.existsSync(path.join(pub96, "jspi")));
    // Four JSPI scripts, one Asyncify engine and one unzip.js, shared.
    assert.equal(listFiles(path.join(pub96, "e", "jspi")).filter(f => f.endsWith(".js")).length, 4);
    assert.equal(listFiles(path.join(pub96, "e")).filter(f => /^openjkdf2\.[0-9a-f]{12}\.js$/.test(f)).length, 1);
    for (const [keep, want] of [["1", ["cloudflare-96b", "cloudflare-95"]], ["0", ["cloudflare-96b"]]]) {
        fs.rmSync(at("k96b"), { recursive: true, force: true });
        const r = build(at("k96b"), ["--label", "cloudflare-96b", "--keep", keep], { prev: at("k95", "public"), jspi: at("jspi96") });
        assert.equal(r.code, 0, r.err);
        assert.deepEqual(labels("k96b"), want);
    }
});

// Each refusal: exit 1, the reason, and no public/ made. o is the options
// for build() (made when the test runs, after kit 93 is), or args gives the
// whole command line.
function refuses(name, why, { o = () => ({}), args, extra = [], before } = {}) {
    test("refuses " + name, () => {
        const out = at("refused", name.replace(/[^a-z0-9]+/gi, "-"));
        if (before)
            before(out);
        const r = args ? run(...args(out)) : build(out, extra, o());
        assert.equal(r.code, 1, r.out + r.err);
        assert.match(r.err, why);
        assert.doesNotMatch(r.err, /\n    at /);
        if (!before)
            assert.ok(!fs.existsSync(path.join(out, "public")), "public/ was made");
    });
}
const badPage = (name, html) => () => ({ page: pageDir(at("pages", name), html) });
// Kit 93's public/ with another kit-files.json (or none), and more files.
const badPrev = (name, manifest, files = {}) => () => {
    const dir = at("prevs", name);
    fs.cpSync(at("k93", "public"), dir, { recursive: true });
    if (manifest === null)
        fs.rmSync(path.join(dir, "kit-files.json"));
    else
        write(path.join(dir, "kit-files.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    for (const [f, data] of Object.entries(files))
        write(path.join(dir, f), data);
    return { prev: dir };
};
const keeping = files => ({ made_by: "x", kits: [{ label: "cloudflare-93", files }] });
const all = (out, ...more) => ["public", "--asyncify", at("asy"), "--jspi", at("jspi"), "--page", page,
                               "--prev", at("k92", "public"), "--out", out, ...more];

refuses("a public/ that's there already", /is already there/, { before: out => write(path.join(out, "public", "x"), "x") });
refuses("a page without the marks", /no single \/\* kit-files \*\//, { o: badPage("nomarks", PAGE.replace("/* kit-files */", "")) });
refuses("a page with two tables", /no single/, { o: badPage("two", PAGE + `<script>${TABLE}</script>`) });
refuses("a table that isn't JSON", /isn't JSON/, { o: badPage("notjson", PAGE.replace('"unzip": "unzip.js"', "unzip: 'unzip.js'")) });
for (const [name, from, to] of [["without unzip", ',\n        "unzip": "unzip.js"', ""],
                                ["with another key", '"unzip": "unzip.js"', '"unzip": "unzip.js", "x": "y"'],
                                ["with a name from /", '"unzip.js"', '"/unzip.js"'],
                                ["with an empty name", '"openjkdf2.wasm" }', '"" }'],
                                ["with a list", '{ "js": "openjkdf2.js", "wasm": "openjkdf2.wasm" }', '["openjkdf2.js"]']])
    refuses("a table " + name, /the kit-files table isn't \{/, { o: badPage(name, PAGE.replace(from, to)) });
for (const [name, add] of [["'openjkdf2.js'", "s.src = 'openjkdf2.js';"], ['"unzip.js"', 'new Worker("unzip.js");'],
                           ["`jspi/openjkdf2.wasm`", "fetch(`jspi/openjkdf2.wasm`);"]])
    refuses(`a page naming ${name} outside the table`, /outside the kit-files table/,
            { o: badPage("lit-" + name.replace(/[^a-z]/g, ""), PAGE.replace("</script>", add + "\n</script>")) });
refuses("a room picture whose content doesn't match its name", /SHA-256 doesn't start with/, { o: () => {
    const o = badPage("room", PAGE.replace(ROOM_NAME, "rooms/nar-shaddaa.00000000.webp"))();
    write(at("pages", "room", "rooms", "nar-shaddaa.00000000.webp"), ROOM);
    return o;
} });
refuses("a room picture that isn't there", /can't read .*nar-shaddaa\.11111111\.webp/,
        { o: badPage("noroom", PAGE.replace(ROOM_NAME, "rooms/nar-shaddaa.11111111.webp")) });
refuses("an engine script that doesn't ask locateFile for its wasm", /doesn't ask Module.locateFile/, { o: () => {
    engine(at("badjs"), "bad");
    write(at("badjs", "openjkdf2.js"), "var Module = {}; fetch('openjkdf2.wasm');");
    return { jspi: at("badjs") };
} });
for (const [name, bytes] of [["that isn't wasm", Buffer.from("not a wasm file at all")], ["of 2 bytes", Buffer.from([0, 0x61])]])
    refuses("a wasm " + name, /isn't a wasm file/, { o: () => {
        engine(at("badwasm" + bytes.length), "bad");
        write(at("badwasm" + bytes.length, "openjkdf2.wasm"), bytes);
        return { asy: at("badwasm" + bytes.length) };
    } });
refuses("a kept file missing from --prev", /can't read .*openjkdf2\.ffffffffffff\.wasm/,
        { o: badPrev("missing", keeping(["e/openjkdf2.ffffffffffff.wasm"])) });
for (const f of ["../x.js", "/x.js", "e//x.js", "e/./x.js", "index.html", "move-out.html", "kit-files.json", "_headers",
                 ".assetsignore", "e/x.js.br", "e/x%2e.js", "e/x", 7])
    refuses(`a kept file named ${JSON.stringify(f)}`, /isn't a file a kit keeps/,
            { o: badPrev("name" + String(f).replace(/[^a-z0-9]/gi, "_"), keeping([f])) });
refuses("a kit-files.json that isn't JSON", /isn't JSON/, { o: badPrev("notjson", "{ kits: ") });
refuses("a kit-files.json with no kits", /no kits list/, { o: badPrev("nokits", { made_by: "x" }) });
refuses("a kit-files.json kit without files", /isn't \{ label, files/, { o: badPrev("nofiles", { kits: [{ label: "x" }] }) });
refuses("two different files under one name", /two different files/,
        { o: badPrev("clash", keeping([ROOM_NAME]), { [ROOM_NAME]: "another picture" }) });
refuses("a --prev whose page has a table but no kit-files.json", /not a kit this script made/, { o: badPrev("nomanifest", null) });
refuses("a --label a kept kit has", /a kept kit has that name/,
        { o: () => ({ prev: at("k93", "public") }), extra: ["--label", "cloudflare-93"] });
refuses("an option that isn't one", /--kepp: not an option of public/, { args: out => all(out, "--kepp", "1") });
refuses("an option given twice", /--out given twice/, { args: out => all(out, "--out", out) });
for (const keep of ["-1", "x", "1.5", ""])
    refuses(`--keep ${JSON.stringify(keep)}`, /--keep is a number/, { args: out => all(out, "--keep", keep) });
refuses("no --page", /--page is needed/, { args: out => all(out).filter((a, i, l) => a !== "--page" && l[i - 1] !== "--page") });
refuses("no command", /usage/, { args: () => [] });
refuses("check without a kit", /usage/, { args: () => ["check"] });
refuses("check of a folder that isn't there", /can't read/, { args: () => ["check", at("nothing")] });

// check, on a copy of kit 94 changed afterwards.
function changed(name, change, why) {
    test("check finds " + name, () => {
        const kit = at("changed", name.replace(/[^a-z0-9]+/gi, "-"));
        fs.cpSync(at("k94"), kit, { recursive: true });
        assert.equal(run("check", kit).code, 0);
        change(path.join(kit, "public"), kit);
        const r = run("check", kit);
        assert.equal(r.code, 1, r.out);
        for (const w of [].concat(why))
            assert.match(r.err, w);
    });
}
const t94 = () => JSON.parse(fs.readFileSync(at("k94", "public", "kit-files.json"), "utf8")).kits[0].page;
changed("a wasm that isn't what its name says", pub => fs.appendFileSync(path.join(pub, t94().jspi.wasm), "x"),
        [/its content doesn't match its name/, /SHA256SUMS: public\/e\/jspi\/openjkdf2\.[0-9a-f]{12}\.wasm doesn't match/]);
changed("a .br that doesn't unpack to its file", pub => fs.writeFileSync(path.join(pub, t94().jspi.js + ".br"), "nonsense"),
        /doesn't unpack to/);
changed("a file without its .br", pub => fs.rmSync(path.join(pub, t94().unzip + ".br")), /no \.br beside it/);
changed("a .br without its file", pub => write(path.join(pub, "e", "openjkdf2.aaaaaaaaaaaa.js.br"), zlib.brotliCompressSync("x")),
        /no e\/openjkdf2\.aaaaaaaaaaaa\.js beside it/);
changed("a .br outside e/", pub => write(path.join(pub, "openjkdf2.wasm.br"), zlib.brotliCompressSync("x")), /a \.br outside e\//);
changed("a file under e/ no kit loads", pub => {
    const buf = Buffer.from("stray");
    const f = path.join(pub, "e", `stray.${sha(buf).slice(0, 12)}.js`);
    write(f, buf);
    write(f + ".br", zlib.brotliCompressSync(buf));
}, /no kit in kit-files\.json loads it/);
changed("a kept file that's gone", pub => fs.rmSync(path.join(pub, "jspi", "openjkdf2.wasm")),
        /jspi\/openjkdf2\.wasm \(before build-kit\.mjs\) isn't there/);
changed("a page whose table isn't the kit's", pub => {
    const f = path.join(pub, "index.html");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/e\/unzip\.[0-9a-f]{12}\.js/, "e/unzip.000000000000.js"));
}, /doesn't name the page's own files first/);
changed("an .assetsignore that lets kit-files.json out", pub => fs.writeFileSync(path.join(pub, ".assetsignore"), "# nothing\n"),
        /\.assetsignore doesn't keep/);
changed("a file SHA256SUMS doesn't list", (pub, kit) => write(path.join(kit, "README.md"), "the kit"),
        /SHA256SUMS doesn't list README\.md/);

test("sums lists what's been added, and check passes again", () => {
    const kit = at("summed");
    fs.cpSync(at("k94"), kit, { recursive: true });
    write(path.join(kit, "README.md"), "the kit");
    write(path.join(kit, "src", "lobby.js"), "// the lobby");
    write(path.join(kit, "node_modules", "x", "index.js"), "not listed");
    write(path.join(kit, ".wrangler", "state"), "not listed");
    assert.equal(run("check", kit).code, 1);
    const s = run("sums", kit);
    assert.equal(s.code, 0, s.err);
    const c = run("check", kit);
    assert.equal(c.code, 0, c.err);
    const listed = fs.readFileSync(path.join(kit, "SHA256SUMS"), "utf8");
    assert.match(listed, /  README\.md\n/);
    assert.match(listed, /  src\/lobby\.js\n/);
    assert.doesNotMatch(listed, /node_modules|\.wrangler|SHA256SUMS/);
});

// tools/check-site.mjs through the router, over a stand-in for the asset
// server serving a kit's public/ (_headers as the kit writes it; _headers,
// .assetsignore and what it names aren't uploaded).
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm",
                ".webp": "image/webp", ".jpg": "image/jpeg" };
function assetsOf(pub, { pageEtag = true } = {}) {
    return {
        async fetch(input) {
            const req = input instanceof Request ? input : new Request(input);
            let p = decodeURIComponent(new URL(req.url).pathname);
            p = p === "/" ? "/index.html" : p;
            const year = /^\/(e|rooms)\//.test(p) ? { "Cache-Control": "public, max-age=31536000, immutable" } : {};
            const file = path.join(pub, p);
            if (!file.startsWith(pub + path.sep) || ["/_headers", "/.assetsignore", "/kit-files.json"].includes(p) ||
                !fs.existsSync(file) || !fs.statSync(file).isFile())
                return new Response(null, { status: 404, headers: year });
            const body = fs.readFileSync(file);
            const etag = '"' + sha(body).slice(0, 32) + '"';
            const headers = { "Cache-Control": "public, max-age=0, must-revalidate", ...year };
            if (pageEtag || p !== "/index.html")
                headers.ETag = etag;
            const type = TYPES[path.extname(p)];
            if (type)
                headers["Content-Type"] = type;
            const inm = req.headers.get("If-None-Match");
            if (headers.ETag && (inm === etag || inm === "W/" + etag))
                return new Response(null, { status: 304, headers });
            return new Response(req.method === "HEAD" ? null : body, { headers });
        },
    };
}
// A get for checkSite: as Cloudflare hands a request to the Worker (the
// browser's Accept-Encoding in cf.clientAcceptEncoding, "br, gzip" in the
// header), and the answer as Node's http would give it.
const getVia = (worker, env) => async (p, headers = {}, method = "GET") => {
    const r = new Request(new URL(p, "https://site.example"), { method, headers: { ...headers, "Accept-Encoding": "br, gzip" } });
    Object.defineProperty(r, "cf", { value: { clientAcceptEncoding: headers["Accept-Encoding"] || "" } });
    const res = await worker.fetch(r, env, {});
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    return { status: res.status, h, body: Buffer.from(await res.arrayBuffer()) };
};
async function siteCheck(pub, opts = {}, worker = lobby) {
    const lines = [];
    const env = { ASSETS: assetsOf(pub, opts), SITE: "https://site.example", MOVED_FROM: "https://old.example" };
    const counts = await checkSite({ pub, get: getVia(worker, env), ae: "gzip, deflate, br, zstd", log: l => lines.push(l) });
    return { ...counts, lines };
}

test("check-site: a kit served by the router is all ok", async () => {
    const { bad, zone, lines } = await siteCheck(at("k94", "public"));
    assert.equal(bad, 0, lines.join("\n"));
    assert.equal(zone, 0, lines.join("\n"));
    assert.ok(lines.length >= 30, lines.join("\n"));
    assert.match(lines.join("\n"), /ok   JSPI wasm, browser takes br: HTTP 200, br, \d+ B \(the kit's \.br, byte for byte\)/);
    assert.match(lines.join("\n"), /page is the kit's byte for byte/);
    assert.match(lines.join("\n"), /ok   kept \(cloudflare-93\) e\/jspi\/openjkdf2\.[0-9a-f]{12}\.wasm/);
    assert.match(lines.join("\n"), /ok   kept \(before build-kit\.mjs\) jspi\/openjkdf2\.wasm/);
    assert.equal(lines.at(-1), "all ok");
});

test("check-site: a page without an ETag is the zone's, not the kit's", async () => {
    const { bad, zone, lines } = await siteCheck(at("k94", "public"), { pageEtag: false });
    assert.equal(bad, 0, lines.join("\n"));
    assert.equal(zone, 1);
    assert.match(lines.join("\n"), /^zone page ETag: none: the zone takes it off/m);
    assert.equal(lines.at(-1), "all ok; 1 for the zone's settings (not the kit)");
});

test("check-site: a kept file that isn't served, and a Worker without the e/ route, are BAD", async () => {
    const pub = at("served-missing");
    fs.cpSync(at("k94", "public"), pub, { recursive: true });
    const served = at("served-missing-site");
    fs.cpSync(pub, served, { recursive: true });
    fs.rmSync(path.join(served, "jspi", "openjkdf2.wasm"));
    const lines = [];
    const env = { ASSETS: assetsOf(served), SITE: "" };
    const { bad } = await checkSite({ pub, get: getVia(lobby, env), log: l => lines.push(l) });
    assert.equal(bad, 1, lines.join("\n"));
    assert.match(lines.join("\n"), /^BAD  kept \(before build-kit\.mjs\) jspi\/openjkdf2\.wasm: HTTP 404/m);
    // The asset server alone: no br, the .br by name sent as it is, no year.
    const plain = await siteCheck(at("k94", "public"), {}, { fetch: (r, env) => env.ASSETS.fetch(r) });
    assert.ok(plain.bad >= 10, plain.lines.join("\n"));
    assert.match(plain.lines.join("\n"), /^BAD  JSPI wasm, browser takes br: HTTP 200, identity/m);
    assert.match(plain.lines.join("\n"), /^BAD  a \.br by its own name: HTTP 200/m);
});

test("check-site: no address, or not http(s): the usage line", () => {
    for (const args of [[], ["beta.jediknight.zone"], ["ftp://x.example"]]) {
        const r = spawnSync(process.execPath, [path.join(HERE, "..", "tools", "check-site.mjs"), ...args], { encoding: "utf8" });
        assert.equal(r.status, 2);
        assert.match(r.stderr, /^usage: node tools\/check-site\.mjs https:\/\/<site>/);
    }
});

let failed = 0;
try {
    for (const t of tests) {
        try {
            await t.fn();
            console.log("ok   " + t.name);
        } catch (e) {
            failed++;
            console.log("FAIL " + t.name + "\n" + (e.stack || e));
        }
    }
} finally {
    fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
