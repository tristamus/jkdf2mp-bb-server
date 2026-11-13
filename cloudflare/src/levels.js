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
//
// The routes (levelsRoute, only with LEVELS and LEVELJOB bound):
//
//   GET /levels/jk1.json, /levels/mots.json
//   GET /levels/d/<id>.json
//   GET /levels/z/<id>.zip[?h=<sha>]   immutable when h is the zip's SHA-256
//   GET /levels/s/<id>-<n>.jpg
//   GET /levels/p/<id>-<m>.map.json, .mat.json   the 3D data (sent gzip)
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
         decodeText, releaseDate, isText, isLevelFile } from "./levels-read.js";

const MASSASSI = "https://www.massassi.net";
// The lists, in the order the job works through them: multiplayer first.
export const LISTS = [
    { cat: "jkmp", game: "jk1", kind: "mp", prio: 0 },
    { cat: "jkctf", game: "jk1", kind: "ctf", prio: 0 },
    { cat: "motsmp", game: "mots", kind: "mp", prio: 0 },
    { cat: "motskfy", game: "mots", kind: "kfy", prio: 0 },
    { cat: "jksp", game: "jk1", kind: "sp", prio: 1 },
    { cat: "motssp", game: "mots", kind: "sp", prio: 1 },
];
const BY_CAT = Object.fromEntries(LISTS.map(l => [l.cat, l]));
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lv (
    id INTEGER PRIMARY KEY,
    cat TEXT NOT NULL,
    game TEXT NOT NULL,
    prio INTEGER NOT NULL,
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
                           "pv_size INTEGER NOT NULL DEFAULT 0", "pv_tex INTEGER NOT NULL DEFAULT 0"]) {
            try {
                this.sql.exec(`ALTER TABLE lv ADD COLUMN ${col}`);
            } catch {
                // There already.
            }
        }
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

    // One request to Massassi, or none when there's nothing to do (false).
    async step(now) {
        const list = LISTS.find(l => Number(this.kv("list_at:" + l.cat) || 0) + LIST_MS <= now);
        if (list) {
            await this.guard(() => this.readList(list, now));
            return true;
        }
        const full = await this.full();
        const row = this.sql.exec(
            `SELECT * FROM lv WHERE (retry_at IS NULL OR retry_at <= ?) AND (
                 page_at IS NULL
                 OR (page_st = 'ok' AND zip_url IS NOT NULL AND zip_st IS NULL AND ? = 0)
                 OR (page_st = 'ok' AND zip_st = 'ok' AND shots_got < json_array_length(shots) AND ? = 0)
                 OR (page_st = 'ok' AND zip_st = 'ok' AND shots_got >= json_array_length(COALESCE(shots, '[]'))
                     AND pv_st IS NULL AND zip_url IS NOT NULL AND ? = 0)
                 OR (pv_st = 'ok' AND pv_tex = 0 AND ? = 0))
             ORDER BY prio, dl DESC, id LIMIT 1`, now, full ? 1 : 0, full ? 1 : 0,
            full || this.env.LEVELS_PREVIEW === "0" || this.previewFull() ? 1 : 0, this.env.LEVELS_PREVIEW === "0" ? 1 : 0).toArray()[0];
        if (row) {
            let local = false;
            await this.guard(async () => {
                local = await this.work(row, now) === LOCAL;
            }, row);
            this.kv("steps", Number(this.kv("steps") || 0) + 1);
            return local ? LOCAL : true;
        }
        // Each page again now and then: a level updated on Massassi.
        const old = this.sql.exec(
            "SELECT * FROM lv WHERE page_at IS NOT NULL AND page_at <= ? ORDER BY page_at LIMIT 1", now - REPAGE_MS).toArray()[0];
        if (old) {
            await this.guard(() => this.readPage(old, now), old);
            return true;
        }
        return false;
    }

    async work(row, now) {
        if (row.page_at == null)
            return this.readPage(row, now);
        if (row.zip_st == null)
            return this.readZip(row, now);
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
    async guard(fn, row) {
        try {
            await fn();
            this.kv("fails", 0);
        } catch (e) {
            const status = e instanceof HttpError ? e.status : 0;
            const why = String(e && e.message || e).slice(0, 300);
            this.kv("last_error", `${new Date().toISOString()} ${row ? "level " + row.id + ": " : ""}${why}`);
            // The 3D preview failing on one level (its converter can't read
            // it, say) is that level's, not Massassi being busy.
            if (status === 429 || (status >= 500 && !e.preview) || e.network || !row) {
                const fails = Number(this.kv("fails") || 0) + 1;
                this.kv("fails", fails);
                const after = Number(e.retryAfter) > 0 ? Number(e.retryAfter) * 1000 : 0;
                this.kv("backoff_until", Date.now() + Math.max(after, Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (fails - 1))));
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
        const src = this.env.LEVELS_SOURCE, psrc = this.env.LEVELS_PREVIEW_SOURCE;
        const real = url.startsWith(PREVIEW) ? (psrc ? psrc + url.slice(PREVIEW.length) : url)
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
        this.dirty();
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
        // A new address, or a zip of another size: the zip again.
        const again = row.zip_url !== p.zip || (row.size_txt && row.size_txt !== p.size);
        this.sql.exec(
            `UPDATE lv SET page_at = ?, page_st = 'ok', name = ?, size_txt = ?, mdate = ?, descr = ?,
                 title = COALESCE(NULLIF(?, ''), title), author = COALESCE(NULLIF(?, ''), author),
                 zip_url = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?`,
            now, p.name, p.size, p.date, p.desc, p.title, p.author, p.zip, row.id);
        if (again || row.zip_st == null || row.zip_st === "error" || row.zip_st === "full") {
            this.sql.exec("UPDATE lv SET zip_st = ?, shots = ?, shots_got = 0, pv_st = NULL, pv_maps = NULL, pv_got = 0, pv_size = 0, pv_tex = 0 WHERE id = ?",
                          p.zip ? null : "none", shots, row.id);
        } else if (shots !== row.shots) {
            this.sql.exec("UPDATE lv SET shots = ?, shots_got = 0 WHERE id = ?", shots, row.id);
        }
        // The description is in the level's detail: written again if it changed.
        if (!again && row.zip_st === "ok" && p.desc !== row.descr)
            await this.patchDetail(row.id, { desc: p.desc });
        this.dirty();
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
        let res;
        try {
            res = await this.get(row.zip_url, MAX_ZIP);
        } catch (e) {
            if (e instanceof HttpError && (e.status === 404 || e.status === 410 || e.status === 403)) {
                this.sql.exec("UPDATE lv SET zip_st = 'gone', zip_at = ?, tries = 0, retry_at = NULL, err = ? WHERE id = ?",
                              now, e.message, row.id);
                this.dirty();
                return;
            }
            throw e;
        }
        const key = `zip/${row.id}.zip`;
        const name = decodeURIComponent(row.zip_url.split("/").pop());
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
        let found;
        try {
            found = await this.lookInside(zip, row);
        } catch (e) {
            found = { bad: String(e && e.message || e) };
        }
        if (zip.bytes)
            await this.env.LEVELS.put(key, zip.bytes, { httpMetadata: { contentType: "application/zip" },
                                                      customMetadata: { sha256: sha, name } });
        const status = found.bad ? "bad" : found.gobs.length ? "ok" : "nolevel";
        const info = found.bad ? { bad: found.bad } : {
            gobs: found.gobs.map(g => ({ n: g.name, h: g.sha, b: g.size, ep: g.ep, ty: g.ty, lv: g.lv, in: g.inner })),
            date: { d: found.date.date, p: found.date.precision, src: found.date.source, sort: found.date.sort,
                    flags: found.date.flags },
        };
        info.name = name;
        if (!found.bad) {
            const detail = {
                id: row.id, title: row.title, author: row.author, desc: row.descr || "",
                massassi: `${MASSASSI}/levels/files/${row.id}.shtml`, zip: name, size, sha256: sha,
                date: found.date, files: found.files, texts: found.texts, gobs: info.gobs,
            };
            await this.env.LEVELS.put(`detail/${row.id}.json`, JSON.stringify(detail),
                                      { httpMetadata: { contentType: "application/json" } });
        }
        this.sql.exec(
            `UPDATE lv SET zip_st = ?, zip_at = ?, zip_size = ?, zip_sha = ?, info = ?, tries = 0, retry_at = NULL, err = ?
             WHERE id = ?`, status, now, size, sha, JSON.stringify(info), found.bad || null, row.id);
        this.dirty();
    }

    // The zip's GOBs (or GOOs), with their SHA-256 and episode, its files, its
    // readmes and the level's release date. A zip with no GOB at its top but
    // a zip inside is looked into, one level down.
    async lookInside(reader, row) {
        let z = await openZip(reader);
        let inner = null;
        const levelOf = es => es.filter(e => !e.dir && /\.(gob|goo)$/i.test(e.name));
        if (!levelOf(z.entries).length) {
            const nested = z.entries.find(e => /\.zip$/i.test(e.name) && e.size <= MEM_ZIP);
            if (nested) {
                const b = await readEntry(z, nested);
                const z2 = await openZip(memReader(b));
                if (levelOf(z2.entries).length) {
                    inner = nested.name;
                    z = { ...z2, outer: z };
                }
            }
        }
        const all = z.outer ? z.outer.entries.concat(z.entries) : z.entries;
        const files = all.filter(e => !e.dir).slice(0, MAX_FILES).map(e => ({ n: (z.outer && z.entries.includes(e) ? inner + "/" : "") + e.name,
                                                                                b: e.size, d: e.date }));
        const gobs = [];
        for (const e of levelOf(z.entries)) {
            const g = { name: e.name, size: e.size, sha: null, ep: null, ty: null, lv: null, inner };
            if (e.size <= MEM_GOB && e.csize <= MEM_GOB) {
                const b = await readEntry(z, e);
                g.sha = await sha256(b);
                const dir = parseGob(b);
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
                await s.pipeThrough(h.stream).pipeTo(new WritableStream());
                if (h.size() !== e.size)
                    throw new Error(`bad size for ${e.name}`);
                g.sha = await h.sha();
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
        const fileDates = all.filter(e => !e.dir && isLevelFile(e.name) && e.date).map(e => e.date);
        const date = releaseDate(texts, fileDates, row.mdate || row.added);
        return {
            gobs, files, date,
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
    async readPreview(row, now) {
        const at = row.zip_url;
        // Its url= as the preview's own page writes it, unless it can't be.
        const zipArg = /[\s&#+?%]/.test(at) ? encodeURIComponent(at) : at;
        let maps = row.pv_maps ? JSON.parse(row.pv_maps) : null;
        try {
            if (!maps) {
                const gobs = (JSON.parse(row.info || "{}").gobs || []).filter(g => g.ep || (g.lv && g.lv.length));
                if (!gobs.length) {
                    // No level in it (a skin, a mod): nothing to show.
                    this.sql.exec("UPDATE lv SET pv_st = 'none', pv_at = ?, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", now, row.id);
                    return;
                }
                if (gobs.length === 1 && gobs[0].lv && gobs[0].lv.length === 1) {
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
            if (e.tooBig || e instanceof HttpError && (e.status === 404 || e.status === 410)) {
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
            for (const e of z.entries.filter(isGob)) {
                if (e.size <= MEM_GOB && e.csize <= MEM_GOB)
                    gobTextures(await readEntry(z, e), out);
            }
        }
        await this.env.LEVELS.put(`pv/${row.id}.tex.json`, JSON.stringify(out),
                                  { httpMetadata: { contentType: "application/json" } });
        this.sql.exec("UPDATE lv SET pv_tex = 1, tries = 0, retry_at = NULL, err = NULL WHERE id = ?", row.id);
        this.dirty();
        return LOCAL;
    }

    dirty() {
        this.kv("dirty", 1);
    }

    // Writes the two indexes, at most every INDEX_MS while levels come in
    // (now: at once, when the job has caught up).
    async index(now) {
        if (this.kv("dirty") !== "1")
            return;
        const last = Number(this.kv("index_at") || 0);
        if (!now && last + INDEX_MS > Date.now())
            return;
        const built = new Date().toISOString();
        for (const game of GAMES) {
            const rows = this.sql.exec("SELECT * FROM lv WHERE game = ? ORDER BY title COLLATE NOCASE", game).toArray();
            const levels = [];
            for (const r of rows) {
                if (r.page_st !== "ok" || r.zip_st !== "ok")
                    continue;
                const info = JSON.parse(r.info || "{}");
                const d = info.date || {};
                levels.push({
                    id: r.id, k: BY_CAT[r.cat] ? BY_CAT[r.cat].kind : r.cat, t: r.title, a: r.author,
                    rel: d.d || null, rp: d.p ? d.p[0] : null, sd: d.sort && d.sort !== d.d ? d.sort : undefined,
                    src: d.src ? d.src[0] : null, add: r.mdate || r.added, sz: r.zip_size, r: r.rating, v: r.votes, dl: r.dl,
                    sh: r.shots_got, z: info.name, h: r.zip_sha,
                    pv: r.pv_st === "ok" ? JSON.parse(r.pv_maps || "[]").map(m => m.n) : undefined,
                    g: (info.gobs || []).map(g => ({ n: g.n, h: g.h, b: g.b, ep: g.ep || undefined, ty: g.ty || undefined,
                                                      lv: g.lv && g.lv.length ? g.lv : undefined, in: g.in || undefined })),
                });
            }
            const listed = rows.length;
            const left = rows.filter(r => r.page_at == null || (r.page_st === "ok" && r.zip_url && r.zip_st == null)).length;
            const body = JSON.stringify({ v: 1, game, built, source: MASSASSI, listed, left, levels });
            await this.env.LEVELS.put(`index/${game}.json`, body, { httpMetadata: { contentType: "application/json" } });
        }
        this.kv("index_at", Date.now());
        this.kv("dirty", 0);
    }

    async status() {
        const by = this.sql.exec(
            `SELECT cat, COUNT(*) AS listed,
                    SUM(page_st = 'ok') AS pages, SUM(page_at IS NULL) AS pages_left,
                    SUM(zip_st = 'ok') AS zips, SUM(page_st = 'ok' AND zip_url IS NOT NULL AND zip_st IS NULL) AS zips_left,
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
        const lists = {};
        for (const l of LISTS)
            lists[l.cat] = { at: Number(this.kv("list_at:" + l.cat) || 0) || null, n: Number(this.kv("list_n:" + l.cat) || 0) };
        return {
            on: this.on(), alarm: await this.ctx.storage.getAlarm(), pace_ms: this.pace(),
            backoff_until: Number(this.kv("backoff_until") || 0) || null, fails: Number(this.kv("fails") || 0),
            requests_today: Number(this.kv("req_today") || 0), requests_total: Number(this.kv("req_total") || 0),
            stored_bytes: this.stored(), preview_bytes: this.previewBytes(), index_at: Number(this.kv("index_at") || 0) || null,
            last_error: this.kv("last_error"), lists, by_list: by, not_ready: odd, errors, date_flags: flagged,
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
        return serve(request, env, `pv/${m[1]}.tex.json`, "public, max-age=86400", "application/json; charset=utf-8");
    if ((m = /^\/levels\/p\/(\d{1,7})-(\d)\.(map|mat)\.json$/.exec(path)))
        return serve(request, env, `pv/${m[1]}-${m[2]}.${m[3]}.json`, "public, max-age=86400", "application/json; charset=utf-8", "gzip");
    if ((m = /^\/levels\/s\/(\d{1,7})-(\d)\.jpg$/.exec(path)))
        return serve(request, env, `shot/${m[1]}-${m[2]}`, "public, max-age=604800");
    if (path === "/levels/status") {
        const res = await job(env).fetch("https://levels/status");
        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    return NOT_FOUND();
}
