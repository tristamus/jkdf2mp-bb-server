// The Level Library: community levels from Massassi (www.massassi.net) that a
// host picks in the game and plays. A job here copies Massassi's levels into
// an R2 bucket, slowly, and writes an index of them for each game; the page
// reads the index and gets the levels from here, never from Massassi.
//
// How it treats Massassi, as Brian (who runs it) asked, via Antonio on
// 2026-11-12: it reads the level lists and the level pages at a moderate
// rate and keeps what it read, so a game never makes Massassi do anything;
// it takes each zip from the direct address the page's 3D Preview names
// (url=), never from the Download link, so it doesn't add to the download
// counts or run Massassi's download page; and keeping copies of the files is
// fine with him. One request at a time, PACE_MS apart (30 s: the first pass
// over ~1,700 levels, with their pages, zips and screenshots, takes about two
// days), the lists again every LIST_MS, and after the first pass only what's
// new, plus each page again every REPAGE_MS in case a level was updated.
//
// The job is a Durable Object (LevelJob, SQLite storage) that runs on its
// own alarm, one request each time. The Worker's cron (scheduled() in
// lobby.js, every 10 minutes) only makes sure the alarm is set. Each level
// goes page, then zip, then screenshots, most downloaded first, multiplayer
// lists before single player, so the library is useful long before the pass
// is over. What it keeps in the bucket (LEVELS):
//
//   index/<game>.json   the levels of jk1 or mots that are ready (see index())
//   detail/<id>.json    one level's description, readmes, files and dates
//   zip/<id>.zip        the level's zip, as Massassi has it
//   shot/<id>-<n>       its screenshots, as Massassi has them
//   pv/<id>-<m>.map.json, pv/<id>-<m>.mat.json   its 3D data for map m (gzip)
//   pv/<id>.tex.json    the textures and colormaps its GOBs ship, and which
//                       of its maps have parts.json
//   pv/<id>-<m>.parts.json   the parts of map m's models that the 3D data
//                       leaves out (levels-parts.js), when it leaves any (gzip)
//
// The routes (levelsRoute, only with LEVELS and LEVELJOB bound):
//
//   GET /levels/jk1.json, /levels/mots.json
//   GET /levels/all/jk1.json, /levels/all/mots.json   with jkdf2.net's too (below)
//   GET /levels/mods/jk1.json, /levels/mods/all/jk1.json (and mots)   the mods (below)
//   GET /levels/d/<id>.json
//   GET /levels/z/<id>.zip[?h=<sha>]   immutable when h is the zip's SHA-256
//   GET /levels/s/<id>-<n>.jpg
//   GET /levels/p/<id>-<m>.map.json, .mat.json, .parts.json   the 3D data (sent gzip)
//   GET /levels/p/<id>.tex.json
//   GET /levels/status                  the job's progress, for checking on it
//
// A level's real release date comes from its readme or the dates of its
// files (levels-read.js, releaseDate), not Massassi's "Added", which is
// 2000-06-02 for ~600 levels imported in bulk that day.
//
// The 3D data comes from Massassi's 3D preview (jkview, by Stephan Reiter,
// on 3dpreview.massassi.net), which Brian said is fine to fetch, spread over
// time: for each level, after its zip and pictures, the preview's map.json
// (the level's surfaces, their texture coordinates and light, the spawn
// points) and mat.json (its textures as PNGs, with their names), once per map
// (GOB) in the zip. Taken without ownsgame=1, so it holds no art from the
// game itself: textures that come with the level are in it, the game's own
// only as blurred stand-ins, which the page swaps for the real ones from the
// player's own game files.
//
// The Mod Library's mods come the same way, from Massassi's jkmod and motsmod
// lists, in the same table and bucket, with the most downloaded of levels
// and mods first. A mod's page has no 3D Preview, so its zip's address comes
// from its Download link (/levels/download/<id>/), which Brian said is fine
// for mods (via Antonio, 2026-11-15): it adds one to the mod's download count,
// so the job asks it once for each mod (and again only if the mod's page
// later shows a zip of another size). Each mod's zip is looked into for what
// the page needs to put it into the game (levels-read.js, modPlan): which of
// its files make up the mod's folder, which GOBs are episodes, what's inside
// its GOBs, and what kind of mod it is (modKind). Mods have no 3D data. Their
// own index, so the levels' stays as it is:
//
//   index/<game>-mods.json   the mods of jk1 or mots that are ready
//
//   GET /levels/mods/jk1.json, /levels/mods/mots.json
//
// and their details, zips and screenshots go under the same keys and routes
// as a level's (Massassi numbers levels and mods together).
//
// jkdf2.net (www.jkdf2.net) is a second source, for the multiplayer levels
// Massassi doesn't have: Antonio has the permission of its owner (JKLE_Cougar,
// 2026-11-16). Its archive (/JKBot/JKArchive/, a Directory Lister site) has a
// folder for each list (DF2_LISTS), with each file's name, size and date; the
// job reads each folder once a day (DF2_LIST_MS) and takes the zips Massassi
// doesn't have: not a zip of the same name and size as one of Massassi's (the
// lists' pages say each zip's name), and not one whose GOBs are all the same
// files (SHA-256) as a level already in the library. Those levels are rows of
// their own, with ids from DF2_ID + 1 (Massassi's are far below), with their
// zip and its 3D data but no page or screenshots: Massassi's 3D preview is
// asked about their zips on jkdf2.net as about Massassi's own (Antonio, on
// 2026-11-16: "let them all be read and have 3d previews. We have
// permission."). Their title is their episode's, their author from a readme
// ("Author: ..."), their date from the readmes and files, never jkdf2.net's
// (the day it was uploaded there).
// Slowly, as Antonio asked: in turns with Massassi's work, one request at a
// time (PACE_MS apart), at most LEVELS_DF2_PER_DAY zips a day when it's set
// (none by default since 2026-11-17, DF2_PER_DAY), none over
// LEVELS_DF2_MAX_MB (DF2_MAX_MB: bigger ones wait as "big" until it's raised),
// smallest first, and for each game only once Massassi's lists' pages for it
// have all been read (so its zips' names are known). LEVELS_DF2 = "0" stops
// it, and LEVELS_DF2_SOURCE is for tests. Their index is a list of its own,
// with Massassi's levels in it too, so a game that reads <game>.json sees
// only Massassi's levels, as before:
//
//   index/<game>-all.json   both sources' levels of jk1 or mots that are ready
//
//   GET /levels/all/jk1.json, /levels/all/mots.json
//
// Each of its jkdf2.net levels has o: "jkdf2.net", and its detail says
// from: "jkdf2.net" and the zip's address there (url) in place of massassi.
//
// jkdf2.net's mods come the same way (Antonio, 2026-11-16: "We have cougar's
// permission to take anything from jkdf2.net, but we should still do it in a
// way that doesn't crash his site"): its jkmod and motsmod folders, and the
// folders inside them (skins, weapons ...; not "info", its readmes, nor the
// "prior versions" of a mod), each read once a day. They're rows like its
// levels', in the same queue (smallest first) and under the same day's count
// of zips when there is one (LEVELS_DF2_PER_DAY is for both, not each), with no 3D data. A mod
// is left out when Massassi has a zip of its name and size, when its zip is
// the same file (SHA-256) as one in the library, or when its GOBs all are
// one's. For each game they wait until Massassi's mods for it have all had
// their page and download page read, so that their zips' names are known.
// Their title is the one their readme gives ("Title: ..."), else their
// episode's or their zip's name. LEVELS_DF2_MODS = "0" stops only them. Their
// index has Massassi's mods in it too, so a game that reads <game>-mods.json
// sees only Massassi's, as before:
//
//   index/<game>-mods-all.json   both sources' mods of jk1 or mots that are ready
//
//   GET /levels/mods/all/jk1.json, /levels/mods/all/mots.json
//
// Variables (wrangler.toml): LEVELS_FETCH = "0" stops the job (what it has
// stays served); LEVELS_PREVIEW = "0" stops it getting 3D data, and
// LEVELS_PREVIEW_GB (3 when it isn't set) once it has that much of it;
// LEVELS_MAX_GB stops copying zips and pictures once the
// bucket holds that much (6 when it isn't set: the account's 10 GB a month
// of R2 without charge is shared with the screenshots); LEVELS_PACE_MS and
// LEVELS_SOURCE are for tests (a local stand-in for Massassi), and so is
// LEVELS_MEM_ZIP (the size from which a zip is read from the bucket in parts).

import { DurableObject } from "cloudflare:workers";
import { parseList, parsePage, previewMaps, gobTextures, sizeBytes, openZip, readEntry, dataStart, memReader, parseGob, parseEpisode,
         decodeText, releaseDate, isText, isLevelFile, downloadZip, modPlan, modKind, modGroup, MOD_DIRS,
         parseArchive, parseArchiveDirs, zipKey, sizeSlack, readmeAuthor, readmeTitle, readmeFirstLine, readmeDesc, nameTitle,
         modWords, df2Title } from "./levels-read.js";
import { levelParts, gobFinder } from "./levels-parts.js";
import { OFFICIAL_3DO } from "./levels-official.js";

