# cloudflare-112

Kit 111 with the fixes from kit 110's check on beta: the 3D view drawn as Massassi's preview draws it, the other
game's textures, Next Map, long titles, My levels with nothing saved, and the copy job working through both games'
lists side by side.

- **Worker:** kit 111's, except `src/levels.js` (the job's order). `wrangler.toml` and the package files are 111's,
  byte for byte: the same bindings on both, the site's job off.
- **Page:** kit 111's `index.html`, except `Module.jkSavedGameFile` (for the 3D view, a file of the other game's
  saved in this browser) and its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `0a402d1`; Worker code bb-server `bd7ccac`.
- `public/` keeps the engine files of kits 93 to 111 (`--keep 17`), and the five fixed-name files from before
  `build-kit.mjs`.

## What's changed

- **One side of each surface:** the front, as the game and Massassi's preview draw them (a surface seen from both
  sides is in the data twice). In Walk, the player's model standing at each starting place no longer fills the view
  from inside its head. From outside (Orbit and the small view), the walls' backs let you see into the rooms.
- **No light:** each texture as it is, as Massassi's preview draws it. 110 used the level's light, which made it much
  darker than Massassi's from outside.
- **The other game's textures:** Massassi's preview reads Res1hi.gob, Res2.gob and JKMRES.GOO for every level, so a
  Jedi Knight level can use a texture that only Mysteries of the Sith has (Caesar's Palace: five, on a model), and the
  other way round. Those now come from the other game's files when this browser has them saved (or kept, and
  readable without asking), read in pieces, not whole. Without them they stay Massassi's blurred stand-in, and the note
  says "5 textures here are from Mysteries of the Sith: shown blurred."
- **Next Map** stays while the next map loads, so a press then goes on to the one after (110 hid it, and the press
  hit nothing).
- **Titles** too long for the big font are drawn in the medium one before being cut ("Chaos Eternal: academy (1 of
  3)"). The Walk help line is shorter: "Drag to look, W A S D to move, E Q up and down, Shift faster."
- **My levels with nothing in the list:** nothing stays picked. The details say "My levels" and "No levels saved in
  this browser yet." (or that none match the search), with no screenshot or 3D frames.
- **The job:** each level gets its place in its own game's list, most downloaded first, and the job works by that
  place. MotS's levels (fewer downloads) no longer wait for nearly all of Jedi Knight's. Same pace, same requests.

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 111's, so its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 111's beta. It should upload 9 asset files: the page and the four new engine
  files with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` line.
- **The job:** `https://beta.jediknight.zone/levels/status` shows no new `last_error`, and its requests go to MotS
  levels as well as JK's within the hour.

## Tested

- `packaging/wasm/test/library-menu-test.sh` (1255 checks, AddressSanitizer): as 110, and Next Map while a map
  loads, a long title in the medium font that fits, a short one back in the big font, and the empty list with no
  picture frames.
- `packaging/wasm/test/library-test.mjs` (all pass, Chromium with WebGL 2): as 110, and the one-sided drawing's GL
  state, the vertices without light, the other game's texture from a saved file (asked once, read in pieces, through
  the level's colormap), the note when it isn't saved, Next Map while loading, and My levels clearing the pick and
  saying why. maps-test, map-names-test, picker-test and mods-test pass.
- **One side, on real data** (Massassi's 3D data for levels 11783 and 6000, every starting place): the world covers
  the same share of the view as drawn from both sides (100% at 11783's), and drawn the other way round much less, so
  counterclockwise is the front. Within 0.1 of the eye, the models covered 68% of the view (the face); now 0%.
- **The five textures** on Caesar's Palace: in none of Jedi Knight's files (Res2, Res1hi, JK1MP, JK1CTF, JK1 on
  Antonio's PC), all five in MotS's JKMRES.GOO (chrpads, chrback, chrarm, chrmetal, chrbutt). Chaos Eternal: none
  missing.
- `test/levels.mjs` (all pass): as 111, and both games' lists side by side. The Worker's other tests pass as before.
- Both engines build (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- The real game on beta with a real GPU, mouse and keyboard, and with MotS's files saved in the browser: checked on
  beta.

## Rollback

Deploy kit 111 to beta again (kit 110's page and engines with the library's bindings).
