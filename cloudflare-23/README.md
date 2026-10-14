# cloudflare-23

`cloudflare-22` with a lobby that ends a game whose host is gone: the engine and page are the same
as `cloudflare-22` (OpenJKDF2 commit cfe985df), and the lobby is from this repository's commit
497f45f5 (`main` with #28 merged).

- **Games whose host vanished come off the lists:** a game used to stay listed until its host's
  connection closed, which can take a long while when a tab goes away without closing it (a killed
  browser, a computer that went to sleep, a dropped network). The game and the page ping the lobby
  every 25 s whatever the player is doing, and background tabs still do at least once a minute.
  The lobby now ends a connection that has sent nothing for 2 minutes as if it had closed: its
  player comes off the counts, a game it hosted ends, and its joiners are told the host left.
  Idle players, in a match or in the menus, keep pinging and stay.

Only `src/lobby.js` changed. `public/`, `wrangler.toml` and the package files are the same as
`cloudflare-22`. `SHA256SUMS` lists every file.

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
