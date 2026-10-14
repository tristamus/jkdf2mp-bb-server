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
// depend on how many rooms the lobby opened before. The watching page (W)
// only prints the test's own players and games (named t_...), so players
// online during a run don't show, plus "ok" when the counts add up and no
// password got out. What arrives during one
// step is listed by client (each client's lines in the order they came), since
// messages to different clients can arrive in either order over the internet.
const url = process.argv[2];
const log = [];
let pending = [];  // what clients received since the last step: [client, line]
const flush = () => {
  pending.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);  // stable: keeps each client's order
  // A status can arrive before the hosted line that names its room.
  for (const [, line] of pending) log.push(line.replace(/<room (\d+)>/g, (m, id) => roomName(id)));
  pending = [];
};
const rooms = new Map();
const roomName = id => rooms.get(id) || id;
const named = s => s.replace(/^(hosted|join) (\d+)/, (m, op, id) => {
  if (op === 'hosted') rooms.set(id, '<room' + (rooms.size + 1) + '>');
  return op + ' ' + roomName(id);
}).replace(/^list((?: \d+ \d+ [0-9a-fA-F]+)*)$/, (m, games) =>
  'list' + games.replace(/ (\d+) (\d+) ([0-9a-fA-F]+)/g, (g, id, n, e) => ` ${roomName(id)} ${n} ${e}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const SECRET = 'sekrit9';
// A jkMultiEntry (types.h in the OpenJKDF2 fork), in hex.
function entry({ name, episode, map, max, password = '' }) {
  const b = Buffer.alloc(240);
  b.writeInt32LE(max, 16);
  b.writeInt32LE(1, 20);
  b.write(name, 24, 'utf16le');
  b.write(episode, 88, 'latin1');
  b.write(map, 120, 'latin1');
  b.write(password, 152, 'utf16le');
  return b.toString('hex');
}
// The tail mods.js adds for a mod (flag 1) and the MotS Remastered pack (2).
function modTail(mod, pack) {
  const b = Buffer.alloc(7 + (mod ? 32 : 0) + (pack ? 16 : 0) + (mod || '').length, 0xab);
  b.write('JKMD', 0, 'latin1');
  b[4] = 2; b[5] = (mod ? 1 : 0) | (pack ? 2 : 0); b[6] = (mod || '').length;
  if (mod) b.write(mod, b.length - mod.length, 'latin1');
  return b.toString('hex');
}
let lastStatus = null;
function status(b64data) {
  const json = Buffer.from(b64data, 'base64').toString('utf8');
  const s = JSON.parse(json);
  const ok = s.online === s.lobby.length + s.games.reduce((n, g) => n + g.players, 0) && !json.includes(SECRET);
  const ours = n => n.startsWith('t_');
  const games = s.games.filter(g => ours(g.name)).map(g => `<room ${g.id}> ${JSON.stringify(g.name)} ` +
    `${g.game} ${g.map} ${g.episode} mod=${JSON.stringify(g.mod)} ${g.locked ? 'locked' : 'open'} ` +
    `${g.players}/${g.max} ${JSON.stringify(g.names)}`);
  const line = `status ${ok ? 'ok' : 'WRONG'} lobby=${JSON.stringify(s.lobby.filter(ours))} games=[${games.join(', ')}]`;
  if (line === lastStatus) return null;
  return lastStatus = line;
}
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
        if (s.startsWith('status ') && (s = status(s.slice(7))) === null) return;
      } else {
        const v = new DataView(ev.data);
        s = `bin from=${v.getUint32(0, true)} to=${v.getUint32(4, true)} body=${Buffer.from(ev.data.slice(8)).toString()}`;
      }
      pending.push([name, `${name} <- ${s}`]);
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error(name + ' error'));
    ws.onclose = ev => pending.push([name, `${name} closed ${ev.code}`]);
  });
}
function pkt(from, to, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32LE(from, 0); b.writeUInt32LE(to, 4); b.write(body, 8);
  return b;
}
const step = async (name, ws, data, shown) => {
  flush(); log.push(`${name} -> ${shown || (typeof data === 'string' ? named(data) : 'bin')}`); ws.send(data); await sleep(150); flush();
};
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
flush(); log.push('C closes'); C.close(); await sleep(300);
await step('A', A, 'list');
// Live counts.
const duel = { name: 't_Duel', episode: 'JK1MP.gob', map: '01narshadda.jkl', max: 4 };
const W = await client('W'); await sleep(200);
await step('W', W, 'watch');
await step('H', H, 'hello jk1 ' + b64('t_Host'), 'hello jk1 t_Host');
await step('A', A, 'hello mots ' + b64('t_\u00c4\u202e\u0007ccent long name'), 'hello mots t_\u00c4<RLO><BEL>ccent long name');
await step('B', B, 'hello jk1 ' + b64('t_B'), 'hello jk1 t_B');
await step('B', B, 'hello jk1 ' + b64('t_B'), 'hello jk1 t_B (again)');
await step('B', B, 'hello xx ' + b64('t_B'), 'hello xx t_B');
await step('B', B, 'hello jk1 !!');
await step('H', H, 'host ' + entry(duel), 'host <t_Duel entry>');
await step('A', A, 'join ' + H.room);
await step('H', H, 'update ' + entry({ ...duel, map: '03katarn.jkl', password: SECRET }) + modTail('t_Sabers'),
           'update <t_Duel entry on 03katarn.jkl with a password and the t_Sabers mod>');
await step('B', B, 'join ' + H.room);
await step('B', B, 'hello jk1 ' + b64('t_Bee'), 'hello jk1 t_Bee');
await step('A', A, 'leave');
const D = await client('D'); await sleep(200);
await step('D', D, 'host ' + entry({ name: 't_Sith', episode: 'JKM_MP.goo', map: 'm2.jkl', max: 99 }) + modTail(null, true),
           'host <t_Sith entry on JKM_MP.goo with the Remastered pack, no hello>');
await step('H', H, 'leave');
flush(); log.push('D closes'); D.close(); await sleep(300);
flush(); log.push('W closes'); W.close(); await sleep(300);
flush(); log.push('big message'); A.send('x'.repeat(70000)); await sleep(400);
// One at a time: over the internet, two closes can finish in either order.
H.close(); await sleep(300);
B.close(); await sleep(300);
flush();
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
