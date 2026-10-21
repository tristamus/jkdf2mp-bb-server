# cloudflare-36

`cloudflare-35` with the engine from OpenJKDF2 commit 631157a8 (`web-mp` with
tristamus/OpenJKDF2#47 merged on top of 43ae388d, the source of `cloudflare-35`). The page and the
lobby are `cloudflare-35`'s, unchanged.

- **Hosts start at a 16 ms tick rate:** Host > Advanced now starts at 16 instead of 180, in Jedi
  Knight and MotS. Under 100, a match runs physics at 150 steps a second instead of 50, which is
  what makes play smooth in the browser. Joiners take the host's value, as before. A saved 180
  (the Host screen saves the value every time it closes) moves to 16 once. A value a player typed
  themselves, like 100, stays. The registry's `tickRateDefault` records which default a player was
  last given.
- **Less lobby traffic:** a host no longer sends its broadcasts to itself through the lobby. The
  lobby dropped these but counted each one against the free plan's daily Durable Objects requests.
  With a host alone in a match for 60 s, `cloudflare-35` sent 400 of them at 180 and 3,148 at 16.
  This build sends 0. A player's position now goes through the lobby to each player at most every
  200 ms, the rate at 180. Direct WebRTC links still carry every one. The network log's link check
  line says how many positions were skipped.

`openjkdf2.js` and `openjkdf2.wasm` changed. `index.html`, `src/lobby.js`, `wrangler.toml` and the
package files are the same as `cloudflare-35`'s: between 43ae388d and 631157a8 only four engine
files changed (`src/engine_config.h`, `src/Main/Main.c`, `src/Gui/jkGUINetHost.c`,
`src/Platform/Networking/WSRelay/stdComm_WSRelay.c`). The engine was built with Emscripten 6.0.12
and SDL3 3.4.2, and its main menu shows 631157a8. `SHA256SUMS` lists every file.

The lobby code doesn't change, but `wrangler deploy` still redeploys the Worker, so deploy when no
game is in progress. Pages loaded before the deploy keep running the old engine until they reload.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
