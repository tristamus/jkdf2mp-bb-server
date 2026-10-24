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
// online during a run don't show, plus "ok" when the counts add up, in all
// and by game, and no password got out. What arrives during one
// step is listed by client (each client's lines in the order they came), since
// messages to different clients can arrive in either order over the internet.
// Each step waits STEP_MS (400 by default) for what it sets off.
// Seat keys print as <key>. The test waits once for held seats to run out:
// set HOLD_MS to the lobby's (60000 by default), e.g. HOLD_MS=3000 for
// `wrangler dev --var HOLD_MS:3000`. It also sends packets that go nowhere for
// longer than the lobby's NOTICE_MS (5000 by default): set NOTICE_MS the same
// way. protocol.expected.txt was made with
// `wrangler dev --var HOLD_MS:3000 --var NOTICE_MS:1000`.
const url = process.argv[2];
const STEP_MS = Number(process.env.STEP_MS) || 400;
const HOLD_MS = Number(process.env.HOLD_MS) || 60000;
const NOTICE_MS = Number(process.env.NOTICE_MS) || 5000;
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
const named = s => s.replace(/^(hosted|join|seat|rejoined|rehosted) (\d+)/, (m, op, id) => {
  if (op === 'hosted') rooms.set(id, '<room' + (rooms.size + 1) + '>');
  return op + ' ' + roomName(id);
}).replace(/^(seat \S+ \d+) [0-9a-f]{32}$/, '$1 <key>').replace(/^list((?: \d+ \d+ [0-9a-fA-F]+)*)$/, (m, games) =>
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
  const playing = k => s.games.reduce((n, g) => n + (!k || g.game === k ? g.players : 0), 0);
  const kinds = Object.keys(s.byGame || {});
  const ok = s.online === s.lobby.length + playing() && !json.includes(SECRET) &&
    kinds.join() === 'jk1,mots' && kinds.every(k => s.byGame[k].online === s.byGame[k].lobby.length + playing(k)) &&
    s.online === kinds.reduce((n, k) => n + s.byGame[k].online, 0) &&
    JSON.stringify(kinds.flatMap(k => s.byGame[k].lobby).sort()) === JSON.stringify(s.lobby.slice().sort());
  const ours = n => n.startsWith('t_');
  const games = s.games.filter(g => ours(g.name)).map(g => `<room ${g.id}> ${JSON.stringify(g.name)} ` +
    `${g.game} ${g.map} ${g.episode} mod=${JSON.stringify(g.mod)} ${g.locked ? 'locked' : 'open'} ` +
    `${g.players}/${g.max} ${JSON.stringify(g.names)}`);
  const lobby = kinds.map(k => `${k}=${JSON.stringify(s.byGame[k].lobby.filter(ours))}`).join(' ');
  const line = `status ${ok ? 'ok' : 'WRONG'} lobby ${lobby} games=[${games.join(', ')}]`;
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
        if (s.startsWith('seat ')) ws.key = s.split(' ')[3];
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
  flush(); log.push(`${name} -> ${shown || (typeof data === 'string' ? named(data) : 'bin')}`); ws.send(data); await sleep(STEP_MS); flush();
};
// A socket that closes without leave.
const closes = async (name, ws) => {
  flush(); log.push(`${name} closes`); ws.close(); await sleep(STEP_MS); flush();
};
// Sends the same packet every 100 ms for half a second past NOTICE_MS.
const keepsSending = async (name, ws, data, shown) => {
  flush(); log.push(`${name} -> ${shown}, for longer than NOTICE_MS`);
  for (const until = Date.now() + NOTICE_MS + 500; Date.now() < until; await sleep(100))
    ws.send(data);
  await sleep(STEP_MS); flush();
};
const WRONG_KEY = '0'.repeat(32);
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
// leave ends the seat at once: its key doesn't take it back.
await step('A', A, `rejoin ${H.room} 2 ${A.key}`, 'rejoin <room1> 2 <A\'s key>');
await step('A', A, 'join ' + H.room);
await step('H', H, 'leave');
await step('B', B, 'list');
await step('B', B, pkt(3, 1, 'no room'));
const C = await client('C'); await sleep(200);
await step('C', C, 'host 00');
await step('A', A, 'join ' + C.room);
// The host's socket closes without leave: its seat is held, so the room is
// out of the lists, but A is still in it until it leaves.
await closes('C', C);
await step('A', A, 'list');
await step('A', A, 'leave');
// Live counts.
// Episode names have no extension.
const duel = { name: 't_Duel', episode: 'JK1MP', map: '01narshadda.jkl', max: 4 };
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
await step('D', D, 'host ' + entry({ name: 't_Sith', episode: 'JKM_MP', map: 'm2.jkl', max: 99 }) + modTail(null, true),
           'host <t_Sith entry on JKM_MP with the Remastered pack, no hello>');
