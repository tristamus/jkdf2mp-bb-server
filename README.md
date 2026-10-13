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
- `cloudflare-11/`: `cloudflare-10` with the MotS Remastered fan pack loaded like the game's own files instead of listed as mods.
- `cloudflare-12/`: `cloudflare-11` with characters whose `.plr` can't be read starting over instead of giving "Cannot set player".
- `cloudflare-13/`: `cloudflare-12` with screenshots saved in the browser and listed on the landing page.
- `cloudflare-14/`: `cloudflare-13` with each lit saber lighting the area around it in its blade's color.
- `cloudflare-15/`: `cloudflare-14` with a Features section on the landing page.
- `cloudflare-16/`: `cloudflare-15` with the MotS multiplayer fixes (personalities, Carbonite, saber training) and a colored saber glow that no longer dims the area.
- `cloudflare-17/`: `cloudflare-16` with Select all for mods and a mod list that remembers each browser's picks.
- `cloudflare-18/`: `cloudflare-17` with every MotS player running the Remastered pack the way the host does.

**No game files are here.** Each player picks their own Jedi Knight install in the browser, and it
stays in that browser.
