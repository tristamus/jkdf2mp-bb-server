#!/usr/bin/env python3
"""Checks room passwords in relay.py, the same ways cloudflare/test/passwords.mjs
checks them in the Cloudflare lobby: relay.py runs as its own process on a free
port, with each setting of --passwords-for-old-games, and plain WebSocket
clients act as the engine does. Python 3 standard library only.

  python3 relay/test_passwords.py

An "old" game (cloudflare-89) checks the listed password itself, with the box
shown only for sessionFlags 0x400, and sends a bare join. A "new" one connects
with pw=1 and, when the lobby said pw, sends join <room> <hex of the typed
password> instead (bare when the box is empty). Hosts of both send their
password in every entry. It prints a line for each check and exits 1 if one
fails.
"""

import base64
import datetime
import importlib.util
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(HERE, "relay.py")
PASSWORD = "letmein"
TAIL = "4a4b4d4402010861626364"
# The relay's log, from every run, to check no password gets into it.
LOGS = []


def hex_pw(text):
    return text.encode("utf-16-le").hex()


def entry(name="t_Room", password="", flag=None, tail=""):
    """A jkMultiEntry (types.h in the OpenJKDF2 fork) in hex, then a tail. flag is sessionFlags 0x400, which
    the host's game sets with a password and keeps (it's sticky) after."""
    if flag is None:
        flag = bool(password)
    b = bytearray(240)
    struct.pack_into("<I", b, 8, 0x4A4B4852)
    struct.pack_into("<i", b, 16, 8)
    b[24:24 + 2 * len(name)] = name.encode("utf-16-le")
    b[88:93] = b"JK1MP"
    b[120:135] = b"01narshadda.jkl"
    b[152:152 + 2 * len(password)] = password.encode("utf-16-le")
    struct.pack_into("<i", b, 216, 0x400 | 0x8 if flag else 0x8)
    struct.pack_into("<i", b, 224, 10)
    return b.hex() + tail


def decode(hex_entry):
    b = bytes.fromhex(hex_entry[:480])
    flags = struct.unpack_from("<i", b, 216)[0]
    return dict(name=b[24:88].decode("utf-16-le").split("\0")[0], pw=b[152:216].decode("utf-16-le").split("\0")[0],
                box=bool(flags & 0x400), flags=flags)


class Client:
    """A plain WebSocket client. say sends a line and returns what came back for it: the relay handles a
    connection's frames in order, so everything its lines set off has arrived once it answers a ping sent
    after them."""

    def __init__(self, port, kind, src=None, query=None):
        self.kind = kind
        self.pings = 0
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5,
                                             source_address=(src, 0) if src else None)
        if query is None:
            query = "?net=0&pw=1" if kind == "new" else "?net=0"
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET /relay%s HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
                           "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
                           % (query, key)).encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            data = self.sock.recv(4096)
            assert data, "the relay closed the connection"
            self.buf += data
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        assert head.startswith(b"HTTP/1.1 101"), head
        self.lobby_line = next((line for line in self.take() if line.startswith("lobby ")), "")

    def frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x80 | opcode]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack("!H", n))
        self.sock.sendall(head + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))

    def read_frame(self):
        while True:
            if len(self.buf) >= 2:
                n, at = self.buf[1] & 0x7F, 2
                if n == 126 and len(self.buf) >= 4:
                    n, at = struct.unpack("!H", self.buf[2:4])[0], 4
                elif n == 127 and len(self.buf) >= 10:
                    n, at = struct.unpack("!Q", self.buf[2:10])[0], 10
                if n < 126 or at > 2:
                    if len(self.buf) >= at + n:
                        opcode, payload = self.buf[0] & 0x0F, self.buf[at:at + n]
                        self.buf = self.buf[at + n:]
                        return opcode, payload
            data = self.sock.recv(65536)
            assert data, "the relay closed the connection"
            self.buf += data

    def take(self):
        """The lines that came since the last take."""
        self.pings += 1
        mark = b"sync%d" % self.pings
        self.frame(0x9, mark)
        lines = []
        while True:
            opcode, payload = self.read_frame()
            if opcode == 0xA and payload == mark:
                return lines
            if opcode == 0x1:
                lines.append(payload.decode())

    def say(self, line):
        self.frame(0x1, line.encode())
        return self.take()

    def close(self):
        self.sock.close()


