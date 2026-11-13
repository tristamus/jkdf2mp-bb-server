# cloudflare-105

The Level Library's screen, on beta. This is kit 104 (the fetching job) plus the library itself: a **Level Library...**
button on the Host Game screen, to the right of Choose Episode, that opens the site's copy of Massassi's levels. A
level picked there is downloaded from the site, checked, saved in the browser and selected as the episode to host.
People who join get it from the host, as with any level today.

- **Worker:** kit 104's, byte for byte (`src/`, `wrangler.toml`, the package files). The job keeps running as it is.
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `e0bb19b`, on web-mp `0651055e` (live kit 103's
  engines). The library is a new page script inside the engine (`packaging/wasm/library.js`, bundled like `maps.js`),
  plus the button in `src/Gui/jkGUINetHost.c`.
- `public/` keeps the engine files of kits 93 to 103 (`--keep 11`), and the five fixed-name files from before
  `build-kit.mjs`, as 104 does.

## What a player sees (beta)

- **Multiplayer, Host Game:** a **Level Library...** button to the right of Choose Episode (Jedi Knight and Mysteries
  of the Sith). It is there only when the site answers `/levels/<game>.json`, so it shows on beta and not on the live
  site, which has no `/levels`.
- **The library:** every level the job has copied so far for that game (most downloaded multiplayer levels come in
  first; the first pass takes about two and a half days), with search, filters (Multiplayer, CTF or Kill the Fool,
  Co-op for single-player levels, off by default) and sorts (name, newest, oldest, downloads, rating, size). A ✓ marks
  a level already saved in this browser.
- **For a level:** Overview (screenshot, author, real release date and where that date came from, size, type, episode,
  rating, downloads, description, a link to its Massassi page), Readme and Files.
- **Use Level:** downloads the zip from the site (not from Massassi), checks its SHA-256 and each GOB's against the
  index, saves the GOB in the browser's map store (the one maps sent by hosts use: up to 2 GB, oldest out first) and
  selects it in Choose Episode. A saved level is used from the store with no download. Cancel or Escape stops a
  download. A level whose GOB has the name of a retail episode or of another saved level with different content is
  saved as `<name>_<id>`.
- **Episode limit:** the browser build now lists up to 512 episodes instead of 64 (`JKEPISODE_MAX`), so a browser with
  many saved levels still lists them all.

## Live site

A live deploy of this kit would show no button (no `/levels` there): the engines would be 103's plus the 512 limit and
the hidden button, and the Worker would be 104's (103's plus an unused Durable Object class, migration `v2`). Not
planned until the library has been tried on beta.

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 104's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 104 (`env.LEVELJOB`, `env.LEVELS (jkdf2mp-levels-beta)`, the `*/10` schedule).
  It should upload 9 asset files: the page and the four new engine files with their `.br`.
- **check-site:** each line `ok`, except the expected `zone` lines.

## Tested

- `packaging/wasm/test/library-test.mjs` (12 tests, in Chromium, against a stand-in for the site): the list and its
  counts, sorts, filters, search, keys typed in the library kept away from the game, Readme and Files, Use Level (download, checks, saved in the store, picked as the result), a saved level not downloaded again, a
  GOB in a zip inside the zip and in a folder, the renames, a zip with no GOB, a wrong hash refused, Escape and Cancel
  during a download, MotS, and the library saying it isn't there when the site has none (so the engine hides the
  button).
- The same script against kit 104's Worker under `wrangler dev --env beta --local`, serving 43 real levels fetched from
  Massassi on 13 Nov: 4 Jedi Knight and 2 MotS levels picked, downloaded, checked and saved, each GOB's SHA-256 the same
  as the index's.
- `maps-test.mjs` (42), `map-names-test.mjs` (7), `picker-test.mjs` (64), `mods-test.mjs` (29): all pass with the
  changed `maps.js`.
- Both engines build (Asyncify and JSPI) with the commit `e0bb19b` in them.

## Not tested

- The button and the hand-off back to Choose Episode in the real game: the cloud has no game files to run the engine
  with, so the first real run is on beta.
- Hosting a library level with a joiner: it is the same path as any custom level the host has, but not tried with one.

## Rollback

Deploy kit 104 to beta again: same Worker, so the job is untouched, and 103's page and engines (no button).
