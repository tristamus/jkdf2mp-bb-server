// jkdf2.net's .7z and .rar files, and its loose GOBs, made into the zip the
// Level Library keeps for every level and mod (zip/<id>.zip): the game's page
// and the rest of the job (src/levels.js) only open zips. On since kit 184
// (Antonio, 2026-11-22: "Yes, add .7z and .rar").
//
// An archive is unpacked with libarchive (src/vendor/libarchive.js and .wasm,
// made by tools/vendor-libarchive.sh), in its own wasm memory, which is capped
// (maxHeap, MAX_HEAP by default): the archive itself and what unpacking it
// takes (a 7z's dictionary, say) have to fit, so the Durable Object stays
// inside its 128 MB. One that doesn't is too big to unpack here (TooBig), as
// is one that unpacks to more than maxOut, or holds more files than a zip
// without zip64 can. A damaged one, or one locked with a password, is bad
// (e.bad). Each archive gets a fresh wasm instance, dropped afterwards.
//
// Each file goes into the zip deflated as it comes out (CompressionStream),
// its CRC-32 and sizes after its data (bit 3, a data descriptor: the central
// directory, which the page and openZip read, has them too), in the
// archive's order, a later file of the same name left out. The zip goes into
// the bucket as it's made, in parts of part bytes (a multipart upload: R2
// wants every part but the last the same size, 5 MiB at least) once it's past
// one part; a smaller zip is given back whole (bytes) for the job to put.

import libarchive from "./vendor/libarchive.js";
import wasm from "./vendor/libarchive.wasm";

export const ARCHIVE = /\.(7z|rar)$/i;
export const LOOSE = /\.(gob|goo)$/i;
export const MAX_HEAP = 80 * 1024 * 1024;
// Unpacking and deflating takes about 5 s of CPU for 100 MB (a Durable
// Object has 30 s for each alarm, and the job reads the zip again after).
export const MAX_OUT = 320 * 1024 * 1024;
export const PART = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const FILE = 0o100000;

export class TooBig extends Error {
    constructor(why) {
        super(why);
        this.tooBig = true;
    }
}

const bad = why => Object.assign(new Error(why), { bad: true });

// ---- CRC-32 and SHA-256

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

export function crc32(b, crc = 0) {
    let c = ~crc;
    for (let i = 0; i < b.length; i++)
        c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
}

function hex(buf) {
    return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// A SHA-256 of bytes as they go by (crypto.DigestStream in a Worker; in
// Node.js, which hasn't one, of all of them at the end).
function digest() {
    const ds = typeof crypto.DigestStream === "function" ? new crypto.DigestStream("SHA-256") : null;
    const w = ds && ds.getWriter();
    const parts = [];
    return {
        async add(b) {
            if (w) await w.write(b); else parts.push(b);
        },
        async hex() {
            if (w) {
                await w.close();
                return hex(await ds.digest);
            }
            return hex(await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer()));
        },
    };
}

// ---- The zip, into the bucket as it's made

class Sink {
    constructor(bucket, key, opts, part) {
        Object.assign(this, { bucket, key, opts, part });
        this.buf = new Uint8Array(part);
        this.n = 0;
        this.size = 0;
        this.parts = [];
        this.up = null;
        this.sha = digest();
    }

    async write(b) {
        await this.sha.add(b);
        this.size += b.length;
        while (b.length) {
            const k = Math.min(b.length, this.part - this.n);
            this.buf.set(b.subarray(0, k), this.n);
            this.n += k;
            b = b.subarray(k);
            if (this.n === this.part)
                await this.flush();
        }
    }

    async flush() {
        if (!this.up)
            this.up = await this.bucket.createMultipartUpload(this.key, this.opts);
        this.parts.push(await this.up.uploadPart(this.parts.length + 1, this.buf));
        this.buf = new Uint8Array(this.part);
        this.n = 0;
    }

    // { size, sha } and, for a zip of less than a part, its bytes.
    async done() {
        const sha = await this.sha.hex();
        if (!this.up)
            return { size: this.size, sha, bytes: this.buf.slice(0, this.n) };
        if (this.n)
            this.parts.push(await this.up.uploadPart(this.parts.length + 1, this.buf.subarray(0, this.n)));
        await this.up.complete(this.parts);
        this.buf = null;
        return { size: this.size, sha };
    }

    async abort() {
        if (this.up)
            await this.up.abort().catch(() => {});
        this.up = null;
    }
}

