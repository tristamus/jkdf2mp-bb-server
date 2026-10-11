#!/bin/bash
# Sets up the always-on lobby on a fresh Ubuntu 22.04/24.04 server (written
# for Oracle Cloud's Always Free VMs): the relay behind Caddy for HTTPS, and
# coturn for STUN/TURN. Safe to run again, for example to install a new build.
#
#   sudo bash setup-server.sh <public-ip> [<build-dir> | <https-base-url>]
#
# The build is index.html, openjkdf2.js, openjkdf2.wasm and relay.py, plus a
# SHA256SUMS file listing them; every file is checked against it, and
# SHA256SUMS itself against JK_SUMS_SHA256 when that's set. With no build
# argument, the build already installed is kept.
#
# The page ends up at https://<public-ip-with-dashes>.sslip.io/index.html
# (sslip.io resolves those names to the IP in them, so no domain is needed and
# Caddy can get a Let's Encrypt certificate). Set JK_HOSTNAME to use your own.

set -euo pipefail

BUILD_FILES="index.html openjkdf2.js openjkdf2.wasm relay.py"
APP=/opt/jkdf2mp
CONF=/etc/jkdf2mp
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200

usage() {
    echo "usage: sudo bash $0 <public-ip> [<build-dir> | <https-base-url>]" >&2
    exit 2
}

