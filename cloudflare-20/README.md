# cloudflare-20

`cloudflare-19` with the engine from OpenJKDF2 commit 815cdb89 (`web-mp` with
tristamus/OpenJKDF2#27 merged on top of af3bc32c, which has the same source as `cloudflare-19`).

- **No screen flicker with Bloom and SSAO on (#27):** the blur behind Bloom and SSAO now takes the
  same number of samples every frame. On some GPUs (seen on an RTX 5090 in Chrome) it sometimes
  skipped its outer ring, and the final combine then darkened the 3D view to a fraction of its
  brightness while the HUD stayed normal. That showed as flicker on Edit Character and in MotS
  matches; a Jedi Knight player saw the same and it stopped with Bloom and SSAO off. A new scene
  buffer's first frame also clears all four of its color buffers now, so it no longer starts with a
  black glow.

`openjkdf2.wasm` changed. `openjkdf2.js` changed only in the numbers the engine uses to find its
inline JavaScript and the short names of the functions it imports. `index.html` and the lobby
(`src/lobby.js`, `wrangler.toml` and the package files) are the same as `cloudflare-19`.
`SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
