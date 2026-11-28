// Writes src/chat-lookalikes.js, the room chat's lookalike characters
// (src/chat.js readings): each character Unicode's confusables list says looks
// like one ASCII letter, digit, dot, slash or colon, as that character, and
// the dots and slashes the list leaves out (bullets, other scripts' full
// stops, fraction and division slashes, ...).
//
//   curl -O https://www.unicode.org/Public/security/latest/confusables.txt
//   node tools/make-chat-lookalikes.mjs confusables.txt
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const text = readFileSync(file, "utf8");
const version = (/^# Version: (.*)$/m.exec(text) || [])[1] || "?";
const map = new Map();
const add = (ch, to, over = false) => {
    for (const c of new Set([ch, ch.toLowerCase()])) {
        if (c.codePointAt(0) < 128 || [...c].length !== 1 || c.normalize("NFKC").toLowerCase() === to || (map.has(c) && !over))
            continue;
        map.set(c, to);
    }
};
for (const line of text.split("\n")) {
    const m = /^([0-9A-F]+) ;\t([0-9A-F ]+) ;/.exec(line);
    if (!m)
        continue;
    const to = m[2].trim().split(" ").map(h => String.fromCodePoint(parseInt(h, 16))).join("").toLowerCase();
    if (/^[a-z0-9./:]$/.test(to))
        add(String.fromCodePoint(parseInt(m[1], 16)), to);
}
// Dots: middle dots, bullets, other scripts' full stops, the degree sign.
const DOTS = [0x00b0, 0x00b7, 0x0387, 0x0589, 0x06d4, 0x0701, 0x0702, 0x1362, 0x1427, 0x166e, 0x1803, 0x1809, 0x2022,
    0x2023, 0x2024, 0x2027, 0x2043, 0x204c, 0x204d, 0x2059, 0x2219, 0x2299, 0x22a1, 0x22c5, 0x25cf, 0x25d8, 0x25e6,
    0x2619, 0x2765, 0x2767, 0x2981, 0x29be, 0x29bf, 0x2a00, 0x2cf9, 0x2cfe, 0x2e30, 0x2e31, 0x2e33, 0x2e3c, 0x3002,
    0x30fb, 0xa4f8, 0xa4ff, 0xa60e, 0xa6f3, 0xfe12, 0xfe52, 0xff0e, 0xff61, 0xff65, 0x16af5, 0x16e98, 0x1bc9f, 0x1da88];
// Slashes: fraction, division, big and dotted solidus, box-drawing diagonal.
const SLASHES = [0x2044, 0x2215, 0x2298, 0x233f, 0x2571, 0x27cb, 0x29f8, 0x2afb, 0x2afd, 0x2e4a, 0xff0f, 0x1f67c];
// Circles for an o.
const OS = [0x25cb, 0x25ef, 0x26aa, 0x2b55, 0x3007];
// Small capitals, as their letters.
const SMALL_CAPS = "\u1d00a \u0299b \u1d04c \u1d05d \u1d07e \ua730f \u0262g \u029ch \u026ai \u1d0aj \u1d0bk \u029fl " +
    "\u1d0dm \u0274n \u1d0fo \u1d18p \ua7afq \u0280r \ua731s \u1d1bt \u1d1cu \u1d20v \u1d21w \u028fy \u1d22z";
// These win over what the confusables list says (it has some bullets as x).
for (const cp of DOTS) add(String.fromCodePoint(cp), ".", true);
for (const cp of SLASHES) add(String.fromCodePoint(cp), "/", true);
for (const cp of OS) add(String.fromCodePoint(cp), "o", true);
for (const pair of SMALL_CAPS.split(" ")) add(pair[0], pair[1], true);
const by = new Map();
for (const [ch, to] of map)
    by.set(to, (by.get(to) || "") + ch);
// Written as escapes: some of these are accents or right-to-left letters that
// would make the file hard to read.
const esc = text => JSON.stringify(text).replace(/[^\x20-\x7e]/gu, ch => {
    const cp = ch.codePointAt(0);
    return cp > 0xffff ? "\\u{" + cp.toString(16) + "}" : "\\u" + cp.toString(16).padStart(4, "0");
});
const lines = [...by].sort(([a], [b]) => a < b ? -1 : 1).map(([to, chars]) => `    [${esc(to)}, ${esc(chars)}],`);
writeFileSync(new URL("../src/chat-lookalikes.js", import.meta.url), `// Characters that look like an ASCII letter, digit, dot, slash or colon, for
// the room chat to read a web address written with them (src/chat.js): from
// Unicode's confusables list (version ${version}), and dots and slashes it
// leaves out. Made by tools/make-chat-lookalikes.mjs: run it again for a newer
// list.

const BY = [
${lines.join("\n")}
];

export const LOOKALIKES = new Map(BY.flatMap(([to, chars]) => [...chars].map(ch => [ch, to])));
`);
console.log(map.size, "characters, confusables version", version);
