# The lobby on Cloudflare

`src/lobby.js` is `relay/relay.py` rebuilt for Cloudflare Workers, so the lobby runs all the time on
Cloudflare at https://jediknight.zone/ (before 2026-10-29, `https://jkdf2mp.jkdf2mp-lobby.workers.dev/`;
see Address below), with nothing running at home. It speaks the same protocol, so the same browser build works with either one.

- The page and its two engines (`index.html`; the Asyncify engine's `openjkdf2.js` and
  `openjkdf2.wasm`, and the JSPI engine's, which browsers with JSPI load) are static files in
  `public/`, the engines' files and `unzip.js` under `e/`, named by their content (see Engine files
  below). They're not in this branch: take them from a folder in the `builds` branch, where
  `SHA256SUMS` lists their hashes. There are no game files here or there.
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

`/relay`, `/summary`, `/imperial-games`, `/`, `/index.html` and everything under `/e/` run the Worker
(`run_worker_first` in `wrangler.toml`), and so does a path with no file; everything else is served
straight from the files. `wrangler dev` sees every request as `SITE` (the first route), so locally
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

## The match record

With a D1 database bound as `LADDER`, the lobby keeps a record of every match played in its rooms,
so nobody has to post a screenshot of the scoreboard. Without the binding none of it runs: the lobby
asks the games for nothing, and the pages below aren't served.

The game has no server, and each player's game keeps its own score. So each game in a room reports
to the lobby what it sees (`match`, a text line like the others; `src/ladder.js` has the format): the
kills, as its own game heard them announced, and from the host its scoreboard. A match is one level
in a room. The lobby puts the reports together, counting a kill once however many games saw it, and
when the level ends writes the match to D1: one row for the match, one for each player, and the
kills in order. It keeps how many games reported and how many kills two games or more saw, and
marks a match `counted` when it ran two minutes, two games or more reported it, nine in ten of its
kills were seen by two games, it had no password and no two of its players had the same browser key.
The standings add up only the matches that are `counted`.

What that's worth: a kill two games reported was announced in the match, not made up afterwards by
one of them. It says no more. The victim's own game is the one that announces a kill, a changed game
can announce what it likes, and two players can agree to feed each other kills.

Each match keeps what it was played with: the game, the level's file, title and episode (one that
isn't the games' own is shown as a custom map), teams or not, the score and time limits, the highest
Force rank, and the host's mod, which everyone in the room runs. The mod is kept by name and by
fingerprint (`mods.js` in the fork). The name is the mod folder's on the host's computer, so one mod
can come under several names, and the fingerprint changes with any file in it.

A player is a browser key: 32 hex digits the page gets from `POST /ladder/key`, which the lobby also
sets as a cookie (`jkpk`, kept 400 days and set again on each visit) so it outlasts a browser
clearing what pages keep. There are no accounts. D1 only ever gets the key's SHA-256, with the name
the player last used. A player whose page says not to record them is in the match with no name and
no key: in no standings, and with no page of their own. A player whose game sent no key (it reported
nothing, or its page never asked for one: a tab opened before the record was on) is in the match by
name only, and counts for the record that has that name when exactly one does (below).

A browser that clears its cookies and site data gets a new key. So that the record isn't lost with
it, a key D1 has never had becomes another key of a record when it plays under that record's name
(below).

| Path | What it is |
| --- | --- |
| `/match/<id>` | A match: scoreboard, who killed whom, mod and map, and how many games reported it |
| `/matches` | The matches, newest first; `?game=jk` or `mots` for one game's |
| `/players` | The standings of a game: `?game=`, `?period=week`, `month` or `all` (all three without), `?sort=` a column, `?dir=asc` |
| `/player/<id>` | A player: what they did in a game over a period, their rivals, what they play and their latest matches |
| `/ladder/recent` | For the landing page, as JSON: the latest matches of each game, each game's top ten over each period, and who's asking |
| `/ladder/key` | `POST`: the page's player's key |

The pages are made for each request, in the landing page's two looks, and ask search engines not to
keep them. A match in a room with a password has its page, for its players, but is in no list, isn't
posted to Discord and isn't `counted`. The lobby's status says which match is the latest (`match`,
which is there only when the lobby keeps a record), so the landing page shows its lists only then and
asks for them again only when that number changes. Games that reported a match hear `matched <id>`
when it's saved.

It's on for the site and for the test address: `wrangler.toml` binds a database for each
(`jkdf2mp-ladder`, and `jkdf2mp-ladder-beta` under `[env.beta]`). A deploy without those blocks turns
the record off, with no error; the matches already saved stay in the database. So after a deploy, the
`lobby` line a game gets still has to carry the word `match`, and `/ladder/recent` has to answer.

