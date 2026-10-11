# test-hide-singleplayer

A test build, not a deploy folder: the live site's page and engine with Single Player hidden from
the main menu, in Jedi Knight and Mysteries of the Sith. Built from OpenJKDF2 branch
`claude/project-thread-wti5ke` (commit f217106), which merges the hidden Single Player change
(afd3dc7) with the MotS 16-bit texture fix (2e84e91, already live as Cloudflare version 3d89b4db),
using Emscripten 6.0.12.

Only `public/openjkdf2.wasm` differs from what's live: `index.html` and `openjkdf2.js` are the same
files. Stamped with the live build's commit instead, the wasm differs from the live one only in the
main menu code. `SHA256SUMS` lists every file.

To try it without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8092`, then open http://127.0.0.1:8092/index.html.

No game files are here.
