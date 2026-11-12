// Screenshots on match pages. A player's page keeps the pictures they take in
// a game (F8 or F12) in their own browser. With an R2 bucket bound as SHOTS,
// the page also sends the ones taken in a recorded match here, and the
// match's page shows them to everyone (src/ladder-pages.js). Without the
// bucket, or with LADDER_SHOTS = "0", none of this runs: the routes aren't
// there, /ladder/recent doesn't say "shots", so pages send nothing, and the
// match pages are as they were.
//
//   GET /ladder/shot?age=<ms>&taken=<ms>[&final=1]
//                      where a picture taken that long ago would go, before
//                      the page sends it: {match, secs, left}, or with id
//                      when the lobby has it already
//   POST /ladder/shot?age=<ms>&taken=<ms>[&final=1]
//                      the picture, as a form with two files: full (a JPEG,
//                      SHOTS.edge pixels at most on its longer side) and
//                      thumb (a small one). Answers {id, match, secs, left}.
//                      Where it goes is settled from the address, before
//                      any of the form is read.
//   DELETE /ladder/shot/<id>
//                      its player takes it off again
//   GET /shot/<id>.jpg, /shot/<id>.t.jpg
//                      the picture and its small copy
//
// Whose picture, and of which match: the player is the browser's key (the
// cookie /ladder/key set, as on the pages), and the match is the one of
// theirs that was being played when the picture was taken. The page says how
// long ago that was (age) rather than when, so its clock doesn't matter, and
// the lobby never takes a match's number from it. A picture of a match that
// isn't saved yet gets "wait" and the page asks again after the match is.
//
// What that proves is only who sent it: a player with a line in that match,
// under a key. The age and the picture itself are the sender's word. So
// there are limits (SHOTS: so many a player and a match, so many bytes, only
// JPEGs of a sane size, only matches of the last few days), a picture is
// served as an image and nothing else, and one can be hidden or deleted by
// hand (README.md, "Screenshots on match pages"). A player recorded as
// Anonymous has no key in the match and can't add any.
//
// The final scoreboard: the game takes one picture of its score screen when
// a level ends, and the page sends it with final=1. A match keeps the first
// that arrives (every game shows the same screen), only when its host said
// the level ended, and never when one of its players is shown as Anonymous:
// that screen has everyone's name on it.
//
// A picture is two objects in the bucket, m/<match>/<id>.jpg and
// m/<match>/<id>.t.jpg, and a row in match_shots (ladder.js, SCHEMA). The id
// is random, so a picture's address can't be guessed from its match's.
//
// Nothing here deletes a picture for its age, so the bucket only grows. The
// lobby stops taking pictures when all of them together reach SHOTS_MAX_GB
// (8 when it isn't set, under the 10 GB a month R2 stores without charge),
// and says 507 "room" until some are deleted or the number is raised.

import { cookieKey, ensureSchema, hashKey } from "./ladder.js";

export const SHOTS = {
    perPlayer: 12,          // a player's pictures in one match
    perMatch: 60,           // and everyone's
    bytes: 1500000,         // the picture
    thumbBytes: 200000,     // and its small copy
    edge: 1920,             // the picture's longer side, in pixels
    thumbEdge: 480,
    days: 7,                // how long after a match its pictures are taken
};
const MIN_EDGE = 64;
// The form's boundaries and its files' names.
const FORM_EXTRA = 8192;
const HOUR_MS = 60 * 60 * 1000;
// How far outside a match's times a picture's may be: the page's age is
// taken when it sends, and the lobby's clock when the request arrives.
const SLACK_MS = 5000;
// A final scoreboard is taken as the level ends. The match's end in the
// record is when the lobby closed it, up to CLOSE_MS (ladder.js) later.
const FINAL_BEFORE_MS = 25000;
const FINAL_AFTER_MS = 45000;
// How long a picture waits for its match to be saved: a match can run for
// hours, and a final scoreboard's is saved within minutes or not at all.
const WAIT_MS = 12 * HOUR_MS;
const FINAL_WAIT_MS = 10 * 60 * 1000;

// Whether this lobby takes pictures.
export function shotsOn(env) {
    return !!(env.LADDER && env.SHOTS) && env.LADDER_SHOTS !== "0";
}