A copy of the lobby in another Cloudflare account makes its own database once and puts the id that
prints in `wrangler.toml`. The lobby makes the tables itself (`SCHEMA` in `src/ladder.js`).

```
npx wrangler d1 create jkdf2mp-ladder
```

To post each match to a Discord channel, make a webhook for the channel in Discord (channel
settings, Integrations, Webhooks) and give its address to the lobby as a secret. It's posted for
matches of three players or more (`DISCORD_MIN_PLAYERS`) that ran two minutes, with the scoreboard
and a link to the match's page (`MATCH_LINKS`, else `SITE`). Names are players' own words, so the
post can't mention anyone.

```
npx wrangler secret put DISCORD_WEBHOOK
```

`npx wrangler d1 export jkdf2mp-ladder --remote --output=ladder-backup.sql` saves all of it as a
file, and D1's Time Travel can put the database back as it was at any minute of the last 30 days.

`node test/ladder.mjs` checks it, with Node's own SQLite standing in for D1.

### Standings and player pages

The standings are per game, over this week, this month and all time. A week starts on Monday and a
month on its first day, at 3 in the morning in `America/Los_Angeles` (`ZONE` and `TURN_HOUR` in
`src/ladder-pages.js`), so an evening's play in the Americas falls in one week. Players are ranked by
score, which is kills less suicides, as the game's own scoreboard has it. Any column sorts the table,
but a kill to death ratio takes its place only with 30 kills and deaths or more in the period
(`KD_MIN`); under that it's shown with a mark and sorted after the rest.

A player's page has their totals for a game and a period, who killed them most and whom they killed
most (from their latest 50 matches of the period), how their kills came, the levels and mods they
play, and their latest ten matches. A record taken off the pages (`hidden`) answers 404, and the id
of a key that was joined to a record goes to that record's page.

The landing page shows the top ten of each game in a section under the rooms and the top five in a
box in its sidebar, from `/ladder/recent`. That answer also says who's asking, by the `jkpk` cookie:
their record's id and name, their latest match and their place on each board, so the page can link
"Your record" and "Your last match" for a player whose game left before the match was saved.

Adding up the standings reads every match's rows, and D1 counts the rows a query reads. So they're
added up once and kept in D1, in `ladder_cache`: six rows, one for each game and period, under a
stamp of what they depend on (the latest match, when the week and the month began, and the day). A
page reads the six rows, and the first page after a match is saved adds them up again. A player's
page reads, besides, that player's own matches of the period.

So a change made by hand doesn't show in the standings at once. It shows after the next saved
match, the next day (UTC), or at once after:

```
DELETE FROM ladder_cache;
```

### A new browser under a known name

A browser that lost its key (cleared cookies and site data, another browser, another computer) gets
a new one. When a match is saved, a key D1 has never had becomes another key of an existing record
(`merged_into`) if all of this holds:

- the name it played under is the name exactly one record on the pages last used, whatever the
  letters' case;
- the name has three characters or more and isn't one many players would have (`COMMON_NAMES` in
  `src/ladder.js`: "Player", "Kyle", "Jedi" and the like);
- no other player in that match has the same name;
- that record's player isn't in the match under a key of their own.

From then on that browser's matches count for the record, under either key. The lobby logs each
join (`a new browser joins record <id> by its name`).

It means a name is all it takes: someone who plays one match under another player's name, from a
browser the lobby hasn't seen, adds that match to their record, good or bad. There are no accounts,
so nothing stops that; it's the price of a record that outlasts a cleared browser. To undo a join,
free the key: its matches follow it off the record.

```
-- 46 was joined to 45 by its name: make it a player of its own again
UPDATE players SET merged_into = NULL WHERE id = 46;
DELETE FROM ladder_cache;
```

`LADDER_JOIN_NAMES = "0"` under `[vars]` turns joining off: every new key is then a new player, a
player with no key is nobody's, and two records are joined only by hand.

### A player with no key under a known name

A player whose game sent no key is in a match by name only (`match_players.player_id` is empty). The
same rule gives such a line to a record, whichever came first, the line or the record:

- its name is the name exactly one record on the pages last used, whatever the letters' case;
- the name has three characters or more and isn't one many players would have;
- no other player in that match has the same name;
- that record's player isn't in that match under a key.

It's looked at when a match is saved, for the names in that match: their lines in it, and their
earlier lines that are still nobody's. So a player's matches from before they had a key become
theirs with the first match they play with one. The first match a lobby saves after this rule came
in looks once at every such line, whatever its name (the lobby keeps `ladder:keyless` in its own
storage to say it has). The lobby logs each line (`a player with no key joins record <id> by their
name`).

The lines hang on a row of their own in `players`, the record's stand-in for them: its `key_hash` is
`name:` and the record's id, which no browser's key can be, and its `merged_into` is the record. So
the pages need nothing new to count them, and they come off the record the way a joined key does.
Taken off, the stand-in is a player of its own under the same name, and the record gets no more
such lines until it's put back:

```
-- Record 45's matches without a key: make them a player of their own again
UPDATE players SET merged_into = NULL WHERE key_hash = 'name:45';
DELETE FROM ladder_cache;
-- ... and back
UPDATE players SET merged_into = 45 WHERE key_hash = 'name:45';
DELETE FROM ladder_cache;
```

A name is all it takes here too, and less: nobody has to play. A line under a name is theirs as
soon as one record has that name, so a player who renames themselves to a name that has lines and
no record gets those lines.

### By hand

With `npx wrangler d1 execute jkdf2mp-ladder --remote --command "<SQL>"`. After any of the first
three, `DELETE FROM ladder_cache;` shows it in the standings at once.

```
-- Take a match, or a player's name, off the pages
UPDATE matches SET hidden = 1 WHERE id = 123;
UPDATE players SET hidden = 1 WHERE id = 45;
-- One player with two records: 46's matches, and those of any key joined to 46, count for 45
UPDATE players SET merged_into = 45 WHERE id = 46 OR merged_into = 46;
-- The matches of the last week by mod
SELECT mod, COUNT(*) FROM matches WHERE ended_at > (unixepoch() - 7 * 86400) * 1000 GROUP BY mod;
```

### What it costs

A game's reports are a few WebSocket messages a minute (one within two seconds of a kill, else one
every 30 s), beside the thousands a minute of a match that goes through the lobby. A match is a
handful of rows in D1.

D1's free plan allows 5 million rows read and 100,000 rows written a day, and 5 GB for an account,
500 MB for one database. Past either daily limit, queries fail until 00:00 UTC: matches aren't saved
(the lobby tries five times, a minute apart, then drops the match) and the pages answer an error.
Workers Paid includes 25 billion rows read and 50 million written a month, and takes a database to
10 GB. (https://developers.cloudflare.com/d1/platform/pricing/,
https://developers.cloudflare.com/d1/platform/limits/)

The free plan also allows a Worker 50 queries each time it's called (1,000 on Workers Paid), a batch
counting as one. Saving a match takes four or five, and up to four more when a line without a key
finds its record; a lobby's first save takes up to six more (the tables, and the earlier lines
without a key). Those pages don't say how a call is counted for a Durable Object that stays up
between them. Counted at its strictest (everything saved in one go is one call), ten or so matches
that end in the same moment fit; a save that fails is tried again a minute later.

Saving a match reads, besides its own rows, the lines that are nobody's (players with no key or no
name, one row each) and, for a new key or a line without one, a row or two by its name
(`players_name`).

What reads rows: a match page reads that match's rows, a list its 30 matches, the standings and the
landing page's boards the six kept rows, and a player's page that player's matches of the period and
the players of their latest 50. The one large read is adding the standings up again after a match:
each game's matches, their player rows and those players' records for the all-time board, and the
week's and the month's again for theirs. It grows with the record. By that count, not measured, a
thousand matches of six players come to 20,000 to 40,000 rows after each match, so a hundred matches
a day would use most of the free plan's 5 million and a lobby that busy wants Workers Paid. The
Cloudflare dashboard shows a database's rows read (D1, the database, Metrics).

The pages ask search engines not to keep them or follow their links (`noindex, nofollow`), which
keeps well-behaved crawlers off the player pages; nothing stops one that doesn't ask.

### Known limits

- The games report, and nothing checks them (above). `counted` needs two games to agree, no more.
- A kill is counted once when two games saw it within 5 seconds of each other (`WINDOW_MS`). When the
  victim's own game isn't reporting (an old tab) and the two games that saw it are further apart
  than that, it's counted twice.
- A game whose connection to the lobby is down when its level ends can't send its last report. The
  kills only it saw while the connection was down and, from the host, the final scoreboard are
  lost; the match is saved from what the other games sent and the last scoreboard that arrived.
- A match's weapon highlights (most saber kills and the like) are left out when kills of a kind no
  game told could change who holds them.
- A player with no key whose name is no record's, or the name of more than one, has no record: the
  match shows them, the standings don't.

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

## Engine files

In a kit, the engines' files are named by their content: `e/openjkdf2.<h>.js` and
`e/openjkdf2.<h>.wasm` (Asyncify), `e/jspi/openjkdf2.<h>.js` and `.wasm` (JSPI) and `e/unzip.<h>.js`,
where `<h>` is the first 12 hex digits of the file's SHA-256, each with a `.br` beside it (brotli
quality 11). The page names them in one table, `ENGINE_FILES`, the JSON between its `/* kit-files */`
and `/* /kit-files */` marks. So browsers keep them a year without asking again (`immutable`), and a
page only ever loads its own engine.

