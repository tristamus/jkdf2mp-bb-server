#!/usr/bin/env python3
"""Lobby, WebRTC signaling and fallback relay for OpenJKDF2's browser build.

Serves the web build (index.html, openjkdf2.js, openjkdf2.wasm) from --dir,
lists the games hosted on it, passes WebRTC signaling between a host and its
clients, and relays game packets for players whose direct WebRTC link isn't up.
Python 3 standard library only.

The page's network backend (src/Platform/Networking/WSRelay in the OpenJKDF2
fork) connects to ws://<this server>/relay. Text frames are control lines,
binary frames are game packets:

  client -> relay   list [<game>] | host <entry> | update <entry> | join <room>
                    welcome <id> <entry> | leave | signal <id> <data> | ping
                    hello <game> <name> | watch | rejoin <room> <id> <key>
                    rehost <room> <key> [<entry>]
  relay -> client   list (<room> <players> <entry>)* | hosted <room>
                    peer-joined <id> | peer-left <id> | welcome <id> <entry>
                    host-left | error <code> | signal <id> <data> | ice <data>
                    status <data> | seat <room> <id> <key> | rejoined <room> <id>
                    rehosted <room> | peer-lost <id> | peer-back <id>
                    host-lost | host-back

list jk1 or list mots lists only the games that game can join: it leaves out
those whose host said hello as the other one. <entry> is the host's
hex-encoded session description, passed through as is.
signal carries base64 SDP or ICE candidates between a host and one of its
clients; the relay only checks the sender is in that room and swaps the target
id for the sender's. ice is sent once on connect when --stun or --turn is set:
base64 JSON for RTCPeerConnection's iceServers.

The landing page's live counts: each running game sends hello with its game
(jk1 or mots) and its player's name in base64 UTF-8, again when it changes. A
page that sends watch gets status, base64 UTF-8 JSON, then again whenever it
changes: {"online": n, "lobby": [names], "byGame": {"jk1": {"online": n,
"lobby": [names]}, "mots": {...}}, "games": [{"id", "name", "game", "map",
"episode", "mod", "locked", "players", "max", "names"}]}, the host's name
first and "" for a player whose game didn't say hello. byGame splits the
counts and the lobby by the game players run, for the page's rooms. The relay reads a
game's details from its entry (a jkMultiEntry, then the mod tail from mods.js),
and never sends its password, only whether it has one. A player is a
connection that said hello or is in a room; watching pages don't count.

Game packets go over WebRTC once a player's link is up, so a socket that
drops mid-game (a network blip, or the lobby restarting) needn't end the
match. Each seat in a room has a key, 32 hex digits sent to its player with
seat after hosted or joining. A seat whose socket closes without leave, or
goes quiet, is held for --hold seconds: the host hears peer-lost <id>, or the
clients host-lost, and peer-back or host-back once the player takes the seat
back on a new socket with rejoin <room> <id> <key> (answered rejoined) or, the
host, rehost <room> <key> [<entry>] (answered rehosted). A rejoin replaces the
seat's old socket if that hasn't closed yet. A wrong key or a seat that's gone
gets error no-seat. A seat nobody takes back ends as before: peer-left for a
client, host-left to every client for the host. While its host is away a room
is left out of list and can't be joined. leave still ends a seat at once.
This relay keeps its rooms in memory, so they end when it restarts;
cloudflare/src/lobby.js keeps them in storage.

Game packets start with a little-endian u32 idFrom and u32 idTo. The host is
id 1 and clients get 2..64, as with OpenJKDF2's GNS backend. A packet goes to
the player named in idTo (to the host when idTo is 0 or 1) and is dropped if
that player isn't in the room, which is what the GNS host does when it
forwards. The relay stamps idFrom with a client's real id. The host's idFrom is
kept, because a host forwards packets for clients it reaches over WebRTC.

This server never serves or stores game files: players pick their own install
in the page, and it stays in their browser.
"""

