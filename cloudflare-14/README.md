# cloudflare-14

`cloudflare-13` with the engine from OpenJKDF2 commit d4c28982 (PR tristamus/OpenJKDF2#21, on top of
`web-mp` e2225f1, which has the same source as `cloudflare-13`). A lit saber now lights the walls,
floors and characters around it in its blade's color instead of always in white, in both Jedi Knight
and Mysteries of the Sith, and other players' sabers light the area in their colors too. A new
**Colored Saber Glow** checkbox in Setup > Display turns it off. Nothing new goes over the network:
each player's browser works out the colors itself.

`openjkdf2.js` and `openjkdf2.wasm` changed and go together. `index.html` and the lobby
(`src/lobby.js`, `wrangler.toml` and the package files) are the same as `cloudflare-13`.
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
