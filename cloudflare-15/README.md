# cloudflare-15

`cloudflare-14` with the landing page from OpenJKDF2 commit bde14694 (PR tristamus/OpenJKDF2#22, on
top of `web-mp` 09b67eb, which has the same source as `cloudflare-14`). The page has a new Features
section after the game rooms: four short boxes (Play online, Custom maps and mods, Sabers and
screenshots, Kept for next time) on what this web version adds, linked from the top bar, the gold
menu, the sidebar and a new first headline.

Only `index.html` changed. `openjkdf2.js`, `openjkdf2.wasm` and the lobby (`src/lobby.js`,
`wrangler.toml` and the package files) are the same as `cloudflare-14`. `SHA256SUMS` lists every
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
