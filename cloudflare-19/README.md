# cloudflare-19

`cloudflare-18` with the engine from OpenJKDF2 commit af3bc32c (`web-mp` with
tristamus/OpenJKDF2#28 merged on top of 51b96827, which has the same source as `cloudflare-18`).

- **MotS characters saved by the original game (#28):** multiplayer characters (`.mpc`) that the
  original Mysteries of the Sith saved now load with the personality, rank, model, saber and force
  powers they were saved with, instead of `GUI_PERSONALITY0` and another character's leftovers. A
  character that still can't be read, such as one renamed after the original game saved it, is
  marked "Can't read this character" on Load Character, and Ok and Edit say to remove it and make
  it again with New.

`openjkdf2.wasm` changed. `openjkdf2.js` changed only in the numbers the engine uses to find its
inline JavaScript. `index.html` and the lobby (`src/lobby.js`, `wrangler.toml` and the package
files) are the same as `cloudflare-18`. `SHA256SUMS` lists every file.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