import argparse
import base64
import functools
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import socket
import struct
import threading
import time
import unicodedata

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 64 * 1024
MAX_ENTRY_HEX = 2048
MAX_SIGNAL_B64 = 16384
FIRST_PEER_ID = 2
LAST_PEER_ID = 64
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
ENTRY_HEX = 240 * 2
GAMES = ("jk1", "mots")
MAX_NAME_B64 = 128
MAX_NAME = 15  # the game sends 15 characters of a player's name to the others
MAX_STATUS_GAMES = 64
MAX_STATUS_NAMES = 64
# The game and the page send "ping" every 25 s. A connection that has sent
# nothing for this long is gone without having closed (a tab or browser that
# was killed, a computer that went to sleep, a network that dropped), and its
# player and game come off the lists. Background tabs may only ping once a
# minute. Same as QUIET_MS in cloudflare/src/lobby.js.
QUIET_S = 120
# How long a dropped player's seat waits for them to take it back (--hold).
# The game reconnects after 1 s, then 2, 4 and every 5 s. Same as HOLD_MS in
# cloudflare/src/lobby.js.
HOLD_S = 60
KEY_RE = re.compile(r"^[0-9a-f]{32}$")
# Control and invisible characters (bidi overrides among them) never reach a page.
HIDDEN_RE = re.compile("[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]")

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class Conn:
    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.send_lock = threading.Lock()
        self.room = None
        self.id = 0
        self.name = None  # from hello
        self.game = ""
        self.watch = False
        self.closed = False

    def send_frame(self, opcode, payload):
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        with self.send_lock:
            if self.closed:
                return
            try:
                self.sock.sendall(header + payload)
            except OSError:
                self.closed = True

    def send_text(self, text):
        self.send_frame(OP_TEXT, text.encode("utf-8"))

    def addr_name(self):
        return "%s:%d" % (self.addr[0], self.addr[1])


class Seat:
    """A player's place in a room, which its key takes back. until, name and
    game are only set while it's held."""

    def __init__(self):
        self.key = secrets.token_hex(16)
        self.until = None
        self.name = None
        self.game = ""


class Room:
    def __init__(self, room_id, host, entry):
        self.id = room_id
        self.host = host  # None while the host's seat is held
        self.entry = entry
        self.peers = {}
        self.seats = {1: Seat()}

    def seated(self):
        """The room's players by id, the host first, held seats too: (id, conn or None, seat)."""
        held = [(i, None, s) for i, s in self.seats.items() if s.until]
        live = ([(1, self.host, self.seats.get(1))] if self.host else []) + \
            [(i, c, self.seats.get(i)) for i, c in self.peers.items()]
        return sorted(live + held, key=lambda t: t[0])


