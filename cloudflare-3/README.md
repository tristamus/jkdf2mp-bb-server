# cloudflare-3

`cloudflare-2` with the redesigned landing page from OpenJKDF2 branch `claude/project-thread-j7d5nm`
(commit ee9d3d2), live as Cloudflare version 948dd244. Only `public/index.html` changed: the engine
(`openjkdf2.js`, `openjkdf2.wasm`) and the lobby are the same files as `cloudflare-2`, so characters
and controls are still kept. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
