# cloudflare-4

`cloudflare-3` with a new engine from OpenJKDF2 commit f217106 (branch `claude/project-thread-wti5ke`),
live as Cloudflare version 2619a382. That commit merges two changes on top of `cloudflare-3`'s source:

- Mysteries of the Sith 16-bit textures draw correctly in the browser (2e84e91).
- Single Player is hidden from the browser build's main menu, in Jedi Knight and Mysteries of the
  Sith (afd3dc7).

`openjkdf2.js` and `openjkdf2.wasm` are the deployed files, from the `test-hide-singleplayer` build on
jkdf2mp-bb-server branch `claude/project-thread-wti5ke` (8caf2d4). `index.html` and the lobby are the
same as `cloudflare-3`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