// How many bytes of pictures it keeps at most.
export function shotsRoom(env) {
    const gb = Number(env.SHOTS_MAX_GB);
    return Math.round((gb > 0 && isFinite(gb) ? gb : 8) * 1e9);
}

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

function refuse(status, error, more) {
    return json(status, { error, ...more });
}

// A page on another address can't have a browser send or delete for it.
function sameSite(request) {
    const origin = request.headers.get("Origin");
    if (origin === null)
        return true;
    try {
        return new URL(origin).host === new URL(request.url).host;
    } catch (e) {
        return false;
    }
}

function whole(text, max) {
    return typeof text === "string" && /^[0-9]{1,16}$/.test(text) && Number(text) <= max ? Number(text) : -1;
}

// A JPEG's size in pixels, from its frame header: {w, h}, or null for what
// isn't one from its first byte to its last.
export function jpegSize(b) {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9)
        return null;
    let at = 2;
    while (at + 4 <= b.length) {
        if (b[at] !== 0xff)
            return null;
        const marker = b[at + 1];
        // Fill bytes before a marker.
        if (marker === 0xff) {
            at++;
            continue;
        }
        // Markers with nothing after them.
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2;
            continue;
        }
        const size = (b[at + 2] << 8) | b[at + 3];
        if (size < 2 || at + 2 + size > b.length)
            return null;
        // A frame header (SOF), but not the tables that share its range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (size < 7)
                return null;
            return { h: (b[at + 5] << 8) | b[at + 6], w: (b[at + 7] << 8) | b[at + 8] };
        }
        // The picture's data begins: no frame header came first.
        if (marker === 0xda)
            return null;
        at += 2 + size;
    }
    return null;
}

function objectKeys(match, id) {
    return [`m/${match}/${id}.jpg`, `m/${match}/${id}.t.jpg`];
}

// Where a picture taken at `captured` by the key's player goes. An answer to
// send as it is (res), or the match: {match, slot, player, secs, left, id}
// with id the picture's when the lobby has this one already. room: the bytes
// of pictures the lobby keeps at most.
async function place(db, keyHash, captured, taken, final, now, room) {
    const since = now - SHOTS.days * 24 * HOUR_MS;
    // A match it could be of began before `to` and ended after `from`.
    const from = final ? captured - FINAL_AFTER_MS : captured - SLACK_MS;
    const to = final ? captured + FINAL_BEFORE_MS : captured + SLACK_MS;
    const [who, found, kept] = await db.batch([
        // The key's player, whether their record is hidden, and when their
        // latest match ended (match numbers go up with time).
        db.prepare(
            `SELECT p.id, COALESCE(c.hidden, 0) AS hidden,
                    (SELECT m.ended_at FROM matches m WHERE m.id =
                        (SELECT MAX(mp.match_id) FROM match_players mp WHERE mp.player_id = p.id)) AS last
             FROM players p LEFT JOIN players c ON c.id = COALESCE(p.merged_into, p.id)
             WHERE p.key_hash = ?`).bind(keyHash),
        // Their matches around that time, with what each has already.
        // unnamed: its players shown as Anonymous.
        db.prepare(
            `SELECT m.id, m.started_at, m.ended_at, m.ended, mp.slot, mp.player_id,
                    (SELECT s.id FROM match_shots s
                     WHERE s.match_id = m.id AND s.player_id = mp.player_id AND s.taken = ?) AS have,
                    (SELECT COUNT(*) FROM match_shots s
                     WHERE s.match_id = m.id AND s.player_id = mp.player_id AND s.final = 0) AS mine,
                    (SELECT COUNT(*) FROM match_shots s WHERE s.match_id = m.id AND s.final = 0) AS total,
                    (SELECT COUNT(*) FROM match_shots s WHERE s.match_id = m.id AND s.final = 1) AS finals,
                    (SELECT COUNT(*) FROM match_players x LEFT JOIN players xp ON xp.id = x.player_id
                                     LEFT JOIN players xc ON xc.id = COALESCE(xp.merged_into, xp.id)
                     WHERE x.match_id = m.id AND (x.name = '' OR COALESCE(xc.hidden, 0) = 1)) AS unnamed
             FROM players p JOIN match_players mp ON mp.player_id = p.id JOIN matches m ON m.id = mp.match_id
             WHERE p.key_hash = ? AND m.hidden = 0 AND m.ended_at >= ? AND m.started_at <= ? AND m.ended_at >= ?
             ORDER BY mp.match_id DESC, mp.slot LIMIT 8`).bind(taken, keyHash, since, to, from),
        db.prepare("SELECT bytes FROM shot_total WHERE id = 1"),
    ]);
    const player = who.results[0];
    // A match still being played, or closed a moment ago, isn't saved yet,
    // and a key's first match makes its player.
    const wait = now - captured < (final ? FINAL_WAIT_MS : WAIT_MS);
    if (!player)
        return { res: refuse(404, "none", { wait }) };
    if (player.hidden)
        return { res: refuse(403, "hidden") };
    let rows = found.results;
    // A final scoreboard is of a level its host ended, taken as it ended.
    if (final)
        rows = rows.filter(m => m.ended === "level" && m.ended_at <= to);
    // The match it was taken in: the one whose times hold it, the later one
    // of two (a level that follows another at once), else the nearest.
    const off = m => final ? Math.abs(captured - m.ended_at)
                           : captured < m.started_at ? m.started_at - captured : captured > m.ended_at ? captured - m.ended_at : 0;
    rows.sort((a, b) => off(a) - off(b) || b.id - a.id);
    const m = rows[0];
    if (!m) {
        // Later than all their matches: its own may come yet.
        const later = captured > (player.last || 0) + (final ? FINAL_AFTER_MS : SLACK_MS);
        return { res: refuse(404, "none", { wait: wait && later }) };
    }
    const at = final ? m.ended_at : Math.min(Math.max(captured, m.started_at), m.ended_at);
    const out = { match: m.id, slot: m.slot, player: m.player_id, secs: Math.round((at - m.started_at) / 1000),
                  left: Math.max(0, Math.min(SHOTS.perPlayer - m.mine, SHOTS.perMatch - m.total)), id: m.have || "" };
    if (m.have)
        return out;
    // The lobby has all the pictures it keeps.
    if ((kept.results[0] ? kept.results[0].bytes : 0) >= room)
        return { res: refuse(507, "room") };
    if (final) {
        if (m.unnamed)
            return { res: refuse(409, "anonymous") };
        if (m.finals)
            return { res: refuse(409, "have") };
        out.left = 1;
    } else if (!out.left) {
        return { res: refuse(409, "full") };
    }
    return out;
}

