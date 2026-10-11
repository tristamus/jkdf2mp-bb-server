# cloudflare-8

`cloudflare-7` with a new page and engine from OpenJKDF2 commit 5a6b3966 (PR tristamus/OpenJKDF2#13,
merged into `web-mp`), live as Cloudflare version e7098fc3. Players can play with full mods, like Saber Battle X. After picking the game
folder, the page lists every mod it finds, all ticked: mod folders, GOBs in `Resource` and `mods`
that aren't the game's own, and JK Patch Commander's active patches. Several ticked mods run
together. A host's mods go to joiners who don't have them, directly or through the lobby, without
original game files, and a joiner on other mods restarts in the same tab with the host's.

All three files in `public/` differ from `cloudflare-7`. The lobby (`src/lobby.js`, `wrangler.toml`
and the package files) is unchanged: the lobby entries already had room for the mod's short tail.
The toolchain (Emscripten 6.0.12, SDL3 release-3.4.2) built the merged commit with the old version
label byte for byte the same as the tested build, so the engine here differs from what was tested
only by its version label. Each file in `public/` was checked against the live site after the
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
