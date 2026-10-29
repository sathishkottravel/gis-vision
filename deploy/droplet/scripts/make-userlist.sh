#!/usr/bin/env bash
# Writes PgBouncer's auth file from the SCRAM verifiers Postgres already stores (design D5),
# so no plaintext password is kept anywhere. PgBouncer authenticates clients against these
# verifiers and reuses them to log in to Postgres, which only works because they are the
# server's own. Run it after the first `docker compose up -d db`, and after every password change.
#
# Usage: scripts/make-userlist.sh [role ...]        (default role: gis_app)
#   SECRETS_VOLUME       Docker volume (default: gis-vision-droplet-secrets, as in compose.yaml)
#   DB_CONTAINER         container to read from (default: this folder's Compose `db`)
#   PGBOUNCER_CONTAINER  reloaded afterwards if running (default: this folder's Compose `pgbouncer`)
set -euo pipefail

OPENSSL_IMAGE='alpine/openssl:3.5.8@sha256:3f25da71f70eba788067daac3f3df03bd1de7a7c52ed89fa93b94ad2c92d986b'
SECRETS_VOLUME="${SECRETS_VOLUME:-gis-vision-droplet-secrets}"
DB_CONTAINER="${DB_CONTAINER:-$(docker compose ps -q db)}"
PGBOUNCER_CONTAINER="${PGBOUNCER_CONTAINER-$(docker compose ps -q pgbouncer 2>/dev/null || true)}"
roles=("${@:-gis_app}")

if [ -z "$DB_CONTAINER" ]; then
  echo "db is not running: start it with 'docker compose up -d --wait db' first" >&2
  exit 1
fi

# One `"role" "SCRAM-SHA-256$..."` line per role, in PgBouncer's auth_file format.
list="$(printf "'%s'," "${roles[@]}")"
userlist="$(MSYS_NO_PATHCONV=1 docker exec -u postgres "$DB_CONTAINER" psql -d gis_vision -tA -c \
  "SELECT format('\"%s\" \"%s\"', rolname, rolpassword) FROM pg_authid
    WHERE rolname IN (${list%,}) AND rolpassword LIKE 'SCRAM-SHA-256\$%' ORDER BY rolname")"

found="$(printf '%s\n' "$userlist" | grep -c . || true)"
if [ "$found" -ne "${#roles[@]}" ]; then
  echo "expected SCRAM verifiers for ${roles[*]}, found $found" >&2
  exit 1
fi

printf '%s\n' "$userlist" | MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "$SECRETS_VOLUME:/secrets" --entrypoint sh "$OPENSSL_IMAGE" -euc '
    mkdir -p /secrets/pgbouncer
    cat > /secrets/pgbouncer/userlist.txt
    chown 70:70 /secrets/pgbouncer/userlist.txt
    chmod 600 /secrets/pgbouncer/userlist.txt
  '
echo "Wrote PgBouncer auth file for: ${roles[*]}"

if [ -n "$PGBOUNCER_CONTAINER" ]; then
  docker kill -s HUP "$PGBOUNCER_CONTAINER" >/dev/null
  echo "Reloaded PgBouncer."
fi
