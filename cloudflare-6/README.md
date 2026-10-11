# cloudflare-6

`cloudflare-5` with a corrected landing page from OpenJKDF2 commit 5e45b364 (PR
tristamus/OpenJKDF2#8), live as Cloudflare version 284a7f05. The page used to say picked game
files never reach the server or other players. Since `cloudflare-5`, a custom map someone hosts is
sent to joiners who don't have it, directly or through the lobby, so the headline, the Your Files
section and the folder prompt now say so, and that original game files are never sent.

Only `public/index.html` differs from `cloudflare-5`. The engine (`openjkdf2.js`, `openjkdf2.wasm`)
and the lobby are unchanged, and each file in `public/` was checked against the live site after the
deploy. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