// GET and POST /ladder/shot.
async function takeShot(request, env, url, now) {
    const post = request.method === "POST";
    if (!post && request.method !== "GET")
        return new Response("GET or POST here", { status: 405, headers: { Allow: "GET, POST" } });
    if (post && !sameSite(request))
        return refuse(403, "site");
    const key = cookieKey(request);
    if (!key)
        return refuse(401, "key");
    if (post) {
        const size = Number(request.headers.get("Content-Length") || NaN);
        if (!(size >= 0))
            return refuse(411, "length");
        if (size > SHOTS.bytes + SHOTS.thumbBytes + FORM_EXTRA)
            return refuse(413, "big");
    }
    const age = whole(url.searchParams.get("age"), 400 * 24 * HOUR_MS);
    const taken = whole(url.searchParams.get("taken"), 8.64e15);
    const final = url.searchParams.get("final") === "1";
    if (age < 0 || taken < 0)
        return refuse(400, "fields");
    if (age > SHOTS.days * 24 * HOUR_MS)
        return refuse(404, "none", { wait: false });
    const db = env.LADDER;
    const room = shotsRoom(env);
    const placed = await place(db, await hashKey(key), now - age, taken, final, now, room);
    if (placed.res)
        return placed.res;
    const answer = id => json(200, { match: placed.match, secs: placed.secs, left: placed.left, ...(id ? { id } : {}) });
    if (!post || placed.id)
        return answer(placed.id);

    let form;
    try {
        form = await request.formData();
    } catch (e) {
        return refuse(400, "form");
    }
    const files = [];
    for (const [name, max, edge] of [["full", SHOTS.bytes, SHOTS.edge], ["thumb", SHOTS.thumbBytes, SHOTS.thumbEdge]]) {
        const f = form.get(name);
        if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function")
            return refuse(400, "fields");
        if (f.size > max)
            return refuse(413, "big");
        const bytes = new Uint8Array(await f.arrayBuffer());
        const size = jpegSize(bytes);
        if (!size)
            return refuse(415, "jpeg");
        if (Math.max(size.w, size.h) > edge || Math.min(size.w, size.h) < (name === "full" ? MIN_EDGE : 1))
            return refuse(415, "size");
        files.push({ bytes, ...size });
    }
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, "0")).join("");
    const keys = objectKeys(placed.match, id);
    const [full, thumb] = files;
    const gone = () => env.SHOTS.delete(keys).catch(() => {});
    // The bytes first: a row always has its picture. What's put for a row
    // that then isn't made is deleted again.
    try {
        await Promise.all(files.map((f, i) => env.SHOTS.put(keys[i], f.bytes, { httpMetadata: { contentType: "image/jpeg" } })));
    } catch (e) {
        console.log(`ladder: a picture for match ${placed.match} wasn't stored (${e && e.message || e})`);
        await gone();
        return refuse(503, "store");
    }
    const size = full.bytes.length + thumb.bytes.length;
    try {
        // The limits again, in the statement that makes the row, so two
        // pictures sent at once can't both be the last one let in. One
        // final a match is the table's own rule (match_shots_final). The
        // lobby's total goes up with the row, in the same transaction.
        const [made, , total] = await db.batch([
            db.prepare(
                `INSERT INTO match_shots (id, match_id, slot, player_id, taken, secs, final, w, h, bytes, thumb_bytes, added_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                 WHERE (SELECT bytes FROM shot_total WHERE id = 1) < ?
                   AND (? = 1 OR ((SELECT COUNT(*) FROM match_shots WHERE match_id = ? AND player_id = ? AND final = 0) < ?
                                  AND (SELECT COUNT(*) FROM match_shots WHERE match_id = ? AND final = 0) < ?))
                 RETURNING id`)
                .bind(id, placed.match, placed.slot, placed.player, taken, placed.secs, final ? 1 : 0, full.w, full.h,
                      full.bytes.length, thumb.bytes.length, now, room,
                      final ? 1 : 0, placed.match, placed.player, SHOTS.perPlayer, placed.match, SHOTS.perMatch),
            db.prepare("UPDATE shot_total SET bytes = bytes + ? WHERE id = 1 AND EXISTS (SELECT 1 FROM match_shots WHERE id = ?)")
                .bind(size, id),
            db.prepare("SELECT bytes FROM shot_total WHERE id = 1"),
        ]);
        if (!made.results[0]) {
            await gone();
            return (total.results[0] ? total.results[0].bytes : 0) >= room ? refuse(507, "room") : refuse(409, "full");
        }
    } catch (e) {
        await gone();
        if (!/UNIQUE/i.test(String(e && e.message)))
            throw e;
        // The same picture sent twice at once, or another game's final
        // scoreboard a moment sooner.
        const have = await db.prepare("SELECT id FROM match_shots WHERE match_id = ? AND player_id = ? AND taken = ?")
            .bind(placed.match, placed.player, taken).first();
        return have ? answer(have.id) : refuse(409, "have");
    }
    console.log(`ladder: match ${placed.match}: a ${final ? "final scoreboard" : "picture"} from slot ${placed.slot}, ` +
                `${full.w}x${full.h}, ${size} bytes`);
    return answer(id);
}

