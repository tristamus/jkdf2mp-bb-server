# cloudflare-16

`cloudflare-15` with the engine from OpenJKDF2 commit 80cc2eb2 (`web-mp` with PRs
tristamus/OpenJKDF2#24 and tristamus/OpenJKDF2#23 merged on top of 4c68c71, which has the same
source as `cloudflare-15`).

- **MotS multiplayer (#24):** joiners get their personality's loadout, and a Carbonite hit or a
  force power affects only the player it hits, not the host. With 3 or more players, a hit between
  two joiners no longer reaches the host too. Sith Lightsaber Training shows up in the host's
  episode list. Other players' light values arrive as sent instead of as zero.
- **Colored saber glow (#23):** a lit saber's light keeps the brightness of the white light it
  replaces and is only tinted toward the blade's color, so the area around it no longer dims.

Only `openjkdf2.wasm` changed. `index.html`, `openjkdf2.js` and the lobby (`src/lobby.js`,
`wrangler.toml` and the package files) are the same as `cloudflare-15`. `SHA256SUMS` lists every
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