`src/engine.js` answers `/e/` (`run_worker_first`): to a browser that takes br (by
`request.cf.clientAcceptEncoding`, since the `Accept-Encoding` a Worker sees always says br) the
`.br`'s bytes as `Content-Encoding: br`, otherwise the plain file, which Cloudflare compresses as
usual. The JSPI engine's wasm is 683 KB that way, against about 853-880 KB compressed on the fly. It
answers only a name as a kit writes it: a `.br` by its own name, any other spelling of a name, and a
name that isn't there get a 404 with `no-store`, as does any other path with no file (`src/lobby.js`),
also under `rooms/`, so a page from a newer deploy that reaches an older one finds its file once it's
there. A `Range` gets the whole file. Each engine file is a Worker request the first time a browser
downloads it (once per browser per kit), and none after that; these count toward the free plan's
100,000 Worker requests a day, and past the limit they get a 429, as the page does.

Each kit also keeps the files of the last three kits before it, at their own paths, so a tab opened
before a deploy still finds its engine: those of cloudflare-92 and before by their fixed names
(`openjkdf2.js`, `openjkdf2.wasm`, `jspi/openjkdf2.js`, `jspi/openjkdf2.wasm`, `unzip.js`).

An older kit hasn't got a newer kit's files, so a rollback (deploying an older kit again) takes them
away. A tab on the newer page whose game has started has its engine already and plays on. One whose
game hasn't asks for files that are gone: its player clicks Play, picks the game folder, and then sees
"The game couldn't start" with a Reload button; the reload brings the older page, where the folder
has to be picked again, and the game starts. Tabs on the older page, and on those of the kits it
keeps, aren't affected. Build the next kit with `--prev` set to the newest kit built, even one that
was rolled back, not to the kit the rollback went to: the newest kit's `public/` has its own files and
the ones it kept, so the next kit keeps both, and tabs still open on either page find their engine.

`tools/build-kit.mjs` makes a kit's `public/` from the two builds' `web/` folders, the page (whose
folder gives `unzip.js`, `move-out.html` and the room pictures in `rooms/`) and the previous kit's
`public/`. Each `web/` folder has to hold one build's `openjkdf2.js` and `openjkdf2.wasm`, as that
build made them: the tool tells the two kinds of engine apart, but not a script and a wasm from two
builds of the same kind.

```
node tools/build-kit.mjs public --asyncify <asyncify web/> --jspi <jspi web/> \
    --page <OpenJKDF2>/packaging/wasm/index.html --prev <previous kit>/public --out <kit> --label cloudflare-93
node tools/build-kit.mjs sums <kit>     # once README.md, src/ and the rest are in
node tools/build-kit.mjs check <kit>
```

It writes the page with its table filled in (nothing else in it changes), the hashed files and their
`.br`, the kept ones, `_headers` (a year for `rooms/` and `e/`), `kit-files.json` (which files each
kit's page loads, newest first, for the next kit's `--prev`; `.assetsignore` keeps it out of the
upload) and `SHA256SUMS`, and prints which kits' files it kept. The same inputs give the same kit,
byte for byte, with the same Node.js (its brotli makes the `.br` files; for a file the previous kit
has too, it keeps that kit's `.br`, as another Node.js's brotli may write other bytes). It writes
nothing when an input is wrong: a page without its one table, or one that names an engine file
outside it, an engine script that doesn't ask `locateFile` for its wasm, the two builds swapped or
one given for both (the JSPI engine's script wraps its wasm's imports in `WebAssembly.Suspending`,
the Asyncify one's doesn't), a wasm that doesn't compile or imports from a module its script doesn't
give it (the other kind's wasm), a room picture whose content doesn't match its name, a kept file
that isn't in `--prev`, a kept file under `e/` whose `.br` isn't there or doesn't unpack to it, a
`.br` beside a kept file outside `e/`, or two different files under one name. `check` reads a kit
back: every file each kit's page loads is there, the page's room pictures too, names under `e/` and
`rooms/` match their content, the page's two engines are the kinds it names and each wasm imports
only from modules its script gives, each `.br` unpacks to its file, there's no `.br` outside `e/`,
and `SHA256SUMS` matches.

`node test/engine.mjs` checks `src/engine.js` and the router, and `node test/build-kit.mjs` the kit
tool and `tools/check-site.mjs`, both with no ports.

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

After a deploy, `node tools/check-site.mjs https://beta.jediknight.zone` (or the site's address) in the
kit's folder checks how the page and the engine files come: the kit's `.br` byte for byte to a browser
that takes br, the plain file otherwise, a year's caching, 404s that nothing keeps, and the kept kits'
files. It makes a few dozen requests, all GET or HEAD, and downloads about 4 MB. A page without an ETag
comes from the zone's settings, not from the kit, and its line says so (`zone`, not `BAD`).

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
