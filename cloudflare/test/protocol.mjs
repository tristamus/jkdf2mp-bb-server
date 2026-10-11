// Drives the lobby protocol with plain WebSocket clients and prints a
// transcript, to check a deployed lobby against protocol.expected.txt (made
// with `wrangler dev`). Needs Node.js 22 or newer.
//
//   node protocol.mjs wss://<host>/relay [protocol.expected.txt]
//
// With the expected transcript, it prints where they differ and exits 1 if
// they do. Run it while nobody else is hosting, or their games show up in
// the lists.
// Room ids are printed as <room1>, <room2>, ... so the transcript doesn't
// depend on how many rooms the lobby opened before.
const url = process.argv[2];
const log = [];
const rooms = new Map();
const roomName = id => rooms.get(id) || id;
const named = s => s.replace(/^(hosted|join) (\d+)/, (m, op, id) => {
  if (op === 'hosted') rooms.set(id, '<room' + (rooms.size + 1) + '>');
  return op + ' ' + roomName(id);
}).replace(/^list((?: \d+ \d+ [0-9a-fA-F]+)*)$/, (m, games) =>
  'list' + games.replace(/ (\d+) (\d+) ([0-9a-fA-F]+)/g, (g, id, n, e) => ` ${roomName(id)} ${n} ${e}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.got = [];
    ws.onmessage = ev => {
      let s;
      if (typeof ev.data === 'string') {
        s = ev.data.startsWith('ice ') ? 'ice ' + Buffer.from(ev.data.slice(4), 'base64').toString() : ev.data;
        if (s.startsWith('hosted ')) ws.room = s.split(' ')[1];
        s = named(s);
      } else {
        const v = new DataView(ev.data);
        s = `bin from=${v.getUint32(0, true)} to=${v.getUint32(4, true)} body=${Buffer.from(ev.data.slice(8)).toString()}`;
      }
      log.push(`${name} <- ${s}`);
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error(name + ' error'));
    ws.onclose = ev => log.push(`${name} closed ${ev.code}`);
  });
}
function pkt(from, to, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32LE(from, 0); b.writeUInt32LE(to, 4); b.write(body, 8);
  return b;
}
const step = async (name, ws, data) => { log.push(`${name} -> ${typeof data === 'string' ? named(data) : 'bin'}`); ws.send(data); await sleep(150); };
const H = await client('H'); await sleep(200);
await step('H', H, 'list');
await step('H', H, 'host abcd');
await step('H', H, 'update ab12');
await step('H', H, 'host zz');
await step('H', H, 'bogus');
const A = await client('A'); await sleep(200);
await step('A', A, 'list');
await step('A', A, 'join 999999');
await step('A', A, 'join ' + H.room);
await step('H', H, 'welcome 2 ab12');
const B = await client('B'); await sleep(200);
await step('B', B, 'join ' + H.room);
await step('H', H, 'welcome 3 ab12');
await step('A', A, 'signal 1 c2RwYQ==');
await step('A', A, 'signal 3 c2RwYQ==');
await step('H', H, 'signal 3 c2RwSA==');
await step('H', H, 'signal 2 bad!');
await step('A', A, pkt(77, 1, 'A to host'));
await step('A', A, pkt(77, 0, 'A to host via 0'));
await step('A', A, pkt(77, 3, 'A to B'));
await step('A', A, pkt(77, 2, 'A to self'));
await step('H', H, pkt(3, 2, 'host fwd from B to A'));
await step('H', H, pkt(1, 9, 'host to nobody'));
await step('B', B, Buffer.from('short'));
await step('A', A, 'ping');
await step('A', A, 'list');
await step('A', A, 'leave');
await step('A', A, pkt(2, 1, 'after leave'));
await step('A', A, 'join ' + H.room);
await step('H', H, 'leave');
await step('B', B, 'list');
await step('B', B, pkt(3, 1, 'no room'));
const C = await client('C'); await sleep(200);
await step('C', C, 'host 00');
await step('A', A, 'join ' + C.room);
log.push('C closes'); C.close(); await sleep(300);
await step('A', A, 'list');
log.push('big message'); A.send('x'.repeat(70000)); await sleep(400);
for (const ws of [H, B]) ws.close();
await sleep(300);
if (!process.argv[3]) {
  console.log(log.join('\n'));
  process.exit(0);
}
const { readFileSync } = await import('node:fs');
const want = readFileSync(process.argv[3], 'utf8').replace(/\r/g, '').trimEnd().split('\n');
let bad = 0;
for (let i = 0; i < Math.max(want.length, log.length); i++) {
  if (want[i] !== log[i] && bad++ < 10)
    console.log(`line ${i + 1}: expected ${JSON.stringify(want[i])}, got ${JSON.stringify(log[i])}`);
}
console.log(bad ? `${bad} line(s) differ from ${process.argv[3]}` : `same as ${process.argv[3]} (${log.length} lines)`);
process.exit(bad ? 1 : 0);
