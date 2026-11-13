# cloudflare-106

The Level Library as a real game menu, on beta. Kit 105 drew the library as a page over the game, in the game's
colors. This kit draws it with the game's own menu system instead, like the Host Game screen it opens from: the same
background, fonts, checkboxes, lists, arrow buttons, hint line, cursor and hover and click sounds. What happens
underneath (the list, the download, the checks, saving in the browser, picking it on Choose Episode) is kit 105's.

- **Worker:** kit 105's (and so 104's), byte for byte (`src/`, `wrangler.toml`, the package files). The job keeps
  running as it is.
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `674f3a5`. New: `src/Gui/jkGUILibrary.c`, the
  menu. `packaging/wasm/library.js` now only gets the levels and gives the menu its text.
- `public/` keeps the engine files of kits 93 to 105 (`--keep 12`), and the five fixed-name files from before
  `build-kit.mjs`, as 105 does.

## What a player sees (beta)

- **Multiplayer, Host Game:** the same **Level Library...** button as 105, to the right of Choose Episode.
- **The library, a game menu:** "Level Library" at the top in the game's large font, and under it how many levels
  the site has so far.
  - **Left:** a Search box, the Multiplayer, CTF (Kill the Fool in Mysteries of the Sith) and Co-op checkboxes, Sort
    with the game's left and right arrows (Name, Newest first, Oldest first, Most downloaded, Top rated, Smallest
    first), and the list of levels with the year and size of each. A `*` before a title means it's saved in this
    browser.
  - **Right:** Overview, Readme and Files. Overview shows the screenshot (click it for the next one), the level's name,
    and its author, real release date and where that date came from, size, type, episode, rating, downloads and
    description.
  - **Bottom:** the hint line, what's coming in (with a percentage), and Cancel, Massassi Page and Use Level.
  - **Keys:** Return is Use Level, Escape is Cancel, a double click on a level uses it. Cancel during a download stops
    it and keeps the library open.
- **The screenshot** is the one part the game can't draw (its menus have 256 colors), so the page puts the picture
  over the frame the menu leaves for it. It goes when the menu closes.
- Text the game's fonts don't have (curly quotes, long dashes, accented letters) is shown as the nearest plain letters.

## Live site

Not planned until the library has been tried on beta. A live deploy would show no button (no `/levels` there).

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 105's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 105 (`env.LEVELJOB`, `env.LEVELS (jkdf2mp-levels-beta)`, the `*/10` schedule).
  It should upload 9 asset files: the page and the four new engine files with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` lines.

## Tested

- `packaging/wasm/test/library-menu-test.sh` (188 checks): the menu's own code, built with Emscripten and
  AddressSanitizer, on stand-ins for the game's menu system and for the page. What it shows (the rows, long titles cut
  with `...` to fit, the Overview's labels and wrapped lines, the tabs, the screenshot's frame), what it tells the
  page (search, filters, sort, the pick, Use Level, Cancel, Massassi Page, the next screenshot), and what it gives the
  Host screen back. No reads or writes out of bounds.
- `packaging/wasm/test/library-test.mjs` (16 tests, Chromium, a stand-in for the site): the page's half as the menu
  drives it: the list, counts, sorts, filters, search, Readme and Files, the screenshot placed over the menu's frame
  and following the canvas, the text cleanup, Use Level end to end into the store and `episode/`, a saved level not
  downloaded again, a zip in the zip and a subfolder, the renames, a zip with no GOB, a wrong hash refused, Cancel and
  closing during a download, MotS, no library where the site has none, a list that can't be got.
- `maps-test.mjs` (42), `map-names-test.mjs` (7), `picker-test.mjs` (64), `mods-test.mjs` (29) pass. Both engines build
  (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- The menu in the real game: the cloud has no game files to run the engine with, so beta is its first real run. The
  places and fonts follow the Host Game screen's, but how it looks with the real fonts (how much of a title fits, the
  label column) is only known from a real run.
- Hosting a library level with a joiner.

## Rollback

Deploy kit 105 to beta again (same Worker, the HTML library screen), or kit 104 (no button).
