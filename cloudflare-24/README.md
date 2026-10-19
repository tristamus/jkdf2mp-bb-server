# cloudflare-24

`cloudflare-23` with the engine from OpenJKDF2 commit 0a6519a5 (`web-mp` with
tristamus/OpenJKDF2#33 and #34 merged on top of cfe985df, the source of `cloudflare-23`).

- **No more spawning in a death pose (#33):** a player who joined into the slot of someone who had
  left while dead got that player's death pose from the host's join sync, and ran around lying down
  in third person until they died once. A multiplayer spawn now clears every animation track.
- **A quick rejoin gets in (#34):** a player who joined soon after someone else left was usually
  given that player's net id, and their first messages were dropped as repeats of the last
  player's, so in a quiet game they timed out with "Server has left game". A leaving player's
  messages are now forgotten, and each new game starts with none remembered.

`openjkdf2.wasm` changed. `openjkdf2.js`, `index.html` and the lobby (`src/lobby.js`,
`wrangler.toml` and the package files) are the same as `cloudflare-23`. `SHA256SUMS` lists every
file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
