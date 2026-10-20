# cloudflare-31

`cloudflare-30` with the page and engine from OpenJKDF2 commit 6a6b73d1 (`web-mp` with
tristamus/OpenJKDF2#40, #41 and #39 merged on top of 24a9ea5b, the source of `cloudflare-30`).
Before its first deploy, the engine was rebuilt to carry #41 and #39 too.

- **Every key binds and works:** Insert, Num Lock and the Menu key reach the game and can be
  bound. Insert, the Controls screen's Add shortcut, no longer binds itself. A held Page Up or \
  stays held (each read as tapped every frame before).
- **The browser stays out of game keys:** its typing mode is on only while chat, the console or a
  menu text box is open, so Firefox's Quick Find on / and ', and other browser shortcuts, no
  longer take keys during play. In fullscreen, Chrome and Edge also give Ctrl+W, Ctrl+T and Ctrl+N
  to the game.
- **Console:** opens with Ctrl+Shift+` only; Shift+` and Shift+Esc no longer open it mid-match.
  ` or Esc closes it.
- **Turn keys:** new characters get Numpad 4 on Turn Left and Numpad 6 on Turn Right (Numpad 4 was
  on Turn Right and Numpad 6 on nothing), and characters saved that way are repaired when they
  load.
- **Key check:** `index.html?keycheck` lists each key pressed with the game's name for it, what it's
  bound to, what it did in a level, and whether the browser acted on it too.
- **MotS saber blades (#41):** other players' lit sabers show their blade, not just the glow at
  the hilt.
- **Force Pull (#39):** a weapon pulled from another player's hands flies to the puller again, in
  JK and MotS, and everyone sees it. In MotS, an item the host picks up also disappears for the
  other players.

`index.html`, `openjkdf2.js` and `openjkdf2.wasm` changed; the engine keeps the mouse wheel binds of
`cloudflare-29` and the page keeps the saved game files of `cloudflare-30`. The lobby
(`src/lobby.js`, `wrangler.toml` and the package files) is the same as `cloudflare-30`.
`SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
