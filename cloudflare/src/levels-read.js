// What the Level Library's job (src/levels.js) reads out of Massassi's pages
// and the level zips: pure functions, no fetching and no storage, so the
// tests (test/levels.mjs) run them on saved pages and zips in Node.js.
//
//   parseList(html)        a level list (/levels/<cat>/?num=9999): its rows
//   parsePage(html, id)    a level's page (/levels/files/<id>.shtml)
//   openZip(reader)        a zip's entries, through reader.read(at, n)
//   readEntry(zip, e)      an entry's bytes, unpacked
//   parseGob(bytes)        a GOB's file list
//   parseEpisode(text)     an episode.jk's title, type and levels
//   decodeText(bytes)      a readme as text, as find_dates.py decodes it
//   releaseDate(...)       a level's real release date (see below)
//
// The release date is a port of find_dates.py (builds/level-library/
// release-dates in the project files), tested there on 43 Massassi levels on
// 2026-11-13: a labelled date in a readme ("Date of Release : October 16,
// 1999"), else any date in a readme the level files agree with, else the
// newest date of the GOB, GOO or JKL files in the zip, else Massassi's own
// date unless it is the 2000-06-02 bulk import. test/levels.mjs checks the
// port gives that test's results.

import { JkUnzip } from "./vendor/jkunzip.js";

const MASSASSI = "https://www.massassi.net";

// ---- HTML

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", raquo: "»", laquo: "«",
                   copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
                   rdquo: "”", ldquo: "“", eacute: "é", egrave: "è", aacute: "á", ouml: "ö", uuml: "ü",
                   auml: "ä", szlig: "ß", ntilde: "ñ", ccedil: "ç" };

export function unescapeHtml(s) {
    return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e) => {
        if (e[0] === "#") {
            const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
        }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
}

// Text of a piece of HTML: tags off, entities read, spaces run together.
function text(html) {
    return unescapeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// The same, keeping paragraphs and line breaks as new lines.
function paragraphs(html) {
    const t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<[^>]*>/g, "");
    return unescapeHtml(t).split("\n").map(l => l.replace(/[ \t\r\f\v]+/g, " ").trim()).join("\n")
        .replace(/\n{3,}/g, "\n\n").trim();
}

