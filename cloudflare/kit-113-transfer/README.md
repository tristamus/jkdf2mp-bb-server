# cloudflare-113

Kit 112 with one more fix to the Level Library's 3D view: no player model standing at the starting places.

- **Worker:** kit 112's, byte for byte (`src/`, `wrangler.toml`, the package files).
- **Page:** kit 112's `index.html`, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `75ea58e` (112's `0a402d1` and this fix).
- `public/` keeps the engine files of kits 93 to 112 (`--keep 18`), and the five fixed-name files from before
  `build-kit.mjs`.

## What's changed

- **The starting places:** Massassi's 3D data has a player's model (Kyle) at each one, as the level has a thing
  there. The game switches a starting place's player off until someone takes it (`sithPlayer_Startup`:
  `SITH_TF_DISABLED`) and draws none of them, so the 3D view now leaves them out: a model surface all of whose
  corners are close around a starting place. In 112, Chaos Eternal showed a Kyle just ahead of the camera at a
  starting place; from outside, every starting place had one.

## Deploy (beta)

In this folder (the package files are 112's, so its `node_modules` works):

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 112's beta. It should upload 9 asset files: the page and the four new engine
  files with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` line.

## Tested

- **On real data:** Massassi's 3D data for five levels (11783, 6000, bactf, 4hgyrd, tfpack; 78 starting places): at
  every starting place exactly 289 triangles are left out, one Kyle, and nothing else.
- `packaging/wasm/test/library-test.mjs` (all pass): as 112, and a model at a starting place left out while one beside
  it, or reaching past it, is drawn. The menu test (1255 checks), maps-test, map-names-test, picker-test and mods-test
  pass.
- Both engines build (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Rollback

Deploy kit 112 to beta again.