class Relay:
    """relay.py running on a free port, with the options given."""

    def __init__(self, *options, env=None):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.log = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([sys.executable, "-B", RELAY, "--port", str(self.port), "--dir", HERE, *options],
                                     stdout=self.log, stderr=subprocess.STDOUT, env=dict(os.environ, **(env or {})))
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=1).close()
                return
            except OSError:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.05)
        self.stop()
        raise RuntimeError("relay.py didn't start: " + self.output())

    def output(self):
        self.log.seek(0)
        return self.log.read().decode("utf-8", "replace")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)
        LOGS.append(self.output())
        self.log.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()

    def connect(self, kind, src=None):
        return Client(self.port, kind, src)

    def host(self, kind, src=None, **opts):
        h = self.connect(kind, src)
        h.entry = entry(**opts)
        out = h.say("host " + h.entry)
        assert len(out) >= 2 and out[0].startswith("hosted "), out
        h.room = int(out[0].split()[1])
        h.key = out[1].split()[3]
        return h

    def listed(self, ws, room):
        line = next(line for line in ws.say("list") if line.startswith("list"))
        items = line.split()[1:]
        for i in range(0, len(items), 3):
            if int(items[i]) == room:
                return dict(decode(items[i + 2]), hex=items[i + 2])
        return None

    def join_as(self, j, room, typed):
        """What a game's player sees joining room with typed in the password box."""
        listed = self.listed(j, room)
        if not listed:
            return "not listed"
        # The engine snapshots the lobby line with each list.
        if j.kind == "new" and "pw" in j.lobby_line.split():
            out = j.say("join %d" % room + (" " + hex_pw(typed) if typed else ""))
        else:
            # The box is cleared when the join screen opens, and hidden
            # without the flag.
            if listed["pw"] != (typed if listed["box"] else ""):
                return "wrong password (its own check)"
            out = j.say("join %d" % room)
        return seen(out)

    def try_join(self, kind, room, typed, src=None):
        j = self.connect(kind, src)
        try:
            return self.join_as(j, room, typed)
        finally:
            j.close()

    def status(self):
        w = self.connect("old")
        line = [line for line in w.say("watch") if line.startswith("status ")][-1]
        w.close()
        text = base64.b64decode(line[7:]).decode()
        return text, json.loads(text)


def seen(lines):
    if any(line.startswith("seat ") for line in lines):
        return "JOINED"
    return next((line for line in lines if line.startswith("error ")), "nothing")


RESULTS = {"passed": 0, "failed": 0}


def check(name):
    def run(fn):
        try:
            fn()
            RESULTS["passed"] += 1
            print("ok   " + name, flush=True)
        except Exception:
            RESULTS["failed"] += 1
            print("FAIL " + name + "\n" + traceback.format_exc(), flush=True)
        return fn
    return run


def iso(seconds_from_now):
    return datetime.datetime.fromtimestamp(time.time() + seconds_from_now, datetime.timezone.utc) \
        .strftime("%Y-%m-%dT%H:%M:%SZ")


def expected(host_kind, joiner_kind, typed, keeps):
    """A game that sends passwords is checked by the relay; an older one checks a room an older game hosts
    itself while the relay lets it, and hears newer version for any other room with a password."""
    if joiner_kind == "new":
        return "JOINED" if typed == PASSWORD else "error password"
    if host_kind == "old" and keeps:
        return "JOINED" if typed == PASSWORD else "wrong password (its own check)"
    return "error version newer"


