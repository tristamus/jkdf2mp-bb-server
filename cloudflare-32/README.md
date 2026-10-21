# cloudflare-32

`cloudflare-31` with the page from OpenJKDF2 commit a3146aae (`web-mp` with
tristamus/OpenJKDF2#42 merged on top of 6a6b73d1, the source of `cloudflare-31`).

- **Fullscreen before every start:** "Play in fullscreen" is in the window shown just before the
  game starts, below the mods, instead of on the first folder prompt. That window now shows on
  every start, including Play with saved files and Join or Host from a room, so players can turn
  fullscreen on or off after their first upload. Without mods it's titled "Ready to play Jedi
  Knight" (or Mysteries of the Sith) and has just the box and Start. Each browser remembers the
  choice.
- **Closing that window cancels it:** closing it with its X or Esc used to leave Choose game folder
  and Play with saved files greyed out until the page was reloaded.
- **Remembered mods kept:** a start without mods in the folder no longer forgets which mods were
  left unticked.

Only `index.html` changed. `openjkdf2.js` and `openjkdf2.wasm` are `cloudflare-31`'s, byte for
byte: #42 changes no engine code, so the engine source is the same as `cloudflare-31`'s. The lobby
(`src/lobby.js`, `wrangler.toml` and the package files) is the same as `cloudflare-31`.
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