const MASSASSI = "https://www.massassi.net";
// The lists, in the order the job works through them: multiplayer levels and
// mods first, most downloaded first, then single-player levels.
export const LISTS = [
    { cat: "jkmp", game: "jk1", kind: "mp", prio: 0 },
    { cat: "jkctf", game: "jk1", kind: "ctf", prio: 0 },
    { cat: "motsmp", game: "mots", kind: "mp", prio: 0 },
    { cat: "motskfy", game: "mots", kind: "kfy", prio: 0 },
    { cat: "jkmod", game: "jk1", kind: "mod", prio: 0, mod: true },
    { cat: "motsmod", game: "mots", kind: "mod", prio: 0, mod: true },
    { cat: "jksp", game: "jk1", kind: "sp", prio: 1 },
    { cat: "motssp", game: "mots", kind: "sp", prio: 1 },
];
// jkdf2.net's archive: its folders of multiplayer levels (not its "ai maps",
// bots for levels Massassi has), each a list of its own, and of mods, each
// with the folders inside it (subs) read as part of the list.
const DF2 = "https://www.jkdf2.net";
const DF2_ARCHIVE = DF2 + "/JKBot/JKArchive/";
export const DF2_LISTS = [
    { cat: "df2jkmp", dir: "jkmp", game: "jk1", kind: "mp", prio: 0 },
    { cat: "df2jkctf", dir: "jkctf", game: "jk1", kind: "ctf", prio: 0 },
    { cat: "df2motsmp", dir: "motsmp", game: "mots", kind: "mp", prio: 0 },
    { cat: "df2motskfy", dir: "motskfy", game: "mots", kind: "kfy", prio: 0 },
    { cat: "df2jkmod", dir: "jkmod", game: "jk1", kind: "mod", prio: 0, mod: true, subs: true },
    { cat: "df2motsmod", dir: "motsmod", game: "mots", kind: "mod", prio: 0, mod: true, subs: true },
];
// The folders inside a mods folder that aren't mods: its readmes, and older
// versions of one mod.
const DF2_SKIP_DIR = /^info$|prior versions/i;
// Its levels' ids start after this one.
export const DF2_ID = 1000000;
const isDf2 = row => row.id > DF2_ID;
const BY_CAT = Object.fromEntries(LISTS.concat(DF2_LISTS).map(l => [l.cat, l]));
const MOD_CATS = LISTS.filter(l => l.mod).map(l => l.cat);
const DF2_MOD_CATS = DF2_LISTS.filter(l => l.mod).map(l => l.cat);
const sqlList = cats => cats.map(c => `'${c}'`).join(", ");
// For SQL: Massassi's mods' lists, as a quoted list ('jkmod', 'motsmod'),
// jkdf2.net's, and both.
const MOD_SQL = sqlList(MOD_CATS);
const DF2_MOD_SQL = sqlList(DF2_MOD_CATS);
const ALL_MOD_SQL = sqlList(MOD_CATS.concat(DF2_MOD_CATS));
const isMod = row => MOD_CATS.includes(row.cat) || DF2_MOD_CATS.includes(row.cat);
const GOB_EXT = { jk1: "gob", mots: "goo" };
// The page's graphics packs (index.html, OPTIONAL_PACKS): each player's own.
const GRAPHICS_PACKS = ["jke.gob", "jkr.gob", "jk hd models.gob"];
// What the index and detail say about the files inside a mod's GOBs, at most.
const MAX_INSIDE = 8000;
export const GAMES = ["jk1", "mots"];
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PACE_MS = 30 * 1000;
const LIST_MS = 12 * HOUR;
const REPAGE_MS = 90 * DAY;
// With nothing to fetch: when to look again (a list may be due).
const IDLE_MS = 15 * MIN;
// How often the index is written while levels keep coming in.
const INDEX_MS = 10 * MIN;
// After a 429 or a 5xx from Massassi: everything waits, doubling up to 6 h.
const BACKOFF_MS = 10 * MIN, BACKOFF_MAX_MS = 6 * HOUR;
// A level whose fetch failed (not a 404) is tried again after 1, 2, 4 h, and
// is left as "error" after MAX_TRIES, until its page is read again.
const MAX_TRIES = 4;
const MAX_GB = 6;
// The 3D data's own cap (LEVELS_PREVIEW_GB): about 2 MB a level, so most of
// the library, and with the levels' 6 still inside the account's 10 GB of R2
// without charge.
const PREVIEW_GB = 3;
// Zips up to MEM_ZIP are read in memory, bigger ones from the bucket in
// parts (a Durable Object has 128 MB). Over MAX_ZIP they aren't copied.
const MEM_ZIP = 24 * 1024 * 1024;
const MAX_ZIP = 1024 * 1024 * 1024;
// A GOB is unpacked in memory (for its file list and episode.jk) up to
// MEM_GOB; a bigger one is only hashed, as it streams.
const MEM_GOB = 40 * 1024 * 1024;
// A step that made no request (step(), work()).
const LOCAL = "local";
const MAX_SHOTS = 6, MAX_SHOT = 3 * 1024 * 1024;
const MAX_PAGE = 2 * 1024 * 1024;
// Readmes kept for the library's Readme tab.
const MAX_TEXTS = 4, MAX_TEXT_IN = 1024 * 1024, MAX_TEXT_OUT = 64 * 1024;
const MAX_FILES = 500;
const UA = "Mozilla/5.0 (compatible; level-index/1.0)";
const PREVIEW = "https://3dpreview.massassi.net/level/";
// The preview's data format, as its own page asks for it.
const PREVIEW_VERSION = 14;
const MAX_PREVIEW = 64 * 1024 * 1024;
const MAX_MAPS = 4;
const DF2_LIST_MS = DAY;
// No count a day since 2026-11-17 (Antonio: "limit it to 1 every 30 seconds but not
// limit the amount per day"): PACE_MS alone sets the pace. It was 150.
const DF2_PER_DAY = null;
const DF2_MAX_MB = 32;
// A Massassi level whose zip is in one of these states has none in the
// library, so a zip of the same name on jkdf2.net is still worth having.
const MAS_LOST = ["gone", "none", "error", "bad"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lv (
    id INTEGER PRIMARY KEY,
    cat TEXT NOT NULL,
    game TEXT NOT NULL,
    prio INTEGER NOT NULL,
    rk INTEGER NOT NULL DEFAULT 0,
    title TEXT, author TEXT, added TEXT, rating REAL, votes INTEGER, comments INTEGER, dl INTEGER,
    listed_at INTEGER,
    page_at INTEGER, page_st TEXT,
    name TEXT, size_txt TEXT, mdate TEXT, descr TEXT,
    shots TEXT,
    shots_got INTEGER NOT NULL DEFAULT 0,
    zip_url TEXT, zip_at INTEGER, zip_st TEXT, zip_size INTEGER, zip_sha TEXT,
    pv_st TEXT, pv_at INTEGER, pv_maps TEXT, pv_got INTEGER NOT NULL DEFAULT 0, pv_size INTEGER NOT NULL DEFAULT 0,
    pv_tex INTEGER NOT NULL DEFAULT 0,
    info TEXT,
    tries INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, err TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

// A zip's file name from its address.
function nameOf(url) {
    const last = String(url || "").split("/").pop();
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

// The id of the Massassi level whose zip is this one of jkdf2.net (the same
// name, and the same size as far as both say), or null (massassiZips). For
// one of its mods (of, a list or a row's list), only a Massassi mod of the
// same game.
function onMassassi(mas, name, sizeTxt, of) {
    const b = sizeBytes(sizeTxt), s = sizeSlack(sizeTxt);
    for (const m of mas.get(zipKey(name)) || [])
        if ((!of || !of.mod || (m.mod && m.game === of.game)) && (!b || !m.b || Math.abs(m.b - b) <= s + m.s))
            return m.id;
    return null;
}

// A level in the index (index(), indexAll()). One of jkdf2.net's has no
// rating, downloads, Massassi date or screenshots.
function indexEntry(r, info) {
    const d = info.date || {};
    const df2 = isDf2(r);
    return {
        id: r.id, k: BY_CAT[r.cat] ? BY_CAT[r.cat].kind : r.cat, t: r.title, a: r.author,
        rel: d.d || null, rp: d.p ? d.p[0] : null, sd: d.sort && d.sort !== d.d ? d.sort : undefined,
        src: d.src ? d.src[0] : null, add: df2 ? undefined : r.mdate || r.added, sz: r.zip_size,
        r: df2 ? undefined : r.rating, v: df2 ? undefined : r.votes, dl: df2 ? undefined : r.dl,
        sh: r.shots_got, z: info.name, h: r.zip_sha,
        pv: r.pv_st === "ok" ? JSON.parse(r.pv_maps || "[]").map(m => m.n) : undefined,
        g: (info.gobs || []).map(g => ({ n: g.n, h: g.h, b: g.b, ep: g.ep || undefined, ty: g.ty || undefined,
                                          lv: g.lv && g.lv.length ? g.lv : undefined, in: g.in || undefined })),
    };
}

function hex(buf) {
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes) {
    return hex(await crypto.subtle.digest("SHA-256", bytes));
}

// A stream's SHA-256 and length, as it goes by.
function hashing() {
    const ds = typeof crypto.DigestStream === "function" ? new crypto.DigestStream("SHA-256") : null;
    const w = ds && ds.getWriter();
    const parts = [];
    let n = 0;
    const ts = new TransformStream({
        async transform(chunk, ctl) {
            n += chunk.length;
            if (w) await w.write(chunk); else parts.push(chunk);
            ctl.enqueue(chunk);
        },
        async flush() {
            if (w) await w.close();
        },
    });
    return {
        stream: ts,
        size: () => n,
        async sha() {
            if (ds) return hex(await ds.digest);
            return sha256(await new Blob(parts).arrayBuffer());
        },
    };
}

// A GOB's file table as the GOB streams by, for one too big to hold: its
// header says where the table starts, and the table runs to the end.
export function gobTable() {
    let at = 0, head = new Uint8Array(0), start = -1;
    const parts = [];
    const join = (a, b) => {
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
    };
    const stream = new TransformStream({
        transform(chunk, ctl) {
            if (head.length < 12)
                head = join(head, chunk.subarray(0, 12 - head.length));
            if (start < 0 && head.length >= 12) {
                const ok = head[0] === 0x47 && head[1] === 0x4f && head[2] === 0x42 && head[3] === 0x20;
                start = ok ? (head[8] | (head[9] << 8) | (head[10] << 16)) + head[11] * 0x1000000 : Infinity;
            }
            const end = at + chunk.length;
            if (start >= 0 && end > start && parts.reduce((n, p) => n + p.length, 0) < 8 * 1024 * 1024)
                parts.push(chunk.slice(Math.max(0, start - at)));
            at = end;
            ctl.enqueue(chunk);
        },
    });
    return {
        stream,
        files() {
            if (!(start >= 12) || !parts.length)
                return null;
            const t = new Uint8Array(new Blob(parts).size);
            let o = 0;
            for (const p of parts) {
                t.set(p, o);
                o += p.length;
            }
            // The table: a count, then 136 bytes a file (offset, size, name).
            const count = t.length >= 4 ? (t[0] | (t[1] << 8) | (t[2] << 16)) + t[3] * 0x1000000 : 0;
            const files = [];
            for (let i = 0; i < count && 4 + (i + 1) * 136 <= t.length; i++) {
                const e = 4 + i * 136;
                const size = (t[e + 4] | (t[e + 5] << 8) | (t[e + 6] << 16)) + t[e + 7] * 0x1000000;
                let name = "";
                for (let j = 0; j < 128 && t[e + 8 + j]; j++)
                    name += String.fromCharCode(t[e + 8 + j]);
                files.push({ name: name.replace(/\\/g, "/"), size });
            }
            return files;
        },
    };
}

class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} for ${url}`);
        this.status = status;
    }
}

export class LevelJob extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(SCHEMA);
        // The 3D data's columns, for a table from before them.
        for (const col of ["pv_st TEXT", "pv_at INTEGER", "pv_maps TEXT", "pv_got INTEGER NOT NULL DEFAULT 0",
                           "pv_size INTEGER NOT NULL DEFAULT 0", "pv_tex INTEGER NOT NULL DEFAULT 0",
                           "rk INTEGER NOT NULL DEFAULT 0"]) {
            try {
                this.sql.exec(`ALTER TABLE lv ADD COLUMN ${col}`);
            } catch {
                // There already.
            }
        }
        if (this.kv("pv_names") !== "2")
            this.fixPreviewNames();
        if (this.kv("ranked") !== "1")
            this.rank();
        // Once: the textures' step again for every level with 3D data, for
        // the parts of its models that the data leaves out (parts.json).
        if (this.kv("tex_v") !== "2") {
            try {
                this.sql.exec("UPDATE lv SET pv_tex = 0 WHERE pv_st = 'ok'");
            } catch {
                // A table too old to have them (only in tests).
            }
            this.kv("tex_v", 2);
        }
        // Once: the 3D data asked for again for each level that went without
        // it, its zip in hand and not a mod. Its map was asked for before
        // the preview's page was opened, and a zip on jkdf2.net isn't found
        // that way (readPreview).
        if (this.kv("pv_again") !== "1") {
            try {
                this.sql.exec(`UPDATE lv SET pv_st = NULL, pv_at = NULL, pv_maps = NULL, pv_got = 0, pv_size = 0
                               WHERE pv_st = 'none' AND zip_st = 'ok' AND cat NOT IN (${ALL_MOD_SQL})`);
            } catch {
                // A table too old to have them (only in tests).
            }
            this.kv("pv_again", 1);
        }
        // Once: Massassi's mods that had nothing for the game (files loose
        // in their zip, outside the game's folders) read again, now that
        // modPlan places such files by their kind (typed).
        if (this.kv("typed_plan") !== "1") {
            try {
                this.sql.exec(`UPDATE lv SET zip_st = NULL, tries = 0, retry_at = NULL, err = NULL
                               WHERE zip_st = 'nomod' AND id <= ${DF2_ID} AND zip_url IS NOT NULL`);
            } catch {
                // A table too old to have them (only in tests).
            }
            this.kv("typed_plan", 1);
        }
    }

    // Each level's place in its own game's list (and priority), most
    // downloaded first: the job works down both games' lists side by side,
    // so Mysteries of the Sith's levels don't wait for all of Jedi Knight's,
    // whose levels have more downloads. Set again after each list is read.
    // jkdf2.net's levels have no downloads to go by: a list of their own for
    // each game, smallest zip first.
    rank() {
        let rows;
        try {
            rows = this.sql.exec("SELECT id, game, prio, dl, size_txt FROM lv").toArray();
        } catch {
            // A table too old to have them (only in tests): nothing to rank.
            return;
        }
        rows.sort((a, b) => (isDf2(a) - isDf2(b)) ||
                            (isDf2(a) ? (sizeBytes(a.size_txt) || 0) - (sizeBytes(b.size_txt) || 0) : (b.dl || 0) - (a.dl || 0)) ||
                            a.id - b.id);
        const next = {};
        for (const r of rows) {
            const k = r.game + "/" + r.prio + (isDf2(r) ? "/df2" : "");
            next[k] = (next[k] || 0) + 1;
            this.sql.exec("UPDATE lv SET rk = ? WHERE id = ? AND rk != ?", next[k] - 1, r.id, next[k] - 1);
        }
        this.kv("ranked", 1);
    }

    // Once, for 3D data copied before the map names were the levels': the
    // job then named the one map of a zip with one GOB after the GOB, and
    // took only its first level. A GOB of one level gets that level's name
    // (its map is the right one); one of more levels is asked for again,
    // from the preview's page, which lists them.
    fixPreviewNames() {
        let changed = false, rows = [];
        try {
            rows = this.sql.exec("SELECT id, info, pv_maps FROM lv WHERE pv_maps IS NOT NULL").toArray();
        } catch {
            // A table without them: nothing copied yet.
        }
        for (const row of rows) {
            let maps, gobs;
            try {
                maps = JSON.parse(row.pv_maps);
                gobs = (JSON.parse(row.info || "{}").gobs || []).filter(g => g.ep || (g.lv && g.lv.length));
            } catch {
                continue;
            }
            if (gobs.length !== 1 || !Array.isArray(maps) || maps.length !== 1 || maps[0].e !== 0 ||
                maps[0].n !== String(gobs[0].n || "").replace(/\.go[bo]$/i, ""))
                continue;
            const lv = gobs[0].lv || [];
            if (lv.length === 1) {
                const n = lv[0].replace(/\.jkl$/i, "");
                if (n === maps[0].n)
                    continue;
                this.sql.exec("UPDATE lv SET pv_maps = ? WHERE id = ?", JSON.stringify([{ n, e: 0 }]), row.id);
            } else {
                this.sql.exec("UPDATE lv SET pv_st = NULL, pv_at = NULL, pv_maps = NULL, pv_got = 0, pv_size = 0 WHERE id = ?", row.id);
            }
            changed = true;
        }
        this.kv("pv_names", 2);
        if (changed)
            this.dirty();
    }

    kv(k, v) {
        if (v === undefined) {
            const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
            return r ? r.v : null;
        }
        this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
    }

    pace() {
        return Number(this.env.LEVELS_PACE_MS) || PACE_MS;
    }

    on() {
        return this.env.LEVELS_FETCH !== "0" && !!this.env.LEVELS;
    }

    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/kick") {
            if (this.on() && !(await this.ctx.storage.getAlarm()))
                await this.ctx.storage.setAlarm(Date.now() + 1000);
            return Response.json({ ok: true });
        }
        if (path === "/status")
            return Response.json(await this.status());
        return new Response("Not found", { status: 404 });
    }

    async alarm() {
        if (!this.on())
            return;
        const start = Date.now();
        let next = start + this.pace();
        try {
            const wait = Number(this.kv("backoff_until") || 0);
            if (wait > start) {
                next = wait;
            } else {
                const did = await this.step(start);
                if (!did) {
                    await this.index(true);
                    next = start + IDLE_MS;
                } else {
                    await this.index(false);
                    // Work in the bucket alone doesn't wait the pace.
                    if (did === LOCAL)
                        next = start + 1000;
                }
            }
        } catch (e) {
            this.kv("last_error", `${new Date().toISOString()} ${e && e.message || e}`);
            console.log("levels: job failed:", e && e.stack || e);
        } finally {
            await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
        }
    }

    // One request to Massassi or jkdf2.net, or none when there's nothing to
    // do (false). jkdf2.net's levels go in turns with Massassi's work.
    async step(now) {
        const list = LISTS.find(l => Number(this.kv("list_at:" + l.cat) || 0) + LIST_MS <= now);
        if (list) {
            await this.guard(() => this.readList(list, now));
            return true;
        }
        const df2 = this.df2On() && Number(this.kv("df2_backoff_until") || 0) <= now;
        const df2Folder = df2 && this.df2Folders().find(f => Number(this.kv("list_at:" + f.key) || 0) + DF2_LIST_MS <= now);
        if (df2Folder) {
            await this.guard(() => this.readDf2List(df2Folder.list, now, df2Folder), null, true);
            return true;
        }
        const full = await this.full();
        const mas = this.sql.exec(
            `SELECT * FROM lv WHERE (retry_at IS NULL OR retry_at <= ?) AND (
                 (id <= ${DF2_ID} AND page_at IS NULL)
                 OR (id <= ${DF2_ID} AND page_st = 'ok' AND zip_st IS NULL AND (zip_url IS NOT NULL OR cat IN (${MOD_SQL})) AND ? = 0)
                 OR (page_st = 'ok' AND zip_st = 'ok' AND shots_got < json_array_length(shots) AND ? = 0)
                 OR (page_st = 'ok' AND zip_st = 'ok' AND shots_got >= json_array_length(COALESCE(shots, '[]'))
                     AND pv_st IS NULL AND zip_url IS NOT NULL AND ? = 0)
                 OR (pv_st = 'ok' AND pv_tex = 0 AND ? = 0))
             ORDER BY prio, rk, dl DESC, id LIMIT 1`, now, full ? 1 : 0, full ? 1 : 0,
            full || this.env.LEVELS_PREVIEW === "0" || this.previewFull() ? 1 : 0, this.env.LEVELS_PREVIEW === "0" ? 1 : 0).toArray()[0];
        // jkdf2.net's zips in turns with the rest (their 3D data is the
        // rest's: from Massassi's preview).
        const other = df2 && !full ? this.df2Next(now) : null;
        const row = other && (!mas || this.kv("df2_turn") === "1") ? other : mas;
        if (row) {
            this.kv("df2_turn", row === other ? 0 : 1);
            let local = false;
            await this.guard(async () => {
                local = await this.work(row, now) === LOCAL;
            }, row, row === other);
            this.kv("steps", Number(this.kv("steps") || 0) + 1);
            return local ? LOCAL : true;
        }
        // Each page again now and then: a level updated on Massassi.
        const old = this.sql.exec(
            `SELECT * FROM lv WHERE id <= ${DF2_ID} AND page_at IS NOT NULL AND page_at <= ? ORDER BY page_at LIMIT 1`,
            now - REPAGE_MS).toArray()[0];
        if (old) {
            await this.guard(() => this.readPage(old, now), old);
            return true;
        }
        return false;
    }

    // jkdf2.net's next zip, if it's due: under the day's count (levels and
    // mods together), and for a game whose Massassi levels have all had their
    // page read (a level), or whose Massassi mods have all had their page and
    // download page read (a mod), so that the zips it already has from
    // Massassi are known by name.
    df2Next(now) {
        const cap = this.df2PerDay();
        if (cap != null && this.df2Today() >= cap)
            return null;
        const waiting = sql => this.sql.exec(`SELECT DISTINCT game FROM lv WHERE id <= ${DF2_ID} AND ${sql}`).toArray().map(r => r.game);
        const levelGames = GAMES.filter(g => !waiting(`prio = 0 AND cat NOT IN (${MOD_SQL}) AND page_at IS NULL`).includes(g));
        const modGames = this.df2ModsOn() ? GAMES.filter(g => !waiting(
            `cat IN (${MOD_SQL}) AND (page_at IS NULL OR (page_st = 'ok' AND zip_st IS NULL AND zip_url IS NULL))`).includes(g)) : [];
        const games = list => list.map(g => `'${g}'`).join(", ");
        const which = [];
        if (levelGames.length)
            which.push(`(cat NOT IN (${DF2_MOD_SQL}) AND game IN (${games(levelGames)}))`);
        if (modGames.length)
            which.push(`(cat IN (${DF2_MOD_SQL}) AND game IN (${games(modGames)}))`);
        if (!which.length)
            return null;
        return this.sql.exec(
            `SELECT * FROM lv WHERE id > ${DF2_ID} AND page_st = 'ok' AND zip_st IS NULL AND zip_url IS NOT NULL
                 AND (retry_at IS NULL OR retry_at <= ?) AND (${which.join(" OR ")})
             ORDER BY rk, id LIMIT 1`, now).toArray()[0] || null;
    }

    // jkdf2.net's folders the job reads, each once a day: each list's own,
    // and for a mods list the folders found inside it (kept from its last
    // read), each { list, dir, key }, key naming it in the kv.
    df2Folders() {
        const out = [];
        for (const list of DF2_LISTS) {
            if (list.mod && !this.df2ModsOn())
                continue;
            out.push({ list, dir: list.dir, key: list.cat });
            if (!list.subs)
                continue;
            for (const d of this.df2Subs(list))
                out.push({ list, dir: d.dir, key: list.cat + "/" + d.name, sub: d.name });
        }
        return out;
    }

    df2ModsOn() {
        return this.env.LEVELS_DF2_MODS !== "0";
    }

    df2On() {
        return this.env.LEVELS_DF2 !== "0";
    }

    // The most zips a day from jkdf2.net, or null for no such count.
    df2PerDay() {
        const v = this.env.LEVELS_DF2_PER_DAY;
        return v != null && v !== "" && Number(v) >= 0 ? Number(v) : DF2_PER_DAY;
    }

    df2MaxBytes() {
        return (Number(this.env.LEVELS_DF2_MAX_MB) || DF2_MAX_MB) * 1024 * 1024;
    }

    // jkdf2.net's zips asked for today (UTC).
    df2Today() {
        return this.kv("df2_day") === new Date().toISOString().slice(0, 10) ? Number(this.kv("df2_today") || 0) : 0;
    }

    async work(row, now) {
        if (row.page_at == null)
            return this.readPage(row, now);
        if (row.zip_st == null)
            return row.zip_url ? this.readZip(row, now) : this.readDownload(row, now);
        if (row.shots_got < JSON.parse(row.shots || "[]").length)
            return this.readShot(row, now);
        if (row.pv_st === "ok")
            return this.readTextures(row, now);
        return this.readPreview(row, now);
    }

    // Runs one fetch and settles what a failure means. Massassi busy or
    // away (429, a 5xx, no answer): everything waits, and the level isn't
    // charged a try. Anything else about one level: that level waits, and
    // after MAX_TRIES is left until its page is read again (REPAGE_MS).
    // jkdf2.net busy or away (df2: the request was to it): only its work waits.
    async guard(fn, row, df2) {
        const pre = df2 ? "df2_" : "";
        try {
            await fn();
            this.kv(pre + "fails", 0);
        } catch (e) {
            const status = e instanceof HttpError ? e.status : 0;
            const why = String(e && e.message || e).slice(0, 300);
            this.kv("last_error", `${new Date().toISOString()} ${row ? "level " + row.id + ": " : ""}${why}`);
            // The 3D preview failing on one level (its converter can't read
            // it, say) is that level's, not Massassi being busy.
            if (status === 429 || (status >= 500 && !e.preview) || e.network || !row) {
                const fails = Number(this.kv(pre + "fails") || 0) + 1;
                this.kv(pre + "fails", fails);
                const after = Number(e.retryAfter) > 0 ? Number(e.retryAfter) * 1000 : 0;
                this.kv(pre + "backoff_until", Date.now() + Math.max(after, Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (fails - 1))));
                return;
            }
            const tries = row.tries + 1;
            // The preview's converter failing on a level fails the same way
            // again: two tries, not four.
            if (tries < (e.preview ? 2 : MAX_TRIES)) {
                this.sql.exec("UPDATE lv SET tries = ?, retry_at = ?, err = ? WHERE id = ?",
                              tries, Date.now() + HOUR * 2 ** (tries - 1), why, row.id);
            } else if (row.page_at == null) {
                this.sql.exec("UPDATE lv SET page_at = ?, page_st = 'error', tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              Date.now(), why, row.id);
            } else if (row.zip_st == null) {
                this.sql.exec("UPDATE lv SET zip_st = 'error', zip_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              Date.now(), why, row.id);
            } else if (row.pv_st === "ok") {
                // The textures' list failed: the 3D view goes with the preview's own.
                this.sql.exec("UPDATE lv SET pv_tex = 2, tries = 0, retry_at = NULL, err = ? WHERE id = ?", why, row.id);
            } else if (row.shots_got >= JSON.parse(row.shots || "[]").length) {
                this.sql.exec("UPDATE lv SET pv_st = 'error', pv_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              Date.now(), why, row.id);
            } else {
                // A picture that won't come: the level goes without it.
                const list = JSON.parse(row.shots || "[]");
                list.splice(row.shots_got, 1);
                this.sql.exec("UPDATE lv SET shots = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              JSON.stringify(list), why, row.id);
            }
            this.dirty();
        }
    }

    async get(url, max) {
        const src = this.env.LEVELS_SOURCE, psrc = this.env.LEVELS_PREVIEW_SOURCE, dsrc = this.env.LEVELS_DF2_SOURCE;
        const real = url.startsWith(PREVIEW) ? (psrc ? psrc + url.slice(PREVIEW.length) : url)
                   : url.startsWith(DF2 + "/") ? (dsrc ? dsrc + url.slice(DF2.length) : url)
                   : src ? url.replace(MASSASSI, src) : url;
        this.count();
        let res;
        try {
            res = await fetch(real, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "manual" });
        } catch (e) {
            throw Object.assign(new Error(`no answer for ${url}: ${e && e.message || e}`), { network: true });
        }
        if (res.status !== 200) {
            if (res.body) await res.body.cancel();
            throw Object.assign(new HttpError(res.status, url), { retryAfter: res.headers.get("Retry-After") });
        }
        const len = Number(res.headers.get("Content-Length") || 0);
        if (max && len > max) {
            await res.body.cancel();
            throw Object.assign(new Error(`too big (${len} bytes)`), { tooBig: true });
        }
        return res;
    }

    // Requests made today (UTC), for the status.
    count() {
        const day = new Date().toISOString().slice(0, 10);
        if (this.kv("req_day") !== day) {
            this.kv("req_day", day);
            this.kv("req_today", 0);
        }
        this.kv("req_today", Number(this.kv("req_today") || 0) + 1);
        this.kv("req_total", Number(this.kv("req_total") || 0) + 1);
    }

    async readList(list, now) {
        const url = `${MASSASSI}/levels/${list.cat}/?num=9999`;
        let html;
        try {
            html = await (await this.get(url, MAX_PAGE * 4)).text();
        } catch (e) {
            // Tried again in an hour, not at once.
            this.kv("list_at:" + list.cat, now - LIST_MS + HOUR);
            throw e;
        }
        const rows = parseList(html);
        this.kv("list_at:" + list.cat, now);
        this.kv("list_n:" + list.cat, rows.length);
        // None at all most likely means Massassi's page changed: nothing is
        // taken off (the job never takes levels off), and it shows in the status.
        if (!rows.length)
            this.kv("last_error", `${new Date().toISOString()} no levels in the ${list.cat} list (has its page changed?)`);
        for (const r of rows)
            this.sql.exec(
                `INSERT INTO lv (id, cat, game, prio, title, author, added, rating, votes, comments, dl, listed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET cat = excluded.cat, game = excluded.game, prio = excluded.prio,
                     title = excluded.title, author = excluded.author, added = excluded.added, rating = excluded.rating,
                     votes = excluded.votes, comments = excluded.comments, dl = excluded.dl, listed_at = excluded.listed_at`,
                r.id, list.cat, list.game, list.prio, r.title, r.author, r.added, r.rating, r.votes, r.comments, r.dl, now);
        this.rank();
        this.dirty();
    }

    // One of jkdf2.net's folders (DF2_LISTS, df2Folders): a row for each zip
    // in it that Massassi doesn't have (by name and size, massassiZips), and
    // that isn't a second copy in jkdf2.net's archive ("x[1].zip", or another
    // folder). A zip of another size than before is read again; one that has
    // since turned out to be Massassi's is left ("dupe"). A mods list's own
    // folder also says which folders are inside it.
    async readDf2List(list, now, folder) {
        const f0 = folder || { list, dir: list.dir, key: list.cat };
        const key = f0.key;
        const url = `${DF2_ARCHIVE}?dir=JKDF2/JKDF2/Game%20Files/${f0.dir}`;
        let html;
        try {
            html = await (await this.get(url, MAX_PAGE * 8)).text();
        } catch (e) {
            // A folder inside one that's gone from the archive: not asked for again.
            if (f0.sub && e instanceof HttpError && (e.status === 404 || e.status === 410)) {
                this.setDf2Subs(list, this.df2Subs(list).filter(d => d.dir !== f0.dir));
                return;
            }
            this.kv("list_at:" + key, now - DF2_LIST_MS + HOUR);
            throw e;
        }
        const files = parseArchive(html).filter(f => /\.zip$/i.test(f.name));
        this.kv("list_at:" + key, now);
        this.kv("list_n:" + key, files.length);
        if (list.subs && !f0.sub)
            this.setDf2Subs(list, parseArchiveDirs(html, list.dir).filter(d => !DF2_SKIP_DIR.test(d.name)));
        // A folder inside may hold no zips at all; the list's own shouldn't.
        if (!files.length && !f0.sub)
            this.kv("last_error", `${new Date().toISOString()} no zips in jkdf2.net's ${list.dir} folder (has its page changed?)`);
        const mas = this.massassiZips();
        const rows = this.sql.exec(`SELECT id, zip_url, size_txt, zip_st FROM lv WHERE id > ${DF2_ID}`).toArray();
        const have = new Map(rows.map(r => [r.zip_url, r]));
        const copies = new Set(rows.map(r => zipKey(nameOf(r.zip_url)) + "|" + r.size_txt));
        let next = rows.reduce((n, r) => Math.max(n, r.id), DF2_ID) + 1;
        let same = 0, twice = 0;
        const max = this.df2MaxBytes();
        for (const f of files) {
            const zip = DF2_ARCHIVE + f.href;
            const onMas = onMassassi(mas, f.name, f.size, list);
            const row = have.get(zip);
            if (row) {
                // A new file there, or one that waited for the size cap.
                const again = row.size_txt !== f.size || (row.zip_st === "big" && sizeBytes(f.size) <= max);
                if (onMas && (row.zip_st == null || again))
                    this.sql.exec("UPDATE lv SET size_txt = ?, zip_st = 'dupe', zip_at = ?, info = ? WHERE id = ?",
                                  f.size, now, JSON.stringify({ name: f.name, mas: onMas }), row.id);
                else if (again && !onMas)
                    this.sql.exec(`UPDATE lv SET size_txt = ?, mdate = ?, zip_st = NULL, tries = 0, retry_at = NULL, err = NULL
                                   WHERE id = ?`, f.size, f.date && f.date.slice(0, 10), row.id);
                this.sql.exec("UPDATE lv SET listed_at = ? WHERE id = ?", now, row.id);
                continue;
            }
            if (onMas) {
                same++;
                continue;
            }
            const k = zipKey(f.name) + "|" + f.size;
            if (copies.has(k)) {
                twice++;
                continue;
            }
            copies.add(k);
            this.sql.exec(
                `INSERT INTO lv (id, cat, game, prio, title, author, dl, listed_at, page_at, page_st, name, size_txt, mdate, descr, shots, zip_url)
                 VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, 'ok', ?, ?, ?, '', '[]', ?)`,
                next++, list.cat, list.game, list.prio, df2Title(null, f.name), now, now, f.name, f.size,
                f.date && f.date.slice(0, 10), zip);
        }
        this.kv("list_same:" + key, same);
        this.kv("list_twice:" + key, twice);
        this.rank();
        this.dirty();
    }

    // The folders inside a mods list's folder, as its last read found them.
    df2Subs(list) {
        try {
            return JSON.parse(this.kv("df2_subs:" + list.cat) || "[]");
        } catch {
            return [];
        }
    }

    setDf2Subs(list, subs) {
        this.kv("df2_subs:" + list.cat, JSON.stringify(subs.map(d => ({ name: d.name, dir: d.dir }))));
    }

    // The zips of Massassi's levels and mods, by name (zipKey): [{ id, b, s }]
    // with their size in bytes (b, null when not known) and how far off that
    // can be (s). Only those whose zip is or will be in the library.
    massassiZips() {
        const out = new Map();
        const rows = this.sql.exec(
            `SELECT id, cat, game, zip_url, zip_size, zip_st, size_txt, json_extract(info, '$.name') AS n FROM lv
             WHERE id <= ${DF2_ID} AND zip_url IS NOT NULL AND COALESCE(zip_st, '') NOT IN (${MAS_LOST.map(s => `'${s}'`).join(", ")})`)
            .toArray();
        for (const r of rows) {
            const k = zipKey(r.n || nameOf(r.zip_url));
            if (!k)
                continue;
            const got = r.zip_size != null && r.zip_st != null;
            const m = { id: r.id, b: got ? r.zip_size : sizeBytes(r.size_txt), s: got ? 0 : sizeSlack(r.size_txt),
                        game: r.game, mod: isMod(r) };
            if (!out.has(k))
                out.set(k, []);
            out.get(k).push(m);
        }
        return out;
    }

    async readPage(row, now) {
        let p;
        try {
            p = parsePage(await (await this.get(`${MASSASSI}/levels/files/${row.id}.shtml`, MAX_PAGE)).text(), row.id);
        } catch (e) {
            if (e instanceof HttpError && (e.status === 404 || e.status === 410)) {
                this.sql.exec("UPDATE lv SET page_at = ?, page_st = 'gone', tries = 0, retry_at = NULL, err = NULL WHERE id = ?", now, row.id);
                this.dirty();
                return;
            }
            throw e;
        }
        const shots = JSON.stringify(p.shots.slice(0, MAX_SHOTS));
        // A new address, or a zip of another size: the zip again. A mod's
        // address comes from its download page (readDownload), asked again
        // only for a zip of another size, since each time counts a download.
        const mod = isMod(row);
        const sized = row.size_txt && row.size_txt !== p.size;
        const again = mod ? !!sized : row.zip_url !== p.zip || sized;
        const zip = mod ? (sized ? null : row.zip_url) : p.zip;
        this.sql.exec(
            `UPDATE lv SET page_at = ?, page_st = 'ok', name = ?, size_txt = ?, mdate = ?, descr = ?,
                 title = COALESCE(NULLIF(?, ''), title), author = COALESCE(NULLIF(?, ''), author),
                 zip_url = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?`,
            now, p.name, p.size, p.date, p.desc, p.title, p.author, zip, row.id);
        if (again || row.zip_st == null || row.zip_st === "error" || row.zip_st === "full") {
            this.sql.exec("UPDATE lv SET zip_st = ?, shots = ?, shots_got = 0, pv_st = NULL, pv_maps = NULL, pv_got = 0, pv_size = 0, pv_tex = 0 WHERE id = ?",
                          zip || mod ? null : "none", shots, row.id);
        } else if (shots !== row.shots) {
            this.sql.exec("UPDATE lv SET shots = ?, shots_got = 0 WHERE id = ?", shots, row.id);
        }
        // The description is in the level's detail: written again if it changed.
        if (!again && row.zip_st === "ok" && p.desc !== row.descr)
            await this.patchDetail(row.id, { desc: p.desc });
        this.dirty();
    }

    // A mod's zip address, from its download page (/levels/download/<id>/),
    // which counts a download on Massassi: so once for each mod, and the
    // count of them is in the status.
    async readDownload(row, now) {
        const declared = sizeBytes(row.size_txt);
        if (declared && declared > MAX_ZIP) {
            this.sql.exec("UPDATE lv SET zip_st = 'big', zip_at = ? WHERE id = ?", now, row.id);
            return;
        }
        const max = (Number(this.env.LEVELS_MAX_GB) || MAX_GB) * 1e9;
        if (declared && this.stored() + declared > max) {
            this.sql.exec("UPDATE lv SET zip_st = 'full', zip_at = ? WHERE id = ?", now, row.id);
            return;
        }
        let html;
        try {
            this.kv("download_pages", Number(this.kv("download_pages") || 0) + 1);
            html = await (await this.get(`${MASSASSI}/levels/download/${row.id}/`, MAX_PAGE)).text();
        } catch (e) {
            if (e instanceof HttpError && (e.status === 404 || e.status === 410 || e.status === 403)) {
                this.sql.exec("UPDATE lv SET zip_st = 'gone', zip_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              now, e.message, row.id);
                this.dirty();
                return;
            }
            throw e;
        }
        const zip = downloadZip(html);
        if (!zip) {
            this.sql.exec("UPDATE lv SET zip_st = 'none', zip_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                          now, "no zip address on its download page", row.id);
            this.dirty();
            return;
        }
        this.sql.exec("UPDATE lv SET zip_url = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", zip, row.id);
    }

    async patchDetail(id, fields) {
        const obj = await this.env.LEVELS.get(`detail/${id}.json`);
        if (!obj)
            return;
        const d = Object.assign(await obj.json(), fields);
        await this.env.LEVELS.put(`detail/${id}.json`, JSON.stringify(d), { httpMetadata: { contentType: "application/json" } });
    }

    // What the bucket holds for the levels themselves (zips and pictures), as
    // the job counts it: LEVELS_MAX_GB. The 3D data has a cap of its own
    // (previewBytes, LEVELS_PREVIEW_GB), so it never takes the levels' room.
    stored() {
        const r = this.sql.exec("SELECT COALESCE(SUM(zip_size), 0) AS n FROM lv WHERE zip_st = 'ok'").toArray()[0];
        return r.n + Number(this.kv("shot_bytes") || 0);
    }

    previewBytes() {
        return this.sql.exec("SELECT COALESCE(SUM(pv_size), 0) AS n FROM lv").toArray()[0].n;
    }

    previewFull() {
        return this.previewBytes() >= (Number(this.env.LEVELS_PREVIEW_GB) || PREVIEW_GB) * 1e9;
    }

    async full() {
        const max = Number(this.env.LEVELS_MAX_GB) || MAX_GB;
        return this.stored() >= max * 1e9;
    }

    async readZip(row, now) {
        const df2 = isDf2(row);
        const declared = sizeBytes(row.size_txt);
        const cap = df2 ? Math.min(MAX_ZIP, this.df2MaxBytes()) : MAX_ZIP;
        if (declared && declared > cap) {
            this.sql.exec("UPDATE lv SET zip_st = 'big', zip_at = ? WHERE id = ?", now, row.id);
            return df2 ? LOCAL : undefined;
        }
        const max = (Number(this.env.LEVELS_MAX_GB) || MAX_GB) * 1e9;
        if (declared && this.stored() + declared > max) {
            this.sql.exec("UPDATE lv SET zip_st = 'full', zip_at = ? WHERE id = ?", now, row.id);
            return df2 ? LOCAL : undefined;
        }
        if (df2) {
            // Massassi's, by name, since its list was read: not asked for.
            const onMas = onMassassi(this.massassiZips(), row.name, row.size_txt, BY_CAT[row.cat]);
            if (onMas) {
                this.sql.exec("UPDATE lv SET zip_st = 'dupe', zip_at = ?, info = ? WHERE id = ?",
                              now, JSON.stringify({ name: row.name, mas: onMas }), row.id);
                this.dirty();
                return LOCAL;
            }
            const day = new Date().toISOString().slice(0, 10);
            if (this.kv("df2_day") !== day) {
                this.kv("df2_day", day);
                this.kv("df2_today", 0);
            }
            this.kv("df2_today", Number(this.kv("df2_today") || 0) + 1);
            this.kv("df2_total", Number(this.kv("df2_total") || 0) + 1);
        }
        let res;
        try {
            res = await this.get(row.zip_url, df2 ? cap + sizeSlack(row.size_txt) : MAX_ZIP);
        } catch (e) {
            if (e.tooBig) {
                this.sql.exec("UPDATE lv SET zip_st = 'big', zip_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", now, row.id);
                this.dirty();
                return;
            }
            if (e instanceof HttpError && (e.status === 404 || e.status === 410 || e.status === 403)) {
                this.sql.exec("UPDATE lv SET zip_st = 'gone', zip_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              now, e.message, row.id);
                this.dirty();
                return;
            }
            throw e;
        }
        const key = `zip/${row.id}.zip`;
        const name = nameOf(row.zip_url);
        const len = Number(res.headers.get("Content-Length") || 0);
        const memZip = Number(this.env.LEVELS_MEM_ZIP) || MEM_ZIP;
        let zip, sha, size;
        if (len && len > memZip) {
            // Into the bucket as it comes, then read from there in parts.
            const h = hashing();
            const body = typeof FixedLengthStream === "function"
                ? res.body.pipeThrough(h.stream).pipeThrough(new FixedLengthStream(len)) : res.body.pipeThrough(h.stream);
            await this.env.LEVELS.put(key, body, { httpMetadata: { contentType: "application/zip" } });
            sha = await h.sha();
            size = h.size();
            zip = { size, read: async (at, n) => {
                const o = await this.env.LEVELS.get(key, { range: { offset: at, length: Math.max(0, Math.min(n, size - at)) } });
                return new Uint8Array(await o.arrayBuffer());
            }, stream: async (at, n) => (await this.env.LEVELS.get(key, { range: { offset: at, length: n } })).body };
        } else {
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length > MEM_ZIP * 2)
                throw new Error("too big without a Content-Length");
            sha = await sha256(bytes);
            size = bytes.length;
            zip = memReader(bytes);
            zip.stream = async (at, n) => new Blob([bytes.subarray(at, at + n)]).stream();
            zip.bytes = bytes;
        }
        // jkdf2.net's: not kept when it's the very zip (SHA-256) of one the
        // library has under another name.
        const sameZip = df2 ? this.sql.exec("SELECT id FROM lv WHERE zip_st = 'ok' AND zip_sha = ? AND id != ? ORDER BY id LIMIT 1",
                                            sha, row.id).toArray()[0] : null;
        if (sameZip) {
            if (!zip.bytes)
                await this.env.LEVELS.delete(key);
            this.sql.exec(
                `UPDATE lv SET zip_st = 'dupe', zip_at = ?, zip_size = ?, zip_sha = ?, info = ?, pv_st = 'none', pv_at = ?,
                     tries = 0, retry_at = NULL, err = NULL WHERE id = ?`,
                now, size, sha, JSON.stringify({ name, same_zip: sameZip.id }), now, row.id);
            this.dirty();
            return;
        }
        let found;
        try {
            found = await this.lookInside(zip, row);
        } catch (e) {
            found = { bad: String(e && e.message || e) };
        }
        // jkdf2.net's: not kept when its GOBs are all a level (or for a mod, a
        // mod) the library already has (Massassi's, or an earlier copy on
        // jkdf2.net).
        const same = df2 && !found.bad ? this.sameGobs(row.id, found.gobs, isMod(row)) : null;
        if (same) {
            if (!zip.bytes)
                await this.env.LEVELS.delete(key);
            this.sql.exec(
                `UPDATE lv SET zip_st = 'dupe', zip_at = ?, zip_size = ?, zip_sha = ?, info = ?, pv_st = 'none', pv_at = ?,
                     tries = 0, retry_at = NULL, err = NULL WHERE id = ?`,
                now, size, sha, JSON.stringify({ name, same, gobs: found.gobs.map(g => ({ n: g.name, h: g.sha, b: g.size })) }),
                now, row.id);
            this.dirty();
            return;
        }
        if (df2 && !found.bad) {
            // Its own title (its episode's) and author (its readme's). A mod's
            // title is its readme's "Title:", else its episode's (when it's
            // only that one episode), else its
            // readme's first line when that looks like a title, else its
            // zip's name; its description is its readme's "Description:".
            const texts = found.texts.map(t => ({ text: t.t }));
            const ep = found.gobs.find(g => g.ep);
            if (isMod(row)) {
                // An episode's title names the mod only when it's all the mod is.
                const one = found.gobs.length === 1 && ep;
                const t = readmeTitle(texts), e = one && df2Title(ep.ep, ""), l = readmeFirstLine(texts);
                row.title = t || (e && e !== "Untitled" ? e : null) || l || nameTitle(name);
                found.mod.titleFrom = t ? "readme" : e && e !== "Untitled" ? "episode" : l ? "line" : "zip";
                row.descr = readmeDesc(texts) || "";
            } else {
                row.title = df2Title(ep && ep.ep, name);
            }
            row.author = readmeAuthor(texts) || "";
            this.sql.exec("UPDATE lv SET title = ?, author = ?, descr = ? WHERE id = ?", row.title, row.author, row.descr || "", row.id);
        }
        if (zip.bytes)
            await this.env.LEVELS.put(key, zip.bytes, { httpMetadata: { contentType: "application/zip" },
                                                      customMetadata: { sha256: sha, name } });
        const mod = isMod(row);
        // A mod is ready when the game gets something from it: a file for
        // its folder or an episode. One that is only a program, say, isn't.
        const status = found.bad ? "bad" : mod ? (found.plan.files.length || found.plan.episodes.length ? "ok" : "nomod")
                                             : found.gobs.length ? "ok" : "nolevel";
        const info = found.bad ? { bad: found.bad } : {
            gobs: found.gobs.map(g => ({ n: g.name, h: g.sha, b: g.size, ep: g.ep, ty: g.ty, lv: g.lv, in: g.inner })),
            date: { d: found.date.date, p: found.date.precision, src: found.date.source, sort: found.date.sort,
                    flags: found.date.flags },
        };
        info.name = name;
        if (!found.bad && mod)
            info.mod = { k: found.mod.kind, n: found.mod.files, ep: found.mod.eps.length, x: found.mod.programs.length,
                         gp: found.mod.pack || undefined, in: found.plan.inner || undefined,
                         // Placed by the kind of each file (modPlan's typed).
                         ty: found.plan.typed || undefined,
                         // jkdf2.net's: what names it, and its files' names, to find it by.
                         tf: df2 ? found.mod.titleFrom : undefined, f: df2 ? found.mod.words : undefined };
        if (!found.bad) {
            const detail = {
                id: row.id, title: row.title, author: row.author, desc: row.descr || "",
                massassi: df2 ? undefined : `${MASSASSI}/levels/files/${row.id}.shtml`,
                from: df2 ? "jkdf2.net" : undefined, url: df2 ? row.zip_url : undefined, zip: name, size, sha256: sha,
                date: found.date, files: found.files, texts: found.texts, gobs: info.gobs,
            };
            if (mod)
                detail.mod = {
                    kind: found.mod.kind, pack: found.mod.pack, episodes: found.mod.eps, programs: found.mod.programs,
                    // How the page puts it into the game (modPlan): the zip's
                    // entries for the mod's folder, with their place there,
                    // and the episode GOBs, in the inner zip when there's one.
                    plan: { inner: found.plan.inner, files: found.plan.files, episodes: found.plan.episodes,
                            typed: found.plan.typed || undefined },
                    left: found.plan.left,
                    // What's inside its GOBs: [name, size] for each file.
                    inside: found.inside,
                };
            await this.env.LEVELS.put(`detail/${row.id}.json`, JSON.stringify(detail),
                                      { httpMetadata: { contentType: "application/json" } });
        }
        this.sql.exec(
            `UPDATE lv SET zip_st = ?, zip_at = ?, zip_size = ?, zip_sha = ?, info = ?, tries = 0, retry_at = NULL, err = ?
             WHERE id = ?`, status, now, size, sha, JSON.stringify(info), found.bad || null, row.id);
        // Mods have no 3D data: no level to show (and no address for the preview).
        if (mod)
            this.sql.exec("UPDATE lv SET pv_st = 'none', pv_at = ? WHERE id = ?", now, row.id);
        this.dirty();
    }

    // The level in the library (not id) that has every one of these GOBs
    // (by SHA-256), or null: Massassi's levels, and jkdf2.net's kept so far;
    // for a mod (mod), the mods.
    sameGobs(id, gobs, mod) {
        const want = gobs.map(g => g.sha);
        if (!want.length || want.some(h => !h))
            return null;
        const rows = this.sql.exec(`SELECT id, info FROM lv WHERE zip_st = 'ok' AND id != ? AND cat ${mod ? "" : "NOT "}IN (${ALL_MOD_SQL})
                                    ORDER BY id`, id).toArray();
        for (const r of rows) {
            let have;
            try {
                have = new Set((JSON.parse(r.info || "{}").gobs || []).map(g => g.h).filter(Boolean));
            } catch {
                continue;
            }
            if (want.every(h => have.has(h)))
                return r.id;
        }
        return null;
    }

    // The zip's GOBs (or GOOs), with their SHA-256 and episode, its files, its
    // readmes and the level's release date. A zip with no GOB at its top but
    // a zip inside is looked into, one level down.
    async lookInside(reader, row) {
        let z = await openZip(reader);
        let inner = null;
        const mod = isMod(row);
        const levelOf = es => es.filter(e => !e.dir && /\.(gob|goo)$/i.test(e.name));
        // A mod may be loose files in the game's folders, with no GOB.
        const modOf = es => es.filter(e => !e.dir && e.name.split("/").slice(0, -1).some(p => MOD_DIRS.includes(p.toLowerCase())));
        if (!levelOf(z.entries).length && !(mod && modOf(z.entries).length)) {
            const nested = z.entries.find(e => /\.zip$/i.test(e.name) && e.size <= MEM_ZIP);
            if (nested) {
                const b = await readEntry(z, nested);
                const z2 = await openZip(memReader(b));
                if (levelOf(z2.entries).length || (mod && modOf(z2.entries).length)) {
                    inner = nested.name;
                    z = { ...z2, outer: z };
                }
            }
        }
        const all = z.outer ? z.outer.entries.concat(z.entries) : z.entries;
        const files = all.filter(e => !e.dir).slice(0, MAX_FILES).map(e => ({ n: (z.outer && z.entries.includes(e) ? inner + "/" : "") + e.name,
                                                                                b: e.size, d: e.date }));
        const gobs = [];
        // A mod's: the files inside each of its GOBs, for what it changes.
        const inside = {};
        let insideN = 0;
        const keepInside = (g, dir) => {
            if (!mod || !dir)
                return;
            const list = dir.slice(0, Math.max(0, MAX_INSIDE - insideN)).map(f => [f.name, f.size]);
            insideN += list.length;
            inside[g.name] = list;
            g.files = dir.length;
        };
        for (const e of levelOf(z.entries)) {
            const g = { name: e.name, size: e.size, sha: null, ep: null, ty: null, lv: null, inner };
            if (e.size <= MEM_GOB && e.csize <= MEM_GOB) {
                const b = await readEntry(z, e);
                g.sha = await sha256(b);
                const dir = parseGob(b);
                keepInside(g, dir);
                const epf = dir && dir.find(f => f.name.toLowerCase() === "episode.jk");
                if (epf) {
                    const ep = parseEpisode(decodeText(b.subarray(epf.offset, epf.offset + epf.size)));
                    g.ep = ep.title;
                    g.ty = ep.type;
                    g.lv = ep.levels.slice(0, 32);
                }
            } else if ((e.method === 8 || e.method === 0) && z.reader.stream) {
                const start = await dataStart(z, e);
                const h = hashing();
                let s = await z.reader.stream(start, e.csize);
                if (e.method === 8)
                    s = s.pipeThrough(new DecompressionStream("deflate-raw"));
                // A mod's GOB too big to hold: its file table, as it goes by.
                const table = mod ? gobTable() : null;
                if (table)
                    s = s.pipeThrough(table.stream);
                await s.pipeThrough(h.stream).pipeTo(new WritableStream());
                if (h.size() !== e.size)
                    throw new Error(`bad size for ${e.name}`);
                g.sha = await h.sha();
                if (table)
                    keepInside(g, table.files());
            }
            gobs.push(g);
        }
        const texts = [];
        for (const e of all.filter(e => !e.dir && isText(e.name))) {
            const from = z.outer && z.outer.entries.includes(e) ? z.outer : z;
            let t = null;
            if (e.size <= MAX_TEXT_IN) {
                try {
                    t = decodeText(await readEntry(from, e));
                } catch {}
            }
            texts.push({ name: e.name, text: t });
        }
        let plan = null, modInfo = null;
        if (mod) {
            const ext = GOB_EXT[row.game] || "gob";
            plan = modPlan(z.entries, ext, gobs.filter(g => g.ep != null || (g.lv && g.lv.length)).map(g => g.name));
            plan.inner = inner;
            // Loose files are in a folder; the mod's GOBs are at its top.
            const planGobs = new Set(plan.files.filter(f => !f[1].includes("/")).map(f => f[0]));
            const names = plan.files.filter(f => f[1].includes("/")).map(f => f[1]);
            for (const g of gobs)
                for (const [n] of inside[g.name] || [])
                    names.push(n);
            const eps = gobs.filter(g => plan.episodes.includes(g.name)).map(g => ({ n: g.name, ep: g.ep, ty: g.ty, lv: g.lv }));
            // A graphics pack (the page's OPTIONAL_PACKS) is each player's
            // own: one GOB of that name and nothing else.
            const pack = plan.files.length === 1 && planGobs.size === 1 && !eps.length &&
                         GRAPHICS_PACKS.includes(plan.files[0][1].toLowerCase()) ? plan.files[0][1] : null;
            modInfo = {
                kind: modKind(names, eps, pack), pack, eps, words: modWords(names, 12),
                files: plan.files.length - planGobs.size + gobs.filter(g => planGobs.has(g.name)).reduce((n, g) => n + (g.files || 1), 0),
                programs: plan.left.programs,
            };
        }
        // A mod's date goes by all of its files; a level's by its GOBs and JKLs.
        const dated = mod && plan ? new Set(plan.files.map(f => f[0]).concat(plan.episodes)) : null;
        const fileDates = all.filter(e => !e.dir && e.date && (dated ? dated.has(e.name) : isLevelFile(e.name))).map(e => e.date);
        // jkdf2.net's date for a file is the day it went up there, not the level's.
        const date = releaseDate(texts, fileDates, isDf2(row) ? null : row.mdate || row.added);
        return {
            gobs, files, date, plan, inside, mod: modInfo,
            texts: texts.filter(t => t.text != null).slice(0, MAX_TEXTS)
                .map(t => ({ n: t.name, t: t.text.length > MAX_TEXT_OUT ? t.text.slice(0, MAX_TEXT_OUT) + "\n[...]" : t.text })),
        };
    }

    async readShot(row, now) {
        const list = JSON.parse(row.shots || "[]");
        const n = row.shots_got;
        const path = list[n];
        let res;
        try {
            res = await this.get(MASSASSI + path, MAX_SHOT);
        } catch (e) {
            if (e instanceof HttpError && e.status === 404) {
                list.splice(n, 1);
                this.sql.exec("UPDATE lv SET shots = ?, tries = 0, retry_at = NULL WHERE id = ?", JSON.stringify(list), row.id);
                return;
            }
            throw e;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_SHOT)
            throw new Error("picture too big");
        const type = /\.png$/i.test(path) ? "image/png" : /\.gif$/i.test(path) ? "image/gif" : "image/jpeg";
        await this.env.LEVELS.put(`shot/${row.id}-${n + 1}`, bytes, { httpMetadata: { contentType: type } });
        this.kv("shot_bytes", Number(this.kv("shot_bytes") || 0) + bytes.length);
        this.sql.exec("UPDATE lv SET shots_got = shots_got + 1, tries = 0, retry_at = NULL WHERE id = ?", row.id);
        this.dirty();
    }

    // The level's 3D data from Massassi's 3D preview, one file a step. The
    // preview has a map for each level its episode.jk lists (episode=N, the
    // Nth that loads): for a zip of one GOB of one level, map 0; otherwise
    // the preview's page first, for the maps it lists. Kept gzip, as the page
    // gets it.
    // The preview fetches a zip from another site (jkdf2.net) only when its
    // page is opened: a part asked for before that is not found. So a
    // jkdf2.net zip always goes by its page, and a part not found (the
    // preview may have let the zip go since) has the page opened once more
    // (maps[0].page: 1 to open it, 2 opened) before the level goes without.
    async readPreview(row, now) {
        const at = row.zip_url;
        // Its url= as the preview's own page writes it, unless it can't be.
        const zipArg = /[\s&#+?%]/.test(at) ? encodeURIComponent(at) : at;
        let maps = row.pv_maps ? JSON.parse(row.pv_maps) : null;
        try {
            if (maps && maps.length && maps[0].page === 1) {
                await (await this.get(`${PREVIEW}?url=${zipArg}`, MAX_PAGE)).text();
                maps[0].page = 2;
                this.sql.exec("UPDATE lv SET pv_maps = ?, pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?",
                              JSON.stringify(maps), now, row.id);
                return;
            }
            if (!maps) {
                const gobs = (JSON.parse(row.info || "{}").gobs || []).filter(g => g.ep || (g.lv && g.lv.length));
                if (!gobs.length) {
                    // No level in it (a skin, a mod): nothing to show.
                    this.sql.exec("UPDATE lv SET pv_st = 'none', pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", now, row.id);
                    return;
                }
                if (!isDf2(row) && gobs.length === 1 && gobs[0].lv && gobs[0].lv.length === 1) {
                    maps = [{ n: gobs[0].lv[0].replace(/\.jkl$/i, ""), e: 0 }];
                } else {
                    const html = await (await this.get(`${PREVIEW}?url=${zipArg}`, MAX_PAGE)).text();
                    maps = previewMaps(html).slice(0, MAX_MAPS);
                    this.sql.exec("UPDATE lv SET pv_maps = ?, pv_got = 0, pv_st = ?, pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?",
                                  JSON.stringify(maps), maps.length ? null : "none", now, row.id);
                    if (!maps.length)
                        this.dirty();
                    return;
                }
                this.sql.exec("UPDATE lv SET pv_maps = ?, pv_got = 0 WHERE id = ?", JSON.stringify(maps), row.id);
            }
            const k = row.pv_maps ? row.pv_got : 0;
            const m = k >> 1, what = k & 1 ? "mat" : "map";
            const res = await this.get(`${PREVIEW}${what}.json?version=${PREVIEW_VERSION}&url=${zipArg}&episode=${maps[m].e}`, MAX_PREVIEW);
            const gz = await packPreview(res, what);
            if (!gz) {
                // Bigger than the page should load: the level goes without.
                this.sql.exec("UPDATE lv SET pv_st = 'big', pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", now, row.id);
                this.dirty();
                return;
            }
            await this.env.LEVELS.put(`pv/${row.id}-${m}.${what}.json`, gz,
                                      { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
            const done = k + 1 >= maps.length * 2;
            this.sql.exec("UPDATE lv SET pv_got = ?, pv_size = pv_size + ?, pv_st = ?, pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?",
                          k + 1, gz.length, done ? "ok" : null, now, row.id);
            if (done)
                this.dirty();
        } catch (e) {
            const gone = e instanceof HttpError && (e.status === 404 || e.status === 410);
            if (gone && maps && maps.length && !maps[0].page) {
                maps[0].page = 1;
                this.sql.exec("UPDATE lv SET pv_maps = ?, pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?",
                              JSON.stringify(maps), now, row.id);
                return;
            }
            if (e.tooBig || gone) {
                this.sql.exec("UPDATE lv SET pv_st = ?, pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?",
                              e.tooBig ? "big" : "none", now, row.id);
                this.dirty();
                return;
            }
            throw Object.assign(e, { preview: true });
        }
    }

    // What the 3D view needs to draw the level's textures as the game does
    // (levels-read.js, gobTextures), from the zip in the bucket: no request
    // to Massassi. pv/<id>.tex.json.
    async readTextures(row, now) {
        const key = `zip/${row.id}.zip`;
        const head = await this.env.LEVELS.head(key);
        const out = { own: [], cmp: {}, pal: {} };
        if (head) {
            const size = head.size;
            let z = await openZip({ size, read: async (at, n) => {
                const o = await this.env.LEVELS.get(key, { range: { offset: at, length: Math.max(0, Math.min(n, size - at)) } });
                return new Uint8Array(await o.arrayBuffer());
            } });
            const isGob = e => !e.dir && /\.(gob|goo)$/i.test(e.name);
            if (!z.entries.some(isGob)) {
                const nested = z.entries.find(e => /\.zip$/i.test(e.name) && e.size <= MEM_ZIP);
                if (nested)
                    z = await openZip(memReader(await readEntry(z, nested)));
            }
            const gobs = [];
            let kept = 0;
            for (const e of z.entries.filter(isGob)) {
                if (e.size <= MEM_GOB && e.csize <= MEM_GOB) {
                    const b = await readEntry(z, e);
                    gobTextures(b, out);
                    if (kept + b.length <= MEM_GOB) {
                        gobs.push(b);
                        kept += b.length;
                    }
                }
            }
            if (gobs.length)
                out.parts = await this.writeParts(row, gobs);
        }
        await this.env.LEVELS.put(`pv/${row.id}.tex.json`, JSON.stringify(out),
                                  { httpMetadata: { contentType: "application/json" } });
        this.sql.exec("UPDATE lv SET pv_tex = 1, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", row.id);
        this.dirty();
        return LOCAL;
    }

    // For each map, the parts of its models that the preview's data leaves
    // out (levels-parts.js), from the level's own files and the map's
    // mat.json: pv/<id>-<m>.parts.json, gzip. The maps that have one.
    async writeParts(row, gobs) {
        const files = gobFinder(gobs, parseGob);
        const maps = JSON.parse(row.pv_maps || "[]");
        const have = [];
        for (let m = 0; m < maps.length; m++) {
            const jkl = `jkl/${maps[m].n}.jkl`;
            const own = files.only(jkl);
            let parts = null;
            if (own) {
                try {
                    const obj = await this.env.LEVELS.get(`pv/${row.id}-${m}.mat.json`);
                    const mats = obj && await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).json();
                    parts = mats && levelParts(own, jkl, mats, "left", OFFICIAL_3DO);
                } catch (e) {
                    this.kv("last_parts_error", `${new Date().toISOString()} level ${row.id} map ${m}: ${String(e && e.message || e).slice(0, 200)}`);
                    parts = null;
                }
            }
            const key = `pv/${row.id}-${m}.parts.json`;
            if (parts) {
                const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(parts)]).stream()
                    .pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
                await this.env.LEVELS.put(key, gz, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
                have.push(m);
            } else {
                await this.env.LEVELS.delete(key);
            }
        }
        return have;
    }

    dirty() {
        this.kv("dirty", 1);
    }

    // Writes the indexes, the levels' and the mods' of each game, at most
    // every INDEX_MS while levels come in (now: at once, when the job has
    // caught up).
    async index(now) {
        if (this.kv("dirty") !== "1")
            return;
        const last = Number(this.kv("index_at") || 0);
        if (!now && last + INDEX_MS > Date.now())
            return;
        const built = new Date().toISOString();
        for (const game of GAMES) {
            const all = this.sql.exec("SELECT * FROM lv WHERE game = ? ORDER BY title COLLATE NOCASE", game).toArray();
            const rows = all.filter(r => !isMod(r) && !isDf2(r));
            await this.indexMods(game, built, all.filter(r => isMod(r) && !isDf2(r)), all.filter(r => isMod(r) && isDf2(r)));
            const levels = rows.filter(r => r.page_st === "ok" && r.zip_st === "ok").map(r => indexEntry(r, JSON.parse(r.info || "{}")));
            const listed = rows.length;
            const left = rows.filter(r => r.page_at == null || (r.page_st === "ok" && r.zip_url && r.zip_st == null)).length;
            const body = JSON.stringify({ v: 1, game, built, source: MASSASSI, listed, left, levels });
            await this.env.LEVELS.put(`index/${game}.json`, body, { httpMetadata: { contentType: "application/json" } });
            await this.indexAll(game, built, levels, listed, left, all.filter(r => isDf2(r) && !isMod(r)));
        }
        this.kv("index_at", Date.now());
        this.kv("dirty", 0);
    }

    // index/<game>-all.json: Massassi's levels (as in <game>.json), and
    // jkdf2.net's that are ready, each with o: "jkdf2.net". One of jkdf2.net's
    // whose GOBs all came in with a level the library has from Massassi
    // since it was copied (or an earlier one of jkdf2.net's) is left out.
    async indexAll(game, built, levels, listed, left, rows) {
        const gobs = new Set();
        for (const l of levels)
            for (const g of l.g)
                if (g.h)
                    gobs.add(g.h);
        const df2 = [];
        for (const r of rows.slice().sort((a, b) => a.id - b.id)) {
            if (r.page_st !== "ok" || r.zip_st !== "ok")
                continue;
            const e = indexEntry(r, JSON.parse(r.info || "{}"));
            const hs = e.g.map(g => g.h);
            if (hs.length && hs.every(h => h && gobs.has(h)))
                continue;
            for (const h of hs)
                if (h)
                    gobs.add(h);
            e.o = "jkdf2.net";
            df2.push(e);
        }
        const name = l => String(l.t || "").toLowerCase();
        const both = levels.concat(df2).sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a.id - b.id);
        const cap = this.df2MaxBytes();
        const pending = rows.filter(r => r.page_st === "ok" && r.zip_url && r.zip_st == null && !(sizeBytes(r.size_txt) > cap)).length;
        const body = JSON.stringify({ v: 1, game, built, source: MASSASSI, sources: [MASSASSI, DF2],
                                      listed: listed + rows.filter(r => r.zip_st !== "dupe").length, left: left + pending,
                                      from: { "jkdf2.net": df2.length }, levels: both });
        await this.env.LEVELS.put(`index/${game}-all.json`, body, { httpMetadata: { contentType: "application/json" } });
    }

    // index/<game>-mods.json: Massassi's mods (rows) that are ready. Each has
    // what a level has in the levels' index (the zip, its GOBs, dates,
    // downloads), and k its kind (modKind), n how many files it has, ep how
    // many episodes, x how many programs the page leaves out, gp the graphics
    // pack's name when it's one, and gk which of the others are versions of
    // it (modGroup). index/<game>-mods-all.json: those, and jkdf2.net's
    // (df2Rows) that are ready, each with o: "jkdf2.net" and no Massassi date,
    // rating or downloads. One of jkdf2.net's that turned out to be one the
    // library already has (the same zip, or all the same GOBs) since it was
    // copied is left out.
    async indexMods(game, built, rows, df2Rows) {
        const entry = r => {
            const info = JSON.parse(r.info || "{}");
            const d = info.date || {}, m = info.mod || {};
            const df2 = isDf2(r);
            return {
                id: r.id, k: m.k || "other", t: r.title, a: r.author,
                rel: d.d || null, rp: d.p ? d.p[0] : null, sd: d.sort && d.sort !== d.d ? d.sort : undefined,
                src: d.src ? d.src[0] : null, add: df2 ? undefined : r.mdate || r.added, sz: r.zip_size,
                r: df2 ? undefined : r.rating, v: df2 ? undefined : r.votes, dl: df2 ? undefined : r.dl,
                sh: r.shots_got, z: info.name, h: r.zip_sha, gk: modGroup(r.title, r.author),
                n: m.n || 0, ep: m.ep || undefined, x: m.x || undefined, gp: m.gp || undefined,
                // Its files placed by their kind; the names of its files (jkdf2.net's).
                ty: m.ty || undefined, f: m.f && m.f.length ? m.f : undefined,
                g: (info.gobs || []).map(g => ({ n: g.n, h: g.h, b: g.b, ep: g.ep || undefined, ty: g.ty || undefined,
                                                  in: g.in || undefined })),
            };
        };
        const ready = r => r.page_st === "ok" && r.zip_st === "ok";
        const mods = rows.filter(ready).map(entry);
        const left = rows.filter(r => r.page_at == null || (r.page_st === "ok" && r.zip_st == null)).length;
        const body = JSON.stringify({ v: 1, game, built, source: MASSASSI, listed: rows.length, left, mods });
        await this.env.LEVELS.put(`index/${game}-mods.json`, body, { httpMetadata: { contentType: "application/json" } });
        const zips = new Set(mods.map(m => m.h).filter(Boolean));
        const gobs = new Set();
        for (const m of mods)
            for (const g of m.g)
                if (g.h)
                    gobs.add(g.h);
        const df2 = [];
        for (const r of (df2Rows || []).slice().sort((a, b) => a.id - b.id)) {
            if (!ready(r))
                continue;
            const e = entry(r);
            const hs = e.g.map(g => g.h);
            if ((e.h && zips.has(e.h)) || (hs.length && hs.every(h => h && gobs.has(h))))
                continue;
            zips.add(e.h);
            for (const h of hs)
                if (h)
                    gobs.add(h);
            e.o = "jkdf2.net";
            df2.push(e);
        }
        const cap = this.df2MaxBytes();
        const pending = (df2Rows || []).filter(r => r.page_st === "ok" && r.zip_url && r.zip_st == null &&
                                                    !(sizeBytes(r.size_txt) > cap)).length;
        const name = m => String(m.t || "").toLowerCase();
        const both = mods.concat(df2).sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a.id - b.id);
        const allBody = JSON.stringify({ v: 1, game, built, source: MASSASSI, sources: [MASSASSI, DF2],
                                         listed: rows.length + (df2Rows || []).filter(r => r.zip_st !== "dupe").length,
                                         left: left + pending, from: { "jkdf2.net": df2.length }, mods: both });
        await this.env.LEVELS.put(`index/${game}-mods-all.json`, allBody, { httpMetadata: { contentType: "application/json" } });
    }

    async status() {
        const by = this.sql.exec(
            `SELECT cat, COUNT(*) AS listed,
                    SUM(page_st = 'ok') AS pages, SUM(page_at IS NULL) AS pages_left,
                    SUM(zip_st = 'ok') AS zips,
                    SUM(page_st = 'ok' AND zip_st IS NULL AND (zip_url IS NOT NULL OR cat IN (${MOD_SQL}))) AS zips_left,
                    SUM(shots_got) AS shots, SUM(CASE WHEN zip_st = 'ok' THEN MAX(0, json_array_length(COALESCE(shots, '[]')) - shots_got) ELSE 0 END) AS shots_left,
                    SUM(COALESCE(zip_size, 0)) AS bytes,
                    SUM(pv_st = 'ok') AS previews, SUM(zip_st = 'ok' AND pv_st IS NULL) AS previews_left,
                    SUM(pv_st IN ('none', 'error')) AS previews_none, SUM(pv_size) AS preview_bytes
             FROM lv GROUP BY cat`).toArray();
        const odd = this.sql.exec(
            `SELECT COALESCE(zip_st, page_st, 'pending') AS st, COUNT(*) AS n FROM lv
             WHERE page_st != 'ok' OR zip_st NOT IN ('ok') GROUP BY st`).toArray();
        const errors = this.sql.exec("SELECT id, title, err FROM lv WHERE err IS NOT NULL ORDER BY retry_at DESC LIMIT 10").toArray();
        const flagged = this.sql.exec(
            `SELECT id, title, json_extract(info, '$.date.d') AS d, json_extract(info, '$.date.flags') AS flags FROM lv
             WHERE json_array_length(json_extract(info, '$.date.flags')) > 0 LIMIT 50`).toArray();
        const kinds = this.sql.exec(
            `SELECT game, json_extract(info, '$.mod.k') AS kind, COUNT(*) AS n FROM lv
             WHERE cat IN (${ALL_MOD_SQL}) AND zip_st = 'ok' GROUP BY game, kind`).toArray();
        const lists = {};
        for (const l of LISTS)
            lists[l.cat] = { at: Number(this.kv("list_at:" + l.cat) || 0) || null, n: Number(this.kv("list_n:" + l.cat) || 0) };
        for (const f of this.df2Folders())
            lists[f.key] = { at: Number(this.kv("list_at:" + f.key) || 0) || null, n: Number(this.kv("list_n:" + f.key) || 0),
                             // Zips left out: Massassi's (by name), and second copies on jkdf2.net.
                             same_as_massassi: Number(this.kv("list_same:" + f.key) || 0),
                             copies: Number(this.kv("list_twice:" + f.key) || 0) };
        const dupes = this.sql.exec(
            `SELECT game, cat IN (${DF2_MOD_SQL}) AS mods, SUM(json_extract(info, '$.mas') IS NOT NULL) AS by_name,
                    SUM(json_extract(info, '$.same') IS NOT NULL) AS by_gobs, SUM(json_extract(info, '$.same_zip') IS NOT NULL) AS by_zip
             FROM lv WHERE id > ${DF2_ID} AND zip_st = 'dupe' GROUP BY game, mods`).toArray();
        return {
            on: this.on(), alarm: await this.ctx.storage.getAlarm(), pace_ms: this.pace(),
            backoff_until: Number(this.kv("backoff_until") || 0) || null, fails: Number(this.kv("fails") || 0),
            requests_today: Number(this.kv("req_today") || 0), requests_total: Number(this.kv("req_total") || 0),
            stored_bytes: this.stored(), preview_bytes: this.previewBytes(), index_at: Number(this.kv("index_at") || 0) || null,
            last_error: this.kv("last_error"), lists, by_list: by, not_ready: odd, errors, date_flags: flagged,
            // The mods' download pages asked, each one a download on Massassi.
            download_pages: Number(this.kv("download_pages") || 0), mod_kinds: kinds,
            // jkdf2.net: its zips asked for today and in all, the day's cap,
            // and those found to be Massassi's after all.
            jkdf2: {
                on: this.df2On(), mods: this.df2ModsOn(), per_day: this.df2PerDay(), max_mb: this.df2MaxBytes() / 1048576,
                today: this.df2Today(), total: Number(this.kv("df2_total") || 0),
                backoff_until: Number(this.kv("df2_backoff_until") || 0) || null, fails: Number(this.kv("df2_fails") || 0),
                dupes,
            },
        };
    }
}

// ---- The Worker's routes

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export function levelsOn(env) {
    return !!(env.LEVELS && env.LEVELJOB);
}

function job(env) {
    return env.LEVELJOB.get(env.LEVELJOB.idFromName("massassi"));
}

// From the cron (lobby.js scheduled()).
// A 3D data file, gzipped as it comes in rather than held whole (a big level's
// map.json is tens of MB), and checked to be the preview's: map.json an object
// with its surfaces first, mat.json a list. Null past MAX_PREVIEW.
async function packPreview(res, what) {
    let size = 0, head = new Uint8Array(0), tail = new Uint8Array(0), big = false;
    const join = (a, b) => {
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
    };
    const check = new TransformStream({
        transform(chunk, ctl) {
            size += chunk.length;
            if (size > MAX_PREVIEW) {
                big = true;
                throw new Error(`3D ${what} too big`);
            }
            if (head.length < 32)
                head = join(head, chunk.subarray(0, 32 - head.length));
            tail = chunk.length >= 32 ? chunk.slice(chunk.length - 32) : join(tail, chunk).slice(-32);
            ctl.enqueue(chunk);
        },
    });
    let gz;
    try {
        gz = new Uint8Array(await new Response(res.body.pipeThrough(check).pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    } catch (e) {
        if (big)
            return null;
        throw e;
    }
    const dec = b => new TextDecoder().decode(b).trim();
    const ok = what === "map" ? /^\{\s*"surfaces"\s*:\s*\[/.test(dec(head)) && dec(tail).endsWith("}")
                              : /^\[\s*(\]|\{)/.test(dec(head)) && dec(tail).endsWith("]");
    if (!ok)
        throw new Error(`3D ${what} isn't the preview's`);
    return gz;
}

export async function kickLevels(env) {
    if (levelsOn(env) && env.LEVELS_FETCH !== "0")
        await job(env).fetch("https://levels/kick");
}

// encoding: what the stored object already is (gzip), sent as it is.
async function serve(request, env, key, cache, type, encoding) {
    const head = request.method === "HEAD";
    const seen = (request.headers.get("If-None-Match") || "").replace(/^W\//, "").replace(/^"|"$/g, "");
    const obj = head ? await env.LEVELS.head(key)
                     : await env.LEVELS.get(key, seen ? { onlyIf: { etagDoesNotMatch: seen } } : undefined);
    if (!obj)
        return NOT_FOUND();
    const headers = {
        "Content-Type": type || (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream",
        ETag: obj.httpEtag,
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
    };
    if (!head && !obj.body)
        return new Response(null, { status: 304, headers });
    headers["Content-Length"] = String(obj.size);
    if (encoding) {
        headers["Content-Encoding"] = encoding;
        headers.Vary = "Accept-Encoding";
        return new Response(head ? null : obj.body, { status: 200, headers, encodeBody: "manual" });
    }
    return new Response(head ? null : obj.body, { status: 200, headers });
}

export async function levelsRoute(request, env, url) {
    const path = url.pathname;
    if (!path.startsWith("/levels/") || !levelsOn(env))
        return null;
    if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    let m;
    if ((m = /^\/levels\/(jk1|mots)\.json$/.exec(path)))
        return serve(request, env, `index/${m[1]}.json`, "public, max-age=300", "application/json; charset=utf-8");
    if ((m = /^\/levels\/mods\/(jk1|mots)\.json$/.exec(path)))
        return serve(request, env, `index/${m[1]}-mods.json`, "public, max-age=300", "application/json; charset=utf-8");
    if ((m = /^\/levels\/mods\/all\/(jk1|mots)\.json$/.exec(path)))
        return serve(request, env, `index/${m[1]}-mods-all.json`, "public, max-age=300", "application/json; charset=utf-8");
    if ((m = /^\/levels\/all\/(jk1|mots)\.json$/.exec(path)))
        return serve(request, env, `index/${m[1]}-all.json`, "public, max-age=300", "application/json; charset=utf-8");
    if ((m = /^\/levels\/d\/(\d{1,7})\.json$/.exec(path)))
        return serve(request, env, `detail/${m[1]}.json`, "public, max-age=3600", "application/json; charset=utf-8");
    if ((m = /^\/levels\/z\/(\d{1,7})\.zip$/.exec(path))) {
        // Kept for good when the address names the zip by its hash (the
        // index's h): a new version of the level is a new address.
        const h = url.searchParams.get("h");
        const res = await serve(request, env, `zip/${m[1]}.zip`, "public, max-age=3600", "application/zip");
        if (res.status === 200 && h && /^[0-9a-f]{64}$/.test(h)) {
            const obj = await env.LEVELS.head(`zip/${m[1]}.zip`);
            if (obj && obj.customMetadata && obj.customMetadata.sha256 === h)
                res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
        }
        return res;
    }
    if ((m = /^\/levels\/p\/(\d{1,7})\.tex\.json$/.exec(path)))
        return serve(request, env, `pv/${m[1]}.tex.json`, "public, max-age=3600", "application/json; charset=utf-8");
    if ((m = /^\/levels\/p\/(\d{1,7})-(\d)\.(map|mat|parts)\.json$/.exec(path)))
        return serve(request, env, `pv/${m[1]}-${m[2]}.${m[3]}.json`, "public, max-age=86400", "application/json; charset=utf-8", "gzip");
    if ((m = /^\/levels\/s\/(\d{1,7})-(\d)\.jpg$/.exec(path)))
        return serve(request, env, `shot/${m[1]}-${m[2]}`, "public, max-age=604800");
    if (path === "/levels/status") {
        const res = await job(env).fetch("https://levels/status");
        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return NOT_FOUND();
}
