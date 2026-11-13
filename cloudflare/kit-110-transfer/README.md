# cloudflare-110

Kit 109 with the Level Library's 3D view, My levels, and fixes to the Host Game button and the list's mouse wheel.

- **Worker:** kit 109's, except `src/levels.js` and `src/levels-read.js` (each level's own textures and colormaps for
  the 3D view, the map rule, a cap of its own for the 3D data, and a one-time repair of map names). `wrangler.toml`
  and the package files are 109's, byte for byte: no new bindings, the same bucket.
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `de3e52e`.
- `public/` keeps the engine files of kits 93 to 109 (`--keep 16`), and the five fixed-name files from before
  `build-kit.mjs`, as 109 does.

## What's changed

- **The Overview:** the screenshot moves left, in line with the details under it, and the level's 3D view sits to
  its right, the same size, ending where the tabs do. It turns slowly. A click on it (or its corner icon) opens the
  big 3D view.
- **The big 3D view:** the level's name over a wide frame. Orbit: drag to turn, right-drag to move, wheel to zoom.
  Walk: from each starting place, drag to look, W A S D, E and Q up and down, Shift faster, the wheel a step. Walk /
  Orbit, Next Start (walking) or Next Map (a zip of more than one level), and Back. Back or Escape returns to the
  library as it was: its tab, its pick, its scroll.
- **Textures:** the level's own textures are Massassi's PNGs of them, exact. The game's own (which the site doesn't
  keep) come from the player's own game files by name (`resource/Res2.gob`, `Res1hi.gob`, the episodes; MotS's
  `.goo`s), through the level's master colormap, as the game draws them. One that's in neither stays Massassi's
  blurred stand-in, and the big view says how many.
- **A 3D view that didn't load:** "Click to try again". Next Map stays, to the level's other maps.
- **Big maps** (up to about 20 MB of JSON) are read in a worker, so the menu doesn't stop; textures load in batches.
- **My levels:** a checkbox beside Co-op. Only the levels saved in this browser (used here, or got from a host), with
  the kinds ticked and the search. "No levels saved in this browser yet." when there are none.
- **The wheel over the list of levels** picks the next or previous level from the first notch, without clicking the
  list first.
- **Host Game:** "Level Library..." stays on one line (109 wrapped it), its text ending at x 630.
- **The job:** each level's own textures (names), colormaps and each level's master colormap, read from the zip in
  the bucket (no request to Massassi): `pv/<id>.tex.json`, served at `/levels/p/<id>.tex.json`. Levels copied before
  get it first, a step a second. A zip of one GOB of one level goes straight to its map; one of more levels asks the
  preview's page, which lists each. The 3D data has a cap of its own, `LEVELS_PREVIEW_GB` (3 GB if not set), apart
  from `LEVELS_MAX_GB`'s zips and pictures.
- **Repair, once:** 109 named the one map of a single-GOB zip after the GOB and took only its first level. When 110's
  job starts: a GOB of one level gets the level's name (its map was right, nothing is asked again); a GOB of more
  levels is asked for again from the preview's page.

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 109's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 109. It should upload 9 asset files: the page and the four new engine files
  with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` line.
- **The job:** `https://beta.jediknight.zone/levels/status` within a few minutes shows no new `last_error`, and
  `https://beta.jediknight.zone/levels/p/323.tex.json` (6000 Block) answers with its `own`, `cmp` and `pal`.

## Tested

- `test/levels.mjs` (all 29 pass): as 109's, and the textures' list (own MATs, CMPs in the GOB, each .jkl's master
  colormap), levels from before getting it without asking Massassi, the one-level shortcut, the 3D cap, and the
  repair (renamed without a request; asked again from the preview's page; once only). The Worker's other tests pass
  as before (`imperial-route`, `protocol` and `turn` need a network this cloud doesn't have).
- `packaging/wasm/test/library-menu-test.sh` (1229 checks, AddressSanitizer): the two frames side by side, the 3D
  view's states (none, coming, there, failed and its retry), the big view and back (its texts, Walk, Next Start, Next
  Map on a failed map, Escape, the library as it was, what changed meanwhile), My levels, the wheel over the list.
- `packaging/wasm/test/library-test.mjs` (22 tests, Chromium with WebGL 2): MATs (8-bit through a colormap, the
  transparent color, 16-bit, a color MAT), colormaps, GOBs, the map's triangles, which texture comes from where; the
  3D view in its frame and the textures read back from the GPU (the level's own exact, the game's from the player's
  files through the level's own colormap or one of the game's, a missing one as Massassi's); the big view (orbit
  zoom, walk, keys, drag, wheel, starting places); two maps, one failing, retry, Next Map; the worker and the page's
  own thread; My levels. maps-test, map-names-test, picker-test and mods-test pass as before.
- **Textures against Massassi's own:** level 11783's own MATs read as the 3D view reads them map pixel for pixel to
  one colormap across all its textures in Massassi's PNGs; read the other way up they don't (tens of thousands of
  clashes).
- Both engines build (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- The 3D view with a real mouse, keyboard, GPU and the player's real game files: checked on beta.
- Massassi's real data for levels with the game's textures swapped in: checked on beta (the job's repair and textures'
  list run there first).

## Rollback

Deploy kit 109 to beta again (its page has no 3D view; what 110's job wrote stays in the bucket, unused).
