#!/usr/bin/env python3
"""Local WebSocket relay for OpenJKDF2's browser build (Phase 1).

Serves the web build (index.html, openjkdf2.js, openjkdf2.wasm) from --dir and
relays multiplayer traffic between the browser tabs that load it, so two tabs
can play one match. Python 3 standard library only.

The page's network backend (src/Platform/Networking/WSRelay in the OpenJKDF2
fork) connects to ws://<this server>/relay. Text frames are control lines,
binary frames are game packets:

  client -> relay   list | host <entry> | update <entry> | join <room>
                    welcome <id> <entry> | leave
  relay -> client   list (<room> <players> <entry>)* | hosted <room>
                    peer-joined <id> | peer-left <id> | welcome <id> <entry>
                    host-left | error <code>

<entry> is the host's hex-encoded session description, passed through as is.
Game packets start with a little-endian u32 idFrom and u32 idTo. The host is
id 1 and clients get 2..64, as with OpenJKDF2's GNS backend. A packet goes to
the player named in idTo (to the host when idTo is 0 or 1) and is dropped if
that player isn't in the room, which is what the GNS host does when it
forwards. The relay stamps idFrom with the sender's real id.

This server never serves or stores game files: players pick their own install
in the page, and it stays in their browser.
"""

import argparse
import base64
import functools
import hashlib
import http.server
import re
import socket
import struct
import threading

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 64 * 1024
MAX_ENTRY_HEX = 2048
FIRST_PEER_ID = 2
LAST_PEER_ID = 64
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")

OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class Conn:
    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.send_lock = threading.Lock()
        self.room = None
        self.id = 0
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

    def name(self):
        return "%s:%d" % (self.addr[0], self.addr[1])


class Room:
    def __init__(self, room_id, host, entry):
        self.id = room_id
        self.host = host
        self.entry = entry
        self.peers = {}


class Relay:
    def __init__(self):
        self.lock = threading.Lock()
        self.rooms = {}
        self.next_room = 1

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
        outbox = []
        with self.lock:
            if op == "list":
                games = ["%d %d %s" % (r.id, 1 + len(r.peers), r.entry) for r in self.rooms.values()]
                outbox.append((conn, OP_TEXT, " ".join(["list"] + games).encode()))
            elif op == "host" and len(args) == 1 and valid_entry(args[0]):
                self._leave(conn, outbox)
                room = Room(self.next_room, conn, args[0])
                self.next_room += 1
                self.rooms[room.id] = room
                conn.room, conn.id = room, 1
                outbox.append((conn, OP_TEXT, b"hosted %d" % room.id))
                log("room %d opened by %s" % (room.id, conn.name()))
            elif op == "update" and len(args) == 1 and valid_entry(args[0]):
                if conn.room and conn.room.host is conn:
                    conn.room.entry = args[0]
            elif op == "join" and len(args) == 1 and args[0].isdigit():
                self._leave(conn, outbox)
                room = self.rooms.get(int(args[0]))
                if not room:
                    outbox.append((conn, OP_TEXT, b"error no-room"))
                else:
                    peer_id = next((i for i in range(FIRST_PEER_ID, LAST_PEER_ID + 1) if i not in room.peers), None)
                    if peer_id is None:
                        outbox.append((conn, OP_TEXT, b"error full"))
                    else:
                        room.peers[peer_id] = conn
                        conn.room, conn.id = room, peer_id
                        outbox.append((room.host, OP_TEXT, b"peer-joined %d" % peer_id))
                        log("room %d: %s joined as id %d" % (room.id, conn.name(), peer_id))
            elif op == "welcome" and len(args) == 2 and args[0].isdigit() and valid_entry(args[1]):
                room = conn.room
                if room and room.host is conn:
                    peer = room.peers.get(int(args[0]))
                    if peer:
                        outbox.append((peer, OP_TEXT, ("welcome %s %s" % (args[0], args[1])).encode()))
            elif op == "leave":
                self._leave(conn, outbox)
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
            data = struct.pack("<I", conn.id) + data[4:]
        if target and target is not conn:
            target.send_frame(OP_BINARY, data)

    def leave(self, conn):
        outbox = []
        with self.lock:
            self._leave(conn, outbox)
        self.deliver(outbox)

    def _leave(self, conn, outbox):
        room = conn.room
        if not room:
            return
        if room.host is conn:
            del self.rooms[room.id]
            for peer in room.peers.values():
                peer.room, peer.id = None, 0
                outbox.append((peer, OP_TEXT, b"host-left"))
            log("room %d closed" % room.id)
        else:
            room.peers.pop(conn.id, None)
            outbox.append((room.host, OP_TEXT, b"peer-left %d" % conn.id))
            log("room %d: id %d left" % (room.id, conn.id))
        conn.room, conn.id = None, 0


def valid_entry(text):
    return len(text) <= MAX_ENTRY_HEX and HEX_RE.match(text) is not None


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

    def end_headers(self):
        # Always serve the newest build, no Ctrl+Shift+R needed.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

        sock = self.connection
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn = Conn(sock, self.client_address)
        try:
            self.websocket_loop(conn)
        finally:
            self.relay.leave(conn)
            conn.closed = True

    def websocket_loop(self, conn):
        msg_op, parts, size = None, [], 0
        while True:
            frame = read_frame(self.rfile)
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
    args = parser.parse_args()

    Handler.relay = Relay()
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
