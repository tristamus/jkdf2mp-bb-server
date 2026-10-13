# cloudflare-17

`cloudflare-16` with the page from OpenJKDF2 commit 87a36110 (`web-mp` with
tristamus/OpenJKDF2#25 merged on top of 80cc2eb, which has the same source as `cloudflare-16`).

- **Select all for mods:** a checkbox above the mod list ticks or unticks every mod from the game
  folder at once, with a count beside it like "2 of 12 ticked". It shows a dash when only some are
  ticked, and single mods can still be ticked after it. It only shows for two or more mods.
- **Remembered mod picks:** the list starts the way the player left it last time in that browser,
  kept separately for JK and MotS. Mods that are new since then start ticked. Mods saved from an
  online game aren't counted, and picking one doesn't change what's remembered.

Only `index.html` changed. `openjkdf2.js`, `openjkdf2.wasm` and the lobby (`src/lobby.js`,
`wrangler.toml` and the package files) are the same as `cloudflare-16`. `SHA256SUMS` lists every
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
