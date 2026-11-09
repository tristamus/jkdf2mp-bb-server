// The engine's files, under /e/ (run_worker_first in wrangler.toml): each
// engine's openjkdf2.<hash>.js and openjkdf2.<hash>.wasm, and unzip.<hash>.js.
//
// The kit's build script (tools/build-kit.mjs) names them by their content
// (the first 12 hex digits of its SHA-256) and writes the names into the
// page (ENGINE_FILES), so a name never changes what it gives: the browser
// keeps them a year without asking again (immutable), and a page only ever
// gets its own engine, also a page opened before a deploy (the kit keeps the
// last kits' files). Beside each one the kit has <name>.br, the same file
// compressed with brotli at its best (11): the JSPI engine's 2.43 MB wasm is
// 683 KB that way, against about 853-870 KB as Cloudflare compresses on the
// fly (brotli 4 or zstd 3), and the scripts about 90 KB against 107-111 KB.
//
// Cloudflare's asset server can't send a .br file as such: it gives it no
// Content-Type and never a Content-Encoding (and a Content-Encoding set in
// _headers gets the bytes compressed again). So this does it: to a browser
// that takes br, the .br file's bytes as they are, as Content-Encoding br and
// the file's own Content-Type (application/wasm, which
// WebAssembly.instantiateStreaming needs). encodeBody "manual" keeps the
// runtime from compressing them again, and no-transform keeps Cloudflare
// from undoing or redoing it on the way. A browser that doesn't take br (by
// what it told Cloudflare: request.cf.clientAcceptEncoding, since the
// Accept-Encoding a Worker sees always says br) gets the plain file, which
// Cloudflare compresses as usual. If-None-Match goes to the asset server,
// which answers 304 for its own ETag.
//
// Only a name as a kit writes it is looked up: letters, digits, - and _,
// with dots between, in folders under e/. The asset server decodes %-escapes
// and joins doubled slashes, so another spelling of a name could reach a
// file under another name (a .br, sent without its Content-Encoding); that,
// a .br asked for by its own name, and any other method than GET or HEAD
// never reach it. It's always asked for the whole file: a Range in the
// request is left out (the asset server doesn't do parts either), so the
// answer is the whole file, 200, or 304.
//
// A name that isn't there (a page from a newer deploy reaching an older one,
// or a mistyped address) gets a 404 that nothing keeps (no-store), so it can
// be found once it's there.

const IMMUTABLE = "public, max-age=31536000, immutable";
// The types a .br beside a file is sent for, by the file's extension.
const TYPES = { ".wasm": "application/wasm", ".js": "text/javascript; charset=utf-8" };
// A name as a kit writes it: /e/, then folders and a file name, each one or
// more runs of letters, digits, - and _, with single dots between (so no
// empty, "." or ".." parts, and nothing %-escaped).
const NAME_RE = /^\/e(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)+$/;

export async function engineFile(request, env) {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    const path = url.pathname;
    // The .br files are only ever sent in place of the file they compress.
    if (!NAME_RE.test(path) || /\.br$/i.test(path))
        return missing();
    // The asset server gets the method and If-None-Match, nothing else.
    const headers = new Headers();
    const inm = request.headers.get("If-None-Match");
    if (inm)
        headers.set("If-None-Match", inm);
    const ask = p => env.ASSETS.fetch(new Request(new URL(p, url), { method, headers }));
    const dot = path.lastIndexOf(".");
    const type = dot > path.lastIndexOf("/") ? TYPES[path.slice(dot)] : undefined;
    if (type && acceptsBr(clientAcceptEncoding(request))) {
        const br = await ask(path + ".br");
        if (br.status === 200 || br.status === 304) {
            const out = new Headers({ "Content-Type": type, "Content-Encoding": "br",
                                      "Cache-Control": IMMUTABLE + ", no-transform", Vary: "Accept-Encoding" });
            const etag = br.headers.get("ETag");
            if (etag)
                out.set("ETag", etag);
            return new Response(method === "HEAD" || br.status === 304 ? null : br.body,
                                { status: br.status, headers: out, encodeBody: "manual" });
        }
        // No .br beside it (a file the kit didn't compress): the plain file.
        if (br.body)
            await br.body.cancel();
    }
    const res = await ask(path);
    if (res.status !== 200 && res.status !== 304) {
        if (res.body)
            await res.body.cancel();
        // Not a file (a redirect would be the asset server's own idea of
        // the name): 404, or the asset server's own trouble as it is.
        return missing(res.status >= 500 ? res.status : 404);
    }
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", IMMUTABLE);
    out.headers.set("Vary", "Accept-Encoding");
    return out;
}

function missing(status = 404) {
    return new Response(status === 404 ? "Not found" : null,
                        { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

// The browser's own Accept-Encoding. Cloudflare gives the Worker
// "br, gzip" whatever the browser sent, and keeps what it sent in
// request.cf.clientAcceptEncoding (Cloudflare's HTTP headers reference);
// wrangler dev does the same. On Cloudflare without it, what the browser
// takes isn't known, so it's taken as nothing: the plain file, which
// Cloudflare compresses for whatever the browser does take. Outside
// Cloudflare (no request.cf), the header.
export function clientAcceptEncoding(request) {
    if (!request.cf)
        return request.headers.get("Accept-Encoding") || "";
    const ae = request.cf.clientAcceptEncoding;
    return typeof ae === "string" ? ae : "";
}

// Whether an Accept-Encoding takes br (named, or *, with q above 0).
export function acceptsBr(accept) {
    let br = null, any = null;
    for (const part of (accept || "").split(",")) {
        const [coding, ...params] = part.split(";").map(s => s.trim().toLowerCase());
        const q = params.find(p => p.startsWith("q="));
        const weight = q ? Number(q.slice(2)) : 1;
        if (coding === "br")
            br = weight;
        else if (coding === "*")
            any = weight;
    }
    const w = br !== null ? br : any;
    return w !== null && w > 0;
}
