# cloudflare-108

Kit 107 with two fixes from its run in the real game.

- **Worker:** kit 107's (and so 104's to 106's), byte for byte (`src/`, `wrangler.toml`, the package files).
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `16f6e32`.
- `public/` keeps the engine files of kits 93 to 107 (`--keep 14`), and the five fixed-name files from before
  `build-kit.mjs`, as 107 does.

## What's changed

- **Host Game:** "Level Library..." is in the small font of the labels and checkboxes around it (about 29% smaller
  than the button font), red, and yellow with the mouse over it, like those checkboxes.
- **The library's list:** a level's kind (CTF, KFY, SP) now sits at the end of the title's column, just before the
  year, instead of in front of the year. In 107, "CTF 2001 5.5 MB" ran past the list's edge and lost its "B", and
  "CTF 2000 2.0 MB" lost " MB". Now every year starts at the same place and the sizes fit; a CTF level's title is cut
  a little shorter to make room.

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 107's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 107. It should upload 9 asset files: the page and the four new engine files
  with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` line.

## Tested

- `packaging/wasm/test/library-menu-test.sh` (667 checks): the menu's own code with AddressSanitizer, on stand-ins
  for the game's menu system and the page, now with rows that carry a kind: the title cut to leave room, the kind
  ending at the column's stop, the year and size after it.
- `packaging/wasm/test/library-test.mjs` (16 tests, Chromium): the page's half, with the new rows.
- `maps-test.mjs` (42), `map-names-test.mjs` (7), `picker-test.mjs` (64), `mods-test.mjs` (29) pass. Both engines build
  (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- The button's new font and the CTF rows in the real game: checked on beta.

## Rollback

Deploy kit 107 to beta again (same Worker).
