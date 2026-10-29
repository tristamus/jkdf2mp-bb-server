# The lobby on Cloudflare

`src/lobby.js` is `relay/relay.py` rebuilt for Cloudflare Workers, so the lobby runs all the time on
Cloudflare at https://jediknight.zone/ (before 2026-10-29, `https://jkdf2mp.jkdf2mp-lobby.workers.dev/`;
see Address below), with nothing running at home. It speaks the same protocol, so the same browser build works with either one.

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
- Each game says which netcode its build speaks when it connects (`/relay?net=<n>`), and the
  lobby only lists games, and lets it join them, whose host speaks the same: a join to another
  gets `error version newer` or `error version older`. Builds that can play a match together
  share a number, so it only goes up with a change older builds can't play with. Until then
  every game, whether or not it says, is 0.
- The landing page's live counts come from the lobby too: each running game sends its player's name
  once, and the page gets the player count, the games and who's in them whenever they change. These
  messages from the lobby to pages don't count toward the free plan's requests.
- Pages get Cloudflare's STUN server (`STUN` in `wrangler.toml`), so most players link directly over
  WebRTC and their game packets never touch the lobby. Players in the same game link to each other
  too, not only to the host. Players who can't link directly get a link through Cloudflare's TURN
  service once it's set up (see TURN below); until then, or if that fails too, the lobby relays
  their packets, as `relay.py` does.

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

## TURN

Some home routers and networks can't make WebRTC links with STUN alone. Players behind them send
every packet through the lobby, which is one Durable Object in one city and passes each player's
position on at most every 200 ms. With a TURN key, the lobby hands those players short-lived
credentials for Cloudflare's TURN service instead, which answers at the Cloudflare city nearest
each player, so they get a full-speed WebRTC link like everyone else.

To turn it on:

