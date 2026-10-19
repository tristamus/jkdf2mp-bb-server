# cloudflare-27

`cloudflare-26` with the page and engine from OpenJKDF2 commit 8a00a435 (`web-mp` with
tristamus/OpenJKDF2#35 merged on top of 6d5b5ad9, the source of `cloudflare-26`).

- **Quit goes back to the lobby:** Yes on the game's Quit stores the saves and reloads the lobby
  page instead of starting the game again in the tab. A game started from the Nar Shaddaa or
  Sith: Asteroid room window comes back to that room window. The browser doesn't ask before
  leaving for this.
- **A way out of the startup Players screens:** the Players and New Player screens shown at
  startup, where Cancel is hidden, have a Quit button in its place, and Esc asks the same Quit
  question. Players opened from the main menu still has Cancel.

`index.html`, `openjkdf2.js` and `openjkdf2.wasm` changed. The lobby (`src/lobby.js`,
`wrangler.toml` and the package files) is the same as `cloudflare-26`. `SHA256SUMS` lists every
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
