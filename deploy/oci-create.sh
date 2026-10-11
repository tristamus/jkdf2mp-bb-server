#!/bin/bash
# Creates the always-on lobby on Oracle Cloud's Always Free tier and sets it up,
# from OCI Cloud Shell (the >_ button in the Oracle Cloud console), where the
# oci command is already signed in. Safe to run again: it reuses what exists.
#
#   bash oci-create.sh [<release-url>]
#
# It makes a network that lets in SSH, HTTPS and TURN, starts an Ubuntu 24.04
# VM.Standard.E2.1.Micro in the account's home region (Always Free only
# covers the home region), then installs the build from the release with
# setup-server.sh over SSH. JK_SHAPE=VM.Standard.A1.Flex asks for an Arm VM
# instead (more memory, but often out of capacity).

set -euo pipefail

RELEASE=${1:-https://github.com/tristamus/jkdf2mp-bb-server/releases/download/lobby-1}
SHAPE=${JK_SHAPE:-VM.Standard.E2.1.Micro}
NAME=jkdf2mp
KEY=$HOME/.ssh/$NAME
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200

say() { echo "== $*"; }
die() { echo "oci-create.sh: $*" >&2; exit 1; }

command -v oci > /dev/null || die "the oci command is missing; run this in OCI Cloud Shell"

TENANCY=${OCI_TENANCY:-$(sed -n 's/^tenancy *= *//p' "${OCI_CLI_CONFIG_FILE:-/etc/oci/config}" 2> /dev/null | head -n 1)}
[ -n "$TENANCY" ] || die "couldn't find the tenancy OCID; set OCI_TENANCY and run again"
HOME_REGION=$(oci iam region-subscription list --tenancy-id "$TENANCY" \
    --query 'data[?"is-home-region"]|[0]."region-name"' --raw-output)
[ -n "$HOME_REGION" ] && [ "$HOME_REGION" != null ] || die "couldn't find the home region"
say "Home region $HOME_REGION"
C=$TENANCY
o() { oci --region "$HOME_REGION" "$@"; }

# Reuse a resource by display name, or create it.
find_id() { # <list command...> ; prints the first live match's id or nothing
    local id
    id=$(o "$@" --all --query "data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING']|[0].id" \
        --raw-output 2> /dev/null || true)
    [ "$id" = null ] && id=
    echo "$id"
}

say "Network"
VCN=$(find_id network vcn list -c "$C" --display-name "$NAME-vcn")
if [ -z "$VCN" ]; then
    VCN=$(o network vcn create -c "$C" --display-name "$NAME-vcn" --cidr-blocks '["10.0.0.0/16"]' \
        --dns-label "$NAME" --wait-for-state AVAILABLE --query data.id --raw-output)
fi
IGW=$(find_id network internet-gateway list -c "$C" --vcn-id "$VCN" --display-name "$NAME-igw")
if [ -z "$IGW" ]; then
    IGW=$(o network internet-gateway create -c "$C" --vcn-id "$VCN" --display-name "$NAME-igw" \
        --is-enabled true --wait-for-state AVAILABLE --query data.id --raw-output)
fi
RT=$(o network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
o network route-table update --rt-id "$RT" --force --wait-for-state AVAILABLE \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" > /dev/null
# SSH, HTTP (certificates), HTTPS, STUN/TURN, TURN relay ports, and the ICMP
# message path MTU discovery needs. Replaces the default list's rules.
tcp() { echo "{\"protocol\":\"6\",\"source\":\"0.0.0.0/0\",\"tcpOptions\":{\"destinationPortRange\":{\"min\":$1,\"max\":${2:-$1}}}}"; }
udp() { echo "{\"protocol\":\"17\",\"source\":\"0.0.0.0/0\",\"udpOptions\":{\"destinationPortRange\":{\"min\":$1,\"max\":${2:-$1}}}}"; }
INGRESS="[$(tcp 22),$(tcp 80),$(tcp 443),$(tcp 3478),$(udp 3478),$(udp $TURN_MIN_PORT $TURN_MAX_PORT),{\"protocol\":\"1\",\"source\":\"0.0.0.0/0\",\"icmpOptions\":{\"type\":3,\"code\":4}}]"
SL=$(o network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)
o network security-list update --security-list-id "$SL" --force --wait-for-state AVAILABLE \
    --ingress-security-rules "$INGRESS" \
    --egress-security-rules '[{"protocol":"all","destination":"0.0.0.0/0"}]' > /dev/null
SUBNET=$(find_id network subnet list -c "$C" --vcn-id "$VCN" --display-name "$NAME-subnet")
if [ -z "$SUBNET" ]; then
    SUBNET=$(o network subnet create -c "$C" --vcn-id "$VCN" --display-name "$NAME-subnet" \
        --cidr-block 10.0.0.0/24 --dns-label pub --wait-for-state AVAILABLE --query data.id --raw-output)
fi

say "Server"
if [ ! -f "$KEY" ]; then
    mkdir -p "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N "" -C "$NAME" -f "$KEY"
fi
INSTANCE=$(find_id compute instance list -c "$C" --display-name "$NAME-lobby")
if [ -z "$INSTANCE" ]; then
    IMAGE=$(o compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version 24.04 \
        --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)
    [ -n "$IMAGE" ] && [ "$IMAGE" != null ] || die "no Ubuntu 24.04 image for $SHAPE"
    SHAPE_CONFIG=()
    [ "$SHAPE" = VM.Standard.A1.Flex ] && SHAPE_CONFIG=(--shape-config '{"ocpus":2,"memoryInGBs":12}')
    # Micro VMs only run in one availability domain of multi-domain regions.
    for AD in $(o iam availability-domain list -c "$C" --query 'data[].name' --raw-output | tr -d '[]",'); do
        has=$(o compute shape list -c "$C" --availability-domain "$AD" \
            --query "length(data[?shape=='$SHAPE'])" --raw-output 2> /dev/null || echo 0)
        [ "$has" != 0 ] || continue
        echo "Starting $SHAPE in $AD"
        if INSTANCE=$(o compute instance launch -c "$C" --availability-domain "$AD" --shape "$SHAPE" "${SHAPE_CONFIG[@]}" \
            --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true --display-name "$NAME-lobby" \
            --ssh-authorized-keys-file "$KEY.pub" --wait-for-state RUNNING --query data.id --raw-output); then
            break
        fi
        INSTANCE=
    done
    [ -n "$INSTANCE" ] || die "couldn't start a $SHAPE server (out of capacity?). Try again later."
fi
IP=$(o compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"' --raw-output)
[ -n "$IP" ] && [ "$IP" != null ] || die "the server has no public IP"
say "Server is at $IP"

say "Setup"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "ubuntu@$IP")
for _ in $(seq 1 30); do "${SSH[@]}" true 2> /dev/null && break; sleep 10; done
"${SSH[@]}" "set -e
    cd \$(mktemp -d)
    curl -fsSL --retry 3 -O '$RELEASE/SHA256SUMS' -O '$RELEASE/setup-server.sh'
    grep '  setup-server.sh\$' SHA256SUMS | sha256sum -c -
    sudo bash setup-server.sh '$IP' '$RELEASE'"

HOST=${IP//./-}.sslip.io
echo
echo "The lobby is at https://$HOST/index.html"
echo "To install a newer release later, run this again with that release's URL."
