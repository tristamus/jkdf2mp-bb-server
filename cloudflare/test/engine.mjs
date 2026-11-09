// Checks how the Worker sends the engine's files under /e/ (src/engine.js,
// and the router in src/lobby.js), with no ports: a stand-in for the static
// asset server (env.ASSETS) that answers as Cloudflare's does (the asset
// worker in workers-shared, as wrangler 4.139's miniflare has it: a strong
// ETag of its own, 304 for If-None-Match "h" or W/"h", no Content-Type for a
// .br file, 404 for a name it hasn't, %-escapes decoded and doubled slashes
// joined, with a 307 to the name as it spells it, Range not done, 405 for
// methods other than GET and HEAD), and requests carrying
// request.cf.clientAcceptEncoding as Cloudflare's do. Needs Node.js 22 or
// newer.
//
//   node test/engine.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { brotliCompressSync } from "node:zlib";

// cloudflare:workers is only needed for lobby.js's Durable Object class.
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
        return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    const r = await next(specifier, context);
    return r.url.endsWith(".js") ? { ...r, format: "module" } : r;
}`));
const { engineFile, acceptsBr, clientAcceptEncoding } = await import("../src/engine.js");
const lobby = (await import("../src/lobby.js")).default;

const WASM = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(5000, 7)]);
const JS = Buffer.from("var Module = typeof Module != 'undefined' ? Module : {};\n".repeat(200));
const W = "/e/jspi/openjkdf2.0123456789ab.wasm", J = "/e/jspi/openjkdf2.ba9876543210.js";
const PLAIN = "/e/unzip.00112233aabb.js";
const files = new Map([
    [W, { body: WASM, type: "application/wasm" }],
    [W + ".br", { body: brotliCompressSync(WASM), type: null }],
    [J, { body: JS, type: "text/javascript; charset=utf-8" }],
    [J + ".br", { body: brotliCompressSync(JS), type: null }],
    [PLAIN, { body: JS, type: "text/javascript; charset=utf-8" }],
    ["/index.html", { body: Buffer.from("<!doctype html>"), type: "text/html; charset=utf-8" }],
    ["/rooms/nar-shaddaa.df7543fa.webp", { body: Buffer.from("RIFF"), type: "image/webp" }],
]);
const etagOf = body => '"' + createHash("sha256").update(body).digest("hex").slice(0, 32) + '"';
const decodePath = p => p.split("/").map(s => { try { return decodeURIComponent(s); } catch { return s; } })
                         .join("/").replace(/\/+/g, "/");
const encodePath = p => p.split("/").map(encodeURIComponent).join("/");
// Cloudflare's static asset server, as far as these use it; _headers gives
// rooms/ and e/ a year, also on a 404 (as the real one does). With
// ranges.on, it answers a Range with 206 and the part, as it doesn't (yet).
// trouble names paths it answers 500 for.
const fetched = [];
const ranges = { on: false };
const trouble = new Set();
const ASSETS = {
    async fetch(input) {
        const req = input instanceof Request ? input : new Request(input);
        const raw = new URL(req.url).pathname, path = decodePath(raw);
        fetched.push({ path: raw, method: req.method, headers: Object.fromEntries(req.headers) });
        const year = /^\/(e|rooms)\//.test(path) ? { "Cache-Control": "public, max-age=31536000, immutable" } : {};
        if (trouble.has(path))
            return new Response("Internal Server Error", { status: 500 });
        const f = files.get(path === "/" ? "/index.html" : path);
        if (!f)
            return new Response(null, { status: 404, headers: year });
        if (req.method !== "GET" && req.method !== "HEAD")
            return new Response(null, { status: 405 });
        if (encodePath(path) !== raw && path !== "/")
            return new Response(null, { status: 307, headers: { Location: encodePath(path) } });
        const etag = etagOf(f.body);
        const headers = { ETag: etag, ...year };
        // The real one gives no Cache-Control of its own to a Range or
        // Authorization request.
        if (!req.headers.has("Range"))
            headers["Cache-Control"] ??= "public, max-age=0, must-revalidate";
        if (f.type)
            headers["Content-Type"] = f.type;
        const inm = req.headers.get("If-None-Match");
        if (inm === etag || inm === "W/" + etag)
            return new Response(null, { status: 304, headers });
        const range = ranges.on && /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("Range") || "");
        if (range) {
            const [a, b] = [Number(range[1]), Math.min(Number(range[2]), f.body.length - 1)];
            return new Response(req.method === "HEAD" ? null : f.body.subarray(a, b + 1),
                                { status: 206, headers: { ...headers, "Content-Range": `bytes ${a}-${b}/${f.body.length}` } });
        }
        return new Response(req.method === "HEAD" ? null : f.body, { headers });
    },
};
const env = { ASSETS, SITE: "https://site.example", MOVED_FROM: "https://old.example", MOVED_STATUS: "301" };

// A request as the Worker gets it: Accept-Encoding is always "br, gzip", the
// browser's own is in cf.clientAcceptEncoding. ae null: no cf at all (not
// Cloudflare); ae undefined in cf: { cf: {} }.
function req(path, { ae = "gzip, deflate, br, zstd", cf, method = "GET", headers = {}, host = "site.example" } = {}) {
    const r = new Request(`https://${host}${path}`, { method, headers: { "Accept-Encoding": "br, gzip", ...headers } });
    Object.defineProperty(r, "cf", { value: cf !== undefined ? cf : ae === null ? undefined : { clientAcceptEncoding: ae } });
    return r;
}
const bytes = async res => Buffer.from(await res.arrayBuffer());
const nothingKept = res => {
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Content-Encoding"), null);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a wasm to a browser that takes br: the .br's bytes, as br and application/wasm, kept a year", async () => {
    const res = await engineFile(req(W), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/wasm");
    assert.equal(res.headers.get("Content-Encoding"), "br");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable, no-transform");
    assert.equal(res.headers.get("Vary"), "Accept-Encoding");
    assert.equal(res.headers.get("ETag"), etagOf(files.get(W + ".br").body));
    assert.deepEqual(await bytes(res), files.get(W + ".br").body);
});

test("its script too, as text/javascript", async () => {
    const res = await engineFile(req(J, { ae: "br" }), env);
    assert.equal(res.headers.get("Content-Type"), "text/javascript; charset=utf-8");
    assert.equal(res.headers.get("Content-Encoding"), "br");
    assert.deepEqual(await bytes(res), files.get(J + ".br").body);
});

for (const ae of ["gzip, deflate", "br;q=0, gzip", "identity", ""]) {
    test(`to "${ae}": the plain file, kept a year, left to Cloudflare to compress`, async () => {
        const res = await engineFile(req(W, { ae }), env);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Content-Encoding"), null);
        assert.equal(res.headers.get("Content-Type"), "application/wasm");
        assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
        assert.equal(res.headers.get("Vary"), "Accept-Encoding");
        assert.equal(res.headers.get("ETag"), etagOf(WASM));
        assert.deepEqual(await bytes(res), WASM);
    });
}

test("what the browser told Cloudflare counts, not the Accept-Encoding the Worker sees", async () => {
    assert.equal(clientAcceptEncoding(req(W, { ae: "gzip" })), "gzip");
    const res = await engineFile(req(W, { ae: "gzip" }), env);
    assert.equal(res.headers.get("Content-Encoding"), null);
    // Without cf (not Cloudflare's), the header.
    assert.equal(clientAcceptEncoding(req(W, { ae: null, headers: { "Accept-Encoding": "gzip" } })), "gzip");
    assert.equal(clientAcceptEncoding(req(W, { ae: null })), "br, gzip");
});

test("on Cloudflare without clientAcceptEncoding: not known, so no br (not the header's br, gzip)", async () => {
    for (const cf of [{}, { clientAcceptEncoding: null }]) {
        assert.equal(clientAcceptEncoding(req(W, { cf })), "");
        const res = await engineFile(req(W, { cf }), env);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Content-Encoding"), null);
        assert.deepEqual(await bytes(res), WASM);
    }
});

test("acceptsBr reads q values, * and identity", () => {
    const takes = {
        "gzip, deflate, br, zstd": true, "gzip, deflate, br": true, "BR;Q=0.5": true, " br ; q=0.001 ": true,
        "gzip;q=1, br;q=0.5": true, "br;level=5": true, "br, identity;q=0": true, "*": true, "gzip, *;q=0.1": true,
        "gzip;q=0, *": true, "*;q=0, br": true,
        "br;q=0": false, "br;q=0.000": false, "br;q=": false, "br;q=abc": false, "*;q=0": false, "br;q=0, *": false,
        "gzip": false, "identity": false, "identity;q=0, *;q=0": false, "x-br, brotli": false, "": false,
    };
    for (const [ae, want] of Object.entries(takes))
        assert.equal(acceptsBr(ae), want, JSON.stringify(ae));
    assert.equal(acceptsBr(undefined), false);
});

test("asked again with the ETag it got (as is, or weak): 304, nothing sent", async () => {
    const etag = etagOf(files.get(W + ".br").body);
    for (const inm of [etag, "W/" + etag]) {
        const res = await engineFile(req(W, { headers: { "If-None-Match": inm } }), env);
        assert.equal(res.status, 304);
        assert.equal(res.headers.get("Content-Encoding"), "br");
        assert.equal(res.headers.get("ETag"), etag);
        assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable, no-transform");
        assert.equal((await bytes(res)).length, 0);
    }
    for (const inm of [etagOf(WASM), "W/" + etagOf(WASM)]) {
        const plain = await engineFile(req(W, { ae: "gzip", headers: { "If-None-Match": inm } }), env);
        assert.equal(plain.status, 304);
        assert.equal(plain.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
        assert.equal((await bytes(plain)).length, 0);
    }
    // Another ETag (from the other coding): the whole file.
    const other = await engineFile(req(W, { headers: { "If-None-Match": etagOf(WASM) } }), env);
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("Content-Encoding"), "br");
    assert.deepEqual(await bytes(other), files.get(W + ".br").body);
});

test("HEAD: the headers, no body, br or plain", async () => {
    fetched.length = 0;
    const res = await engineFile(req(W, { method: "HEAD" }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Encoding"), "br");
    assert.equal(res.headers.get("Content-Type"), "application/wasm");
    assert.equal(res.body, null);
    assert.deepEqual(fetched.map(f => [f.method, f.path]), [["HEAD", W + ".br"]]);
    const plain = await engineFile(req(W, { method: "HEAD", ae: "gzip" }), env);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("Content-Encoding"), null);
    assert.equal(plain.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(plain.body, null);
    nothingKept(await engineFile(req("/e/jspi/openjkdf2.ffffffffffff.wasm", { method: "HEAD" }), env));
});

test("only GET and HEAD, and the asset server isn't asked for the others", async () => {
    fetched.length = 0;
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
        const res = await engineFile(req(W, { method }), env);
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("Allow"), "GET, HEAD");
    }
    const routed = await lobby.fetch(req(W, { method: "POST" }), env, {});
    assert.equal(routed.status, 405);
    assert.deepEqual(fetched, []);
});

test("a Range: the whole file, 200, br or plain, and the asset server never sees it", async () => {
    ranges.on = true;
    try {
        for (const range of ["bytes=0-99", "bytes=8-"]) {
            fetched.length = 0;
            const br = await engineFile(req(W, { headers: { Range: range, "If-Range": etagOf(WASM) } }), env);
            assert.equal(br.status, 200);
            assert.equal(br.headers.get("Content-Encoding"), "br");
            assert.equal(br.headers.get("Content-Range"), null);
            assert.deepEqual(await bytes(br), files.get(W + ".br").body);
            const plain = await engineFile(req(W, { ae: "gzip", headers: { Range: range } }), env);
            assert.equal(plain.status, 200);
            assert.equal(plain.headers.get("Content-Encoding"), null);
            assert.equal(plain.headers.get("Content-Range"), null);
            assert.equal(plain.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
            assert.deepEqual(await bytes(plain), WASM);
            assert.equal(fetched.length, 2);
            for (const f of fetched)
                assert.deepEqual(Object.keys(f.headers).filter(h => /range/i.test(h)), []);
        }
        // The stand-in does answer a Range when asked directly, so the
        // checks above would see a part if one were passed on.
        const part = await ASSETS.fetch(new Request("https://site.example" + W, { headers: { Range: "bytes=0-99" } }));
        assert.equal(part.status, 206);
    } finally {
        ranges.on = false;
    }
});

test("only the method and If-None-Match reach the asset server, br or plain", async () => {
    const headers = { "If-None-Match": '"x"', Authorization: "Basic eDp4", Cookie: "a=b", "Sec-Fetch-Mode": "navigate" };
    for (const [ae, path] of [["br", W], ["gzip", W], ["br", PLAIN]]) {
        fetched.length = 0;
        assert.equal((await engineFile(req(path, { ae, headers }), env)).status, 200);
        assert.ok(fetched.length > 0);
        for (const f of fetched)
            assert.deepEqual(f.headers, { "if-none-match": '"x"' });
    }
});

test("a name that isn't there: 404 that nothing keeps, with or without br", async () => {
    for (const ae of ["br", "gzip"])
        nothingKept(await engineFile(req("/e/jspi/openjkdf2.ffffffffffff.wasm", { ae }), env));
});

test("a file with no .br beside it: the plain one, kept a year", async () => {
    const res = await engineFile(req(PLAIN), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Encoding"), null);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.deepEqual(await bytes(res), JS);
});

test("a .br asked for by name: 404 (it's only ever sent in place of its file)", async () => {
    fetched.length = 0;
    for (const p of [W + ".br", W + ".BR", J + ".Br"])
        nothingKept(await engineFile(req(p), env));
    assert.deepEqual(fetched, []);
});

test("any other spelling of a name (escapes, empty or dot parts, a slash at the end): 404, not asked", async () => {
    const spellings = [
        W.replace(/\.wasm$/, ".wasm%2ebr"), W.replace(/\.wasm$/, ".wasm%2Ebr"), W.replace(/\.wasm$/, ".wasm.b%72"),
        W.replace("/jspi/", "//jspi/"), W.replace("/e/", "/e//"), W + "/", W.replace("/jspi/", "/%6aspi/"),
        "/e/..%2findex.html", "/e/jspi/..%2f..%2findex.html", "/e/%2e%2e%2findex.html", "/e/jspi/.hidden.js",
        "/e/jspi/openjkdf2..0123456789ab.wasm", "/e/", "/e/jspi/openjkdf2.0123456789ab.wasm%00", "/e/a b.js",
    ];
    fetched.length = 0;
    for (const p of spellings) {
        for (const ae of ["br", "gzip"]) {
            const res = await engineFile(req(p, { ae }), env);
            nothingKept(res);
            assert.notDeepEqual(await bytes(res), files.get(W + ".br").body, p);
            nothingKept(await lobby.fetch(req(p, { ae }), env, {}));
        }
    }
    assert.deepEqual(fetched, []);
    // The stand-in would have found the .br under the first spelling (with
    // a redirect to its name), so the check above means something.
    const direct = await ASSETS.fetch(new Request("https://site.example" + spellings[0]));
    assert.equal(direct.status, 307);
});

test("what the URL parser resolves (%2e%2e, ./) leaves e/ before the router looks", async () => {
    // /e/%2e%2e/index.html is /index.html: the page, with its own caching.
    const page = await lobby.fetch(req("/e/%2e%2e/index.html"), env, {});
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
    assert.deepEqual(await bytes(page), files.get("/index.html").body);
    const dot = await engineFile(req(W.replace("/jspi/", "/jspi/./")), env);
    assert.equal(dot.status, 200);
    assert.equal(dot.headers.get("Content-Encoding"), "br");
});

test("a spelling outside e/ that the asset server decodes to a .br: a redirect to its name, which is a 404", async () => {
    for (const p of ["/" + W + ".br", W.replace("/e/", "/%65/") + ".br"]) {
        const first = await lobby.fetch(req(p), env, {});
        assert.equal(first.status, 307, p);
        assert.equal(first.headers.get("Content-Encoding"), null);
        assert.equal((await bytes(first)).length, 0);
        const to = first.headers.get("Location");
        assert.equal(to, W + ".br");
        nothingKept(await lobby.fetch(req(to), env, {}));
    }
});

test("the asset server's trouble: as it is, kept by nothing; a redirect of its own: 404", async () => {
    trouble.add(W);
    trouble.add(W + ".br");
    try {
        for (const ae of ["br", "gzip"]) {
            const res = await engineFile(req(W, { ae }), env);
            assert.equal(res.status, 500);
            assert.equal(res.headers.get("Cache-Control"), "no-store");
            assert.equal(res.headers.get("Content-Encoding"), null);
        }
    } finally {
        trouble.clear();
    }
    // A .br in trouble, its file not: the plain file.
    trouble.add(W + ".br");
    try {
        const res = await engineFile(req(W), env);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Content-Encoding"), null);
        assert.deepEqual(await bytes(res), WASM);
    } finally {
        trouble.clear();
    }
    const redirecting = { fetch: async () => new Response(null, { status: 307, headers: { Location: "/e/x.js" } }) };
    const res = await engineFile(req(J), { ...env, ASSETS: redirecting });
    nothingKept(res);
    assert.equal(res.headers.get("Location"), null);
});

test("the router: /e/ goes to engineFile, on the old address and www too (no redirect)", async () => {
    for (const host of ["old.example", "www.site.example"]) {
        const res = await lobby.fetch(req(W, { host }), env, {});
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Content-Encoding"), "br");
    }
    const page = await lobby.fetch(req("/", { host: "old.example" }), env, {});
    assert.equal(page.status, 301);
    assert.equal(page.headers.get("Location"), "https://site.example/?moved");
});

test("the router: the page as the asset server gives it, its 304 too", async () => {
    const res = await lobby.fetch(req("/"), env, {});
    assert.equal(res.status, 200);
    const etag = res.headers.get("ETag");
    assert.equal(etag, etagOf(files.get("/index.html").body));
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
    const again = await lobby.fetch(req("/", { headers: { "If-None-Match": etag } }), env, {});
    assert.equal(again.status, 304);
    const weak = await lobby.fetch(req("/index.html", { headers: { "If-None-Match": "W/" + etag } }), env, {});
    assert.equal(weak.status, 304);
});

test("the router: a 404 elsewhere is kept by nothing, also under rooms/ (a year in _headers)", async () => {
    for (const path of ["/favicon.ico", "/rooms/nar-shaddaa.00000000.webp", "/e", "/kit-files.json"]) {
        const res = await lobby.fetch(req(path), env, {});
        assert.equal(res.status, 404, path);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
    }
    // A room picture that is there keeps its year (straight from the assets
    // on Cloudflare; through the router here).
    const pic = await lobby.fetch(req("/rooms/nar-shaddaa.df7543fa.webp"), env, {});
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    // Other answers than 404 pass as they are (a method the asset server
    // doesn't take).
    const post = await lobby.fetch(req("/index.html", { method: "POST" }), env, {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Cache-Control"), null);
});

let failed = 0;
for (const t of tests) {
    try {
        await t.fn();
        console.log("ok   " + t.name);
    } catch (e) {
        failed++;
        console.log("FAIL " + t.name + "\n" + (e.stack || e));
    }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
