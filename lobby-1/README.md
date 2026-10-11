# lobby-1

- `index.html`, `openjkdf2.js`, `openjkdf2.wasm`: the browser build, from
  [tristamus/OpenJKDF2@72d2263](https://github.com/tristamus/OpenJKDF2/commit/72d2263)
  (branch `phase2/webrtc`).
- `relay.py`, `setup-server.sh`, `oci-create.sh`: from
  [tristamus/jkdf2mp-bb-server@b1a6ef6](https://github.com/tristamus/jkdf2mp-bb-server/commit/b1a6ef6)
  (branch `phase2/always-on`).
- `SHA256SUMS`: checksums of everything except `oci-create.sh`, whose checksum is in the command
  below.

To create the always-on server on Oracle Cloud's Always Free tier, open Cloud Shell (the `>_` button
in the Oracle Cloud console) and run:

```
curl -fsSLO https://raw.githubusercontent.com/tristamus/jkdf2mp-bb-server/builds/lobby-1/oci-create.sh && echo "ec21293b17bc18d79818d05352967114209cac5a0addbbfce7e39abb2c30531a  oci-create.sh" | sha256sum -c && bash oci-create.sh https://raw.githubusercontent.com/tristamus/jkdf2mp-bb-server/builds/lobby-1 375193724a8741284a78dc6314d73b9b61a62c8438e14d3101024fcc0375911a
```

On a server that's already set up, install this build with:

```
cd $(mktemp -d) && curl -fsSLO https://raw.githubusercontent.com/tristamus/jkdf2mp-bb-server/builds/lobby-1/SHA256SUMS -fsSLO https://raw.githubusercontent.com/tristamus/jkdf2mp-bb-server/builds/lobby-1/setup-server.sh && echo "375193724a8741284a78dc6314d73b9b61a62c8438e14d3101024fcc0375911a  SHA256SUMS" | sha256sum -c && grep '  setup-server.sh$' SHA256SUMS | sha256sum -c && sudo JK_SUMS_SHA256=375193724a8741284a78dc6314d73b9b61a62c8438e14d3101024fcc0375911a bash setup-server.sh <public-ip> https://raw.githubusercontent.com/tristamus/jkdf2mp-bb-server/builds/lobby-1
```