# The transition settings, and whether older games still check the password
# of a room an older game hosts with each.
MODES = [
    ("default", [], None, True),
    ("host", ["--passwords-for-old-games", "host"], None, True),
    ("none", ["--passwords-for-old-games", "none"], None, False),
    ("none from the environment", [], {"PASSWORDS_FOR_OLD_GAMES": "none"}, False),
    ("until a time past", ["--passwords-for-old-games-until", iso(-3600)], None, False),
    ("until a time to come", ["--passwords-for-old-games-until", iso(3600)], None, True),
    ("until a time past, from the environment", [], {"PASSWORDS_FOR_OLD_GAMES_UNTIL": iso(-3600)}, False),
    ("none until a time to come", ["--passwords-for-old-games", "none", "--passwords-for-old-games-until",
                                   iso(3600)], None, False),
]

for label, options, env, keeps in MODES:
    @check("%s: old and new hosts x old and new joiners x right, wrong and empty password" % label)
    def _(options=options, env=env, keeps=keeps):
        with Relay(*options, env=env) as r:
            for host_kind in ("old", "new"):
                h = r.host(host_kind, password=PASSWORD)
                for joiner_kind in ("old", "new"):
                    for typed in (PASSWORD, "wrong", ""):
                        got = r.try_join(joiner_kind, h.room, typed)
                        assert got == expected(host_kind, joiner_kind, typed, keeps), \
                            (host_kind, joiner_kind, typed, got)
                # The old games' list has the password exactly when they check it themselves.
                listed = r.listed(r.connect("old"), h.room)
                assert listed["pw"] == (PASSWORD if host_kind == "old" and keeps else ""), listed
                assert listed["box"] == (host_kind == "old" and keeps), listed

    @check("%s: rooms without a password let everyone in, and a password sent to one is left out" % label)
    def _(options=options, env=env):
        with Relay(*options, env=env) as r:
            for host_kind in ("old", "new"):
                for flag in (False, True):
                    h = r.host(host_kind, flag=flag)
                    for joiner_kind in ("old", "new"):
                        # An older game's own check runs against the box it
                        # shows (the sticky flag), so only an empty one passes.
                        for typed in ("", "stale text") if joiner_kind == "new" else ("",):
                            assert r.try_join(joiner_kind, h.room, typed) == "JOINED", (host_kind, flag, joiner_kind)


@check("the relay says pw on connect, after links and turn")
def _():
    with Relay() as r:
        assert r.connect("old").lobby_line == "lobby links pw"
        assert r.connect("new").lobby_line == "lobby links pw"
    with Relay("--turn", "turn:turn.example.org:3478", "--turn-user", "u", "--turn-pass", "p") as r:
        assert r.connect("new").lobby_line == "lobby links turn pw"


@check("a game that sends passwords gets the password box exactly for rooms with a password, never a password")
def _():
    with Relay() as r:
        rooms = dict(locked=r.host("new", password=PASSWORD), locked_no_flag=r.host("new", password=PASSWORD, flag=False),
                     old_locked=r.host("old", password=PASSWORD), sticky=r.host("new", flag=True), open=r.host("old"))
        want = dict(locked=True, locked_no_flag=True, old_locked=True, sticky=False, open=False)
        n = r.connect("new")
        for k, h in rooms.items():
            listed = r.listed(n, h.room)
            assert listed["pw"] == "", k
            assert listed["box"] == want[k], k
            # Everything else as the host sent it.
            assert listed["flags"] & ~0x400 == decode(h.entry)["flags"] & ~0x400, k
            assert listed["hex"][:304] == h.entry[:304] and listed["hex"][440:] == h.entry[440:], k


@check("an older game gets a checked room without its password or box, an older game's room as before")
def _():
    with Relay() as r:
        checked = r.host("new", password=PASSWORD, tail=TAIL)
        legacy = r.host("old", password=PASSWORD, tail=TAIL)
        sticky = r.host("new", flag=True)
        o = r.connect("old")
        listed = r.listed(o, checked.room)
        assert listed["pw"] == "" and not listed["box"] and listed["hex"][440:] == checked.entry[440:], listed
        assert r.listed(o, legacy.room)["hex"] == legacy.entry
        assert r.listed(o, sticky.room)["hex"] == sticky.entry