// A file's date and time as a zip has them (MS-DOS, in UTC here), from
// seconds since 1970; 1980-01-01 for none.
function dosTime(sec) {
    const d = new Date(Number(sec) * 1000);
    if (!(Number(sec) > 0) || isNaN(d) || d.getUTCFullYear() < 1980 || d.getUTCFullYear() > 2107)
        return { time: 0, date: (1 << 5) | 1 };
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

// A path in an archive as a zip entry's name: forward slashes, no empty, "."
// or ".." parts.
export function entryName(raw) {
    return String(raw || "").replace(/\\/g, "/").split("/").filter(p => p && p !== "." && p !== "..").join("/");
}

class ZipOut {
    constructor(sink, maxOut) {
        this.sink = sink;
        this.maxOut = maxOut;
        this.at = 0;
        this.out = 0;
        this.dir = [];
        this.names = new Set();
    }

    async put(b) {
        await this.sink.write(b);
        this.at += b.length;
    }

    // One file: fill(write) gives its bytes to write, in order. Left out
    // (false) when the zip has one of its name already.
    async file(name, sec, fill) {
        if (this.names.has(name)) {
            await fill(() => {});
            return false;
        }
        if (this.dir.length >= 0xffff)
            throw new TooBig("it holds more than 65,535 files");
        this.names.add(name);
        const raw = new TextEncoder().encode(name);
        const utf8 = /[^\x20-\x7e]/.test(name);
        const flags = 0x0008 | (utf8 ? 0x0800 : 0);
        const { time, date } = dosTime(sec);
        const at = this.at;
        const head = new Uint8Array(30 + raw.length);
        const v = new DataView(head.buffer);
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, flags, true);
        v.setUint16(8, 8, true);
        v.setUint16(10, time, true);
        v.setUint16(12, date, true);
        v.setUint16(26, raw.length, true);
        head.set(raw, 30);
        await this.put(head);
        let crc = 0, size = 0, csize = 0;
        const cs = new CompressionStream("deflate-raw");
        const w = cs.writable.getWriter();
        const r = cs.readable.getReader();
        const pump = (async () => {
            try {
                for (;;) {
                    const { done, value } = await r.read();
                    if (done)
                        break;
                    csize += value.length;
                    await this.put(value);
                }
            } catch (e) {
                await r.cancel(e).catch(() => {});
                throw e;
            }
        })();
        try {
            await fill(async b => {
                size += b.length;
                this.out += b.length;
                if (this.out > this.maxOut)
                    throw new TooBig(`it unpacks to more than ${Math.round(this.maxOut / 1048576)} MB`);
                crc = crc32(b, crc);
                await w.write(b);
            });
            await w.close();
        } catch (e) {
            await w.abort(e).catch(() => {});
            await pump.catch(() => {});
            throw e;
        }
        await pump;
        if (size > 0xffffffff || csize > 0xffffffff || this.at > 0xffffffff)
            throw new TooBig("it's too big for a zip without zip64");
        const dd = new Uint8Array(16);
        const dv = new DataView(dd.buffer);
        dv.setUint32(0, 0x08074b50, true);
        dv.setUint32(4, crc, true);
        dv.setUint32(8, csize, true);
        dv.setUint32(12, size, true);
        await this.put(dd);
        this.dir.push({ raw, flags, time, date, crc, csize, size, at });
        return true;
    }

    async end() {
        const start = this.at;
        for (const e of this.dir) {
            const c = new Uint8Array(46 + e.raw.length);
            const v = new DataView(c.buffer);
            v.setUint32(0, 0x02014b50, true);
            v.setUint16(4, 20, true);
            v.setUint16(6, 20, true);
            v.setUint16(8, e.flags, true);
            v.setUint16(10, 8, true);
            v.setUint16(12, e.time, true);
            v.setUint16(14, e.date, true);
            v.setUint32(16, e.crc, true);
            v.setUint32(20, e.csize, true);
            v.setUint32(24, e.size, true);
            v.setUint16(28, e.raw.length, true);
            v.setUint32(42, e.at, true);
            c.set(e.raw, 46);
            await this.put(c);
        }
        const end = new Uint8Array(22);
        const v = new DataView(end.buffer);
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, this.dir.length, true);
        v.setUint16(10, this.dir.length, true);
        v.setUint32(12, this.at - start, true);
        v.setUint32(16, start, true);
        await this.put(end);
    }
}

// ---- libarchive

// A fresh libarchive, its wasm memory capped at maxHeap.
async function libarchiveOf(maxHeap) {
    let fail;
    const failed = new Promise((_, reject) => { fail = reject; });
    const mod = await Promise.race([libarchive({
        maxHeap,
        print: () => {},
        printErr: () => {},
        instantiateWasm(imports, done) {
            WebAssembly.instantiate(wasm, imports).then(inst => done(inst, wasm), fail);
            return {};
        },
    }), failed]);
    const c = (name, ret, args) => mod.cwrap(name, ret, args);
    return {
        mod,
        open: c("archive_read_new_memory", "number", ["number", "number", "string"]),
        next: c("archive_read_next_entry", "number", ["number"]),
        read: c("archive_read_data", "number", ["number", "number", "number"]),
        free: c("archive_read_free", "number", ["number"]),
        error: c("archive_error_string", "string", ["number"]),
        type: c("archive_entry_filetype", "number", ["number"]),
        path: c("archive_entry_pathname_utf8", "string", ["number"]),
        mtime: c("archive_entry_mtime", "number", ["number"]),
        locked: c("archive_entry_is_encrypted", "number", ["number"]),
    };
}

