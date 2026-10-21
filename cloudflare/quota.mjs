// How much of the Workers Free plan's daily Durable Objects requests the
// lobby has used today, what's left until the 00:00 UTC reset, and how many
// hours of play that is at the rates matches used lately. Needs Node.js 22.
//
//   node quota.mjs [--days 7] [--since 2026-10-21T05:00Z] [--busy 60] [--json out.json]
//
// The numbers come from Cloudflare's GraphQL Analytics API, which the
// dashboard's charts are drawn from. Credentials, the first one there:
// - CF_ANALYTICS_TOKEN, an API token with only Account Analytics Read
// - wrangler's login in this folder (wrangler auth token), the one that
//   deploys the lobby. It's only used to read analytics here.
// - none, for a cloud session whose network secret adds the token to every
//   request for api.cloudflare.com
// CF_ACCOUNT_ID picks the account, or else wrangler's cached account, or the
// token's only account. The limits are per account, so it counts the whole
// account.
//
// How Cloudflare counts, from
// https://developers.cloudflare.com/durable-objects/platform/pricing/:
// 100,000 Durable Objects requests a day on the free plan, reset at 00:00 UTC,
// past which requests fail until the reset. A WebSocket connection and an
// alarm are a request each, and so is every 20 incoming WebSocket messages;
// outgoing messages and protocol pings are free. Analytics count every
// incoming message (the 20 to 1 is for billing only), and with the
// hibernation API they're invocations of type "hibernation" in
// durableObjectsInvocationsAdaptiveGroups, next to "http" (connections) and
// "alarm" (metrics-and-analytics on the same site).
//
// The hours of play come from "busy" minutes, those with at least --busy raw
// requests (60, one a second, by default), which only matches reach: a lobby
// with nobody playing gets an alarm a minute and the odd command, and its
// pings are answered by Cloudflare without counting. They're the minutes with
// 3 or 4 connections when there are 15 or more of them (each game and each
// open landing page is a connection), else all of them. --since measures only
// from a time on, such as a deploy that changed how much the game sends.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Node's fetch only uses HTTPS_PROXY (as in a cloud session) when asked to.
const PROXIED = !!(process.env.HTTPS_PROXY || process.env.https_proxy);
if (PROXIED && !process.env.NODE_USE_ENV_PROXY) {
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
const MESSAGE_TYPE = "hibernation";
const MIN_MINUTES = 15;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i < 0 ? fallback : args[i + 1];
};
const DAYS = Number(opt("days", 7));
const SINCE = opt("since", null);
const BUSY = Number(opt("busy", 60));
const JSON_OUT = opt("json", null);

