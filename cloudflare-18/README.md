# cloudflare-18

`cloudflare-17` with the engine script and page from OpenJKDF2 commit 51b96827 (`web-mp` with
tristamus/OpenJKDF2#26 merged on top of 87a3611, which has the same source as `cloudflare-17`).

- **MotS Remastered pack in multiplayer (#26):** every player runs the pack the way the host does,
  so the same hit plays out the same on every machine. A joiner whose game folder has the pack
  restarts without it for a host who doesn't run it, and with it again for a host who does. A
  joiner without the pack, or with a different version of it, sees a message naming
  `JKMRemasteredAssets.goo` instead of joining. The pack is never sent between players.

`openjkdf2.js` (which carries `mods.js`) and `index.html` (a comment only) changed.
`openjkdf2.wasm` and the lobby (`src/lobby.js`, `wrangler.toml` and the package files) are the same
as `cloudflare-17`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
