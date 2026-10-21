# cloudflare-35

`cloudflare-34` with the page from OpenJKDF2 commit 43ae388d (`web-mp` with
tristamus/OpenJKDF2#45 and #46 merged on top of 481a7618, the source of `cloudflare-34`). The engine
and the lobby are `cloudflare-34`'s, unchanged.

- **Check my folder for new mods and maps:** started from the files saved in the browser, the mod
  window says when they were saved ("Using your Jedi Knight files saved Oct 21.") and offers "Check
  my folder for new mods and maps". Choosing the folder again names what's new or updated since
  ("New since Oct 21: map AODpc and mod Saber Battle X.", or "Nothing new since"), tags new and
  updated mods, and saves only the files that changed instead of the whole 250 to 500 MB copy.
  Files saved by the earlier page still work and move to the new layout on the next save. The
  game's own GOBs never count as new maps.
- **Keep my mods and maps up to date:** in Chrome, Edge and Opera, once the game files are saved,
  the mod window offers to keep a folder. The browser keeps it and the page reads it again at every
  Join, Host or Play with saved files. A folder with the whole game is read instead of the saved
  files. Any other folder is a folder of mods and maps (Chrome won't keep one in Program Files,
  where Steam installs the games): its Episode folder holds maps, everything else is a mod, and it's
  laid over the saved files. The window says 'Checked your folder "JK mods". New since Oct 21: map
  DralSrhc.' After a browser restart the browser asks once, offering "Allow on every visit". When
  the folder can't be read, the saved files start the game and the window says so. "Stop checking"
  forgets the folder. Firefox and Safari don't show the offer.

`index.html` changed. `openjkdf2.js`, `openjkdf2.wasm`, `src/lobby.js`, `wrangler.toml` and the
package files are the same as `cloudflare-34`'s: between 481a7618 and 43ae388d only
`packaging/wasm/index.html` and its tests changed. `SHA256SUMS` lists every file.

The lobby code doesn't change, but `wrangler deploy` still redeploys the Worker, so deploy when no
game is in progress. Pages loaded before the deploy keep running the old page until they reload.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
