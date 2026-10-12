# cloudflare-10

`cloudflare-9` with a new engine from OpenJKDF2 commit 1b727d10 (PR tristamus/OpenJKDF2#16, merged
into `web-mp`). Hosting a Mysteries of the Sith game shows MotS's own host screen again, with the
"Mysteries of the Sith (personalities)" and "Jedi Knight (ranked Jedi only)" checkboxes, so players
can pick personality characters like the Bounty Hunter. Before, every MotS game was a ranked Jedi
game and personality characters got "No Valid Characters".

It also has the display settings fix (PR tristamus/OpenJKDF2#15), which went live on 2026-10-12 as
an engine-only update of `cloudflare-9` (`openjkdf2.wasm` f84f9774…) and has no folder of its own.

`public/openjkdf2.js` and `public/openjkdf2.wasm` changed and go together. `public/index.html` and
the lobby (`src/lobby.js`, `wrangler.toml` and the package files) are the same as `cloudflare-9`.
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
