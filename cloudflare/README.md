# The lobby on Cloudflare

`src/lobby.js` is `relay/relay.py` rebuilt for Cloudflare Workers, so the lobby runs all the time on
Cloudflare at https://jediknight.zone/ (before 2026-10-29, `https://jkdf2mp.jkdf2mp-lobby.workers.dev/`;
see Address below), with nothing running at home. It speaks the same protocol, so the same browser build works with either one.

- The page and its two engines (`index.html`; `openjkdf2.js` and `openjkdf2.wasm`, the Asyncify
  engine; `jspi/openjkdf2.js` and `jspi/openjkdf2.wasm`, the JSPI engine, which browsers with JSPI
  load) are static files in `public/`.
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
- Room passwords are checked by the lobby, which keeps only a salted HMAC of each and never sends a
  password to a game built for that, in a list or anywhere else (see Room passwords below). Older
  builds still check the password themselves, for rooms older builds host, while
  `PASSWORDS_FOR_OLD_GAMES` lets them.
- The landing page's live counts come from the lobby too: each running game sends its player's name
  once, and the page gets the player count, the games and who's in them whenever they change. These
  messages from the lobby to pages don't count toward the free plan's requests.
- Pages get Cloudflare's STUN server (`STUN` in `wrangler.toml`), so most players link directly over
  WebRTC and their game packets never touch the lobby. Players in the same game link to each other
  too, not only to the host. Players who can't link directly get a link through Cloudflare's TURN
  service once it's set up (see TURN below); until then, or if that fails too, the lobby relays
  their packets, as `relay.py` does.
- When a game leaves a match, its page posts a summary of it to `/summary`: counts only, with no
  names, kept for three months (see Match summaries below).
- `/imperial-games` gives the page the games on the Imperial Network Protocol relay (sithmartyr's),
  to show beside the lobby's, outside the lobby itself (see Imperial relay games below).

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

Without both, the lobby works as before. With them, it tells games it has TURN (`lobby links turn pw`
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

## Room passwords

A host's game puts its password in every entry it sends the lobby (host, update, rehost and the
welcome for each joiner), as it always has. The lobby doesn't pass it on. A game built for this
connects with `pw=1` (`/relay?net=<n>&pw=1`) and the lobby says `pw` on its `lobby` line, so the game
knows to send the password its player typed with `join <room> <hex>` (the UTF-16LE code units in
hex). Such a game gets every room in `list` without a password, with the password box flag
(sessionFlags 0x400) set just for a room that has one, and it sends the password only to a room
listed with the box, and only when something was typed; otherwise its `join` is bare, so text left
in the box from another room never leaves the browser. The lobby answers a wrong or missing
password with `error password`. No game gets a password in `welcome`, and the landing page's
status says only `locked`.

For those rooms the lobby keeps no password, only a verifier: HMAC-SHA-256 of a random salt and the
password, in storage under `pw:<room>`. After 10 wrong passwords on one room from one address
(`CF-Connecting-IP`; an IPv6 address counts by its /64, as a home line or a server usually has a
whole /64 to pick from) within a minute, every try from that address on that room hears
`error password wait`, without being checked, until the oldest of them is a minute old. The counts
are only kept in memory, so they start over whenever the lobby's Durable Object is evicted: at every
deploy, and whenever it has been idle a short while (pings don't wake it, so a lobby where players
only wait is idle). Someone who pauses between bursts of guesses can therefore get more than 10 a
minute; a password of more than a few characters is what keeps a room private.

- `PASSWORD_KEY` (optional secret) keys the HMAC, so the verifiers in storage are no use without it:
  `npx wrangler secret put PASSWORD_KEY` (and the same with `--env beta`). Don't change or remove it
  while rooms with a password are open: their verifiers stop matching, and every join to them hears
  `error password` until their host's game sends the room's entry again.
- `PASSWORDS_FOR_OLD_GAMES` says what older builds get: tabs opened before the update, which connect
  without `pw=1`, check the password against the list themselves and send a bare `join`.
  - `host` (the default, when it's unset): a room an older build hosts (`legacy` in its verifier,
    and every room open when this lobby was deployed) is listed to older builds as before, password
    and all, and their bare join gets in as before. The lobby still checks the password of every
    game that sends `pw=1`. For these rooms the old weakness stays: the password is in storage, and
    anyone who connects without `pw=1` can read it in the list and join without it.
  - `none`: every room with a password is checked by the lobby. Older builds get it in the list
    without its password or the box, and their join hears `error version newer`, which their join
    screen shows as "That game runs a newer version. Reload this page, then join again." Open rooms
    and matches already playing aren't affected.

  Either way, a room a newer build hosts is listed to older builds the `none` way: from the deploy
  on, a tab opened before it can't join a room with a password that a newer tab hosts until its
  player reloads the page, which its join screen tells them. Open rooms aren't affected. Listing
  those rooms' passwords to older builds would hand them to anyone who leaves `pw=1` out.

  Any value other than `host` or `none` (`off`, `false`, a typo) is taken as `none`, and the lobby
  logs that, so a mistake never hands passwords out.
- `PASSWORDS_FOR_OLD_GAMES_UNTIL` is an ISO 8601 UTC time, such as `2026-11-06T12:00:00Z`, after
  which `host` acts as `none`, so the switch needn't wait for a deploy. Then the lobby also takes
  the passwords out of those rooms' entries in storage, within a minute while anyone is connected. A
  value that isn't a time is taken as one that has passed, so `host` acts as `none` (the lobby logs
  that).

