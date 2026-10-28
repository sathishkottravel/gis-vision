#!/usr/bin/env bash
# Creates the private CA and the server certificate for Postgres and PgBouncer (design D4), and
# stores them in the Docker volume both services mount, owned by each service's user:
#   <volume>/postgres/{server.crt,server.key,ca.crt}   uid 999 (postgres in postgis/postgis)
#   <volume>/pgbouncer/{server.crt,server.key,ca.crt}  uid 70  (postgres in edoburu/pgbouncer)
# The CA certificate (for clients) and the CA key (keep it off the droplet) go to $OUT_DIR.
# An existing $OUT_DIR/ca.key is reused, so renewing the server certificate keeps clients' trust.
#
# Usage: scripts/make-certs.sh <droplet-ip> [dns-name ...]
#   SECRETS_VOLUME  Docker volume (default: gis-vision-droplet-secrets, as in compose.yaml)
#   OUT_DIR         where ca.crt, ca.key and server.crt are written (default: ./certs)
# Runs openssl in a pinned container, so it works anywhere Docker does (Linux, macOS, Git Bash).
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <droplet-ip> [dns-name ...]" >&2
  exit 64
fi

OPENSSL_IMAGE='alpine/openssl:3.5.8@sha256:3f25da71f70eba788067daac3f3df03bd1de7a7c52ed89fa93b94ad2c92d986b'
SECRETS_VOLUME="${SECRETS_VOLUME:-gis-vision-droplet-secrets}"
OUT_DIR="${OUT_DIR:-./certs}"

# Every name a client may use: the public address, Compose service names (PgBouncer verifies
# `db`), and loopback for SSH tunnels.
sans="DNS:db,DNS:pgbouncer,DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ || "$name" == *:* ]]; then
    entry="IP:$name"
  else
    entry="DNS:$name"
  fi
  [[ ",$sans," == *",$entry,"* ]] || sans="$sans,$entry"
done

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true
# Docker on Windows (Git Bash) needs a Windows path for the bind mount.
host_out="$(cd "$OUT_DIR" && { pwd -W 2>/dev/null || pwd; })"

docker volume create "$SECRETS_VOLUME" >/dev/null

MSYS_NO_PATHCONV=1 docker run --rm \
  -e SANS="$sans" \
  -v "$SECRETS_VOLUME:/secrets" \
  -v "$host_out:/out" \
  --entrypoint sh "$OPENSSL_IMAGE" -euc '
    cd /out
    if [ ! -f ca.key ]; then
      openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
        -keyout ca.key -out ca.crt -days 3650 -subj "/CN=gis-vision droplet CA" 2>/dev/null
      echo "Created a new CA."
    fi
    work="$(mktemp -d)"
    openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
      -keyout "$work/server.key" -out "$work/server.csr" -subj "/CN=gis-vision-db" 2>/dev/null
    printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n" "$SANS" > "$work/ext"
    openssl x509 -req -in "$work/server.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
      -out "$work/server.crt" -days 730 -extfile "$work/ext" 2>/dev/null
    cp "$work/server.crt" server.crt
    for service in postgres:999 pgbouncer:70; do
      dir="/secrets/${service%%:*}"; uid="${service#*:}"
      mkdir -p "$dir"
      cp "$work/server.crt" "$work/server.key" ca.crt "$dir/"
      chown -R "$uid:$uid" "$dir"
      chmod 700 "$dir"; chmod 600 "$dir/server.key"; chmod 644 "$dir/server.crt" "$dir/ca.crt"
    done
    chmod 600 ca.key
    rm -rf "$work"
    echo "Server certificate for: $SANS"
    openssl x509 -in server.crt -noout -enddate
  '
