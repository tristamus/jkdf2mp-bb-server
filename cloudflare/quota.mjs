// How much of the Workers Free plan's daily Durable Objects requests the
// lobby has used today, what's left until the 00:00 UTC reset, and how many
// hours of play that is at the rate matches used lately. Needs Node.js 22.
//
//   node quota.mjs [--days 7] [--since 2026-10-21T05:00Z] [--busy 60]
//                  [--schema] [--json out.json]
//
// The numbers come from Cloudflare's GraphQL Analytics API, which the
// dashboard's charts are drawn from. Credentials, the first one there:
// - CF_ANALYTICS_TOKEN, an API token with only Account Analytics Read
// - wrangler's login in this folder (npx wrangler auth token), the one that
//   deploys the lobby. It's only used to read analytics here.
// - none, for a cloud session whose network secret adds the token to every
//   request for api.cloudflare.com
// CF_ACCOUNT_ID picks the account, or else wrangler's cached account, or the
// token's only account. The limits are per account, so it counts the whole
// account's Durable Objects and Workers, and says if anything besides the
// lobby used them.
//
// How Cloudflare counts, from
// https://developers.cloudflare.com/durable-objects/platform/pricing/:
// 100,000 Durable Objects requests a day on the free plan, reset at 00:00 UTC,
// past which requests fail until the reset. A WebSocket connection, an alarm
// and every 20 incoming WebSocket messages are a request each; outgoing
// messages and protocol pings are free. Analytics count every incoming
// message (the 20 to 1 is for billing only), and with the hibernation API
// they're in durableObjectsInvocationsAdaptiveGroups with the alarms and
// connections (metrics-and-analytics on the same site).
//
// The hours of play come from the rate measured in "busy" minutes, those with
// at least --busy raw requests (60, one a second, by default), which only
// matches reach: a lobby with nobody playing gets an alarm a minute and the
// odd command, and its pings are answered by Cloudflare without counting.
// --since measures only from a time on, such as a deploy that changed how
// much the game sends.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Node's fetch only uses HTTPS_PROXY (as in a cloud session) when asked to.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
    });
    process.exit(r.status ?? 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.cloudflare.com/client/v4";
const FREE_REQUESTS = 100000;
const FREE_DURATION_GBS = 13000;
const FREE_ROWS_READ = 5000000;
const FREE_ROWS_WRITTEN = 100000;
const FREE_WORKER_REQUESTS = 100000;
const MESSAGES_PER_REQUEST = 20;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const INV = "durableObjectsInvocationsAdaptiveGroups";
const PER = "durableObjectsPeriodicGroups";
const WRK = "workersInvocationsAdaptive";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i < 0 ? fallback : args[i + 1];
};
const DAYS = Number(opt("days", 7));
const SINCE = opt("since", null);
const BUSY = Number(opt("busy", 60));
const JSON_OUT = opt("json", null);
const SHOW_SCHEMA = args.includes("--schema");

const n = x => Math.round(x).toLocaleString("en-US");
const pct = (x, of) => (100 * x / of).toFixed(x / of < 0.1 ? 1 : 0) + "%";
const hours = h => h >= 1 ? `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")} min` : `${Math.round(h * 60)} min`;
const pacific = d => d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const PROXIED = !!(process.env.HTTPS_PROXY || process.env.https_proxy);

