#!/usr/bin/env bash
# KitchenLink — restore a backup made by backup.sh.
#
#   ./deploy/scripts/restore.sh <stamp>            e.g. 20261116T020000Z
#   ./deploy/scripts/restore.sh <stamp> --replace  (see below)
#
# Default (safe) mode ADDS what is missing: MongoDB documents whose _id already
# exists are kept as they are, and existing upload files are not overwritten.
# Use it to fill an empty server (new VPS) or recover deleted records.
#
# --replace drops each MongoDB collection in the backup before restoring it
# and overwrites upload files with the backup's copies: the database goes back
# to exactly the backup's state, and anything newer is LOST. Take a fresh
# backup first; you are asked to type the stamp to confirm.
#
# PostgreSQL is a mirror of MongoDB: after a restore, rebuild it with
#   docker compose -f docker-compose.prod.yml exec backend npm run migrate:pg
set -euo pipefail

STAMP="${1:-}"
MODE="${2:-}"
if [ -z "$STAMP" ]; then
  echo "Usage: $0 <stamp> [--replace]   (stamp from the backup file names)" >&2
  exit 1
fi

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
COMPOSE=(docker compose -f docker-compose.prod.yml)
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"

MONGO_FILE="$BACKUP_DIR/mongo-$STAMP.archive.gz"
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tar.gz"
for f in "$MONGO_FILE" "$UPLOADS_FILE"; do
  [ -s "$f" ] || { echo "Missing or empty: $f" >&2; exit 1; }
done

DROP=""
TAR_KEEP="--skip-old-files"
if [ "$MODE" = "--replace" ]; then
  echo "REPLACE mode: MongoDB collections in the backup are dropped and restored,"
  echo "upload files are overwritten. Newer data will be lost."
  read -r -p "Type the stamp ($STAMP) to continue: " answer
  [ "$answer" = "$STAMP" ] || { echo "Cancelled."; exit 1; }
  DROP="--drop"
  TAR_KEEP="--overwrite"
elif [ -n "$MODE" ]; then
  echo "Unknown option: $MODE" >&2
  exit 1
fi

echo "[restore] MongoDB from $(basename "$MONGO_FILE")${DROP:+ (replace)}..."
"${COMPOSE[@]}" exec -T -e DROP="$DROP" mongo sh -c \
  'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip $DROP' \
  < "$MONGO_FILE"

echo "[restore] Uploads from $(basename "$UPLOADS_FILE")..."
"${COMPOSE[@]}" exec -T backend tar -xzf - -C /app $TAR_KEEP < "$UPLOADS_FILE"

echo "[restore] Done. Now rebuild the PostgreSQL mirror:"
echo "  docker compose -f docker-compose.prod.yml exec backend npm run migrate:pg"
