// Checks where src/moved.js sends requests: page loads on the old address
// go to the same path and options on the site with "moved", www goes there as
// it is, and the lobby and the move-out page stay on every address.
//
//   node test/moved.mjs

import assert from "node:assert/strict";
import { movedTo, movedStatus } from "../src/moved.js";

const SITE = "https://jediknight.zone";
const FROM = "https://jkdf2mp.jkdf2mp-lobby.workers.dev";
const to = (address) => movedTo(new URL(address), SITE, FROM);

const cases = [
    // The old address: the page, with its options and the "moved" mark.
    [FROM + "/", SITE + "/?moved"],
    [FROM + "/?netstats", SITE + "/?netstats&moved"],
    [FROM + "/?nettest=attack&netstats", SITE + "/?nettest=attack&netstats&moved"],
    [FROM + "/index.html", SITE + "/index.html?moved"],
    [FROM + "/?", SITE + "/?moved"],
    // A room link's #room never reaches the server; the browser keeps it.
    // The lobby and the move-out page stay.
    [FROM + "/relay", null],
    [FROM + "/move-out", null],
    [FROM + "/move-out.html", null],
    // www: the same path and options, no mark (no page ever ran there).
    ["https://www.jediknight.zone/", SITE + "/"],
    ["https://www.jediknight.zone/?netstats", SITE + "/?netstats"],
    ["https://www.jediknight.zone/relay", null],
    // The site itself, and any other address (wrangler dev, a preview URL).
    [SITE + "/", null],
    [SITE + "/?moved", null],
    [SITE + "/relay", null],
    ["http://127.0.0.1:8787/", null],
    ["https://abc123-jkdf2mp.jkdf2mp-lobby.workers.dev/", null],
];

let failed = 0;
for (const [address, want] of cases) {
    try {
        assert.equal(to(address), want);
        console.log("ok   " + address + " -> " + want);
    } catch (e) {
        failed++;
        console.log("FAIL " + address + ": got " + to(address) + ", want " + want);
    }
}

// Without SITE, nothing moves.
assert.equal(movedTo(new URL(FROM + "/"), "", FROM), null);
assert.equal(movedTo(new URL(FROM + "/"), undefined, undefined), null);
// Ports count: a local stand-in for each address.
assert.equal(movedTo(new URL("http://127.0.0.1:8787/"), "http://localhost:8787", "http://127.0.0.1:8787"),
             "http://localhost:8787/?moved");

assert.equal(movedStatus("301"), 301);
assert.equal(movedStatus("302"), 302);
assert.equal(movedStatus(undefined), 302);
assert.equal(movedStatus("200"), 302);
console.log("ok   no SITE, ports, status");

if (failed) {
    console.log(failed + " failed");
    process.exit(1);
}