@check("welcome never carries the password, to either kind of game, in any room")
def _():
    with Relay() as r:
        for host_kind in ("old", "new"):
            h = r.host(host_kind, password=PASSWORD, tail=TAIL)
            # An older game only gets into an older game's room.
            for kind in ("old", "new") if host_kind == "old" else ("new",):
                j = r.connect(kind)
                assert r.join_as(j, h.room, PASSWORD) == "JOINED"
                peer = next(line for line in h.take() if line.startswith("peer-joined")).split()[1]
                h.say("welcome %s %s" % (peer, h.entry))
                op, wid, e = j.take()[0].split()
                assert (op, wid) == ("welcome", peer)
                assert decode(e)["pw"] == "" and e[:304] == h.entry[:304] and e[432:] == h.entry[432:], e
                j.say("leave")


@check("the landing page shows every password room locked, and never a password")
def _():
    with Relay() as r:
        r.host("new", name="t_Checked", password=PASSWORD)
        r.host("old", name="t_Legacy", password=PASSWORD)
        r.host("new", name="t_Sticky", flag=True)
        r.host("old", name="t_Open")
        text, data = r.status()
        assert {g["name"]: g["locked"] for g in data["games"]} == \
            dict(t_Checked=True, t_Legacy=True, t_Sticky=False, t_Open=False), data
        assert PASSWORD not in text and hex_pw(PASSWORD) not in text


@check("a join's password must be 1 to 31 code units of hex, none 0, or it's a bad request")
def _():
    with Relay() as r:
        h = r.host("new", password=PASSWORD)
        j = r.connect("new")
        for bad in ("abc", "41", "410", "41004", "zz00", "0000", "41000000", "00004100", "4100" * 32, "-410"):
            assert j.say("join %d %s" % (h.room, bad)) == ["error bad-request"], bad
        assert j.say("join %d %s" % (h.room, "4100" * 31)) == ["error password"]
        assert seen(j.say("join %d %s" % (h.room, hex_pw(PASSWORD).upper()))) == "JOINED"
        long = "x" * 31
        l = r.host("new", password=long)
        assert r.try_join("new", l.room, long) == "JOINED"
        assert r.try_join("new", l.room, long[1:]) == "error password"


@check("rate limit: 10 wrong passwords a minute per room and address, then wait, even with the right one")
def _():
    with Relay() as r:
        h = r.host("new", password=PASSWORD)
        other = r.host("new", password=PASSWORD)
        a = r.connect("new")
        for i in range(10):
            assert a.say("join %d %s" % (h.room, hex_pw("guess%d" % i))) == ["error password"], i
        assert a.say("join %d %s" % (h.room, hex_pw("guess10"))) == ["error password wait"]
        assert a.say("join %d %s" % (h.room, hex_pw(PASSWORD))) == ["error password wait"]
        # An empty box counts for nothing, but waits too.
        assert a.say("join %d" % h.room) == ["error password wait"]
        # Coming back on a new connection from the same address.
        assert r.try_join("new", h.room, PASSWORD) == "error password wait"
        # Another room, and another address, aren't held up.
        assert r.try_join("new", other.room, PASSWORD) == "JOINED"
        try:
            b = r.connect("new", src="127.0.0.2")
        except OSError:
            print("     (no 127.0.0.2 here: another address isn't checked)")
            return
        b.close()
        assert r.try_join("new", h.room, "wrong", src="127.0.0.2") == "error password"
        assert r.try_join("new", h.room, PASSWORD, src="127.0.0.2") == "JOINED"
        # An older game in a room it checks itself isn't counted at all.
        legacy = r.host("old", password=PASSWORD)
        assert r.try_join("old", legacy.room, PASSWORD) == "JOINED"


