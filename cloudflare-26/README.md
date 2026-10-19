# cloudflare-26

`cloudflare-25` with the page and engine from OpenJKDF2 commit 6d5b5ad9 (`web-mp` with
tristamus/OpenJKDF2#31 merged on top of ad43ce01, the source of `cloudflare-25`).

- **Graphics acceleration notice:** when the browser draws the game without the graphics card
  (graphics acceleration off, so WARP, SwiftShader or another software renderer) or can't draw it
  at all, the landing page and the Pick your game folder window say so, with the steps to turn it
  on in Edge, Chrome, Brave or Firefox. Nothing shows on a real graphics card.
- **Edge enhanced security notice:** in Edge, when enhanced security is on for the site (it turns
  off Edge's just-in-time compiler, so the game's WebAssembly runs in an interpreter), the same
  places say how to turn it off for the site. A short speed test in a worker tells, as pages can't
  ask. It has a Hide button.
- **F8 takes screenshots too:** Edge on Windows keeps F12 for its developer tools, so the game
  never gets it there. F8 gives way if the player binds it to something else.
- **Leaving mid-game asks first:** once the game is running, the browser asks before the tab
  closes or reloads. Outside fullscreen Ctrl+W (fire plus walk forward) closed the tab without
  asking.

`index.html` and `openjkdf2.wasm` changed. `openjkdf2.js` is the same as `cloudflare-25`, and so is
the lobby (`src/lobby.js`, `wrangler.toml` and the package files). `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
