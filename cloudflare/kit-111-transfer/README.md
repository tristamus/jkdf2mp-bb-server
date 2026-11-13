# cloudflare-111

Kit 110 for the live site: the same page, engines and Worker code, byte for byte. Only `wrangler.toml` differs, and
only in the site's own section: the site now binds the Level Library.

- **The site (`jkdf2mp`, jediknight.zone):** binds the `LevelJob` Durable Object (its class has been there since the
  `v2` migration) and the R2 bucket `jkdf2mp-levels-beta` as `LEVELS`, with `LEVELS_FETCH = "0"` and no cron. It serves
  `/levels/*` from the levels, pictures and 3D data beta's job copies from Massassi, and runs no job of its own, so it
  writes nothing to that bucket and asks Massassi for nothing. Its `/levels/status` is its own job's: off, empty.
- **Beta:** its section of `wrangler.toml` is kit 110's, byte for byte, so on beta kit 111 is kit 110.
- **Page and engines:** kit 110's (`public/` identical, its `kit-files.json` still says cloudflare-110). OpenJKDF2
  `de3e52e`; Worker code bb-server `85a8203`, config `8a6b1db`.
- Live was kit 103. Everything from kits 104 to 110 comes with it: the Level Library (the Host Game button, the menu,
  Use Level, Readme/Files, screenshots, the 3D view, My levels).

## Deploy (live)

Check first that the live lobby has no rooms open. In this folder:

```
npx wrangler deploy --env=""
node tools/check-site.mjs https://jediknight.zone
```

- **The deploy:** the bindings list should show `env.LEVELJOB (LevelJob)` and `env.LEVELS (jkdf2mp-levels-beta)` beside
  the site's usual ones, and `env.LEVELS_FETCH ("0")`.
- **check-site:** each line `ok`, except the expected `zone` line.
- **Then:** `https://jediknight.zone/levels/jk1.json` answers 200 with the same levels as beta's, and Host Game shows
  "Level Library...".

## Tested

- As kit 110 (its README), which passed on beta: the 3D view, its textures, My levels, the button, the list wheel.
- `wrangler deploy --dry-run` of this folder: the site's bindings as above; beta's as kit 110's.
- The Worker's tests pass with this `wrangler.toml` (build-kit, engine, moved, levels, summary).

## Rollback

Deploy kit 103 to the live site again (no `/levels`, no button; the bucket is beta's and stays as it is).