[ "$(id -u)" = 0 ] || { echo "setup-server.sh: run it as root (sudo)" >&2; exit 1; }
[ $# -ge 1 ] && [ $# -le 2 ] || usage
PUBLIC_IP=$1
SOURCE=${2:-}
[[ $PUBLIC_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || usage
HOST=${JK_HOSTNAME:-${PUBLIC_IP//./-}.sslip.io}
# Cloud VMs sit behind 1:1 NAT: the public IP isn't on any interface, so coturn
# has to be told both addresses.
PRIVATE_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
[ -n "$PRIVATE_IP" ] || { echo "setup-server.sh: couldn't find this server's private IP" >&2; exit 1; }

echo "== Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q caddy coturn python3 curl

echo "== Build"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
if [ -d "$SOURCE" ]; then
    for f in SHA256SUMS $BUILD_FILES; do cp "$SOURCE/$f" "$stage/"; done
elif [[ $SOURCE == https://* ]]; then
    for f in SHA256SUMS $BUILD_FILES; do curl -fsSL --retry 3 -o "$stage/$f" "${SOURCE%/}/$f"; done
elif [ -n "$SOURCE" ]; then
    usage
fi
if [ -n "$SOURCE" ]; then
    if [ -n "${JK_SUMS_SHA256:-}" ]; then
        echo "$JK_SUMS_SHA256  $stage/SHA256SUMS" | sha256sum -c - > /dev/null \
            || { echo "setup-server.sh: SHA256SUMS doesn't match JK_SUMS_SHA256" >&2; exit 1; }
        echo "SHA256SUMS: OK"
    fi
    for f in $BUILD_FILES; do
        want=$(awk -v f="$f" '$2 == f || $2 == "*" f { print $1 }' "$stage/SHA256SUMS")
        have=$(sha256sum "$stage/$f" | cut -d' ' -f1)
        [ -n "$want" ] && [ "$want" = "$have" ] || { echo "setup-server.sh: $f doesn't match SHA256SUMS" >&2; exit 1; }
        echo "$f: OK"
    done
    install -d -m 755 "$APP" "$APP/web"
    install -m 644 "$stage/index.html" "$stage/openjkdf2.js" "$stage/openjkdf2.wasm" "$APP/web/"
    install -m 644 "$stage/relay.py" "$APP/relay.py"
fi
[ -f "$APP/relay.py" ] && [ -f "$APP/web/openjkdf2.wasm" ] || { echo "setup-server.sh: no build installed yet; pass one" >&2; exit 1; }

echo "== TURN secret"
install -d -m 700 "$CONF"
if [ ! -f "$CONF/turn.env" ]; then
    (umask 077; echo "JK_TURN_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')" > "$CONF/turn.env")
fi
TURN_SECRET=$(sed -n 's/^JK_TURN_SECRET=//p' "$CONF/turn.env")

echo "== coturn"
cat > /etc/turnserver.conf <<EOF
# Written by jkdf2mp-bb-server/deploy/setup-server.sh
listening-port=3478
listening-ip=$PRIVATE_IP
relay-ip=$PRIVATE_IP
external-ip=$PUBLIC_IP/$PRIVATE_IP
min-port=$TURN_MIN_PORT
max-port=$TURN_MAX_PORT
realm=$HOST
use-auth-secret
static-auth-secret=$TURN_SECRET
fingerprint
no-tls
no-dtls
no-cli
no-multicast-peers
# Relay only to the public internet, never to this cloud's own networks or
# its metadata service.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
EOF
if getent group turnserver > /dev/null; then
    chown root:turnserver /etc/turnserver.conf
    chmod 640 /etc/turnserver.conf
fi
# Older packages only start once this is set.
if [ -f /etc/default/coturn ]; then
    sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi
systemctl enable -q coturn
systemctl restart coturn

echo "== Relay"
id jkdf2mp > /dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin jkdf2mp
cat > /etc/systemd/system/jkdf2mp-relay.service <<EOF
# Written by jkdf2mp-bb-server/deploy/setup-server.sh
[Unit]
Description=Jedi Knight browser multiplayer lobby
After=network-online.target
Wants=network-online.target

[Service]
User=jkdf2mp
EnvironmentFile=$CONF/turn.env
ExecStart=/usr/bin/python3 $APP/relay.py --dir $APP/web --host 127.0.0.1 --port 8080 \\
    --stun stun:$HOST:3478 \\
    --turn turn:$HOST:3478?transport=udp --turn turn:$HOST:3478?transport=tcp
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q jkdf2mp-relay
systemctl restart jkdf2mp-relay

echo "== Caddy"
cat > /etc/caddy/Caddyfile <<EOF
# Written by jkdf2mp-bb-server/deploy/setup-server.sh
$HOST {
	# Compress the page and engine (the .wasm shrinks to about a third; Caddy
	# 2.6 doesn't compress it by default), but leave the WebSocket alone.
	@page not path /relay
	encode @page gzip {
		match {
			header Content-Type text/*
			header Content-Type application/javascript*
			header Content-Type application/wasm*
		}
	}
	reverse_proxy 127.0.0.1:8080
}
EOF
systemctl enable -q caddy
systemctl reload-or-restart caddy

echo "== Firewall"
# Oracle's Ubuntu images reject everything but SSH in iptables, so new rules
# go above that REJECT rule. The cloud's own security list has to allow the
# same ports (oci-create.sh does that).
open_port() {
    local proto=$1 port=$2 pos
    iptables -C INPUT -p "$proto" -m conntrack --ctstate NEW -m "$proto" --dport "$port" -j ACCEPT 2> /dev/null && return
    pos=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$pos" ]; then
        iptables -I INPUT "$pos" -p "$proto" -m conntrack --ctstate NEW -m "$proto" --dport "$port" -j ACCEPT
    else
        iptables -A INPUT -p "$proto" -m conntrack --ctstate NEW -m "$proto" --dport "$port" -j ACCEPT
    fi
}
open_port tcp 80
open_port tcp 443
open_port tcp 3478
open_port udp 3478
open_port udp "$TURN_MIN_PORT:$TURN_MAX_PORT"
if command -v netfilter-persistent > /dev/null; then
    netfilter-persistent save > /dev/null
elif [ -d /etc/iptables ]; then
    iptables-save > /etc/iptables/rules.v4
fi
if command -v ufw > /dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 3478; ufw allow "$TURN_MIN_PORT:$TURN_MAX_PORT/udp"
fi

echo "== Check"
url="https://$HOST/index.html"
for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
        echo "Lobby is up: $url"
        exit 0
    fi
    sleep 3
done
echo "setup-server.sh: $url didn't answer yet. Caddy may still be getting its certificate:" >&2
echo "  journalctl -u caddy -n 30" >&2
exit 1
