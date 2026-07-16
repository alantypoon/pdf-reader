#!/bin/bash
# ============================================================
# run-server.sh — foreground runner for the pdf-reader server
# Called by launchd (macOS) or systemd (Linux) as a service.
# The OS process manager monitors this process and restarts it
# automatically if it exits.
# ============================================================

set -e
cd "$(dirname "$0")"

# Kill any leftover instances (defensive)
pkill -f "node server/index.js" 2>/dev/null || true
sleep 1

# Build the frontend once at startup
echo "[run-server] Building frontend..."
sh build.sh

# Start the Node.js server in the foreground.
# IMPORTANT: do NOT use nohup / & — the service manager needs
# the process to stay in the foreground so it can monitor it.
echo "[run-server] Starting Node.js server..."
exec node server/index.js
