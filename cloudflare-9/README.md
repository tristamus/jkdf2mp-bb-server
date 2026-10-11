# cloudflare-9

`cloudflare-8` with a new page and engine from OpenJKDF2 commit 3ef73dd8 (PR tristamus/OpenJKDF2#14,
merged into `web-mp`), live since 2026-10-11 as Cloudflare version 1220a383. Each mod gets its own checkbox: every GOB and mod folder in a folder that
collects several mods, like a `mod` or `mods` folder, and every zip file with a mod in it, which the
page opens in the browser as if it had been unzipped in place. A folder's own loose files are one
more checkbox. Joiners get zipped mods like any other.

Only `public/index.html` changed in what the page does. `public/openjkdf2.js` is the same as
`cloudflare-8`, and `public/openjkdf2.wasm` differs from it only by its version label, since no engine
code changed. The lobby (`src/lobby.js`, `wrangler.toml` and the package files) is unchanged.
Each file in `public/` was checked against the live site after the deploy. `SHA256SUMS` lists every
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
