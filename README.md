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
- `cloudflare-19/`: `cloudflare-18` reading MotS characters saved by the original game, with their own personality and force powers.
- `cloudflare-20/`: `cloudflare-19` with no screen flicker when Bloom and SSAO are on.
- `cloudflare-21/`: `cloudflare-20` with live player and game counts on Nar Shaddaa, and a room window listing the games and who's in them.
- `cloudflare-22/`: `cloudflare-21` with Nar Shaddaa for Jedi Knight and Sith: Asteroid for MotS, each with its own live counts and room window, and a Join screen that lists only games you can join.
- `cloudflare-23/`: `cloudflare-22` with a lobby that ends a game whose host vanished without closing, after 2 minutes without its keepalive.
- `cloudflare-24/`: `cloudflare-23` with no more spawning in a death pose after joining a dead player's slot, and a quick rejoin that gets in.
- `cloudflare-25/`: `cloudflare-24` with the game going fullscreen instead of the browser's pointer notice, and Esc reaching the game's menu.
- `cloudflare-26/`: `cloudflare-25` with notices when graphics acceleration is off or Edge's enhanced security slows the game, F8 for screenshots, and a prompt before the tab closes mid-game.
- `cloudflare-27/`: `cloudflare-26` with the game's Quit going back to the lobby, and a Quit button on the Players screens shown at startup.
- `cloudflare-28/`: `cloudflare-27` with a faster start after picking the game folder, reading only the files the game opens.
- `cloudflare-29/`: `cloudflare-28` with the mouse wheel bindable to any action, like a mouse button.
- `cloudflare-30/`: `cloudflare-29` with the game files saved in the browser after the first pick, so later visits start without picking the folder.
- `cloudflare-31/`: `cloudflare-30` with Insert, Num Lock and the Menu key bindable, a held Page Up or \ that stays held, browser shortcuts kept out of game keys, the console only on Ctrl+Shift+`, MotS sabers showing their blade to other players, and Force Pulled weapons flying to the puller again.
- `cloudflare-32/`: `cloudflare-31` with Play in fullscreen asked in the window shown before every start, mods or not, so it can be changed after the first upload.
- `cloudflare-33/`: `cloudflare-32` with joiners staying in the match when their lobby connection drops or the lobby restarts, seats held for a minute, and a network log to save when the network ends a match.

**No game files are here.** Each player picks their own Jedi Knight install in the browser, and it
stays in that browser.
