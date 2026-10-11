# cloudflare-2

`cloudflare-1` with a new browser build from OpenJKDF2 branch `phase2/saves` (commit 9490ded):
characters and controls are kept in the browser, and characters in the picked game folder's
`player` folder are brought in. The lobby is the same as `cloudflare-1`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
