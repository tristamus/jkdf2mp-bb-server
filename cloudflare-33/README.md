# cloudflare-33

`cloudflare-32` with the page and engine from OpenJKDF2 commit a7df0d38 (`web-mp` with
tristamus/OpenJKDF2#43 merged on top of a3146aae, the source of `cloudflare-32`) and the lobby from
jkdf2mp-bb-server commit 2ff9548c (`main` with tristamus/jkdf2mp-bb-server#40).

- **Joiners no longer kicked as if the host left:** a joiner whose own connection to the lobby
  dropped used to leave the match with "Server has left game", even with its direct link to the
  host still up. A lobby deploy did that to every joiner at once. Now the game reconnects to the
  lobby and takes its seat back, and the match goes on over the direct links meanwhile. This
  happened in Jedi Knight as well as MotS.
- **Seats held for a minute:** when a player's connection to the lobby drops, the lobby keeps their
  seat for 60 seconds and tells the room the player was lost, not that they left. A host whose
  connection dropped is hidden from the Join list until it's back.
- **A joiner still leaves when the host is really gone:** that is, when its direct link to the host
  is down and the lobby says the host left, won't give the seat back, or has been unreachable for
  20 seconds. The game's own 30-second timeout is still there too.
- **Closing the tab:** the other players see the player leave within a second.
- **Network log:** when the network ends a match, the page says why ("Left the game: ...") and
  offers **Save network log**, a .txt of the last 1000 lobby, link and engine lines, to send with a
  report. `index.html?netlog` keeps the button up.

`index.html`, `openjkdf2.js`, `openjkdf2.wasm` and `src/lobby.js` changed. The page keeps
`cloudflare-32`'s fullscreen choice before every start. `wrangler.toml` and the package files are
the same as `cloudflare-32`'s. `SHA256SUMS` lists every file.

Deploying this still ends any match in progress: pages loaded before it run the old game, which
leaves the match when the deploy closes its lobby connection. Once players have reloaded, later
lobby deploys no longer end matches, since the held seats are kept in the lobby's storage.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
