# cloudflare-109

Kit 108 with the Readme's mouse wheel, the Host Game button moved, and the job that starts copying each level's 3D
data for the library's 3D preview.

- **Worker:** kit 108's, except `src/levels.js` and `src/levels-read.js` (the 3D data). `wrangler.toml` and the
  package files are 108's, byte for byte: no new bindings, the same bucket.
- **Page:** live kit 103's `index.html`, byte for byte, except its table of engine files.
- **Engines:** OpenJKDF2 branch `claude/project-thread-2z6v32` at `4366c19`.
- `public/` keeps the engine files of kits 93 to 108 (`--keep 15`), and the five fixed-name files from before
  `build-kit.mjs`, as 108 does.

## What's changed

- **The wheel:** over the Readme, the Files text or the Overview's details, it scrolls that text 3 lines a notch,
  from the first notch, whichever box has the focus. In 108 it acted like the arrow keys on the focused box, so an
  unseen cursor walked through the lines on screen first. Over the list of levels it still goes level by level.
- **The list:** CTF, KFY and SP have a column of their own, ending where the year starts, so they line up row to row.
- **Host Game:** the text of "Level Library..." ends at x 630, the right edge of the Episode list and the Server Port
  box (it ended at about 599), and it's 2 px higher, on the line of "Choose Episode:".
- **The job:** after a level's zip and pictures, it takes the level's 3D data from Massassi's 3D preview
  (3dpreview.massassi.net, which Brian said is fine to fetch, spread over time): `map.json` (surfaces, texture
  coordinates, light, start points) and `mat.json` (textures, with their names), for each map (GOB) in the zip, one
  request a step at the job's 30 s pace. Without `ownsgame=1`, so it holds none of the game's own art. Kept gzip in
  the bucket (`pv/<id>-<m>.map.json`, `.mat.json`), served at `/levels/p/<id>-<m>.map.json` and `.mat.json`. The
  levels it already has come first (most downloaded first), so the about 100 of them get their 3D data in about two
  hours; then it goes on with new levels as before, a few requests more each.
- **`/levels/status`:** each list now says `previews` (levels with their 3D data), `previews_left`, `previews_none`
  (none to be had, or it failed twice) and `preview_bytes`.
- **`LEVELS_PREVIEW = "0"`** in `wrangler.toml` stops the 3D part alone (not set: on).

## Deploy (beta)

Needs Node.js 22 or newer. The package files are 108's, so a copy of its `node_modules` works. In this folder:

```
npx wrangler deploy --env beta
node tools/check-site.mjs https://beta.jediknight.zone
```

- **The deploy:** the same bindings as 108. It should upload 5 asset files: the page and the two new engine `.wasm`
  files with their `.br` (the engines' `.js` files are 108's).
- **check-site:** each line `ok`, except the expected `zone` line.
- **The job:** `https://beta.jediknight.zone/levels/status` within a few minutes shows `previews` counting up, and
  `last_error` with nothing new about `3dpreview`.

## Tested

- `test/levels.mjs` (all pass): the job against stand-ins for Massassi and its 3D preview: one GOB straight to its map
  and textures, a zip of two maps through the preview's own page, the files kept gzip and served with
  `Content-Encoding: gzip`, the index's `pv`, 404 (none), a 500 (that level's, no backoff, two tries), an answer that
  isn't the preview's, too big (by `Content-Length` and while reading), `LEVELS_PREVIEW = "0"`, and the new columns
  added to the job's existing table. The Worker's other tests pass as before (`imperial-route`, `protocol` and `turn`
  need a network this cloud doesn't have, as before).
- `packaging/wasm/test/library-menu-test.sh` (680 checks): with the wheel over the Readme, the Files text, the
  details and the list.
- Both engines build (Asyncify and JSPI); the JSPI check and the lost-graphics check pass.

## Not tested

- The wheel with a real mouse, the CTF column and the button's place in the real game: checked on beta.
- Massassi's real 3D preview from the Worker: the job's first requests on beta.

## Rollback

Deploy kit 108 to beta again (its Worker has no 3D step; what 109 copied stays in the bucket, unused).