// DELETE /ladder/shot/<id>: by the player it's of, from any of their keys.
async function removeShot(request, env, id) {
    if (request.method !== "DELETE")
        return new Response("DELETE here", { status: 405, headers: { Allow: "DELETE" } });
    if (!sameSite(request))
        return refuse(403, "site");
    const key = cookieKey(request);
    if (!key)
        return refuse(401, "key");
    const db = env.LADDER;
    const shot = await db.prepare(
        `SELECT s.match_id FROM match_shots s JOIN players sp ON sp.id = s.player_id
                JOIN players p ON COALESCE(p.merged_into, p.id) = COALESCE(sp.merged_into, sp.id)
         WHERE s.id = ? AND p.key_hash = ?`).bind(id, await hashKey(key)).first();
    if (!shot)
        return refuse(404, "none");
    // The row first: the page stops showing it at once, whatever becomes of
    // the bytes. The lobby's total goes down with it.
    await db.batch([
        db.prepare(`UPDATE shot_total SET bytes = MAX(0, bytes - COALESCE((SELECT bytes + thumb_bytes FROM match_shots WHERE id = ?), 0))
                    WHERE id = 1`).bind(id),
        db.prepare("DELETE FROM match_shots WHERE id = ?").bind(id),
    ]);
    try {
        await env.SHOTS.delete(objectKeys(shot.match_id, id));
    } catch (e) {
        console.log(`ladder: match ${shot.match_id}: picture ${id} is off its page, but its bytes weren't deleted (${e && e.message || e})`);
    }
    return json(200, { gone: id });
}

