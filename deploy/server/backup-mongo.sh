#!/bin/bash
# Nightly MongoDB backup of KitchenLink (all databases in kitchenlink-mongo).
# Keeps the last 14 days in /opt/kitchenlink/backups.
set -euo pipefail
dir=/opt/kitchenlink/backups
file="$dir/mongo-$(date +%Y%m%d-%H%M%S).archive.gz"
docker exec kitchenlink-mongo mongodump --archive --gzip --quiet > "$file.part"
mv "$file.part" "$file"
chmod 600 "$file"
find "$dir" -name "mongo-*.archive.gz" -mtime +14 -delete
echo "$(date -Is) backup ok: $file ($(du -h "$file" | cut -f1))"
