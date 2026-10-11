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
- Pages get Cloudflare's STUN server (`STUN` in `wrangler.toml`), so most players link directly over
  WebRTC and their game packets never touch the lobby. There's no TURN server: players who can't
  link directly have their packets relayed by the lobby, as with `relay.py`.

## Free plan limits

The free plan doesn't charge: past a daily limit, requests fail until the limit resets at 00:00 UTC.
For the lobby, the one that matters is 100,000 Durable Object requests a day, where 20 incoming
WebSocket messages count as one request. Game packets between players who link directly don't
count at all. The lobby logs its message count every minute while players are connected
(`npx wrangler tail` shows it live), and the Cloudflare dashboard shows the day's requests.

## Deploy

Needs Node.js 22 or newer and a Cloudflare account (the free plan is enough).

```
npm ci                 # installs the pinned wrangler
npx wrangler login     # opens the browser to allow wrangler into the account
npx wrangler deploy
```

`npx wrangler dev` runs it locally at http://127.0.0.1:8787/index.html instead.

To check a deployed lobby, run `node test/protocol.mjs wss://<host>/relay test/protocol.expected.txt`
while nobody is hosting. It plays out hosting, joining, signaling, packet routing and leaving with
plain WebSocket clients and compares the transcript with the one `wrangler dev` gives.
