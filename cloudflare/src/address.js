// An address as limits count it (wrong passwords in src/lobby.js, the room
// chat's in src/chat.js): an IPv6 one by its first 64 bits, as a home line or
// a server usually has a whole /64 to pick from. An IPv4 address, or one
// mapped into IPv6, as it is.
export function addressKey(ip) {
    if (!ip.includes(":"))
        return ip;
    let text = ip.toLowerCase().replace(/%.*$/, "");
    const v4 = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4)
        text = text.slice(0, -v4[0].length) + ((v4[1] << 8) | v4[2]).toString(16) + ":" + ((v4[3] << 8) | v4[4]).toString(16);
    const halves = text.split("::");
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
    if (halves.length > 2 || groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g)))
        return ip;
    const n = groups.map(g => parseInt(g, 16));
    if (n.slice(0, 5).every(x => !x) && n[5] === 0xffff)
        return [n[6] >> 8, n[6] & 0xff, n[7] >> 8, n[7] & 0xff].join(".");
    return n.slice(0, 4).map(x => x.toString(16)).join(":") + "::/64";
}