// Each game lists the games it can join: a host that hasn't said which game
// it runs shows in both.
await step('B', B, 'list jk1');
await step('B', B, 'list mots');
await step('D', D, 'hello mots ' + b64('t_D'), 'hello mots t_D');
await step('B', B, 'list jk1');
await step('B', B, 'list mots');
await step('B', B, 'list xx');
await step('H', H, 'leave');
// Seats. A socket that closes without leave keeps its player's seat for
// HOLD_MS, for the player to take back on a new socket with its key.
const S = await client('S'); await sleep(200);
await step('S', S, 'host 5ea7');
const P = await client('P'); await sleep(200);
await step('P', P, 'join ' + S.room);
const Q = await client('Q'); await sleep(200);
await step('Q', Q, 'join ' + S.room);
await closes('P', P);
// A held seat still counts, and isn't given to anyone else.
await step('S', S, 'list');
const P2 = await client('P2'); await sleep(200);
await step('P2', P2, `rejoin ${S.room} 2 ${WRONG_KEY}`, 'rejoin <room5> 2 <wrong key>');
await step('P2', P2, `rejoin ${S.room} 3 ${P.key}`, 'rejoin <room5> 3 <P\'s key>');
await step('P2', P2, `rehost ${S.room} ${P.key}`, 'rehost <room5> <P\'s key>');
await step('P2', P2, `rejoin ${S.room} 2 ${P.key}`, 'rejoin <room5> 2 <P\'s key>');
await step('S', S, pkt(1, 2, 'host to P2'));
await step('P2', P2, pkt(77, 1, 'P2 to host'));
// Taking a seat back while its old socket is still open replaces that.
const Q2 = await client('Q2'); await sleep(200);
await step('Q2', Q2, `rejoin ${S.room} 3 ${Q.key}`, 'rejoin <room5> 3 <Q\'s key>');
await step('S', S, pkt(1, 3, 'host to Q2'));
// The host's socket closes: its clients hear host-lost, and nobody can find
// or join the room until the host takes its seat back.
await closes('S', S);
const X = await client('X'); await sleep(200);
await step('X', X, 'list');
await step('X', X, 'join ' + S.room);
const S2 = await client('S2'); await sleep(200);
await step('S2', S2, `rehost ${S.room} ${S.key} 5ea8`, 'rehost <room5> <S\'s key> 5ea8');
await step('X', X, 'list');
await step('S2', S2, pkt(1, 2, 'host back to P2'));
await step('Q2', Q2, pkt(77, 1, 'Q2 to host'));
// Seats nobody takes back in time: a client's ends with peer-left, the
// host's ends its room with host-left.
const T = await client('T'); await sleep(200);
await step('T', T, 'host 7e57');
const U = await client('U'); await sleep(200);
await step('U', U, 'join ' + T.room);
await closes('Q2', Q2);
await closes('T', T);
await closes('D', D);
flush(); log.push('wait for the held seats to run out'); await sleep(HOLD_MS + 3000); flush();
await step('X', X, `rejoin ${S.room} 3 ${Q.key}`, 'rejoin <room5> 3 <Q\'s key>');
await step('X', X, `rehost ${T.room} ${T.key}`, 'rehost <room6> <T\'s key>');
await step('X', X, 'list');
await step('P2', P2, 'leave');
await step('S2', S2, 'leave');
flush(); log.push('W closes'); W.close(); await sleep(300);
// Packets that keep going nowhere: a game in no room hears host-left for its
// packets to the host and peer-left for those to a player, and a host hears
// peer-left for a player who isn't in its room. A client sending to a player
// who isn't there hears nothing (its host tells it who's in the game), and
// neither does a host sending to a held seat.
await keepsSending('X', X, pkt(77, 1, 'to the host'), 'bin to the host, in no room');
await keepsSending('X', X, pkt(77, 4, 'to id 4'), 'bin to id 4, in no room');
const R = await client('R'); await sleep(200);
await step('R', R, 'host 4e57');
await step('U', U, 'join ' + R.room);
await keepsSending('R', R, pkt(1, 9, 'to id 9'), 'bin to id 9');
await keepsSending('U', U, pkt(77, 9, 'to id 9'), 'bin to id 9');
await closes('U', U);
await keepsSending('R', R, pkt(1, 2, 'to id 2'), 'bin to id 2, whose seat is held');
await step('R', R, 'leave');
flush(); log.push('big message'); A.send('x'.repeat(70000)); await sleep(400);
// One at a time: over the internet, two closes can finish in either order.
for (const ws of [H, B, P2, S2, X, R]) {
  ws.close(); await sleep(300);
}
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
