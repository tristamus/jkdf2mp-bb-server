# cloudflare-30

`cloudflare-29` with the page from OpenJKDF2 commit 24a9ea5b (`web-mp` with
tristamus/OpenJKDF2#38 merged on top of f8f39c3e, the source of `cloudflare-29`).

- **Pick the game folder once:** after a game starts from a picked folder, the files it read are
  saved in the browser (IndexedDB), one copy for Jedi Knight and one for Mysteries of the Sith,
  about 250 MB and 500 MB plus mods. On later visits Host and Join start from that copy with no
  folder prompt, and the mod list shows as before, with a "Choose a different folder" link.
  Play JKDF2 offers "Play with saved files", "Choose game folder" or "Remove them".
- If the saved copy can't be read any more (site data cleared, storage evicted), the page forgets
  it and asks for the folder again with a note saying why. Mods or maps added to the folder later
  need the folder chosen again. A checkbox on the folder prompt turns saving off.

Only `index.html` changed. `openjkdf2.js` and `openjkdf2.wasm` are `cloudflare-29`'s, byte for
byte (#38 doesn't touch the engine), so the mouse wheel binds stay. The lobby (`src/lobby.js`,
`wrangler.toml` and the package files) is the same as `cloudflare-29`. `SHA256SUMS` lists every
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
