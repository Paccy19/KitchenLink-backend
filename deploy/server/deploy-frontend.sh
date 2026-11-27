#!/bin/bash
set -euo pipefail

cd /opt/kitchenlink/frontend

echo "Fetching latest frontend code..."
git fetch origin main
git reset --hard origin/main

echo "Installing frontend dependencies..."
npm ci

echo "Building frontend..."
VITE_API_BASE_URL=/api/v1 VITE_DEMO_MODE=false npm run build

echo "Frontend deployment completed successfully."
