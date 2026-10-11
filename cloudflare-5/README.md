# cloudflare-5

`cloudflare-4` with a new engine from OpenJKDF2 commit 7618b236 (branch `claude/project-thread-0cpeq2`,
PR tristamus/OpenJKDF2#6), live as Cloudflare version f868e101. That commit adds automatic map downloads
on top of `cloudflare-4`'s engine (f217106):

- A joiner who doesn't have the host's custom map, or has another version of it, gets it from the
  host's tab before the level loads, over the direct WebRTC link or else through the lobby. It's
  saved in that browser for next time.
- Original game files are never sent. Original levels aren't offered, and files in a custom map that
  are copies of the original game's are rebuilt from the joiner's own install.

`openjkdf2.js` and `openjkdf2.wasm` are the deployed files, checked against the live site after the
deploy. `index.html` and the lobby are the same as `cloudflare-4`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