function int(s) {
    const n = parseInt(String(s || "").replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
}

// A level list: one row per level, in the list's order. Each has the id of
// its page, title, author, the date Massassi says it was added, rating (0 to
// 10, null without votes), votes, comments and downloads.
export function parseList(html) {
    const rows = [];
    const parts = html.split('<div class="level-list-screenshot">').slice(1);
    for (const part of parts) {
        const item = /<div class="level-list-item">([\s\S]*?)<\/div>/.exec(part);
        if (!item)
            continue;
        const link = /<a href="\/levels\/files\/(\d+)\.shtml">([\s\S]*?)<\/a>/.exec(item[1]);
        if (!link)
            continue;
        const by = /By:<\/span>([\s\S]*?)<br/.exec(item[1]);
        const added = /Added:<\/span>\s*(\d{4}-\d{2}-\d{2})/.exec(item[1]);
        const det = /<div class="level-list-details">([\s\S]*?)<\/div>/.exec(part);
        const d = det ? det[1] : "";
        const rating = /Rating:<\/span>[\s\S]*?<span class="level-[a-z]+">\s*(\d+(?:\.\d+)?)\s*<\/span>/.exec(d);
        const votes = /\((\d+) votes?\)/.exec(d);
        const comments = /Comments:\s*(\d+)/.exec(d);
        const dl = /Downloads:<\/span>\s*(\d+)/.exec(d);
        rows.push({
            id: Number(link[1]),
            title: text(link[2]),
            author: by ? text(by[1]) : "",
            added: added ? added[1] : null,
            rating: rating ? Number(rating[1]) : null,
            votes: votes ? Number(votes[1]) : 0,
            comments: comments ? Number(comments[1]) : 0,
            dl: dl ? Number(dl[1]) : 0,
        });
    }
    return rows;
}

// A level's page. The zip's own address comes from the 3D Preview's url=,
// never from the Download link: Brian (who runs Massassi) asked for it that
// way, as it skips the download count and Massassi's dynamic download page.
// Only an address under www.massassi.net/media/levels/files/ is taken; a
// page without one (no 3D Preview) has zip null.
export function parsePage(html, id) {
    const at = html.indexOf('<div id="content">');
    const body = at >= 0 ? html.slice(at) : html;
    const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(body);
    const cat = /<p class="crumb">[\s\S]*?<a href="\/levels\/([a-z]+)\/">/.exec(body);
    const desc = /<div class="level-description">\s*<h2>Description<\/h2>([\s\S]*?)<\/div>/.exec(body);
    const shotsAt = /<div class="level-screenshots">([\s\S]*?)<\/div>/.exec(body);
    const shots = [];
    if (shotsAt) {
        const re = /<a href="(\/media\/levels\/screenshots\/[A-Za-z0-9_.\-]+\.(?:jpe?g|png|gif))"/gi;
        let m;
        while ((m = re.exec(shotsAt[1])) && shots.length < 8)
            if (!shots.includes(m[1]))
                shots.push(m[1]);
    }
    const info = {};
    const re = /level-info-item-name">([\s\S]*?)<\/div>\s*<div class="level-info-item-value">([\s\S]*?)<\/div>/g;
    let m;
    while ((m = re.exec(body)))
        info[text(m[1]).replace(/:$/, "")] = text(m[2]);
    let zip = null;
    const pv = /3dpreview\.massassi\.net\/level\/\?([^"'<>\s]+)/.exec(body);
    if (pv) {
        const q = new URLSearchParams(unescapeHtml(pv[1]));
        zip = directZip(q.get("url"));
    }
    return {
        id,
        title: h1 ? text(h1[1]) : (info.Download || ""),
        cat: cat ? cat[1] : null,
        desc: desc ? paragraphs(desc[1]) : "",
        shots,
        name: info.Download || "",
        size: info["File Size"] || "",
        date: /^\d{4}-\d{2}-\d{2}$/.test(info.Date || "") ? info.Date : null,
        author: info.Author || "",
        dl: int(info.Downloads),
        rating: info["Score (0-10)"] && /\d/.test(info["Score (0-10)"]) ? Number(info["Score (0-10)"]) : null,
        votes: int(info["# of Ratings"]) || 0,
        zip,
    };
}

// The zip's address, if it's one of Massassi's level files.
export function directZip(u) {
    if (!u)
        return null;
    let url;
    try {
        url = new URL(u);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
        return null;
    if (url.hostname !== "www.massassi.net" && url.hostname !== "massassi.net")
        return null;
    if (!/^\/media\/levels\/files\/[a-z0-9]+\/[^/]+$/i.test(url.pathname) || url.search || url.hash)
        return null;
    return MASSASSI + url.pathname;
}

// The maps Massassi's 3D preview page lists for a zip (one per GOB): its
// script has them as var maps = JSON.parse("[[name, "?url=...&episode=N"], ...]").
export function previewMaps(html) {
    const m = /var maps = JSON\.parse\(("(?:[^"\\]|\\.)*")\)/.exec(html || "");
    if (!m)
        return [];
    let list;
    try {
        list = JSON.parse(JSON.parse(m[1]));
    } catch {
        return [];
    }
    const maps = [];
    for (const it of Array.isArray(list) ? list : []) {
        const e = Array.isArray(it) && /[?&]episode=(\d{1,2})(?:&|$)/.exec(String(it[1] || ""));
        if (e && !maps.some(x => x.e === Number(e[1])))
            maps.push({ n: String(it[0] || "").slice(0, 64), e: Number(e[1]) });
    }
    return maps;
}

// What the 3D view needs from a level's GOB to draw its textures as the game
// does: the textures (MATs) and colormaps (CMPs) it ships, and each level's
// master colormap (the first under "World Colormaps" in its .jkl), which the
// game turns every texture into colors with. own: the MATs' paths,
// lowercased; cmp: level (its .jkl's name without .jkl) -> colormap name;
// pal: colormap name -> its 256 colors (768 bytes, base64).
export function gobTextures(b, out) {
    const dir = parseGob(b);
    if (!dir)
        return out;
    for (const f of dir) {
        const name = f.name.toLowerCase();
        const base = name.split("/").pop();
        if (/\.mat$/.test(name)) {
            if (out.own.length < MAX_OWN && !out.own.includes(name))
                out.own.push(name);
        } else if (/\.cmp$/.test(name)) {
            // "CMP ", version, transparency, then 52 bytes, then the colors.
            if (f.size >= 64 + 768 && u32(b, f.offset) === 0x20504d43 && Object.keys(out.pal).length < 32)
                out.pal[base] = toBase64(b.subarray(f.offset + 64, f.offset + 64 + 768));
        } else if (/\.jkl$/.test(name) && f.size <= MAX_JKL) {
            const cmp = worldColormap(b.subarray(f.offset, f.offset + f.size));
            if (cmp)
                out.cmp[base.replace(/\.jkl$/, "")] = cmp;
        }
    }
    return out;
}

const MAX_OWN = 4000, MAX_JKL = 32 * 1024 * 1024;

// A .jkl's master colormap: the first entry of its World Colormaps.
export function worldColormap(b) {
    let t = "";
    // Latin-1, a part at a time: a .jkl can be megabytes, the section is near its top.
    for (let at = 0; at < b.length; at += 65536)
        t += String.fromCharCode.apply(null, b.subarray(at, Math.min(b.length, at + 65536)));
    const m = /^[ \t]*World[ \t]+Colormaps[ \t]+(\d+)[ \t]*\r?$/im.exec(t);
    if (!m || m[1] === "0")
        return null;
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 4096);
    const e = /^[ \t]*0[ \t]*:[ \t]*([^\s#]+)/m.exec(rest);
    return e ? e[1].toLowerCase().slice(0, 64) : null;
}

function toBase64(b) {
    let s = "";
    for (const c of b)
        s += String.fromCharCode(c);
    return btoa(s);
}

// "226.0 KiB" -> bytes.
export function sizeBytes(s) {
    const m = /([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)/i.exec(s || "");
    if (!m)
        return null;
    const k = { b: 1, kib: 1024, kb: 1024, mib: 1048576, mb: 1048576, gib: 1073741824, gb: 1073741824 }[m[2].toLowerCase()];
    return Math.round(Number(m[1]) * k);
}

// ---- Zips (PKWARE's APPNOTE.TXT). reader is { size, read(at, n) ->
// Promise<Uint8Array> }, so a zip can be read in memory or from R2 in parts.

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function cp437(b) {
    let s = "";
    for (const c of b)
        s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
    return s;
}

export function memReader(bytes) {
    return { size: bytes.length, read: async (at, n) => bytes.subarray(at, at + n) };
}

function u16(b, at) {
    return b[at] | (b[at + 1] << 8);
}
function u32(b, at) {
    return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}
function u64(b, at) {
    return u32(b, at) + u32(b, at + 4) * 0x100000000;
}

// The DOS date of an entry as YYYY-MM-DD, or null.
function dosDate(d) {
    const y = 1980 + (d >> 9), mo = (d >> 5) & 15, da = d & 31;
    return mkDate(y, mo, da);
}

// Its entries: { name, method, flags, crc, csize, size, at (its local
// header), date }. Throws if it isn't a zip.
export async function openZip(reader) {
    const size = reader.size;
    if (size < 22)
        throw new Error("not a zip");
    const tailLen = Math.min(size, 65557);
    const tail = await reader.read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw new Error("not a zip");
    let count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdAt = u32(tail, eocd + 16);
    // Zip64: its locator sits right before the end record.
    if ((count === 0xffff || cdAt === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 &&
        u32(tail, eocd - 20) === 0x07064b50) {
        const recAt = u64(tail, eocd - 12);
        const rec = await reader.read(recAt, 56);
        if (u32(rec, 0) === 0x06064b50) {
            count = u64(rec, 32);
            cdSize = u64(rec, 40);
            cdAt = u64(rec, 48);
        }
    }
    if (cdAt + cdSize > size || cdSize > 64 * 1024 * 1024)
        throw new Error("bad zip directory");
    const cd = await reader.read(cdAt, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
        if (u32(cd, p) !== 0x02014b50)
            throw new Error("bad zip directory");
        const flags = u16(cd, p + 8), method = u16(cd, p + 10), date = u16(cd, p + 14);
        const crc = u32(cd, p + 16);
        let csize = u32(cd, p + 20), usize = u32(cd, p + 24);
        const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
        let at = u32(cd, p + 42);
        const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
        // Zip64 sizes and offset, in the extra field, in this order, only
        // those that are 0xffffffff in the record.
        let x = p + 46 + nlen;
        const xend = x + xlen;
        while (x + 4 <= xend) {
            const id = u16(cd, x), n = u16(cd, x + 2);
            if (id === 1) {
                let q = x + 4;
                if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
                if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
                if (at === 0xffffffff) { at = u64(cd, q); q += 8; }
            }
            x += 4 + n;
        }
        const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : cp437(nameBytes);
        entries.push({ name: name.replace(/\\/g, "/"), method, flags, crc, csize, size: usize, at, date: dosDate(date),
                       dir: /\/$/.test(name) });
        p += 46 + nlen + xlen + clen;
    }
    return { reader, entries };
}

// Where an entry's compressed bytes start.
export async function dataStart(zip, e) {
    const h = await zip.reader.read(e.at, 30);
    if (h.length < 30 || u32(h, 0) !== 0x04034b50)
        throw new Error("bad local header");
    return e.at + 30 + u16(h, 26) + u16(h, 28);
}

async function collect(stream, limit) {
    const parts = [];
    let n = 0;
    const r = stream.getReader();
    for (;;) {
        const { done, value } = await r.read();
        if (done)
            break;
        n += value.length;
        if (n > limit) {
            await r.cancel();
            throw new Error("too big");
        }
        parts.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// An entry's bytes, unpacked and checked against its CRC. Stored and
// Deflate go through the runtime's own DecompressionStream; the methods of
// 1990s zip tools (Shrink, Reduce, Implode) and the rest through the page's
// own unzip.js (src/vendor/jkunzip.js).
export async function readEntry(zip, e) {
    if (e.flags & 1)
        throw new Error("encrypted");
    const start = await dataStart(zip, e);
    const data = await zip.reader.read(start, e.csize);
    if (data.length !== e.csize)
        throw new Error("short entry");
    let out;
    if (e.method === 8) {
        const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        out = await collect(ds, e.size + 1);
    } else {
        return JkUnzip.unzip(e.method, e.flags, data, e.size, e.crc);
    }
    if (out.length !== e.size)
        throw new Error("bad size");
    if (JkUnzip.crc32(out) !== e.crc >>> 0)
        throw new Error("CRC mismatch");
    return out;
}

// ---- GOBs and episodes

export function parseGob(b) {
    if (b.length < 16 || b[0] !== 0x47 || b[1] !== 0x4f || b[2] !== 0x42 || b[3] !== 0x20 || u32(b, 4) !== 20)
        return null;
    const table = u32(b, 8);
    if (table + 4 > b.length)
        return null;
    const count = u32(b, table);
    if (table + 4 + count * 136 > b.length)
        return null;
    const files = [];
    for (let i = 0; i < count; i++) {
        const at = table + 4 + i * 136;
        const offset = u32(b, at), size = u32(b, at + 4);
        if (offset + size > b.length)
            return null;
        let name = "";
        for (let j = 0; j < 128 && b[at + 8 + j]; j++)
            name += String.fromCharCode(b[at + 8 + j]);
        files.push({ name: name.replace(/\\/g, "/"), offset, size });
    }
    return files;
}

// An episode.jk: its title (the first line that isn't a comment, in
// quotes), TYPE (1 single player, 2 multiplayer) and the .jkl levels it
// lists, in order.
export function parseEpisode(t) {
    const lines = t.split(/\r?\n/).map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
    let title = "";
    if (lines.length) {
        const q = /^"([^"]*)"/.exec(lines[0]);
        title = (q ? q[1] : lines[0]).trim().slice(0, 64);
    }
    const ty = /^TYPE\s+(\d+)/im.exec(lines.join("\n"));
    const levels = [];
    for (const l of lines) {
        const m = /\b([A-Za-z0-9_\-.]+\.jkl)\b/i.exec(l);
        if (m && /\bLEVEL\b/i.test(l) && !levels.includes(m[1].toLowerCase()))
            levels.push(m[1].toLowerCase());
    }
    return { title, type: ty ? Number(ty[1]) : null, levels };
}

// ---- Readmes, as find_dates.py's decode(): Word files and UTF-16 by their
// runs of text, else UTF-8, Windows-1252 or the DOS code page.

const CP1252_UNDEF = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

export function decodeText(b) {
    let zeros = 0;
    for (const c of b)
        if (c === 0)
            zeros++;
    const ole = b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
                b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;
    const wri = b.length >= 2 && (b[0] === 0x31 || b[0] === 0x32) && b[1] === 0xbe;
    if (ole || wri || zeros > Math.floor(b.length / 20)) {
        const s = latin1(b);
        const runs = s.match(/[\x20-\x7e\t]{4,}/g) || [];
        const wide = (s.match(/(?:[\x20-\x7e]\x00){4,}/g) || []).map(r => r.replace(/\x00/g, ""));
        const t = runs.concat(wide).join("\n");
        return t.replace(/\s{1,3}(?=[A-Z][A-Za-z.()/ ]{2,30}\s*:\s)/g, "\n");
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {}
    for (const c of b)
        if (CP1252_UNDEF.has(c))
            return cp437(b);
    return new TextDecoder("windows-1252").decode(b);
}

function latin1(b) {
    let s = "";
    for (let i = 0; i < b.length; i += 8192)
        s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return s;
}

// ---- Release dates (find_dates.py)

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const EARLIEST = "1997-09-01"; // Jedi Knight shipped in autumn 1997
const LABEL_RE = new RegExp("^\\s*[\\*\\-\\s]*(date\\s+of\\s+release|release\\s+date|date\\s+released|released(?:\\s+on)?|release|" +
    "date\\s+completed|completed(?:\\s+on)?|date\\s+finished|finished(?:\\s+on)?|date\\s+of\\s+completion|" +
    "creation\\s+date|date\\s+created|date|last\\s+updated|updated)\\s*[:=\\-\\.]+\\s*(.+)$", "i");
export const TEXT_EXT = [".txt", ".doc", ".nfo", ".me", ".1st", ".diz", ".wri"];
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
const RANK = { "date of release": 0, "release date": 0, "date released": 0, released: 0, "released on": 0, release: 1,
               "date completed": 2, completed: 2, "completed on": 2, "date finished": 2, finished: 2, "finished on": 2,
               "date of completion": 2, "creation date": 3, "date created": 3, date: 4, "last updated": 5, updated: 5 };

function pad(n) {
    return String(n).padStart(2, "0");
}

// YYYY-MM-DD if it's a real day, else null.
export function mkDate(y, m, d) {
    if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31))
        return null;
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d)
        return null;
    return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

function days(a, b) {
    return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}

function plusDays(a, n) {
    return new Date(Date.parse(a + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

function year4(y) {
    y = Number(y);
    if (y < 100)
        y += y >= 90 ? 1900 : 2000;
    return y;
}

function makeOk(today) {
    return d => d && d >= EARLIEST && d <= today;
}

// [date or null, precision, ambiguous: the other reading or false]
function parseDate(s, labeled, ok) {
    const t = s.toLowerCase();
    let m;
    const month = x => MONTHS[x.slice(0, 3)];
    // 16 October 1999 / 16th of Oct, 99
    m = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?" + MONTH_RE + ",?\\s+(\\d{4}|\\d{2})\\b").exec(t);
    if (m) {
        const d = mkDate(year4(m[3]), month(m[2]), Number(m[1]));
        if (ok(d)) return [d, "day", false];
    }
    // October 16, 1999 / Oct 16th 99
    m = new RegExp("\\b" + MONTH_RE + "\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4}|\\d{2})\\b").exec(t);
    if (m) {
        const d = mkDate(year4(m[3]), month(m[1]), Number(m[2]));
        if (ok(d)) return [d, "day", false];
    }
    // 1999-10-16
    m = /\b(199\d|20[0-2]\d)[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
    if (m) {
        const d = mkDate(Number(m[1]), Number(m[2]), Number(m[3]));
        if (ok(d)) return [d, "day", false];
    }
    // 10/16/99, 16.10.1999: which is the month is unclear when both are 12 or less
    m = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b/.exec(t);
    if (m) {
        const a = Number(m[1]), b = Number(m[2]), y = year4(m[3]);
        const cands = [];
        for (const [mo, da] of [[a, b], [b, a]]) {
            const d = mkDate(y, mo, da);
            if (ok(d) && !cands.includes(d)) cands.push(d);
        }
        if (cands.length)
            return [cands[0], "day", cands.length > 1 ? cands[1] : false];
    }
    // 09/2000
    m = /\b(\d{1,2})[/.\-](199\d|20[0-2]\d)\b/.exec(t);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
        const d = mkDate(Number(m[2]), Number(m[1]), 1);
        if (ok(d)) return [d, "month", false];
    }
    // march 18/03
    m = new RegExp("\\b" + MONTH_RE + "\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[/.\\-]\\s*(\\d{4}|\\d{2})\\b").exec(t);
    if (m) {
        const d = mkDate(year4(m[3]), month(m[1]), Number(m[2]));
        if (ok(d)) return [d, "day", false];
    }
    // May/2004
    m = new RegExp("\\b" + MONTH_RE + "\\s*[/.\\-]\\s*(\\d{4})\\b").exec(t);
    if (m) {
        const d = mkDate(Number(m[2]), month(m[1]), 1);
        if (ok(d)) return [d, "month", false];
    }
    // June 2001
    m = new RegExp("\\b" + MONTH_RE + ",?\\s+(\\d{4})\\b").exec(t);
    if (m) {
        const d = mkDate(Number(m[2]), month(m[1]), 1);
        if (ok(d)) return [d, "month", false];
    }
    // IV 2002 (a Roman-numeral month), only in a labelled value
    if (labeled) {
        m = /\b(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\.?\s*[\s./-]\s*(199\d|20[0-2]\d)\b/.exec(t);
        if (m) {
            const d = mkDate(Number(m[2]), ROMAN.indexOf(m[1]) + 1, 1);
            if (ok(d)) return [d, "month", false];
        }
    }
    // a bare year, only when it is the whole value ("1998")
    m = /^\s*(199[7-9]|20[0-2]\d)\s*$/.exec(t);
    if (m)
        return [mkDate(Number(m[1]), 1, 1), "year", false];
    return [null, null, false];
}

// Is this zip entry a readme the date may be in?
export function isText(name) {
    const n = name.toLowerCase();
    return TEXT_EXT.some(x => n.endsWith(x)) || n.includes("readme");
}

export function isLevelFile(name) {
    return /\.(gob|goo|jkl)$/i.test(name);
}

// The level's release date. texts is [{ name, text }] (text null when the
// readme couldn't be unpacked), fileDates the dates of its GOB, GOO and JKL
// files in the zip, massassi the date Massassi shows. Returns { date,
// precision ("day", "month" or "year"), source ("readme", "files",
// "massassi" or null), sort (the date to sort by), line (the readme line it
// came from), flags (what a person might look at) }.
export function releaseDate(texts, fileDates, massassi, today) {
    today = today || new Date().toISOString().slice(0, 10);
    const ok = makeOk(today);
    const fd = fileDates.filter(ok).sort();
    const fileDate = fd.length ? fd[fd.length - 1] : null;
    const labeled = [], loose = [], unread = [];
    for (const r of texts) {
        if (r.text == null) {
            unread.push(r.name);
            continue;
        }
        for (const line of r.text.split(/\r\n|\r|\n/)) {
            const m = LABEL_RE.exec(line);
            if (m) {
                let [d, prec, amb] = parseDate(m[2], true, ok);
                const ny = /^\s*(\d{1,2})[/.\-](\d{1,2})\s*$/.exec(m[2]);
                if (!d && ny && fileDate) {
                    // "3/20": no year, so the year of the files (or the one before)
                    const fy = Number(fileDate.slice(0, 4));
                    const cands = [];
                    for (const y of [fy, fy - 1])
                        for (const [mo, da] of [[Number(ny[1]), Number(ny[2])], [Number(ny[2]), Number(ny[1])]]) {
                            const c = mkDate(y, mo, da);
                            if (c) cands.push(c);
                        }
                    const near = cands.filter(c => ok(c) && c <= plusDays(fileDate, 31));
                    if (near.length) {
                        d = near.reduce((best, c) => Math.abs(days(c, fileDate)) < Math.abs(days(best, fileDate)) ? c : best);
                        prec = "day";
                        amb = false;
                    }
                }
                const label = m[1].toLowerCase().replace(/\s+/g, " ");
                if (d)
                    labeled.push({ date: d, precision: prec, alt: amb || null, label, line: line.trim().slice(0, 120), file: r.name });
                else if (m[2].trim())
                    labeled.push({ date: null, label, line: line.trim().slice(0, 120), file: r.name });
            } else {
                const [d, prec, amb] = parseDate(line, false, ok);
                if (d && prec !== "year")
                    loose.push({ date: d, precision: prec, alt: amb || null, line: line.trim().slice(0, 120), file: r.name });
            }
        }
    }
    // Release-type labels before "updated" and "date"; day before month. A
    // stable sort, as Python's.
    const good = labeled.filter(l => l.date).map((l, i) => [l, i])
        .sort((a, b) => ((RANK[a[0].label] ?? 9) - (RANK[b[0].label] ?? 9)) ||
                        ((a[0].precision !== "day") - (b[0].precision !== "day")) || (a[1] - b[1]))
        .map(x => x[0]);
    const out = { date: null, precision: null, source: null, sort: null, line: null, label: null, flags: [],
                  fileDate, how: "nothing" };
    const pick = good.length ? good[0] : (loose.length ? loose[0] : null);
    let ambiguous = false, resolved = false, hint = null;
    if (pick) {
        out.how = good.length ? "readme, labeled" : "readme, unlabeled";
        out.date = pick.date;
        out.precision = pick.precision;
        out.line = pick.line;
        out.label = pick.label || null;
        out.source = "readme";
        if (pick.alt) {
            // 5/8/99: May 8 or 5 August? The reading nearest the files' date.
            ambiguous = true;
            if (fileDate) {
                out.date = Math.abs(days(pick.alt, fileDate)) < Math.abs(days(pick.date, fileDate)) ? pick.alt : pick.date;
                resolved = true;
            }
        }
        // An unlabelled date may be "Date Started" or a version history
        // line: only when the files agree.
        if (!good.length && fileDate && Math.abs(days(out.date, fileDate)) > 31) {
            out.how = "file dates (readme date disagrees)";
            hint = out.date;
            out.date = fileDate;
            out.precision = "day";
            out.source = "files";
            ambiguous = false;
        }
    } else if (fileDate) {
        out.how = "file dates only";
        out.date = fileDate;
        out.precision = "day";
        out.source = "files";
    }
    let gap = null;
    if (out.date && fileDate) {
        if (out.precision === "month" && out.date.slice(0, 7) === fileDate.slice(0, 7))
            out.sort = fileDate; // "September 1999" and files of Sept 26: sorted as Sept 26
        gap = days(out.date, fileDate);
        if (out.precision === "month")
            gap = out.date.slice(0, 7) === fileDate.slice(0, 7) ? 0 : gap;
    }
    const bulk = massassi === "2000-06-02";
    if (out.how === "nothing" && massassi && !bulk && ok(massassi)) {
        out.how = "massassi date";
        out.date = massassi;
        out.precision = "day";
        out.source = "massassi";
    }
    if (ambiguous && !resolved) out.flags.push("dd/mm unclear");
    if (Math.abs(gap || 0) > 60) out.flags.push("readme and files disagree");
    if (massassi && !bulk && out.date && out.date > plusDays(massassi, 3)) out.flags.push("after Massassi upload");
    if (out.how.startsWith("readme, unlabeled") || hint) out.flags.push("unlabeled readme date");
    if (unread.length) out.flags.push("readme unreadable");
    out.sort = out.sort || out.date;
    out.massassiBulk = bulk;
    return out;
}
