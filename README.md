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

- **`relay/relay.py`**: the lobby, WebRTC signaling server and fallback relay in one plain Python 3
  script, no installs needed. It serves the browser build, lists the games hosted on it, sets up
  WebRTC data channels between each host and its players, and relays game packets for anyone whose
  direct link doesn't come up.

  ```
  python3 relay/relay.py --dir path/to/web-build
  ```

  Then open http://127.0.0.1:8080/index.html in two windows: host a game in one and join it from
  the other. Add `--host 0.0.0.0` to let other computers on your network join, and `--port` to
  change the port. The protocol is described at the top of the file.

  Players on different networks need a STUN server, and the ones behind strict NATs a TURN server
  (such as [coturn](https://github.com/coturn/coturn)). The relay hands their addresses to every
  page:

  ```
  JK_TURN_SECRET=<coturn static-auth-secret> python3 relay/relay.py --dir path/to/web-build \
      --host 0.0.0.0 --stun stun:turn.example.org:3478 --turn turn:turn.example.org:3478
  ```

  With a secret, each page gets its own TURN login that expires after 12 hours (`--turn-ttl`), the
  scheme coturn checks with `use-auth-secret`. `--turn-user` and `--turn-pass` send one fixed login
  instead.

- **`deploy/`**: puts the lobby, HTTPS and a TURN server on one always-on Linux server.
  - `oci-create.sh` creates an Ubuntu server on Oracle Cloud's Always Free tier and sets it up.
    Run it in OCI Cloud Shell (the `>_` button in the Oracle Cloud console), where `oci` is already
    signed in. It opens SSH, HTTP/HTTPS, STUN/TURN (3478) and the TURN relay ports (UDP
    49160-49200) in the network and on the server, then runs `setup-server.sh` over SSH.
    Published builds live on the `builds` branch, one folder each, with the exact command to run.
  - `setup-server.sh` works on any fresh Ubuntu 22.04/24.04 server:

    ```
    sudo bash deploy/setup-server.sh <public-ip> <build-folder-or-release-url>
    ```

    It installs the build (checked against `SHA256SUMS`, and that against `JK_SUMS_SHA256` if set), runs the relay as a systemd service behind
    Caddy, and sets up coturn with a TURN secret it generates and shares with the relay. The page
    ends up at `https://<public-ip-with-dashes>.sslip.io/index.html`; set `JK_HOSTNAME` to use
    your own domain. Run it again with a newer build to update.

  Oracle may stop an Always Free server that stays idle for a week (low CPU and network); restart it
  from the console, or convert the account to Pay As You Go to avoid that.