class Relay:
    def __init__(self, hold=HOLD_S):
        self.hold = hold
        self.lock = threading.Lock()
        self.rooms = {}
        self.next_room = 1
        self.conns = set()
        self.last_status = None

    # Every handler decides who gets what while holding the lock, then sends
    # after releasing it, so one slow socket can't stall everyone else.
    def deliver(self, outbox):
        for conn, opcode, payload in outbox:
            conn.send_frame(opcode, payload)

    def on_text(self, conn, line):
        parts = line.split()
        if not parts:
            return
        op, args = parts[0], parts[1:]
        if op == "ping":
            return  # keepalive: pages send one every 25 s so proxies keep the socket open
        outbox = []
        with self.lock:
            if op == "list":
                want = args[0] if args and args[0] in GAMES else None
                games = ["%d %d %s" % (r.id, len(r.seated()), r.entry) for r in self.rooms.values()
                         if r.host and (not want or not r.host.game or r.host.game == want)]
                outbox.append((conn, OP_TEXT, " ".join(["list"] + games).encode()))
            elif op == "host" and len(args) == 1 and valid_entry(args[0]):
                self._leave(conn, outbox)
                room = Room(self.next_room, conn, args[0])
                self.next_room += 1
                self.rooms[room.id] = room
                conn.room, conn.id = room, 1
                outbox.append((conn, OP_TEXT, b"hosted %d" % room.id))
                outbox.append((conn, OP_TEXT, ("seat %d 1 %s" % (room.id, room.seats[1].key)).encode()))
                log("room %d opened by %s" % (room.id, conn.addr_name()))
                self._status_changed(outbox)
            elif op == "update" and len(args) == 1 and valid_entry(args[0]):
                if conn.room and conn.room.host is conn and conn.room.entry != args[0]:
                    conn.room.entry = args[0]
                    self._status_changed(outbox)
            elif op == "join" and len(args) == 1 and args[0].isdigit():
                self._leave(conn, outbox)
                room = self.rooms.get(int(args[0]))
                # Not while its host is away: nobody would welcome them.
                if not room or not room.host:
                    outbox.append((conn, OP_TEXT, b"error no-room"))
                else:
                    peer_id = next((i for i in range(FIRST_PEER_ID, LAST_PEER_ID + 1)
                                    if i not in room.peers and i not in room.seats), None)
                    if peer_id is None:
                        outbox.append((conn, OP_TEXT, b"error full"))
                    else:
                        room.peers[peer_id] = conn
                        room.seats[peer_id] = Seat()
                        conn.room, conn.id = room, peer_id
                        outbox.append((room.host, OP_TEXT, b"peer-joined %d" % peer_id))
                        outbox.append((conn, OP_TEXT, ("seat %d %d %s" % (room.id, peer_id, room.seats[peer_id].key)).encode()))
                        log("room %d: %s joined as id %d" % (room.id, conn.addr_name(), peer_id))
                self._status_changed(outbox)
            elif op == "welcome" and len(args) == 2 and args[0].isdigit() and valid_entry(args[1]):
                room = conn.room
                if room and room.host is conn:
                    peer = room.peers.get(int(args[0]))
                    if peer:
                        outbox.append((peer, OP_TEXT, ("welcome %s %s" % (args[0], args[1])).encode()))
            elif op == "signal" and len(args) == 2 and args[0].isdigit() and valid_signal(args[1]):
                # Signaling only runs between a host and its own clients.
                room, to = conn.room, int(args[0])
                if room:
                    if room.host is conn:
                        target = room.peers.get(to)
                    else:
                        target = room.host if to == 1 else None
                    if target:
                        outbox.append((target, OP_TEXT, ("signal %d %s" % (conn.id, args[1])).encode()))
            elif op == "rejoin" and len(args) == 3 and args[0].isdigit() and args[1].isdigit() and KEY_RE.match(args[2]):
                self._take_seat(conn, int(args[0]), int(args[1]), args[2], None, outbox)
            elif op == "rehost" and len(args) in (2, 3) and args[0].isdigit() and KEY_RE.match(args[1]) and \
                    (len(args) == 2 or valid_entry(args[2])):
                self._take_seat(conn, int(args[0]), 1, args[1], args[2] if len(args) == 3 else "", outbox)
            elif op == "leave":
                self._leave(conn, outbox)
                self._status_changed(outbox)
            elif op == "hello" and len(args) == 2 and args[0] in GAMES and player_name(args[1]) is not None:
                conn.name, conn.game = player_name(args[1]), args[0]
                self._status_changed(outbox)
            elif op == "watch" and not args:
                conn.watch = True
                self._watch(conn, outbox)
            else:
                outbox.append((conn, OP_TEXT, b"error bad-request"))
        self.deliver(outbox)

    def on_binary(self, conn, data):
        if len(data) < 8:
            return
        with self.lock:
            room = conn.room
            if not room:
                return
            id_to = struct.unpack_from("<I", data, 4)[0]
            if room.host is conn or id_to not in (0, 1):
                target = room.peers.get(id_to)
            else:
                target = room.host
            if room.host is not conn:
                data = struct.pack("<I", conn.id) + data[4:]
        if target and target is not conn:
            target.send_frame(OP_BINARY, data)

    def connect(self, conn):
        with self.lock:
            self.conns.add(conn)

    def disconnect(self, conn):
        outbox = []
        with self.lock:
            self._drop(conn, outbox)
            self.conns.discard(conn)
            self._status_changed(outbox)
        self.deliver(outbox)

    # The landing page's live counts. Same as status() in cloudflare/src/lobby.js.
    def _status(self):
        waiting = [c for c in self.conns if not c.room and c.name is not None]
        lobby = sorted((c.name for c in waiting), key=sort_key)
        by_game = {g: dict(online=0, lobby=sorted((c.name for c in waiting if c.game == g), key=sort_key))
                   for g in GAMES}
        games = []
        online = len(lobby)
        for room in sorted(self.rooms.values(), key=lambda r: r.id):
            info = read_entry(room.entry)
            if not info:
                continue
            host = room.host or room.seats[1]
            names = [((host if i == 1 else c) if c else s).name or "" for i, c, s in room.seated()]
            online += len(names)
            game = host.game or guess_game(info["episode"])
            by_game[game]["online"] += len(names)
            games.append(dict(id=room.id, name=info["name"], game=game, map=info["map"], episode=info["episode"],
                              mod=info["mod"], locked=info["locked"], players=len(names), max=info["max"],
                              names=names[:MAX_STATUS_NAMES]))
        for g in by_game.values():
            g["online"] += len(g["lobby"])
            g["lobby"] = g["lobby"][:MAX_STATUS_NAMES]
        data = json.dumps(dict(online=online, lobby=lobby[:MAX_STATUS_NAMES], byGame=by_game,
                               games=games[:MAX_STATUS_GAMES]),
                          ensure_ascii=False, separators=(",", ":"))
        return b"status " + base64.b64encode(data.encode("utf-8"))

    # After anything that can change the counts: tells the watching pages,
    # unless they already have this status.
    def _status_changed(self, outbox):
        watchers = [c for c in self.conns if c.watch]
        if not watchers:
            self.last_status = None
            return
        status = self._status()
        if status == self.last_status:
            return
        self.last_status = status
        outbox.extend((c, OP_TEXT, status) for c in watchers)

    def _watch(self, conn, outbox):
        status = self._status()
        if status == self.last_status:
            outbox.append((conn, OP_TEXT, status))
        else:
            self.last_status = status
            outbox.extend((c, OP_TEXT, status) for c in self.conns if c.watch)

    def _leave(self, conn, outbox):
        room = conn.room
        if not room:
            return
        if room.host is conn:
            self._end_room(room, outbox)
            log("room %d closed" % room.id)
        elif room.peers.get(conn.id) is conn:
            del room.peers[conn.id]
            room.seats.pop(conn.id, None)
            if room.host:
                outbox.append((room.host, OP_TEXT, b"peer-left %d" % conn.id))
            log("room %d: id %d left" % (room.id, conn.id))
        conn.room, conn.id = None, 0

    # A socket that closed without leave or went quiet: its seat is held for
    # its player to take back (_take_seat).
    def _drop(self, conn, outbox):
        room = conn.room
        seat = room and self.rooms.get(room.id) is room and room.seats.get(conn.id)
        if not seat or conn is not (room.host if conn.id == 1 else room.peers.get(conn.id)):
            self._leave(conn, outbox)
            return
        seat.until, seat.name, seat.game = time.monotonic() + self.hold, conn.name, conn.game
        if conn.id == 1:
            room.host = None
            outbox.extend((peer, OP_TEXT, b"host-lost") for peer in room.peers.values())
        else:
            del room.peers[conn.id]
            if room.host:
                outbox.append((room.host, OP_TEXT, b"peer-lost %d" % conn.id))
        log("room %d: id %d dropped, seat held" % (room.id, conn.id))
        timer = threading.Timer(self.hold, self._expire, (room, conn.id, seat))
        timer.daemon = True
        timer.start()
        conn.room, conn.id = None, 0

    # A held seat nobody took back in time ends.
    def _expire(self, room, seat_id, seat):
        outbox = []
        with self.lock:
            if self.rooms.get(room.id) is not room or room.seats.get(seat_id) is not seat or not seat.until:
                return
            if seat_id == 1:
                self._end_room(room, outbox)
                log("room %d: the host didn't come back, room closed" % room.id)
            else:
                del room.seats[seat_id]
                if room.host:
                    outbox.append((room.host, OP_TEXT, b"peer-left %d" % seat_id))
                log("room %d: id %d didn't come back" % (room.id, seat_id))
            self._status_changed(outbox)
        self.deliver(outbox)

    # rejoin and rehost: a player takes its seat back with its key, held or
    # not (the old socket may not have closed yet, and is replaced). A rehost
    # may bring the room's entry, in case it changed meanwhile.
    def _take_seat(self, conn, room_id, seat_id, key, entry, outbox):
        room = self.rooms.get(room_id)
        seat = room and room.seats.get(seat_id)
        if not seat or not hmac.compare_digest(seat.key, key) or (seat_id == 1) != (entry is not None):
            outbox.append((conn, OP_TEXT, b"error no-seat"))
            return
        old = room.host if seat_id == 1 else room.peers.get(seat_id)
        if old is not conn:
            self._leave(conn, outbox)
            if old:
                old.room, old.id = None, 0
                outbox.append((old, OP_CLOSE, struct.pack("!H", 4001) + b"replaced"))
        was_held = bool(seat.until)
        seat.until, seat.name, seat.game = None, None, ""
        if seat_id == 1:
            room.host = conn
            if entry:
                room.entry = entry
        else:
            room.peers[seat_id] = conn
        conn.room, conn.id = room, seat_id
        outbox.append((conn, OP_TEXT, (b"rehosted %d" % room.id) if seat_id == 1
                       else (b"rejoined %d %d" % (room.id, seat_id))))
        if was_held and seat_id == 1:
            outbox.extend((peer, OP_TEXT, b"host-back") for peer in room.peers.values())
        elif was_held and room.host:
            outbox.append((room.host, OP_TEXT, b"peer-back %d" % seat_id))
        log("room %d: id %d took its seat back" % (room.id, seat_id))
        self._status_changed(outbox)

    # Ends a room: its players are told the host left.
    def _end_room(self, room, outbox):
        self.rooms.pop(room.id, None)
        for peer in room.peers.values():
            peer.room, peer.id = None, 0
            outbox.append((peer, OP_TEXT, b"host-left"))