// GET /shot/<id>.jpg and /shot/<id>.t.jpg. Asked of D1 each time, so a
// picture or a match hidden by hand is gone from here at once.
async function serveShot(request, env, id, small) {
    if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const none = () => new Response("No such picture", { status: 404, headers: { "Cache-Control": "no-store" } });
    const shot = await env.LADDER.prepare(
        `SELECT s.match_id FROM match_shots s JOIN matches m ON m.id = s.match_id
         WHERE s.id = ? AND s.hidden = 0 AND m.hidden = 0`).bind(id).first();
    if (!shot)
        return none();
    const seen = (request.headers.get("If-None-Match") || "").replace(/^W\//, "").replace(/^"|"$/g, "");
    const name = objectKeys(shot.match_id, id)[small ? 1 : 0];
    const head = request.method === "HEAD";
    const obj = head ? await env.SHOTS.head(name)
                     : await env.SHOTS.get(name, seen ? { onlyIf: { etagDoesNotMatch: seen } } : undefined);
    if (!obj)
        return none();
    const headers = {
        "Content-Type": "image/jpeg",
        ETag: obj.httpEtag,
        // A day in the browser: a picture taken off is gone from the page
        // at once, and from a browser that showed it by the next day.
        "Cache-Control": "public, max-age=86400",
        // An image and nothing else, wherever it's opened.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Robots-Tag": "noindex",
    };
    // The browser's copy is this one.
    if (!head && !obj.body)
        return new Response(null, { status: 304, headers });
    headers["Content-Length"] = String(obj.size);
    return new Response(head ? null : obj.body, { status: 200, headers });
}

// The Worker's routes: null for any other path, and for all of them when
// the lobby takes no pictures.
export async function shotRoute(request, env, url) {
    const path = url.pathname;
    if (!(path === "/ladder/shot" || path.startsWith("/ladder/shot/") || path.startsWith("/shot/")) || !shotsOn(env))
        return null;
    const now = Date.now();
    const served = /^\/shot\/([0-9a-f]{24})(\.t)?\.jpg$/.exec(path);
    const removed = /^\/ladder\/shot\/([0-9a-f]{24})$/.exec(path);
    if (path !== "/ladder/shot" && !served && !removed)
        return null;
    const answer = () => served ? serveShot(request, env, served[1], !!served[2])
                       : removed ? removeShot(request, env, removed[1]) : takeShot(request, env, url, now);
    try {
        try {
            return await answer();
        } catch (e) {
            // A database from before the pictures has no table for them, and
            // a request can only be read once.
            if (!/no such table/i.test(String(e && e.message)) || (request.method === "POST" && request.bodyUsed))
                throw e;
            await ensureSchema(env.LADDER);
            return await answer();
        }
    } catch (e) {
        console.log(`ladder: ${request.method} ${path} failed (${e && e.message || e})`);
        return served ? new Response("The picture can't be read right now", { status: 503, headers: { "Cache-Control": "no-store" } })
                      : refuse(503, "busy");
    }
}

// A match's pictures for its page, the final scoreboard first, then as they
// were taken. rec is the record of the player who sent each, who may take it
// off again (removeShot).
export function shotsQuery(db, match) {
    return db.prepare(`SELECT s.id, s.slot, s.secs, s.final, s.w, s.h, COALESCE(sp.merged_into, sp.id) AS rec
                       FROM match_shots s LEFT JOIN players sp ON sp.id = s.player_id
                       WHERE s.match_id = ? AND s.hidden = 0 ORDER BY s.final DESC, s.secs, s.added_at, s.id LIMIT ?`)
        .bind(match, SHOTS.perMatch + 1);
}
