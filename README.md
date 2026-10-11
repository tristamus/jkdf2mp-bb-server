# jkdf2mp-bb-server

Server-side pieces for playing **Jedi Knight: Dark Forces II** multiplayer in the browser, built on the
[OpenJKDF2](https://github.com/tristamus/OpenJKDF2) engine (branch `web-mp`):

- **Signaling / lobby server**: lists games and brokers WebRTC connections between players
- **WebSocket relay**: a fallback transport when a direct peer-to-peer connection isn't possible
- **TURN configuration**: NAT traversal settings for WebRTC

## No game assets, ever

This repository never stores, bundles, serves or proxies any original game assets (GOB/GOO archives,
videos, music, levels or anything else from the retail game). Each player supplies their own legally
owned copy of the game data locally in their browser. The server only handles lobby metadata and
relays network traffic between players.

## Status

Nothing has been implemented yet; server code is still to come.