def valid_entry(text):
    return len(text) <= MAX_ENTRY_HEX and HEX_RE.match(text) is not None


def valid_signal(text):
    return len(text) <= MAX_SIGNAL_B64 and B64_RE.match(text) is not None


def clean_text(text, limit):
    return HIDDEN_RE.sub("", text).strip()[:limit].strip()


def c_string(data):
    """A C string, printable ASCII only."""
    data = data.split(b"\0", 1)[0]
    return "".join(chr(b) if 0x20 <= b < 0x7F else "?" for b in data)


def mod_name(tail):
    """The mod in a host's tail, as packaging/wasm/mods.js writes it: "JKMD", version 2, flags (1 a mod,
    2 the MotS Remastered pack), the name's length, the mod's 32-byte and the pack's 16-byte
    fingerprints when there, then the name."""
    b = bytes.fromhex(tail[:len(tail) // 2 * 2])
    if len(b) < 7 or b[:5] != b"JKMD\x02":
        return ""
    flags = b[5]
    at = 7 + 32 + (16 if flags & 2 else 0)
    name = c_string(b[at:at + b[6]]) if flags & 1 else ""
    if flags & 2:
        return name + ", Remastered pack" if name else "Remastered pack"
    return name


def read_entry(entry):
    """What the page shows of a hosted game: never its password, only whether it has one. None for an
    entry that isn't a game's (a jkMultiEntry, types.h in the OpenJKDF2 fork)."""
    if len(entry) < ENTRY_HEX:
        return None
    b = bytes.fromhex(entry[:ENTRY_HEX])
    max_players = struct.unpack_from("<i", b, 16)[0]
    server = b[24:88].decode("utf-16-le", "replace").split("\0", 1)[0]
    return dict(max=max_players if 0 < max_players <= LAST_PEER_ID else 0, name=clean_text(server, 32),
                episode=c_string(b[88:120]), map=c_string(b[120:152]), locked=b[152:154] != b"\0\0",
                mod=mod_name(entry[ENTRY_HEX:]))


def sort_key(name):
    """Close to the order JavaScript's localeCompare gives: Ä with the As, case aside."""
    return unicodedata.normalize("NFKD", name).casefold(), name


def guess_game(episode):
    """For a host that didn't say hello: the retail Mysteries of the Sith
    episodes all start with JKM (JKM, JKM_KFY, JKM_MP, JKM_SABER). Episode
    names have no extension."""
    return "mots" if episode.lower().startswith("jkm") else "jk1"


def player_name(b64):
    """hello's base64 UTF-8 name, cleaned, or None if it isn't one."""
    if len(b64) > MAX_NAME_B64 or not B64_RE.match(b64):
        return None
    try:
        data = base64.b64decode(b64, validate=True)
    except ValueError:
        return None
    return clean_text(data.decode("utf-8", "replace"), MAX_NAME)


class IceConfig:
    """The iceServers list each page gets on connect.

    TURN with --turn-secret uses the time-limited credentials coturn checks with
    use-auth-secret: username "<expiry>:jk", password base64(HMAC-SHA1(secret,
    username)). Without a secret, --turn-user and --turn-pass are sent as is.
    """

    def __init__(self, stun, turn, turn_secret, turn_user, turn_pass, ttl):
        self.stun = stun
        self.turn = turn
        self.turn_secret = turn_secret
        self.turn_user = turn_user
        self.turn_pass = turn_pass
        self.ttl = ttl

    def enabled(self):
        return bool(self.stun or self.turn)

    def servers(self):
        servers = []
        if self.stun:
            servers.append({"urls": self.stun})
        if self.turn:
            if self.turn_secret:
                user = "%d:jk" % (int(time.time()) + self.ttl)
                digest = hmac.new(self.turn_secret.encode(), user.encode(), hashlib.sha1).digest()
                password = base64.b64encode(digest).decode()
            else:
                user, password = self.turn_user, self.turn_pass
            entry = {"urls": self.turn}
            if user:
                entry["username"] = user
                entry["credential"] = password or ""
            servers.append(entry)
        return servers

    def message(self):
        return "ice " + base64.b64encode(json.dumps(self.servers()).encode()).decode()


def log(text):
    print("relay: " + text, flush=True)


def read_exact(rfile, n):
    data = rfile.read(n)
    return data if len(data) == n else None


def read_frame(rfile):
    head = read_exact(rfile, 2)
    if head is None:
        return None
    fin = bool(head[0] & 0x80)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    n = head[1] & 0x7F
    if n == 126:
        ext = read_exact(rfile, 2)
        if ext is None:
            return None
        n = struct.unpack("!H", ext)[0]
    elif n == 127:
        ext = read_exact(rfile, 8)
        if ext is None:
            return None
        n = struct.unpack("!Q", ext)[0]
    if n > MAX_MESSAGE:
        return None
    mask = read_exact(rfile, 4) if masked else None
    if masked and mask is None:
        return None
    payload = read_exact(rfile, n) if n else b""
    if payload is None:
        return None
    if mask and n:
        key = (mask * (n // 4 + 1))[:n]
        payload = (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")
    return fin, opcode, payload


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map,
                          **{".wasm": "application/wasm", ".js": "text/javascript"})
    relay = None
    ice = None

    def end_headers(self):
        # Always serve the newest build, no Ctrl+Shift+R needed.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def list_directory(self, path):
        # Once it's public (a tunnel, a VM), the page is all anyone should see.
        self.send_error(404, "Not found")
        return None

    def do_GET(self):
        if self.path.split("?")[0] == "/relay" and self.headers.get("Upgrade", "").lower() == "websocket":
            self.handle_websocket()
        else:
            super().do_GET()

    def handle_websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_error(400, "Missing Sec-WebSocket-Key")
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        # The handler answers in HTTP/1.0 by default. Chrome takes a 1.0
        # upgrade, Firefox refuses it and never connects.
        self.protocol_version = "HTTP/1.1"
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

        sock = self.connection
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(QUIET_S)
        conn = Conn(sock, self.client_address)
        self.relay.connect(conn)
        if self.ice and self.ice.enabled():
            conn.send_text(self.ice.message())
        try:
            self.websocket_loop(conn)
        finally:
            self.relay.disconnect(conn)
            conn.closed = True

    def websocket_loop(self, conn):
        msg_op, parts, size = None, [], 0
        while True:
            try:
                frame = read_frame(self.rfile)
            except OSError:  # quiet for QUIET_S, or reset
                return
            if frame is None:
                return
            fin, opcode, payload = frame
            if opcode == OP_CLOSE:
                conn.send_frame(OP_CLOSE, payload[:2])
                return
            if opcode == OP_PING:
                conn.send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode in (OP_TEXT, OP_BINARY):
                msg_op, parts, size = opcode, [payload], len(payload)
            elif opcode == OP_CONT and msg_op is not None:
                parts.append(payload)
                size += len(payload)
                if size > MAX_MESSAGE:
                    return
            else:
                return
            if fin:
                data = b"".join(parts)
                if msg_op == OP_TEXT:
                    self.relay.on_text(conn, data.decode("utf-8", "replace"))
                else:
                    self.relay.on_binary(conn, data)
                msg_op, parts, size = None, [], 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dir", default=".", help="folder with index.html, openjkdf2.js and openjkdf2.wasm")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to listen on; 0.0.0.0 lets other computers on your network join")
    parser.add_argument("--stun", action="append", default=[], metavar="URL",
                        help="STUN server for WebRTC, e.g. stun:stun.example.org:3478 (repeatable)")
    parser.add_argument("--turn", action="append", default=[], metavar="URL",
                        help="TURN server for WebRTC, e.g. turn:turn.example.org:3478 (repeatable)")
    parser.add_argument("--turn-secret", default=os.environ.get("JK_TURN_SECRET"),
                        help="coturn static-auth-secret, to hand out time-limited TURN logins "
                             "(or set JK_TURN_SECRET, which keeps it out of the process list)")
    parser.add_argument("--turn-user", help="fixed TURN username (when there's no --turn-secret)")
    parser.add_argument("--turn-pass", help="fixed TURN password (when there's no --turn-secret)")
    parser.add_argument("--turn-ttl", type=int, default=12 * 3600, help="TURN login lifetime in seconds")
    parser.add_argument("--hold", type=float, default=HOLD_S,
                        help="seconds a dropped player's seat waits for them to come back")
    args = parser.parse_args()

    Handler.relay = Relay(args.hold)
    Handler.ice = IceConfig(args.stun, args.turn, args.turn_secret, args.turn_user, args.turn_pass, args.turn_ttl)
    server = http.server.ThreadingHTTPServer((args.host, args.port), functools.partial(Handler, directory=args.dir))
    server.daemon_threads = True
    log("serving %s at http://%s:%d/index.html, relay at ws://%s:%d/relay"
        % (args.dir, args.host, args.port, args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
