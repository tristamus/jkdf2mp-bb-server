# Builds

Ready-to-install builds of the Jedi Knight browser multiplayer server, one folder each, for
`deploy/oci-create.sh` and `deploy/setup-server.sh` on the main branches to download. Folders never
change once they're here; a new build gets a new folder.

- `lobby-1/`: the lobby and browser build for a Linux server (Oracle Cloud).
- `cloudflare-1/`: the same browser build with the lobby for Cloudflare's free Workers plan.
- `cloudflare-2/`: `cloudflare-1` with a browser build that keeps characters and controls.
- `cloudflare-3/`: `cloudflare-2` with the redesigned landing page.

**No game files are here.** Each player picks their own Jedi Knight install in the browser, and it
stays in that browser.
