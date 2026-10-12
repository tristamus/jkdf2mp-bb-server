# Builds

Ready-to-install builds of the Jedi Knight browser multiplayer server, one folder each, for
`deploy/oci-create.sh` and `deploy/setup-server.sh` on the main branches to download. Folders never
change once they're here; a new build gets a new folder.

- `lobby-1/`: the lobby and browser build for a Linux server (Oracle Cloud).
- `cloudflare-1/`: the same browser build with the lobby for Cloudflare's free Workers plan.
- `cloudflare-2/`: `cloudflare-1` with a browser build that keeps characters and controls.
- `cloudflare-3/`: `cloudflare-2` with the redesigned landing page.
- `cloudflare-4/`: `cloudflare-3` with the MotS texture fix and Single Player hidden from the menu.
- `cloudflare-5/`: `cloudflare-4` with automatic map downloads for joiners.
- `cloudflare-6/`: `cloudflare-5` with the landing page saying that custom maps you host are shared.
- `cloudflare-7/`: `cloudflare-6` with View Cutscenes and Expansions & Mods hidden from the menu.
- `cloudflare-8/`: `cloudflare-7` with full mods, several at a time, shared with joiners.
- `cloudflare-9/`: `cloudflare-8` with each mod its own checkbox, including zipped mods.
- `cloudflare-10/`: `cloudflare-9` with display settings that stay between visits and MotS's Personalities option on the host screen.

**No game files are here.** Each player picks their own Jedi Knight install in the browser, and it
stays in that browser.