const outOfMemory = why => /alloc|memory|enlarge|OOM/i.test(String(why || ""));

// The download, into the wasm memory: { ptr, size }. Straight in when it
// says its length; else held until it's all there.
async function intoHeap(lib, body, len, max, sha) {
    const mb = Math.round(max / 1048576);
    if (len > max)
        throw new TooBig(`it's more than ${mb} MB`);
    const m = lib.mod;
    let ptr = len ? m._malloc(len) : 0;
    if (len && !ptr)
        throw new TooBig(`no room for it in ${mb} MB`);
    const chunks = [];
    let at = 0;
    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            await sha.add(value);
            if (ptr) {
                if (at + value.length > len)
                    throw new Error("the download is longer than its Content-Length");
                m.HEAPU8.set(value, ptr + at);
            } else {
                if (at + value.length > max)
                    throw new TooBig(`it's more than ${mb} MB`);
                chunks.push(value);
            }
            at += value.length;
        }
    } catch (e) {
        await reader.cancel().catch(() => {});
        if (ptr)
            m._free(ptr);
        throw e;
    }
    if (ptr && at !== len) {
        m._free(ptr);
        throw new Error("the download was cut short");
    }
    if (!ptr) {
        ptr = m._malloc(Math.max(1, at));
        if (!ptr)
            throw new TooBig(`no room for it in ${mb} MB`);
        let o = 0;
        for (const c of chunks.splice(0)) {
            m.HEAPU8.set(c, ptr + o);
            o += c.length;
        }
    }
    return { ptr, size: at };
}

async function unpackArchive(lib, zip, ptr, size) {
    const m = lib.mod;
    const a = lib.open(ptr, size, null);
    if (!a)
        throw bad("it isn't an archive libarchive can open");
    const buf = m._malloc(CHUNK);
    let files = 0;
    try {
        if (!buf)
            throw new TooBig("no room to unpack it");
        for (let n = 0; ; n++) {
            const e = lib.next(a);
            if (!e)
                break;
            if (lib.type(e) !== FILE)
                continue;
            if (lib.locked(e))
                throw bad("it's locked with a password");
            const name = entryName(lib.path(e)) || `file-${n + 1}`;
            const kept = await zip.file(name, lib.mtime(e), async write => {
                for (;;) {
                    const got = lib.read(a, buf, CHUNK);
                    if (got < 0) {
                        const why = lib.error(a) || "a file in it is damaged";
                        throw outOfMemory(why) ? new TooBig(why) : bad(why);
                    }
                    if (got === 0)
                        break;
                    await write(m.HEAPU8.slice(buf, buf + got));
                }
            });
            if (kept)
                files++;
        }
        // The end, or a header that couldn't be read: libarchive says which.
        const why = lib.error(a);
        if (why)
            throw outOfMemory(why) ? new TooBig(why) : bad(why);
        if (!files)
            throw bad("no files in it");
    } finally {
        if (buf)
            m._free(buf);
        lib.free(a);
    }
    return files;
}

// res: the download (a fetch Response) of the file named name, a .7z or .rar
// (ARCHIVE) or a loose GOB (LOOSE). Its zip goes into bucket at key, or comes
// back as bytes when it's less than a part: { size, sha, bytes?, files,
// unpacked, archive: { size, sha256 } }.
export async function unpack(res, { name, bucket, key, meta = {}, maxHeap = MAX_HEAP, maxOut = MAX_OUT, part = PART }) {
    const sink = new Sink(bucket, key, { httpMetadata: { contentType: "application/zip" }, customMetadata: meta }, part);
    const zip = new ZipOut(sink, maxOut);
    const sha = digest();
    let size = 0, files = 0;
    try {
        if (LOOSE.test(name)) {
            await zip.file(entryName(name.split("/").pop()), Date.parse(res.headers.get("Last-Modified") || "") / 1000, async write => {
                const reader = res.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    await sha.add(value);
                    size += value.length;
                    await write(value);
                }
            });
            files = 1;
        } else {
            let lib = await libarchiveOf(maxHeap);
            try {
                const len = Number(res.headers.get("Content-Length") || 0);
                const got = await intoHeap(lib, res.body, len, maxHeap, sha);
                size = got.size;
                files = await unpackArchive(lib, zip, got.ptr, got.size);
            } catch (e) {
                // Whatever went wrong once the memory couldn't grow: libarchive
                // may only say a file is damaged, or the wasm may abort.
                if (!e.tooBig && (lib.mod.heapFull || (!e.bad && outOfMemory(e && e.message))))
                    throw new TooBig(`it takes more than ${Math.round(maxHeap / 1048576)} MB to unpack`);
                throw e;
            } finally {
                lib = null;
            }
        }
        await zip.end();
        const out = await sink.done();
        return { ...out, files, unpacked: zip.out, archive: { size, sha256: await sha.hex() } };
    } catch (e) {
        await sink.abort();
        throw e;
    }
}
