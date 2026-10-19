# cloudflare-28

`cloudflare-27` with the page from OpenJKDF2 commit 816916fb (`web-mp` with
tristamus/OpenJKDF2#36 merged on top of 8a00a435, the source of `cloudflare-27`).

- **Faster start after picking the game folder:** the page reads only the files the game opens
  (the GOBs and episode folders, `resource`, `mods`, loose resource folders, controls, characters
  and each mod's own files) instead of every file in the folder. On a Steam Mysteries of the Sith
  folder with the Remastered pack that's 76 files (509 MB) instead of 4,842 (2.3 GB), mostly the
  pack's `jkgm` HD textures, which the browser build doesn't use.
- The browser console gets one line per load with the time each stage took.

Only `index.html` changed. `openjkdf2.js` and `openjkdf2.wasm` are `cloudflare-27`'s, byte for
byte (#36 doesn't touch the engine or `mods.js`/`maps.js`). The lobby (`src/lobby.js`,
`wrangler.toml` and the package files) is the same as `cloudflare-27`. `SHA256SUMS` lists every
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
