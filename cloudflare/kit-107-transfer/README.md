# cloudflare-107

Kit 106's Level Library game menu, with the crash fixed and the layout put right after its first run in the real game.

- **Worker:** kit 106's (and so 105's and 104's), byte for byte (`src/`, `wrangler.toml`, the package files). The job
  keeps running as it is.
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `047aab2`.
- `public/` keeps the engine files of kits 93 to 106 (`--keep 13`), and the five fixed-name files from before
  `build-kit.mjs`, as 106 does.

## What's fixed

- **The crash** ("The game stopped: RangeError: Maximum call stack size exceeded"). A click in the Overview's details,
  or in the Readme or Files text, puts the game's keyboard focus on that box. Changing tabs hides the box, and the
  game's menu code, when it draws a hidden box, looks for where the focus goes next and draws the focused box again,
  which is the hidden one, and so on until the browser's stack runs out. Changing tabs now gives the focus to the list
  of levels, and the menu code itself moves the focus off a box that's hidden (the original game always did; the
  port's newer drawing didn't).
- **One-line text cut in half:** the status line, the message line and the level's name wrapped when too long, and a
  one-line box shows only the top half of two lines. They're now cut with `...` to fit.
- **Sizes clipped in the list:** the title column is narrower (144 instead of 156), so "CTF 2000 12 MB" fits after it,
  and sizes of 10 MB and up are whole MB.
- **Overview:** the screenshot frame is 4:3 (176 by 132), so no black bars; the level's name is under it; the details
  have room for 7 lines instead of 2; the labels are in a wider column (80), and the downloads are in the Rating line,
  so every value starts in the same place.
- **Host Game:** only the right half of "Level Library..." answered clicks, because the "Choose Episode" label in
  front of it was 240 wide and the game gives the click to the first thing under the mouse. The label now ends before
  the button.
- **Texts:** "N levels from Massassi.net so far, M more coming", and "Levels you use are saved in this browser, not in
  your game folder."

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 106's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 106 (`env.LEVELJOB`, `env.LEVELS (jkdf2mp-levels-beta)`, the `*/10` schedule).
  It should upload 9 asset files: the page and the four new engine files with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` lines.

## Tested

- `packaging/wasm/test/library-menu-test.sh` (664 checks): the menu's own code, built with Emscripten and
  AddressSanitizer, on stand-ins for the game's menu system and for the page. It now draws hidden elements the way the
  game's menu code does, and without the fix it finds the endless focus search (4 checks fail); with it, none do. Also
  what the menu shows (rows, long titles and lines cut with `...` to fit, the Overview's labels and wrapped lines, the
  tabs, the 4:3 screenshot frame), what it tells the page, and what it gives the Host screen back. No reads or writes
  out of bounds.
- `packaging/wasm/test/library-test.mjs` (16 tests, Chromium, a stand-in for the site): the page's half, with the new
  texts.
- `maps-test.mjs` (42), `map-names-test.mjs` (7), `picker-test.mjs` (64), `mods-test.mjs` (29) pass. Both engines build
  (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- How it looks in the real game: the cloud has no game files, so that's checked on beta, with the same screenshots as
  106 for comparison.
- Hosting a library level with a joiner.

## Rollback

Deploy kit 106 to beta again (same Worker, the menu with the crash), 105 (the HTML library screen) or 104 (no button).
