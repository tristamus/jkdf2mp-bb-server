# cloudflare-12

`cloudflare-11` with the engine from OpenJKDF2 commit 45f6ad23 (PR tristamus/OpenJKDF2#18, on top of
`web-mp` 9f692a19), live since 2026-10-12 as Cloudflare version 1c48ced2. A character whose `.plr` is
empty, cut short or doesn't start with `version 1` can be picked again: it starts over with default
settings under the same name, at Medium, and the old file is moved to `<name>.plr.bak`. Before, the
Players list showed it but Ok gave "Cannot set player <name>". A `.plr` with a byte-order mark or
spaces before `version 1` is now read with its own settings, and the browser console says why a
`.plr` was rejected.

Only `public/openjkdf2.js` and `public/openjkdf2.wasm` changed. `public/index.html` and the lobby
(`src/lobby.js`, `wrangler.toml` and the package files) are the same as `cloudflare-11`. Each file in
`public/` was checked against the live site after the deploy. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
