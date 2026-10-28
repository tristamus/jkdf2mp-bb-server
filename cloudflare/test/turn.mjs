// Checks the lobby's TURN credentials (the turn line) against a made-up
// Cloudflare Realtime API that this starts on a port of its own, with
// `wrangler dev` pointed at it. Needs Node.js 22 or newer.
//
//   npx wrangler dev --port 8797 --var TURN_KEY_ID:key1 --var TURN_KEY_API_TOKEN:token1 \
//       --var TURN_API:http://127.0.0.1:8798/
//   node test/turn.mjs ws://localhost:8797/relay 8798
//
// It prints a line for each check and exits 1 if one fails.
import http from 'node:http';
import assert from 'node:assert/strict';

const url = process.argv[2];
const apiPort = Number(process.argv[3] || 8798);
const STEP_MS = Number(process.env.STEP_MS) || 400;
const TTL = 86400;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The made-up API: answers as Cloudflare's docs show, with the port 53
// addresses the docs say its answers have, or with an error while fail is set.
const api = { calls: [], fail: false };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    api.calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
    if (api.fail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error": "made up"}');
      return;
    }
    const n = api.calls.length;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
               'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
               'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'user' + n, credential: 'pass' + n },
    ] }));
  });
});
await new Promise(resolve => server.listen(apiPort, '127.0.0.1', resolve));

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
const TURN = n => [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
           'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp',
           'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'user' + n, credential: 'pass' + n },
];

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.lines = [];
    ws.onmessage = ev => { if (typeof ev.data === 'string') ws.lines.push(ev.data); };
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('socket error'));
  });
}

// Sends a line and returns the lines that came back within STEP_MS.
async function say(ws, line) {
  ws.lines = [];
  ws.send(line);
  await sleep(STEP_MS);
  return ws.lines;
}

// An ice line as [servers, seconds or null].
function ice(line) {
  const [op, data, seconds] = line.split(' ');
  assert.equal(op, 'ice', line);
  return [JSON.parse(Buffer.from(data, 'base64').toString()), seconds === undefined ? null : Number(seconds)];
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n' + (e.stack || e));
  }
}

const H = await client();
await sleep(STEP_MS);
await check('a lobby with a TURN key says so on connect', () => {
  assert.equal(H.lines.length, 2);
  assert.deepEqual(ice(H.lines[0]), [STUN, null]);
  assert.equal(H.lines[1], 'lobby links turn');
});
await check('a game in no room gets no credentials, only the ice every game gets', async () => {
  const got = await say(H, 'turn');
  assert.equal(got.length, 1);
  assert.deepEqual(ice(got[0]), [STUN, null]);
  assert.equal(api.calls.length, 0);
});
let roomId = 0;
await check('a host gets credentials from Cloudflare, without the port 53 addresses, and how long they last', async () => {
  roomId = (await say(H, 'host abcd')).find(l => l.startsWith('hosted ')).split(' ')[1];
  const got = await say(H, 'turn');
  assert.equal(got.length, 1);
  assert.deepEqual(ice(got[0]), [TURN(1), TTL]);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0], { method: 'POST', path: '/key1/credentials/generate-ice-servers', auth: 'Bearer token1',
                                   type: 'application/json', body: JSON.stringify({ ttl: TTL }) });
});
await check('asking again at once gets none', async () => {
  const got = await say(H, 'turn');
  assert.deepEqual(ice(got[0]), [STUN, null]);
  assert.equal(api.calls.length, 1);
});
const J = await client();
const K = await client();
await sleep(STEP_MS);
await check('a joiner gets its own', async () => {
  await say(J, 'join ' + roomId);
  const got = await say(J, 'turn');
  assert.deepEqual(ice(got[0]), [TURN(2), TTL]);
});
await check('after 5 s, the host can have new ones', async () => {
  await sleep(5000);
  const got = await say(H, 'turn');
  assert.deepEqual(ice(got[0]), [TURN(3), TTL]);
  assert.equal(api.calls.length, 3);
});
await check('when Cloudflare can\'t make them, a game gets the ice every game gets', async () => {
  api.fail = true;
  await say(K, 'join ' + roomId);
  const got = await say(K, 'turn');
  assert.equal(got.length, 1);
  assert.deepEqual(ice(got[0]), [STUN, null]);
  assert.equal(api.calls.length, 4);
});
await check('and the lobby doesn\'t ask Cloudflare again for a minute', async () => {
  api.fail = false;
  await sleep(5000);
  const got = await say(J, 'turn');
  assert.deepEqual(ice(got[0]), [STUN, null]);
  assert.equal(api.calls.length, 4);
});
await check('two joiners pass each other link setup', async () => {
  K.lines = [];
  const got = await say(J, 'signal 3 c2RwSg==');
  assert.deepEqual(got, []);
  assert.deepEqual(K.lines, ['signal 2 c2RwSg==']);
});
for (const ws of [H, J, K]) ws.close();
server.close();
console.log(failed ? `${failed} check(s) failed` : 'all passed');
process.exit(failed ? 1 : 0);
