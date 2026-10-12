# cloudflare-13

`cloudflare-12` with the page and engine from OpenJKDF2 commit e1bf8cf3 (PR tristamus/OpenJKDF2#17,
merged with `web-mp` a1a395d after PRs tristamus/OpenJKDF2#18 and #20). F12, or whichever key is
bound to screenshots, now saves what's on screen in both Jedi Knight and Mysteries of the Sith.
Before, the browser build said "Screenshot taken" and saved nothing. The pictures stay in the
player's browser (IndexedDB, in a database of their own), and the landing page lists them under Your
Screenshots, with download, download all as a zip, and delete. While the game has focus, F12 doesn't
open the browser's developer tools.

All three files in `public/` changed: `index.html` adds the Your Screenshots section, and
`openjkdf2.js` and `openjkdf2.wasm` go together. The lobby (`src/lobby.js`, `wrangler.toml` and the
package files) is the same as `cloudflare-12`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