class InProcess:
    """relay.py's Relay in this process, with made-up sockets and time.monotonic moved on by hand (now)."""

    def __enter__(self):
        spec = importlib.util.spec_from_file_location("relay_under_test", RELAY)
        sys.dont_write_bytecode = True
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.mod.log = lambda text: None
        self.real = time.monotonic
        self.now = self.real()
        self.mod.time.monotonic = lambda: self.now
        self.relay = self.mod.Relay()
        return self

    def __exit__(self, *exc):
        self.mod.time.monotonic = self.real

    def conn(self, kind, addr="203.0.113.1"):
        class Sock:
            def __init__(self):
                self.sent = []

            def sendall(self, data):
                self.sent.append(data)

        c = self.mod.Conn(Sock(), (addr, 1), 0, kind == "new")
        self.relay.connect(c)
        return c

    @staticmethod
    def said(c):
        out = [d[2:].decode() for d in c.sock.sent if d[0] == 0x81 and d[1] < 126]
        c.sock.sent = []
        return out

    def host(self, password):
        h = self.conn("new", "192.0.2.1")
        self.relay.on_text(h, "host " + entry(password=password))
        self.said(h)
        return h

    def try_join(self, room, typed, addr):
        c = self.conn("new", addr)
        self.relay.on_text(c, "join %d %s" % (room, hex_pw(typed)))
        got = seen(self.said(c))
        self.relay.on_text(c, "leave")
        return got


@check("rate limit: the minute runs from each wrong try, and a room that ends takes its counts with it")
def _():
    with InProcess() as p:
        relay = p.relay
        h = p.host(PASSWORD)
        room = h.room.id
        a = p.conn("new")
        for i in range(10):
            p.now += 3
            relay.on_text(a, "join %d %s" % (room, hex_pw("guess%d" % i)))
        assert p.said(a) == ["error password"] * 10
        p.now += 30
        relay.on_text(a, "join %d %s" % (room, hex_pw(PASSWORD)))
        assert p.said(a) == ["error password wait"]
        # A minute after the first wrong one, one more try.
        p.now += 3
        relay.on_text(a, "join %d %s" % (room, hex_pw("wrong")))
        assert p.said(a) == ["error password"]
        relay.on_text(a, "join %d %s" % (room, hex_pw(PASSWORD)))
        assert p.said(a) == ["error password wait"]
        p.now += 60
        relay.on_text(a, "join %d %s" % (room, hex_pw(PASSWORD)))
        assert any(line.startswith("seat ") for line in p.said(a))
        assert relay.tries == {}
        relay.on_text(a, "leave")
        relay.on_text(a, "join %d %s" % (room, hex_pw("wrong")))
        assert room in relay.tries
        relay.on_text(h, "leave")
        assert room not in relay.tries


@check("rate limit: an IPv6 address counts by its /64, so changing address within it doesn't help")
def _():
    with InProcess() as p:
        room = p.host(PASSWORD).room.id
        in64 = ["2001:db8:1:2::1", "2001:DB8:1:2::2", "2001:db8:1:2:0:0:0:3", "2001:0db8:0001:0002::4",
                "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2:1::", "2001:db8:1:2::7%eth0",
                "2001:db8:1:2:abcd::8", "2001:db8:1:2::9", "2001:db8:1:2::a"]
        for i, addr in enumerate(in64):
            assert p.try_join(room, "guess%d" % i, addr) == "error password", addr
        assert p.try_join(room, PASSWORD, "2001:db8:1:2::b") == "error password wait"
        # The next /64 over isn't held up.
        assert p.try_join(room, PASSWORD, "2001:db8:1:3::1") == "JOINED"
        # An IPv4 address mapped into IPv6 is that IPv4 address.
        for i in range(10):
            assert p.try_join(room, "guess%d" % i, "198.51.100.9" if i % 2 else "::ffff:198.51.100.9") == \
                "error password"
        assert p.try_join(room, PASSWORD, "::ffff:c633:6409") == "error password wait"
        assert p.try_join(room, PASSWORD, "198.51.100.10") == "JOINED"


