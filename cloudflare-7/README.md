# cloudflare-7

`cloudflare-6` with a new engine from OpenJKDF2 commit 721e3021 (PR tristamus/OpenJKDF2#12, merged
into `web-mp`), live as Cloudflare version 42c0a764. The main menu no longer shows View Cutscenes or
Expansions & Mods, in Jedi Knight or Mysteries of the Sith. Credits moved into the View Cutscenes
slot, so Choose Player, Credits and Setup share one centered row.

Only `public/openjkdf2.wasm` differs from `cloudflare-6`. The page, `openjkdf2.js` and the lobby are
unchanged. The toolchain (Emscripten 6.0.12, SDL3 release-3.4.2) rebuilt `cloudflare-6`'s engine byte
for byte first, and a build of this change with the old version label differed from it only in the
main menu function. Each file in `public/` was checked against the live site after the deploy.
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
