# cloudflare-25

`cloudflare-24` with the page and engine from OpenJKDF2 commit ad43ce01 (`web-mp` with
tristamus/OpenJKDF2#32 merged on top of 0a6519a5, the source of `cloudflare-24`).

- **The game goes fullscreen instead of showing the pointer notice (#32):** every time the game
  locked the mouse, the browser showed its own "has control of your pointer" notice, and Esc never
  reached the game: the browser kept it and freed the mouse, the view kept turning with the
  cursor, and the next click fired a shot as it grabbed the mouse again. Now the first click or
  key in the game goes fullscreen. Firefox shows no pointer notice in fullscreen; Chrome and Edge
  show their "press and hold Esc to exit full screen" notice instead, and again for a few seconds
  when the mouse is locked or freed. Esc opens the game's menu, and holding Esc leaves fullscreen.
  If the browser frees the mouse anyway (fullscreen off, or switching windows), the game opens its
  menu instead of turning the view. In fullscreen, Ctrl+W and Ctrl+T reach the game instead of
  closing or opening a tab. A "Play in fullscreen" option in the Pick your game folder window, on
  by default and remembered, turns it off.

`index.html`, `openjkdf2.js` and `openjkdf2.wasm` changed. The lobby (`src/lobby.js`,
`wrangler.toml` and the package files) is the same as `cloudflare-24`. `SHA256SUMS` lists every
file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
