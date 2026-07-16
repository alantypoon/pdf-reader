#!/bin/bash
# ============================================================
# stop-service.sh — stops the pdf-reader server service
# Unloads launchd plist and force-kills any remaining process.
# ============================================================

set -euo pipefail

SERVICE_NAME="com.pdf-reader.server"
PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
PORT=3007

echo "=== Stopping pdf-reader service ==="

# 1. Unload the launchd plist so it won't auto-restart
if [[ -f "$PLIST" ]]; then
    echo "[1/2] Unloading launchd service..."
    launchctl unload "$PLIST" 2>/dev/null && echo "  ✓ $SERVICE_NAME unloaded" || echo "  ⚠ $SERVICE_NAME was not loaded"
else
    echo "[1/2] No plist found at $PLIST"
fi

# 2. Force-kill any remaining node process on the port
echo "[2/2] Killing node processes on port $PORT..."
for i in 1 2 3; do
    PIDS=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN -c node 2>/dev/null || true)
    if [[ -z "$PIDS" ]]; then
        echo "  ✓ Port $PORT is free"
        break
    fi
    for pid in $PIDS; do
        kill -9 "$pid" 2>/dev/null && echo "  ✓ Killed PID $pid" || true
    done
    sleep 1
done

echo ""
echo "=== Service stopped ==="