1. Make a TURN key in the Cloudflare dashboard, under Realtime
   (https://dash.cloudflare.com/?to=/:account/calls). It has an id and an API token.
2. Store them as two secrets on the Worker, either in the dashboard (Workers & Pages, `jkdf2mp`,
   Settings, Variables and Secrets, type Secret) or with wrangler, which asks for each value:

   ```
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

Without both, the lobby works as before. With them, it tells games it has TURN (`lobby links turn`
on connect), and a game in a room that asks (`turn`) gets credentials that last 24 hours
(`TURN_TTL_S` in `src/lobby.js`). A joiner asks as it joins, a host when someone joins it, so a
host waiting alone doesn't use any. Cloudflare asks that more than half of the credentials made get
used. If Cloudflare can't make them, the lobby logs it and hands out none for a minute; games then
link as they did without TURN.

Cost: Cloudflare charges $0.05 per GB it delivers from TURN to players, after 1,000 GB free a month
(shared with its SFU). A link only goes through TURN when the two computers can't reach each other
directly. By my estimate from packet sizes, one player on TURN in an 8-player match is about 0.2 GB
an hour, so the free allowance is a few thousand player-hours a month.

Risk: anyone who joins a game gets credentials, and could take them out of the browser and use
Cloudflare's TURN for something else for up to 24 hours, at the account's cost. The lobby only gives
them to games in a room, at most one set every 5 seconds per connection. Deleting the TURN key in
the dashboard stops every credential made with it. The dashboard shows how much TURN is used.

The lobby's minute log counts the players sending game packets through the lobby and the
credentials made, so you can see how many players still need the relay.

## Address

The site lives at `SITE` in `wrangler.toml` (https://jediknight.zone), a domain on Cloudflare in the
same account, which `routes` gives the Worker along with www. Its old address, `MOVED_FROM`
(jkdf2mp.jkdf2mp-lobby.workers.dev), stays on (`workers_dev = true`: wrangler turns workers.dev off
once there are routes, unless it's written out). `src/moved.js` decides what goes where:

- A page load on the old address goes to the same path and options on `SITE`, with `moved` added.
  The page there then offers to bring over what the browser saved under the old address
  (characters, settings, saved game files, mods, screenshots), which it can't read by itself: it
  opens `move-out.html` on the old address, which hands them over (OpenJKDF2's
  `packaging/wasm/index.html`, `moveIn`). A page load on www goes to `SITE` as it is.
- `/relay` stays on every address: a browser fails a WebSocket that gets a redirect, and it's the
  same Worker, so a tab opened on the old address keeps playing in the same lobby. So does
  `move-out.html`.
- `MOVED_STATUS` is 302 while the move is checked, then 301, which browsers keep for good: from
  then on the domain has to stay.

Only `/relay`, `/` and `/index.html` run the Worker (`run_worker_first`); everything else is served
straight from the files. `wrangler dev` sees every request as `SITE` (the first route), so locally
nothing moves. To try the moves locally, run it with a copy of `wrangler.toml` without `routes`:

```
npx wrangler dev -c wrangler.local.toml --var SITE:http://localhost:8787 --var MOVED_FROM:http://127.0.0.1:8787
```

Then http://127.0.0.1:8787/ goes to http://localhost:8787/?moved. `node test/moved.mjs` checks
`src/moved.js` on its own.

## Deploy

Needs Node.js 22 or newer and a Cloudflare account (the free plan runs it, within the limits above).
The domain in `routes` has to be an active zone in that account first, or the deploy fails; without
a domain of your own, take `routes` out and set `SITE` to `""`.

```
npm ci                       # installs the pinned wrangler
npx wrangler login           # opens the browser to allow wrangler into the account
npx wrangler deploy --env="" # the site; --env beta for the test address (below)
```

`npx wrangler dev` runs it locally at http://127.0.0.1:8787/ instead. A plain `npx wrangler deploy`
deploys the site too, with a warning that there's more than one environment; `--env=""` names the site's.

To check a deployed lobby, run `node test/protocol.mjs wss://<host>/relay test/protocol.expected.txt`
while nobody is hosting. It plays out hosting, joining, signaling (between a host and its players,
and between two players), packet routing, leaving, and seats being held, taken back and running
out, with plain WebSocket clients, and compares the transcript with the one `wrangler dev` gives.
It waits once for held seats to run out, about a minute against a deployed lobby, and sends packets
that go nowhere for a little over 5 seconds a few times. Against `npx wrangler dev --var HOLD_MS:3000 --var NOTICE_MS:1000`, which made
`protocol.expected.txt`, run it with `HOLD_MS=3000 NOTICE_MS=1000` to make those waits short.

`test/turn.mjs` checks the TURN credentials against a made-up Cloudflare API that it starts itself,
with `wrangler dev` pointed at it:

```
npx wrangler dev --port 8797 --var TURN_KEY_ID:key1 --var TURN_KEY_API_TOKEN:token1 \
    --var TURN_API:http://127.0.0.1:8798/
node test/turn.mjs ws://localhost:8797/relay 8798
```

## Test address

`[env.beta]` in `wrangler.toml` is a second Worker, `jkdf2mp-beta`, at https://beta.jediknight.zone,
with its own lobby. A change to netcode or the lobby goes there first, for a few players to try both hit
rules, and then the same files go to the site:

```
npx wrangler deploy --env beta    # the test address
npx wrangler deploy --env=""      # the site, once it's checked
```

Nobody lands in a test match from the site, since the lobbies are apart. Nothing moves there (`SITE`
is empty). Wrangler doesn't carry variables, bindings or secrets over to an environment, so
`[env.beta]` repeats the first two, and TURN needs its two secrets set on `jkdf2mp-beta` as well
(`npx wrangler secret put TURN_KEY_ID --env beta`, and the same for `TURN_KEY_API_TOKEN`); without them,
its players who can't link directly go through its lobby. Its requests count toward the same account.
`npx wrangler dev --env beta` runs it locally.
