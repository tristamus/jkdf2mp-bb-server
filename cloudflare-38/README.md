# cloudflare-38

`cloudflare-37` with the page and engine from OpenJKDF2 commit a7c0211 (`web-mp` with
tristamus/OpenJKDF2#50 merged on top of f32a316, the source of `cloudflare-37`). The lobby is `cloudflare-37`'s, unchanged.

- **Saved mod sets are a pick of one:** in "Choose your mods", the folder's mods keep their
  checkboxes and Select all. Mods saved from online games move to their own group, "Saved from
  online games", as round buttons under None. Picking one greys out the folder's mods and keeps
  their ticks; None brings them back. Before, saved sets were checkboxes that silently unticked
  everything else, and Select all skipped them, so the list looked broken.
- **Rows stay put:** while the chooser is up, the prompt keeps the height it opened at and its
  scrollbar's room, so the clash note coming and going no longer moves rows under the pointer.
- **Mods up to 250 MB go to joiners,** up from 100 MB. JK HD Models, SBX Dual Sabers and SBX-JK v31
  together are about 109 MB, which `cloudflare-37` refused to send. A joiner still on an older page
  refuses over 100 MB, so players need to reload.

`index.html`, `openjkdf2.js` and `openjkdf2.wasm` changed. `openjkdf2.js` carries the new `mods.js`
(the limit). The engine was rebuilt with Emscripten 6.0.12 and SDL 3.4.2 (from libsdl.org, signature
checked, the release Emscripten pins); no engine C sources changed since `cloudflare-37`. The main
menu shows 97f905da, the last commit touching what the build compiles in. `src/lobby.js`,
`wrangler.toml` and the package files are the same as `cloudflare-37`'s. `SHA256SUMS` lists every
file.

Tested before deploying: the web test suites; two browsers with a real Jedi Knight install and the
three mods above, one hosting and one joining with none ticked (the joiner got the 109 MB set,
restarted into it and joined, then saw it under "Saved from online games" after a reload and
started with it); and these exact files serving the chooser and starting the game with all three
mods.

The lobby code doesn't change, but `wrangler deploy` still redeploys the Worker, so deploy when no
game is in progress. Pages loaded before the deploy keep the old page until they reload.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
