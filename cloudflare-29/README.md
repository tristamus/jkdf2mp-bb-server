# cloudflare-29

`cloudflare-28` with the engine from OpenJKDF2 commit f8f39c3e (`web-mp` with
tristamus/OpenJKDF2#37 merged on top of 816916fb, the source of `cloudflare-28`).

- **Bind the mouse wheel to any action:** Setup, Controls, Mouse has two new rows, Mouse Wheel Up
  and Mouse Wheel Down, which bind like mouse buttons (Next Weapon, Next Force Power and so on) in
  Jedi Knight and Mysteries of the Sith. Each notch is one press, also when scrolling fast; wheel
  amounts below one notch (Firefox, some Windows settings) count as a notch; binding the wheel as
  buttons clears its Mouse Z axis bind so it doesn't also tilt the view. From upstream OpenJKDF2
  (440dbbb): the wheel moves the selection in menus, and the middle button picks the highlighted
  item.

Only `openjkdf2.js` and `openjkdf2.wasm` changed. `openjkdf2.js` differs from `cloudflare-28`'s only
in the addresses of its inline JavaScript blocks (`ASM_CONSTS`), which moved with the engine's new
strings. `index.html` is `cloudflare-28`'s, byte for byte (#37 doesn't touch the page). The lobby (`src/lobby.js`, `wrangler.toml` and the package files) is the same as
`cloudflare-28`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