const n = x => Math.round(x).toLocaleString("en-US");
const pct = (x, of) => (100 * x / of).toFixed(x / of < 0.1 ? 1 : 0) + "%";
const hours = h => h >= 1 ? `${Math.floor(h)} h ${String(Math.floor((h % 1) * 60)).padStart(2, "0")} min` : `${Math.floor(h * 60)} min`;
const pacific = d => d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function credentials() {
    if (process.env.CF_ANALYTICS_TOKEN)
        return { how: "CF_ANALYTICS_TOKEN", token: process.env.CF_ANALYTICS_TOKEN };
    const wrangler = join(HERE, "node_modules", "wrangler", "bin", "wrangler.js");
    if (!existsSync(wrangler))
        return { how: "the network's secret", token: null, why: "no wrangler in " + HERE };
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
    return { how: "the network's secret", token: null, why };
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

async function gql(query, variables) {
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

// A dataset's groups over [from, to), a day per query: a minute's groups for
// a day stay under the 10,000 a query returns.
async function rows(acct, dataset, from, to, fields) {
    const out = [];
    for (let a = from; a < to; a = new Date(a.getTime() + DAY)) {
        const b = new Date(Math.min(to.getTime(), a.getTime() + DAY));
        const data = await gql(`query ($acct: string!, $from: Time!, $to: Time!) {
            viewer { accounts(filter: {accountTag: $acct}) {
                rows: ${dataset}(limit: 10000, filter: {datetime_geq: $from, datetime_lt: $to}) { ${fields} }
            } }
        }`, { acct, from: iso(a), to: iso(b) });
        out.push(...data.viewer.accounts[0].rows);
    }
    return out;
}

// Requests as billed: incoming messages at 20 to one, the rest one each.
const billed = (messages, other) => other + messages / MESSAGES_PER_REQUEST;

async function main() {
    if (!cred.token && !PROXIED)
        throw new Error(`couldn't get wrangler's login (${cred.why}). Run "npx wrangler login" in this folder, ` +
            "or set CF_ANALYTICS_TOKEN to an API token with Account Analytics Read.");
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const reset = new Date(dayStart.getTime() + DAY);
    const lookFrom = SINCE ? new Date(SINCE) : new Date(now.getTime() - DAYS * DAY);
    const acct = await accountId();

    const today = await rows(acct, "durableObjectsInvocationsAdaptiveGroups", dayStart, now,
        "dimensions { type status scriptName } sum { requests }");
    const storage = await rows(acct, "durableObjectsPeriodicGroups", dayStart, now,
        "sum { duration rowsRead rowsWritten }");
    const workers = await rows(acct, "workersInvocationsAdaptive", dayStart, now,
        "dimensions { scriptName } sum { requests }");
    const invMin = await rows(acct, "durableObjectsInvocationsAdaptiveGroups", lookFrom, now,
        "dimensions { datetimeMinute type } sum { requests }");
    const perMin = await rows(acct, "durableObjectsPeriodicGroups", lookFrom, now,
        "dimensions { datetimeMinute } max { activeWebsocketConnections }");

    let messages = 0, other = 0;
    const types = {}, failed = {}, scripts = new Set();
    for (const r of today) {
        const { type, status, scriptName } = r.dimensions;
        types[type] = (types[type] || 0) + r.sum.requests;
        if (type === MESSAGE_TYPE)
            messages += r.sum.requests;
        else
            other += r.sum.requests;
        if (status !== "success")
            failed[`${type} ${status}`] = (failed[`${type} ${status}`] || 0) + r.sum.requests;
        scripts.add(scriptName);
    }
    const used = billed(messages, other);
    const left = Math.max(0, FREE_REQUESTS - used);
    const untilReset = (reset - now) / HOUR;

    const minutes = new Map();
    const minute = k => minutes.get(k) || minutes.set(k, { raw: 0, messages: 0, conns: null }).get(k);
    for (const r of invMin) {
        const m = minute(r.dimensions.datetimeMinute);
        m.raw += r.sum.requests;
        if (r.dimensions.type === MESSAGE_TYPE)
            m.messages += r.sum.requests;
    }
    for (const r of perMin) {
        const m = minute(r.dimensions.datetimeMinute);
        m.conns = Math.max(m.conns || 0, r.max.activeWebsocketConnections || 0);
    }
    const busy = [...minutes.entries()].filter(([, m]) => m.raw >= BUSY).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const few = busy.filter(([, m]) => m.conns >= 3 && m.conns <= 4);
    const sample = few.length >= MIN_MINUTES ? few : busy;
    // An hour's worth at each busy minute's rate, lowest first.
    const rates = sample.map(([, m]) => 60 * billed(m.messages, m.raw - m.messages)).sort((a, b) => a - b);
    const at = q => rates[Math.floor(q * (rates.length - 1))];
    const mean = rates.reduce((t, x) => t + x, 0) / rates.length;

    const L = [];
    L.push(`Lobby quota at ${pacific(now)} (${iso(now)})`);
    L.push("");
    L.push(`Today since ${pacific(dayStart)}: ${n(used)} of ${n(FREE_REQUESTS)} Durable Objects requests used ` +
        `(${pct(used, FREE_REQUESTS)}), ${n(left)} left.`);
    L.push(`  ${n(messages)} incoming WebSocket messages count as ${n(messages / MESSAGES_PER_REQUEST)} (20 to 1); ` +
        `${n(other)} others (${Object.entries(types).filter(([t]) => t !== MESSAGE_TYPE).map(([t, v]) => `${t} ${n(v)}`).join(", ")}) count 1 each.`);
    if (Object.keys(failed).length)
        L.push(`  Not "success": ${Object.entries(failed).map(([k, v]) => `${k} ${n(v)}`).join(", ")}.`);
    if (scripts.size > 1)
        L.push(`  Workers whose Durable Objects used requests today, sharing the limit: ${[...scripts].join(", ")}.`);
    L.push(`  Resets in ${hours(untilReset)}, at ${pacific(reset)}.`);
    L.push("");
    if (!rates.length) {
        L.push(`No busy minutes (${BUSY}+ raw requests) since ${iso(lookFrom)}, so there's no measured rate yet.`);
    } else {
        const playLeft = rate => {
            const h = left / rate;
            return h >= untilReset ? `${hours(h)}, past the reset` : `${hours(h)}, until ${pacific(new Date(now.getTime() + h * HOUR))}`;
        };
        L.push(`Play left, at the rates of ${rates.length} busy minutes ` +
            `${sample === few ? "with 3 or 4 connections" : "(too few had 3 or 4 connections, so any number)"}, ` +
            `${sample[0][0].slice(0, 10)} to ${sample[sample.length - 1][0].slice(0, 10)}:`);
        L.push(`  slowest quarter, ${n(at(0.25))} an hour or less: ${playLeft(at(0.25))}`);
        L.push(`  average, ${n(mean)} an hour: ${playLeft(mean)}`);
        L.push(`  busiest tenth, ${n(at(0.9))} an hour or more: ${playLeft(at(0.9))}`);
        L.push(`  A day of nonstop play at the average would use ${n(24 * mean)} (${pct(24 * mean, FREE_REQUESTS)} of a day's quota); ` +
            `a full day's quota covers ${hours(FREE_REQUESTS / mean)} of it.`);
    }
    L.push("");
    const s = k => storage.reduce((t, r) => t + (r.sum[k] || 0), 0);
    const w = workers.reduce((t, r) => t + r.sum.requests, 0);
    L.push(`Other free limits today: duration ${n(s("duration"))} of ${n(FREE_DURATION_GBS)} GB-s; ` +
        `rows read ${n(s("rowsRead"))} of ${n(FREE_ROWS_READ)}; rows written ${n(s("rowsWritten"))} of ${n(FREE_ROWS_WRITTEN)}; ` +
        `Worker requests ${n(w)} of ${n(FREE_WORKER_REQUESTS)}.`);
    L.push(`Read with ${cred.how}.`);
    console.log(L.join("\n"));

    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify({
            now: iso(now), used, left, messages, other, types, failed, busyMinutes: busy.length,
            sample: sample.length, rates: { p25: at(0.25), mean, p90: at(0.9) }, minutes: [...minutes.entries()].sort(),
        }, null, 1));
    }
}

main().catch(e => {
    console.error("quota: " + e.message);
    // Not process.exit(), which can trip an assertion in Node on Windows
    // while fetch's connections close.
    process.exitCode = 1;
});