function credentials() {
    if (process.env.CF_ANALYTICS_TOKEN)
        return { how: "CF_ANALYTICS_TOKEN", token: process.env.CF_ANALYTICS_TOKEN };
    const wrangler = join(HERE, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!existsSync(wrangler))
        return { how: "the network's secret (no token here)", token: null, why: "no wrangler in " + HERE };
    const r = spawnSync(process.execPath, [wrangler, "auth", "token", "--json"], {
        cwd: HERE, encoding: "utf8", timeout: 120000, windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    const m = /"token":\s*"([^"]+)"/.exec(r.stdout || "");
    if (m)
        return { how: "wrangler's login", token: m[1] };
    // What wrangler said, without anything that could be a token.
    const why = `${r.error ? r.error.message : "exit " + r.status}: ${r.stderr || ""} ${r.stdout || ""}`
        .replace(/\x1b\[[0-9;]*m/g, "").replace(/[A-Za-z0-9._~+\/=-]{24,}/g, "<hidden>")
        .replace(/\s+/g, " ").trim().slice(0, 400);
    return { how: "the network's secret (no token here)", token: null, why };
}

const cred = credentials();
const headers = { "content-type": "application/json" };
if (cred.token)
    headers.authorization = "Bearer " + cred.token;

async function rest(path) {
    const r = await fetch(API + path, { headers });
    const j = await r.json().catch(() => null);
    if (!j || !j.success)
        throw new Error(`${path}: HTTP ${r.status} ${j ? JSON.stringify(j.errors) : ""}`);
    return j.result;
}

async function gql(query, variables = {}) {
    const r = await fetch(API + "/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null);
    if (!j)
        throw new Error(`GraphQL: HTTP ${r.status}`);
    if (j.errors && j.errors.length)
        throw new Error("GraphQL: " + j.errors.map(e => e.message).join("; "));
    if (!j.data)
        throw new Error(`GraphQL: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return j.data;
}

async function accountId() {
    if (process.env.CF_ACCOUNT_ID)
        return process.env.CF_ACCOUNT_ID;
    const cache = join(HERE, "node_modules", ".cache", "wrangler", "wrangler-account.json");
    if (existsSync(cache)) {
        try {
            const id = JSON.parse(readFileSync(cache, "utf8")).account.id;
            if (id)
                return id;
        } catch (e) {}
    }
    const accounts = await rest("/accounts?per_page=50");
    if (accounts.length !== 1)
        throw new Error(`The token reaches ${accounts.length} accounts: set CF_ACCOUNT_ID to one of ${accounts.map(a => a.id).join(", ")}`);
    return accounts[0].id;
}

// The schema, by introspection: for each dataset its filter's fields and the
// fields of each of its parts (dimensions, sum, max, ...). Cloudflare adds
// and renames fields now and then, so the queries use what's there.
const unwrap = t => { while (t && !t.name) t = t.ofType; return t && t.name; };
const TYPE_REF = "name kind ofType { name kind ofType { name kind ofType { name kind } } }";
async function types(names) {
    const q = names.map((name, i) => `t${i}: __type(name: ${JSON.stringify(name)}) {
        name fields { name type { ${TYPE_REF} } args { name type { ${TYPE_REF} } } } inputFields { name } }`).join("\n");
    const data = await gql(`{ ${q} }`);
    return names.map((_, i) => data["t" + i]);
}

async function schema() {
    const [viewer] = await types(["viewer"]);
    const [account] = await types([unwrap(viewer.fields.find(f => f.name === "accounts").type)]);
    const sets = {};
    for (const name of [INV, PER, WRK, "settings"]) {
        const f = account.fields.find(x => x.name === name);
        if (!f)
            continue;
        const filter = f.args.find(a => a.name === "filter");
        sets[name] = { type: unwrap(f.type), filterType: filter ? unwrap(filter.type) : null };
    }
    const first = Object.values(sets).flatMap(s => [s.type, s.filterType]).filter(Boolean);
    const found = new Map((await types(first)).filter(Boolean).map(t => [t.name, t]));
    const parts = [];
    for (const [name, s] of Object.entries(sets)) {
        const t = found.get(s.type);
        s.filter = new Set(((found.get(s.filterType) || {}).inputFields || []).map(x => x.name));
        s.parts = {};
        for (const f of (t && t.fields) || []) {
            s.parts[f.name] = unwrap(f.type);
            parts.push(unwrap(f.type));
        }
        if (name === "settings")
            s.fields = new Set(((t && t.fields) || []).map(f => f.name));
    }
    const partTypes = new Map((await types([...new Set(parts)])).filter(Boolean).map(t => [t.name, t]));
    for (const s of Object.values(sets)) {
        for (const [part, typeName] of Object.entries(s.parts)) {
            const t = partTypes.get(typeName);
            s.parts[part] = new Set(t && t.fields ? t.fields.map(f => f.name) : []);
        }
    }
    return sets;
}

// The first of these fields that's there.
const pick = (set, ...names) => names.find(x => set && set.has(x)) || null;

function timeFilter(s, from, to) {
    if (s.filter.has("datetime_geq") && s.filter.has("datetime_lt"))
        return { datetime_geq: iso(from), datetime_lt: iso(to) };
    if (s.filter.has("datetimeMinute_geq") && s.filter.has("datetimeMinute_lt"))
        return { datetimeMinute_geq: iso(from), datetimeMinute_lt: iso(to) };
    throw new Error("No datetime filter on this dataset: " + [...s.filter].slice(0, 20).join(", "));
}

// One account dataset over [from, to), grouped by dims, with the fields wanted
// from each part ({sum: [...], max: [...]}), in pages of a day or less.
async function rows(acct, s, name, from, to, dims, want, maxSpan) {
    const select = Object.entries(want).filter(([, f]) => f.length).map(([part, f]) => `${part} { ${f.join(" ")} }`).join(" ");
    const out = [];
    for (let a = from; a < to; a = new Date(a.getTime() + maxSpan)) {
        const b = new Date(Math.min(to.getTime(), a.getTime() + maxSpan));
        const data = await gql(`query ($acct: string!, $filter: ${s.filterType}!) {
            viewer { accounts(filter: {accountTag: $acct}) {
                rows: ${name}(limit: 10000, filter: $filter) { ${dims.length ? `dimensions { ${dims.join(" ")} }` : ""} ${select} }
            } }
        }`, { acct, filter: timeFilter(s, a, b) });
        out.push(...data.viewer.accounts[0].rows);
    }
    return out;
}

const sum = (list, part, field) => list.reduce((t, r) => t + ((r[part] && r[part][field]) || 0), 0);

async function main() {
    if (!cred.token && !PROXIED)
        throw new Error(`couldn't get wrangler's login (${cred.why}). Run "npx wrangler login" in this folder, ` +
            "or set CF_ANALYTICS_TOKEN to an API token with Account Analytics Read.");
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const reset = new Date(dayStart.getTime() + DAY);
    const acct = await accountId();
    const sets = await schema();
    if (SHOW_SCHEMA) {
        for (const [name, s] of Object.entries(sets)) {
            console.log(`${name}: filter ${[...s.filter].filter(f => !/_(geq|gt|leq|lt|neq|in|notin|like|notlike|has|hasall|hasany)$/.test(f)).join(", ")}`);
            for (const [part, fields] of Object.entries(s.parts))
                console.log(`  ${part}: ${[...fields].join(", ")}`);
        }
    }
    const inv = sets[INV], per = sets[PER], wrk = sets[WRK];
    if (!inv)
        throw new Error(`This account's analytics have no ${INV}`);
    // How long one query may span and how far back data goes, on this plan.
    let span = DAY, oldest = 0;
    const st = sets.settings;
    if (st && st.fields && st.fields.has(INV) && st.parts[INV] && st.parts[INV].has("maxDuration")) {
        const lim = (await gql(`query ($acct: string!) { viewer { accounts(filter: {accountTag: $acct}) {
            settings { ${INV} { maxDuration ${st.parts[INV].has("notOlderThan") ? "notOlderThan" : ""} } } } } }`,
            { acct })).viewer.accounts[0].settings[INV];
        if (lim && lim.maxDuration)
            span = Math.min(DAY, lim.maxDuration * 1000);
        if (lim && lim.notOlderThan)
            oldest = now.getTime() - lim.notOlderThan * 1000 + MINUTE;
    }

    // Today, by namespace (and whatever says what kind of request each was).
    const nsDim = pick(inv.parts.dimensions, "namespaceId");
    const kindDim = pick(inv.parts.dimensions, "type", "eventType", "invocationType", "requestType", "trigger");
    const invToday = await rows(acct, inv, INV, dayStart, now, [nsDim, kindDim].filter(Boolean),
        { sum: [pick(inv.parts.sum, "requests"), pick(inv.parts.sum, "errors")].filter(Boolean) }, span);
    const perFields = ["inboundWebsocketMsgCount", "outboundWebsocketMsgCount", "duration", "activeTime",
        "rowsRead", "rowsWritten", "storageReadUnits", "storageWriteUnits"].filter(f => per && per.parts.sum && per.parts.sum.has(f));
    const perToday = per ? await rows(acct, per, PER, dayStart, now, [], { sum: perFields }, span) : [];
    const wrkReq = wrk && pick(wrk.parts.sum, "requests");
    const wrkToday = wrkReq ? await rows(acct, wrk, WRK, dayStart, now, pick(wrk.parts.dimensions, "scriptName") ? ["scriptName"] : [],
        { sum: [wrkReq] }, span) : [];

    const raw = sum(invToday, "sum", "requests");
    const errors = sum(invToday, "sum", "errors");
    const inbound = sum(perToday, "sum", "inboundWebsocketMsgCount");
    const namespaces = [...new Set(invToday.map(r => r.dimensions && r.dimensions[nsDim]).filter(Boolean))];

    // Which of the raw requests are incoming messages.
    let messages, how;
    const kinds = {};
    if (kindDim) {
        for (const r of invToday)
            kinds[r.dimensions[kindDim]] = (kinds[r.dimensions[kindDim]] || 0) + r.sum.requests;
        const msgKinds = Object.keys(kinds).filter(k => /websocket.*message|message/i.test(k));
        messages = msgKinds.reduce((t, k) => t + kinds[k], 0);
        how = `${kindDim} says which are messages (${Object.entries(kinds).map(([k, v]) => `${k} ${n(v)}`).join(", ")})`;
    } else if (inbound > 0 && inbound <= raw) {
        messages = inbound;
        how = `${PER} counted ${n(inbound)} incoming messages`;
    } else {
        messages = null;
    }

    // Per minute, to measure how fast matches use requests.
    // From today's start too, for the estimate of today when it needs them.
    const lookFrom = new Date(Math.max(oldest, SINCE ? new Date(SINCE).getTime() : now.getTime() - DAYS * DAY));
    const minFrom = new Date(Math.min(lookFrom.getTime(), dayStart.getTime()));
    const minDim = pick(inv.parts.dimensions, "datetimeMinute");
    const invMin = await rows(acct, inv, INV, minFrom, now, [minDim], { sum: ["requests"] }, span);
    const connMax = per && pick(per.parts.max, "activeWebsocketConnections", "websocketConnections");
    const perMinDim = per && pick(per.parts.dimensions, "datetimeMinute");
    const perMin = per && perMinDim ? await rows(acct, per, PER, minFrom, now, [perMinDim],
        { sum: perFields.filter(f => /WebsocketMsgCount$/.test(f)), max: connMax ? [connMax] : [] }, span) : [];
    const minutes = new Map();
    for (const r of invMin) {
        const m = minutes.get(r.dimensions[minDim]) || { raw: 0, inbound: 0, conns: null };
        m.raw += r.sum.requests;
        minutes.set(r.dimensions[minDim], m);
    }
    for (const r of perMin) {
        const m = minutes.get(r.dimensions[perMinDim]) || { raw: 0, inbound: 0, conns: null };
        m.inbound += (r.sum && r.sum.inboundWebsocketMsgCount) || 0;
        if (connMax && r.max)
            m.conns = Math.max(m.conns || 0, r.max[connMax] || 0);
        minutes.set(r.dimensions[perMinDim], m);
    }
    // A minute's requests as billed: its messages at 20 to one, the rest
    // (connections, alarms) at one each. Without a count of its messages, all
    // but one request a minute (an alarm) is taken to be a message.
    const billed = m => {
        const msgs = messages === null || !m.inbound ? Math.max(0, m.raw - 1) : Math.min(m.inbound, m.raw);
        return m.raw - msgs + msgs / MESSAGES_PER_REQUEST;
    };
    const everything = [...minutes.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const all = everything.filter(([k]) => new Date(k) >= lookFrom);
    const busy = all.filter(([, m]) => m.raw >= BUSY);
    const connGroup = m => m.conns === null ? "?" : m.conns <= 2 ? String(m.conns) : m.conns <= 4 ? "3-4" : "5+";
    const byConns = {};
    for (const [, m] of busy) {
        const k = connGroup(m);
        (byConns[k] = byConns[k] || { minutes: 0, billed: 0 }).minutes++;
        byConns[k].billed += billed(m);
    }
    // The rate for 3 to 4 players: from minutes with 3 or 4 connections when
    // there are at least 15 of them, else from every busy minute.
    const few = byConns["3-4"] && byConns["3-4"].minutes >= 15;
    const used = few ? busy.filter(([, m]) => connGroup(m) === "3-4") : busy;
    const ratePerHour = used.length ? 60 * used.reduce((t, [, m]) => t + billed(m), 0) / used.length : null;
    const hist = [[0, 0], [1, 9], [10, 59], [60, 599], [600, 5999], [6000, Infinity]].map(([lo, hi]) =>
        [lo === hi ? `${lo}` : hi === Infinity ? `${n(lo)}+` : `${n(lo)}-${n(hi)}`, all.filter(([, m]) => m.raw >= lo && m.raw <= hi).length]);

    // Today as billed.
    let billedToday, todayNote;
    if (messages !== null) {
        billedToday = raw - messages + messages / MESSAGES_PER_REQUEST;
        todayNote = `${n(messages)} incoming messages count ${n(messages / MESSAGES_PER_REQUEST)}, ` +
            `${n(raw - messages)} connections and alarms count one each (${how})`;
    } else {
        const today = everything.filter(([k]) => new Date(k) >= dayStart);
        billedToday = today.reduce((t, [, m]) => t + billed(m), 0);
        todayNote = `estimated: Cloudflare doesn't say which of today's ${n(raw)} raw requests were messages, ` +
            `so all but one a minute (the alarm) are taken to be; at most ${n(raw)} if none were`;
    }
    const left = Math.max(0, FREE_REQUESTS - billedToday);
    const untilReset = (reset - now) / (60 * MINUTE);

    const L = [];
    L.push(`Lobby quota at ${pacific(now)} (${iso(now)})`);
    L.push("");
    L.push(`Durable Objects requests today (since ${pacific(dayStart)}):`);
    L.push(`  used ${n(billedToday)} of ${n(FREE_REQUESTS)} (${pct(billedToday, FREE_REQUESTS)}), ${n(left)} left`);
    L.push(`  ${todayNote}`);
    if (errors)
        L.push(`  ${n(errors)} requests failed today${billedToday >= FREE_REQUESTS ? ", probably from the limit" : ""}`);
    L.push(`  resets in ${hours(untilReset)}, at ${pacific(reset)}`);
    if (namespaces.length > 1)
        L.push(`  note: ${namespaces.length} Durable Object namespaces used requests today, and they share the limit`);
    L.push("");
    if (ratePerHour === null) {
        L.push(`No busy minutes (${BUSY}+ raw requests) since ${iso(lookFrom)}, so there's no measured rate yet.`);
    } else {
        const first = used[0][0], last = used[used.length - 1][0];
        L.push(`Rate while matches run: ${n(ratePerHour)} requests an hour, measured over ${used.length} busy minutes ` +
            `(${BUSY}+ raw requests each)${few ? " with 3 or 4 connections" : ", any number of players"}, between ${first} and ${last}.`);
        const keys = Object.keys(byConns).sort();
        if (!(keys.length === 1 && keys[0] === "?"))
            L.push(`  by connections to the lobby in the minute (players' games plus open landing pages): ` +
                keys.map(k => `${k}: ${n(60 * byConns[k].billed / byConns[k].minutes)}/h over ${byConns[k].minutes} min`).join("; "));
        const left_h = left / ratePerHour;
        L.push(`  at that rate, ${n(left)} requests is ${hours(left_h)} of play` +
            (left_h >= untilReset ? `, more than the ${hours(untilReset)} until the reset: playing nonstop until then fits.`
                                  : `, less than the ${hours(untilReset)} until the reset: nonstop play would run out at ${pacific(new Date(now.getTime() + left_h * 60 * MINUTE))}.`));
        L.push(`  a full day of nonstop play would use ${n(24 * ratePerHour)} requests (${pct(24 * ratePerHour, FREE_REQUESTS)} of a day's quota), ` +
            `so a day fits ${hours(FREE_REQUESTS / ratePerHour)} of play.`);
    }
    L.push(`  raw requests a minute, over the ${n(all.length)} minutes with any since ${iso(lookFrom)}: ` +
        hist.map(([k, v]) => `${k}: ${v}`).join(", "));
    L.push("");
    const other = [];
    const dur = sum(perToday, "sum", "duration");
    if (perFields.includes("duration"))
        other.push(`duration ${n(dur)} of ${n(FREE_DURATION_GBS)} GB-s`);
    if (perFields.includes("rowsRead"))
        other.push(`rows read ${n(sum(perToday, "sum", "rowsRead"))} of ${n(FREE_ROWS_READ)}`);
    if (perFields.includes("rowsWritten"))
        other.push(`rows written ${n(sum(perToday, "sum", "rowsWritten"))} of ${n(FREE_ROWS_WRITTEN)}`);
    if (wrkReq) {
        const w = sum(wrkToday, "sum", wrkReq);
        other.push(`Worker requests ${n(w)} of ${n(FREE_WORKER_REQUESTS)}` +
            (wrkToday.some(r => r.dimensions && r.dimensions.scriptName) ? ` (${wrkToday.map(r => `${r.dimensions.scriptName} ${n(r.sum[wrkReq])}`).join(", ")})` : ""));
    }
    if (other.length)
        L.push(`Other free limits today: ${other.join("; ")}.`);
    L.push(`Read with ${cred.how}.`);
    console.log(L.join("\n"));

    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify({
            now: iso(now), account: acct, billedToday, raw, errors, inbound, messages, how, kinds, namespaces,
            perToday, wrkToday, ratePerHour, busyMinutes: busy.length, rateMinutes: used.length, byConns, hist,
            schema: Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, {
                filter: [...s.filter], parts: Object.fromEntries(Object.entries(s.parts).map(([p, f]) => [p, [...f]])),
            }])),
            minutes: all,
        }, null, 1));
    }
}

main().catch(e => {
    console.error("quota: " + e.message);
    // Not process.exit(), which can trip an assertion in Node on Windows
    // while fetch's connections close.
    process.exitCode = 1;
});