Set the two variables under `[vars]` (and `[env.beta.vars]`) in `wrangler.toml` and deploy: one set
only in the dashboard goes at the next `wrangler deploy`, which replaces the variables with those in
`wrangler.toml`.

The deploy itself needs nothing else, and neither does a rollback. The lobby takes the rooms open at
the deploy for older builds' rooms, and makes their verifiers when it starts. A rollback to a lobby
from before this closes every connection, as any deploy does, so a room isn't listed until its host's
game rehosts, which brings its whole entry, password and all, for the games' own check again; a game
that connected with `pw=1` sees no `pw` on that lobby's `lobby` line and checks the password itself.
`node test/passwords.mjs` checks all of this, with the lobby from before it taken from git for the
deploy and the rollback.

Once, around the deploy that turns this on: a newer tab whose join list came from the old lobby
checked the password itself and sends a bare `join`. If that `join` reaches the new lobby before the
list is refreshed (within about 2 s of the deploy, or when the player was on the Load Character
screen, which doesn't refresh it, across the deploy), the lobby answers `error password` and the
player sees "Wrong password" although they typed the right one. Joining again works. The same
happens the other way at a rollback: a `join` with a password, from a list the new lobby made,
reaches the old one, which doesn't take it (`error bad-request`), and the player sees that the game
couldn't connect, once.

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
- `MOVED_STATUS` is 301 since 2026-10-29, after a 302 while the move was checked. Browsers keep
  a 301 for good, so the domain has to stay.

Only `/relay`, `/summary`, `/` and `/index.html` run the Worker (`run_worker_first`); everything else
is served straight from the files. `wrangler dev` sees every request as `SITE` (the first route), so locally
nothing moves. To try the moves locally, run it with a copy of `wrangler.toml` without `routes`:

```
npx wrangler dev -c wrangler.local.toml --var SITE:http://localhost:8787 --var MOVED_FROM:http://127.0.0.1:8787
```

Then http://127.0.0.1:8787/ goes to http://localhost:8787/?moved. `node test/moved.mjs` checks
`src/moved.js` on its own.

## Match summaries

When a game leaves a match, or its tab closes in one, the page posts a summary of it to `/summary`
(`summary()` in OpenJKDF2's `packaging/wasm/netstats.js`), so the hit rules' defaults can be set from
real matches. Counts only, with no names, player numbers or addresses: the game and its build, the
hit rules and reach, how long that game was in the match and at what frame rate, and for each other
player in it, the link (direct, TURN, through the lobby or through the host) and its ping, how far
behind they were drawn, and the hits each way, shown, counted, blocked, missed or turned down and
why, with how far back each claim on that game's player reached. There's none for a match a game was
in for under 30 s.

`src/summary.js` rebuilds each summary from the fields it knows, checks every number and drops
anything else. It keeps it in Workers Analytics Engine (`SUMMARIES` in `wrangler.toml`), which keeps
data for three months and makes the dataset the first time one is written, as one row for each other
player in the match, and writes it to the log. The test address has a dataset of its own.
`node test/summary.mjs` checks it; with an address, `node test/summary.mjs http://127.0.0.1:8787`
also posts to a running lobby.

To read them back, use Analytics Engine's SQL API with an API token that has Account Analytics Read:

```
curl "https://api.cloudflare.com/client/v4/accounts/<account id>/analytics_engine/sql" \
    --header "Authorization: Bearer <token>" \
    --data "SELECT timestamp, blob9 AS summary, blob10 AS player, blob11 AS rest FROM jkdf2mp_summaries
            WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob8 = '' ORDER BY timestamp"
```

Analytics Engine samples when one index (here, the game) gets data points too quickly. Each row's
`_sample_interval` says how many data points it stands for, so count with `SUM(_sample_interval)`
rather than `COUNT()` ([sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)).

Each row's text fields: `blob1` the summary's version (1), `blob2` the game (`jk` or `mots`), `blob3`
the rules (`classic` or `hwys`), `blob4` the build, `blob5` `host` or `joiner`, `blob6` the link,
`blob7` the hello version the two games agreed on (0 for a build from before Hit what you see, -1
unknown), `blob8` any of `sim`, `test` and `netstats` (a slowed, scripted or measured match; empty for
an ordinary one), `blob9` an id the rows of one summary share, `blob10` that other player's part as
JSON, and `blob11` the rest of the summary as JSON (with `"jspi":true` when that game ran the JSPI
engine, which browsers with JSPI get; without it, the Asyncify engine). Its numbers: `double1` the reach, `double2` the
game's time in the match (s), `double3` players, `double4` and `double5` its frame rate (the middle,
and the lowest tenth), `double6` the other player's time in the match with it, `double7` the ping,
`double8` the round trip the browser measured on their link, `double9` how far behind they were drawn
(ms) and `double10` the buffer; the game's hits on them: `double11` shown, `double12` counted,
`double13` turned down, `double14` claimed, `double15` claimed past the reach; their claims on the
game's player: `double16` all, `double17` turned down, `double18` with a moment, `double19` reaching
300 ms back or more; and `double20` its targeted Force powers that played on them. -1 for a number
the game didn't know.

## Imperial relay games

`/imperial-games` (`src/imperial.js`) answers the game list of the Imperial Network Protocol relay
named in `IMPERIAL_LIST` (sithmartyr's, `lobby.jkjunkie.com`), as JSON, for the page's room windows to
show beside this lobby's games. The relay has no web API, so it asks the way the game's Multiplayer
menu does: a WebSocket to the relay, HELLO, then LIST (`jkrelay_proto.h` in the OpenJKDF2 fork), with
3 seconds to answer. It runs beside the lobby, never in it, so a relay that's down or answers garbage
only greys out the page's Imperial games. Answers are cached for 15 seconds (30 when the relay didn't
answer) in each Cloudflare data center, so the relay hears from us a few times a minute whatever the
number of pages watching. The relay's address comes only from `IMPERIAL_LIST`; with it empty the
route answers 404 and the page shows no Imperial games. The game's own Imperial connection doesn't
depend on any of this.

`IMPERIAL_PINNED` lists dedicated servers the page always shows first (`jk1 162.248.94.121:27960
Coruscant`), matched by address, since anyone hosting on the relay can name a game anything. A pinned
server the relay doesn't list, or a relay that doesn't answer, still gets a card, without Join. A
dedicated server's player count has its own slot taken off.

`node test/imperial.mjs` checks how it reads the relay's answers, from one the real relay sent and
made-up ones. `test/imperial-route.mjs` checks the route against a made-up relay that it starts
itself, with `wrangler dev` pointed at it:

```
npx wrangler dev --port 8797 --var IMPERIAL_LIST:127.0.0.1:8799 --var IMPERIAL_TIMEOUT_MS:1500 \
    --var IMPERIAL_CACHE_S:2
node test/imperial-route.mjs http://127.0.0.1:8797 8799
```

With the real relay: `npx wrangler dev`, then http://127.0.0.1:8787/imperial-games.

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

The deploy that brings room passwords, and a rollback from it, can tell a player joining a room with
a password, once, "Wrong password" with the right one, or that the game couldn't connect; joining
again works (see Room passwords).

To check a deployed lobby, run `node test/protocol.mjs wss://<host>/relay test/protocol.expected.txt`
while nobody is hosting. It plays out hosting, joining, signaling (between a host and its players,
and between two players), packet routing, leaving, seats being held, taken back and running out,
and room passwords, with plain WebSocket clients, and compares the transcript with the one `wrangler dev` gives.
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
