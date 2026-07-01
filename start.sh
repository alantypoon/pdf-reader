#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Killing old server ==="
pkill -f "node server/index.js" 2>/dev/null || true

echo "=== Building frontend ==="
sh build.sh

echo "=== Starting PDF Reader server ==="
node server/index.js
