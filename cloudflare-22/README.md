# cloudflare-22

`cloudflare-21` with the landing page's rooms split by game: the engine and page from OpenJKDF2
commit cfe985df (`web-mp` with tristamus/OpenJKDF2#30 merged on top of 5c31bed7, the source of
`cloudflare-21`) and the lobby from this repository's commit 68bcb8d2 (`main` with #26 merged).

- **Nar Shaddaa is Jedi Knight's, Sith: Asteroid is MotS's:** each shows its own game's player
  and game counts, and clicking it opens its own room window with that game's games and players.
  Total Players still counts both. `/#nar-shaddaa` and `/#sith-asteroid` open them directly.
- **Rooms ask for their own game's folder:** Nar Shaddaa and the other Standard and CTF rooms take
  Jedi Knight, and Sith: Asteroid and Sith: Altyr 5 take MotS. The other game's folder gets
  a message saying which room to use instead. The Play JKDF2 buttons still take either game.
- **The Join screen lists only games you can join:** the game asks the lobby for its own game's
  list (`list jk1` or `list mots`), so a Jedi Knight player no longer sees MotS games there, and
  the other way round. A host that hasn't said which game it runs shows in both.

All three files in `public/` changed, and so did `src/lobby.js`. `wrangler.toml` and the package
files are the same as `cloudflare-21`. `SHA256SUMS` lists every file.

Deploying a new lobby restarts it, which drops every connection to it once, so deploy while
nobody is in a match: their games would lose the lobby. Players sitting in the menus reconnect
by themselves.

Needs Node.js 22 or newer. In this folder:

```
npm ci
npx wrangler login
npx wrangler deploy
```

For a local test without deploying, serve `public/` with `relay/relay.py` from jkdf2mp-bb-server:
`python relay.py --dir public --port 8090`, then open http://127.0.0.1:8090/index.html.

No game files are here.