@check("update: a password added, changed and taken away")
def _():
    for kind in ("new", "old"):
        with Relay() as r:
            h = r.host(kind, name="t_Up")
            assert r.status()[1]["games"][0]["locked"] is False
            h.say("update " + entry(name="t_Up", password=PASSWORD))
            assert r.status()[1]["games"][0]["locked"] is True
            assert r.try_join("new", h.room, "") == "error password"
            assert r.try_join("new", h.room, PASSWORD) == "JOINED"
            assert r.try_join("old", h.room, PASSWORD) == ("JOINED" if kind == "old" else "error version newer")
            h.say("update " + entry(name="t_Up2", password="another"))
            assert r.try_join("new", h.room, PASSWORD) == "error password"
            assert r.try_join("new", h.room, "another") == "JOINED"
            # None, with the box's flag still on (sticky): open to all.
            h.say("update " + entry(name="t_Up2", flag=True))
            assert r.status()[1]["games"][0]["locked"] is False
            assert r.try_join("new", h.room, "") == "JOINED"
            assert r.try_join("old", h.room, "") == "JOINED"
            assert r.listed(r.connect("new"), h.room)["box"] is False


@check("a rehost with a password into a room that has none makes it checked, instead of opening the room")
def _():
    for kind in ("new", "old"):
        with Relay("--hold", "30") as r:
            h = r.host(kind)
            # Its update with a password never got here: the socket dropped first.
            h.close()
            back = r.connect(kind)
            out = back.say("rehost %d %s %s" % (h.room, h.key, entry(password=PASSWORD)))
            assert out == ["rehosted %d" % h.room], out
            assert r.try_join("new", h.room, "") == "error password"
            assert r.try_join("new", h.room, "wrong") == "error password"
            assert r.try_join("new", h.room, PASSWORD) == "JOINED"
            assert r.try_join("old", h.room, "") == ("wrong password (its own check)" if kind == "old"
                                                     else "error version newer")
            assert r.try_join("old", h.room, PASSWORD) == ("JOINED" if kind == "old" else "error version newer")
            assert r.status()[1]["games"][0]["locked"] is True


@check("--passwords-for-old-games-until passing while the relay runs: older games stop getting passwords")
def _():
    until = int(time.time()) + 3
    with Relay("--passwords-for-old-games-until", iso(until - time.time())) as r:
        h = r.host("old", password=PASSWORD)
        o = r.connect("old")
        assert r.listed(o, h.room)["pw"] == PASSWORD
        assert r.try_join("old", h.room, PASSWORD) == "JOINED"
        time.sleep(until + 0.2 - time.time())
        listed = r.listed(o, h.room)
        assert listed["pw"] == "" and not listed["box"], listed
        assert r.try_join("old", h.room, PASSWORD) == "error version newer"
        assert r.try_join("new", h.room, PASSWORD) == "JOINED"
        assert r.status()[1]["games"][0]["locked"] is True


@check("settings that aren't host, none or a time stop the relay from starting")
def _():
    for options, env in ((["--passwords-for-old-games", "maybe"], None), ([], {"PASSWORDS_FOR_OLD_GAMES": "maybe"}),
                         (["--passwords-for-old-games-until", "tomorrow"], None)):
        p = subprocess.run([sys.executable, "-B", RELAY, "--port", "1", *options], capture_output=True, text=True,
                           timeout=10, env=dict(os.environ, **(env or {})))
        assert p.returncode == 2 and "passwords-for-old-games" in p.stderr, (options, p.returncode, p.stderr)


@check("the relay's log never has a password")
def _():
    text = "\n".join(LOGS)
    assert "room 1 opened" in text
    for secret in (PASSWORD, "another", "guess"):
        assert secret not in text and hex_pw(secret) not in text, secret


print("%d check(s) failed, %d passed" % (RESULTS["failed"], RESULTS["passed"]) if RESULTS["failed"]
      else "all %d passed" % RESULTS["passed"])
sys.exit(1 if RESULTS["failed"] else 0)
