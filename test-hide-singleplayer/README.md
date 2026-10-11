# test-hide-singleplayer

A test build, not a deploy folder: `cloudflare-3`'s page and engine with Single Player hidden
from the main menu, in Jedi Knight and Mysteries of the Sith. Built from OpenJKDF2 branch
`claude/project-thread-wti5ke` (commit afd3dc7) with Emscripten 6.0.12.

Only `public/openjkdf2.wasm` differs from `cloudflare-3`. `index.html` and `openjkdf2.js` are the
same files. Rebuilt without the change, the same toolchain gives `cloudflare-3`'s wasm byte for
byte, and with it only the main menu code changes. `SHA256SUMS` lists every file.

To try it without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8091`, then open http://127.0.0.1:8091/index.html.

No game files are here.
