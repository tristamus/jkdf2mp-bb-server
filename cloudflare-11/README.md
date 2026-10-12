# cloudflare-11

`cloudflare-10` with the page from OpenJKDF2 commit 1ee62fdd (PR tristamus/OpenJKDF2#20, merged into
`web-mp`), live since 2026-10-12 as Cloudflare version c1d24844. The MotS Remastered fan pack now loads
like the game's own files. Its `JKMRemasteredAssets.goo` in `Mods` loads for whoever has it, isn't
listed as a mod and isn't sent to joiners, and its cutscenes folder, `jkmcutscenes`, is skipped like
the game's videos. Before, a Steam MotS folder with the pack listed both as mods. Other MotS mods are
still listed and shared as before.

Only `public/index.html` changed. `public/openjkdf2.js`, `public/openjkdf2.wasm` and the lobby
(`src/lobby.js`, `wrangler.toml` and the package files) are the same as `cloudflare-10`. Each file in
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
