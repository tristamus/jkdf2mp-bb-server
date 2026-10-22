# cloudflare-37

`cloudflare-36` with the page from OpenJKDF2 commit f32a316 (`web-mp` with tristamus/OpenJKDF2#49
merged on top of 631157a8, the source of `cloudflare-36`). The engine and the lobby are
`cloudflare-36`'s, unchanged.

- **JK_.CD can be anywhere in the game folder:** the page used to require `Resource/JK_.CD` and
  refused a folder that kept it somewhere else, such as next to `JK.EXE`, with a message that the
  folder lacked `resource/jk_.cd`. It now looks through the whole folder, in any letter case, for
  a `jk_.cd` holding a key the game accepts (one of Jedi Knight's three, or MotS's), trying
  `Resource/` first, then the top of the folder, then the rest, nearest the top first. The one it
  finds goes to `resource/jk_.cd` for the engine, and the browser console names it.
- **No usable JK_.CD:** the page makes `resource/jk_.cd` with the game's standard key (Jedi
  Knight's is the one Steam's copy holds and the desktop installer writes), so the game starts
  instead of asking for the CD. The browser console says the standard key was used.
- Telling the two games apart, the "missing files" message, kept folders and "Play with saved
  files" now look only at the game's own files, not `jk_.cd`.

`index.html` changed. `openjkdf2.js`, `openjkdf2.wasm`, `src/lobby.js`, `wrangler.toml` and the
package files are the same as `cloudflare-36`'s: between 631157a8 and f32a316 only
`packaging/wasm/index.html` and its test changed. The main menu still shows 631157a8, the engine's
commit. `SHA256SUMS` lists every file.

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
