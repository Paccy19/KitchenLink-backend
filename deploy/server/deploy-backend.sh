#!/bin/bash
set -euo pipefail

cd /opt/kitchenlink/backend

echo "Fetching latest backend code..."
git fetch origin main
git reset --hard origin/main

echo "Installing backend dependencies..."
npm ci --omit=dev

echo "Restarting backend..."
pm2 restart kitchenlink-backend --update-env

echo "Backend deployment completed successfully."
