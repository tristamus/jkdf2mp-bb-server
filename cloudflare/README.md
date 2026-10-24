# The lobby on Cloudflare

`src/lobby.js` is `relay/relay.py` rebuilt for Cloudflare Workers, so the lobby runs all the time on
Cloudflare's free plan at `https://jkdf2mp.<your-subdomain>.workers.dev/index.html`, with nothing
running at home. It speaks the same protocol, so the same browser build works with either one.

- The page and engine (`index.html`, `openjkdf2.js`, `openjkdf2.wasm`) are static files in `public/`.
  They're not in this branch: take them from a folder in the `builds` branch, where `SHA256SUMS`
  lists their hashes. There are no game files here or there.
- The lobby itself is a Durable Object, so every player reaches the same one. It uses WebSocket
  hibernation, so it isn't kept in memory while people sit in the lobby, and Cloudflare answers the
  pages' keepalive pings without waking it.
- The game and the page ping the lobby every 25 s, whatever the player is doing. A connection that
  sends nothing for 2 minutes, not even that, is gone without having closed (a killed tab, a computer
  that went to sleep), so the lobby ends it: its player comes off the counts, and its game too if it
  was the host. An alarm looks for these once a minute while anyone is connected, which is up to
  1,440 alarm runs a day, and those count as requests.
- Updating the lobby (`wrangler deploy`) closes every connection, and so can a player's network
  blip. Neither ends a match any more: game packets go over WebRTC, the lobby keeps a dropped
  player's seat for 60 seconds (`HOLD_MS`) in storage, and the game reconnects and takes it back
  with the key the lobby gave it. A seat nobody takes back ends as before. This needs a game built
  with the seat protocol; older builds still leave the match when their connection drops.
- The landing page's live counts come from the lobby too: each running game sends its player's name
  once, and the page gets the player count, the games and who's in them whenever they change. These
  messages from the lobby to pages don't count toward the free plan's requests.
- Pages get Cloudflare's STUN server (`STUN` in `wrangler.toml`), so most players link directly over
  WebRTC and their game packets never touch the lobby. There's no TURN server: players who can't
  link directly have their packets relayed by the lobby, as with `relay.py`.

## Free plan limits

The free plan doesn't charge: past a daily limit, requests fail until the limit resets at 00:00 UTC.
For the lobby, the one that matters is 100,000 Durable Object requests a day, where 20 incoming
WebSocket messages count as one request. Game packets between players who link directly don't
count at all, but a match going through the lobby does: on 2026-10-24 one sent about 50,000
messages a minute, which uses the whole day in about 40 minutes, and the lobby went down at 06:00
UTC. Workers Paid ($5 a month) has no daily limit: it includes 1 million requests a month, then
$0.15 a million.

Game packets that can't go anywhere count too: those from a game that isn't in a room, or for a
player who isn't in the room. A game that keeps sending them for 5 seconds (`NOTICE_MS`) hears
`host-left` (for its packets to the host, from a game in no room) or `peer-left <id>` (for its
packets to a player), the messages it would have had in the room, so it stops. A held seat's
player may come back, so packets for one don't set this off.

The lobby logs its message count every minute while players are connected, and then the five
busiest connections by player name and room, with how many of their packets went nowhere and why,
and each time it tells a game to stop. `npx wrangler tail` shows these live, and Workers Logs in
the Cloudflare dashboard keeps them for a few days (`[observability]` in `wrangler.toml`). The
dashboard also shows the day's requests.

## Deploy

Needs Node.js 22 or newer and a Cloudflare account (the free plan runs it, within the limits above).

```
npm ci                 # installs the pinned wrangler
npx wrangler login     # opens the browser to allow wrangler into the account
npx wrangler deploy
```

`npx wrangler dev` runs it locally at http://127.0.0.1:8787/index.html instead.

To check a deployed lobby, run `node test/protocol.mjs wss://<host>/relay test/protocol.expected.txt`
while nobody is hosting. It plays out hosting, joining, signaling, packet routing, leaving, and
seats being held, taken back and running out, with plain WebSocket clients, and compares the
transcript with the one `wrangler dev` gives. It waits once for held seats to run out, about a
minute against a deployed lobby, and sends packets that go nowhere for a little over 5 seconds a
few times. Against `npx wrangler dev --var HOLD_MS:3000 --var NOTICE_MS:1000`, which made
`protocol.expected.txt`, run it with `HOLD_MS=3000 NOTICE_MS=1000` to make those waits short.
