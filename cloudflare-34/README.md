# cloudflare-34

`cloudflare-33` with the page and engine from OpenJKDF2 commit 481a7618 (`web-mp` with
tristamus/OpenJKDF2#44 merged on top of a7df0d38, the source of `cloudflare-33`). The lobby is
`cloudflare-33`'s, unchanged.

- **A second tab no longer puts old controls back:** each tab loads its own copy of the saves when
  its game starts, and storing writes back every changed file in the folder. So an older tab of the
  game overwrote binds saved in a newer one as soon as it saved anything or quit to the lobby. Now
  the tab whose game started last owns storing. Older tabs stop storing and show a strip at the top:
  "The game was started in another tab, so this one no longer saves controls or games. Close this
  tab, or reload it to play and save here." Their game keeps running.
- **Esc keeps new binds:** on the Keyboard, Mouse and Joystick screens, Esc used to act as Cancel
  and silently threw new binds away (the original game's behavior). Esc now leaves like Ok and
  saves. Only clicking Cancel throws changes away. Esc while the Keyboard screen waits for a key,
  or while a mouse or joystick control is being edited, still only stops that.

`index.html` and `openjkdf2.wasm` changed. `openjkdf2.js`, `src/lobby.js`, `wrangler.toml` and the
package files are the same as `cloudflare-33`'s. `SHA256SUMS` lists every file.

The lobby code doesn't change, but `wrangler deploy` still redeploys the Worker, so deploy when no
game is in progress. Pages loaded before the deploy keep running the old game until they reload.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
