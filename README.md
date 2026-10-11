# jkdf2mp-bb-server

Server-side pieces for playing **Jedi Knight: Dark Forces II** multiplayer in the browser, built on the
[OpenJKDF2](https://github.com/tristamus/OpenJKDF2) engine (branch `web-mp`):

- **Signaling / lobby server**: lists games and brokers WebRTC connections between players
- **WebSocket relay**: a fallback transport when a direct peer-to-peer connection isn't possible
- **TURN configuration**: NAT traversal settings for WebRTC

**What is this?** The overview of the whole project, with the link to play and what it adds to OpenJKDF2,
is at the top of the [OpenJKDF2 fork's README](https://github.com/tristamus/OpenJKDF2#jkdf2mp-jedi-knight-multiplayer-in-your-browser).
The lobby code is in this repository's open pull requests and isn't merged into `main` yet. The live
lobby is built from them, and each deployed build is kept on the
[`builds`](https://github.com/tristamus/jkdf2mp-bb-server/tree/builds) branch.

## No game assets, ever

This repository never stores, bundles, serves or proxies any original game assets (GOB/GOO archives,
videos, music, levels or anything else from the retail game). Each player supplies their own legally
owned copy of the game data locally in their browser. The server only handles lobby metadata and
relays network traffic between players.

## Status

- **`relay/relay.py`** (Phase 1): a local WebSocket relay and web server in plain Python 3, no installs
  needed. It serves the browser build and passes multiplayer traffic between the tabs or computers
  that load it.

  ```
  python3 relay/relay.py --dir path/to/web-build
  ```

  Then open http://127.0.0.1:8080/index.html in two tabs: host a game in one and join it from the
  other. Add `--host 0.0.0.0` to let other computers on your network join, and `--port` to change
  the port. The protocol is described at the top of the file.

The signaling/lobby server and TURN setup for WebRTC (Phase 2) are still to come.
