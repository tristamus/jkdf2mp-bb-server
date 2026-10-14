# cloudflare-21

`cloudflare-20` with live player and game counts on the landing page: the engine and page from
OpenJKDF2 commit 5c31bed7 (`web-mp` with tristamus/OpenJKDF2#29 merged on top of 815cdb89, the
source of `cloudflare-20`) and the lobby from this repository's commit f7c1690a (`main` with #24
merged).

- **Live counts on Nar Shaddaa:** Nar Shaddaa under Standard Rooms shows how many players are on
  and how many games are hosted, and the rooms heading shows Total Players, as on the old MSN
  Gaming Zone. Clicking Nar Shaddaa opens a room window listing each game (name, players out of
  max, map, mod, password or not, MotS) with its players' names, and who's in the lobby. It
  updates live while it's open. `/#nar-shaddaa` opens it directly.
- **Join from the room window:** Join on a game asks for the game folder like Play does, and the
  game starts with that game already selected on its Join screen. Host and the Play JKDF2 buttons
  work as before.
- **The game tells the lobby its player's name:** it connects when it starts instead of when the
  Join screen opens, says its player's name and game, and outside a match reconnects by itself if
  the lobby restarts. Passwords never leave the lobby, only whether a game has one.

All three files in `public/` changed, and so did `src/lobby.js`. `wrangler.toml` and the package
files are the same as `cloudflare-20`. `SHA256SUMS` lists every file.

Deploying a new lobby restarts it, which drops every connection to it once, so deploy while
nobody is in a match: their games would lose the lobby. Players sitting in the menus reconnect
by themselves.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
