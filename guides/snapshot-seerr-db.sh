#!/usr/bin/env bash
#
# Snapshot Seerr's SQLite database so `import-seerr-users.ts` can read it.
#
# A plain `cp` does NOT work here and the failure is unhelpful: Seerr runs SQLite in WAL
# mode, a read-only open of a WAL database needs its `-wal` sidecar, and without it SQLite
# fails with a bare `SQLITE_CANTOPEN: unable to open database file` that names neither WAL
# nor the missing file. `.backup` checkpoints the WAL into one self-contained file instead,
# and needs no Seerr downtime.
#
#   ./guides/snapshot-seerr-db.sh <seerr-db.sqlite3> <destination.sqlite3>
#
# The destination belongs in finderr's DATA directory, because that is the one path the
# container can see -- it arrives inside as /data/<name>.
#
# THE SNAPSHOT HOLDS EVERY USER'S PLEX TOKEN AND PASSWORD HASH. Delete it when the import
# is done. It is a copy of a credential store.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <seerr-db.sqlite3> <destination.sqlite3>" >&2
  exit 2
fi

SRC=$1
DEST=$2

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 is not installed, and it is what takes the snapshot." >&2
  exit 1
fi

if [ ! -r "$SRC" ]; then
  echo "error: cannot read $SRC" >&2
  echo "       Seerr's database is usually at <config-dir>/db/db.sqlite3, and is often" >&2
  echo "       owned by root. Re-run with sudo if that is the case." >&2
  exit 1
fi

if [ -e "$DEST" ]; then
  echo "error: $DEST already exists. Remove it first rather than overwriting a snapshot" >&2
  echo "       you may still be importing from." >&2
  exit 1
fi

# .backup rather than cp: it reads through SQLite, so a live writer cannot hand us a torn
# page, and it folds the WAL into the destination.
sqlite3 "$SRC" ".backup '$DEST'"

# The copy inherits WAL mode from the header. Turning it off makes the snapshot readable
# read-only with no sidecar at all, which is exactly what the import job wants.
sqlite3 "$DEST" "pragma journal_mode=delete;" >/dev/null

chmod 600 "$DEST"

USERS=$(sqlite3 "$DEST" "select count(*) from user;")
echo "snapshot written: $DEST"
echo "seerr users in it: $USERS"
echo
echo "Next -- dry run (writes nothing):"
echo "  docker compose exec finderr bun src/jobs/import-seerr-users.ts \\"
echo "    --from /data/$(basename "$DEST") --exclude <your-plex-id>"
echo
echo "Delete this snapshot when you are done: it holds Plex tokens and password hashes."
