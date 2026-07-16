#!/bin/bash
# ============================================================
# run-server.sh — foreground runner for the pdf-reader server
# Called by launchd (macOS) or systemd (Linux) as a service.
# Guarantees exactly ONE process on the target port.
# ============================================================

set -e
cd "$(dirname "$0")"
PORT=3001

# ── Force-release the port (kill ALL processes on it) ──────
echo "[run-server] Releasing port $PORT..."
for i in 1 2 3; do
  PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$PIDS" ]; then
    echo "[run-server] Port $PORT is free"
    break
  fi
  echo "[run-server] Killing PIDs $PIDS on port $PORT (attempt $i)"
  for pid in $PIDS; do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 1
done

# Double-check
PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[run-server] WARNING: Port $PORT still occupied by $PIDS after kill attempts"
fi

# ── Build frontend ─────────────────────────────────────────
echo "[run-server] Building frontend..."
sh build.sh

# ── Start server ───────────────────────────────────────────
echo "[run-server] Starting Node.js server on port $PORT..."
exec node server/index.js
