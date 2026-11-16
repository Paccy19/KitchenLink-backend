#!/usr/bin/env bash
# KitchenLink — back up everything that can't be rebuilt from Git:
#   - MongoDB (source of truth)        -> mongo-<stamp>.archive.gz
#   - PostgreSQL mirror (convenience)  -> postgres-<stamp>.dump
#   - uploaded photos + private documents -> uploads-<stamp>.tar.gz
#
# Read-only for the running stack: nothing is stopped, changed or deleted
# (except backups older than KEEP_DAYS in the backup folder).
#
# Usage (on the server, from anywhere):
#   ./deploy/scripts/backup.sh                 # writes to deploy/backups/
#   BACKUP_DIR=/srv/backups ./deploy/scripts/backup.sh
# Copy the files OFF the server afterwards (another machine / object storage).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE=(docker compose -f docker-compose.prod.yml)
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Database names/users from deploy/.env (same defaults as the compose file).
set -a; [ -f .env ] && . ./.env; set +a
MONGO_ROOT_USER="${MONGO_ROOT_USER:-root}"
MONGO_APP_DB="${MONGO_APP_DB:-online_food_kitchen}"
POSTGRES_DB="${POSTGRES_DB:-online_food_kitchen}"
POSTGRES_USER="${POSTGRES_USER:-kitchenlink}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
umask 077

echo "[backup] MongoDB ($MONGO_APP_DB)..."
# The password is read inside the container from its own environment, so it
# never appears in this host's process list.
"${COMPOSE[@]}" exec -T mongo sh -c \
  'mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db "$MONGO_APP_DB" --archive --gzip' \
  > "$BACKUP_DIR/mongo-$STAMP.archive.gz"

echo "[backup] PostgreSQL mirror ($POSTGRES_DB)..."
"${COMPOSE[@]}" exec -T postgres sh -c \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom' \
  > "$BACKUP_DIR/postgres-$STAMP.dump"

echo "[backup] Uploads (public photos + private documents)..."
"${COMPOSE[@]}" exec -T backend tar -czf - -C /app uploads private-uploads \
  > "$BACKUP_DIR/uploads-$STAMP.tar.gz"

# Fail loudly on an empty file (e.g. a container that wasn't running).
for f in "mongo-$STAMP.archive.gz" "postgres-$STAMP.dump" "uploads-$STAMP.tar.gz"; do
  if [ ! -s "$BACKUP_DIR/$f" ]; then
    echo "[backup] ERROR: $f is empty" >&2
    exit 1
  fi
done

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'mongo-*' -o -name 'postgres-*' -o -name 'uploads-*' \) \
  -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] removed old backup: /'

echo "[backup] Done:"
ls -lh "$BACKUP_DIR"/*-"$STAMP".*
