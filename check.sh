#!/bin/bash
# ============================================================
# check.sh — quick health check for the pdf-reader services
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_LOG="/tmp/pdf-reader-service.log"
MONGO_PORT=2700
SERVER_PORT=3001

echo "=== pdf-reader health check ==="
echo "  $(date)"
echo ""

# ── Services ─────────────────────────────────────────────────

echo "── Services ──"
launchctl list | grep -E "com.mongodb.2700|com.pdf-reader" || echo "  (no services found)"
echo ""

# ── Ports ────────────────────────────────────────────────────

echo "── Listening ports ──"
mongo_pid=$(lsof -tiTCP:$MONGO_PORT -sTCP:LISTEN 2>/dev/null)
server_pid=$(lsof -tiTCP:$SERVER_PORT -sTCP:LISTEN 2>/dev/null)

if [[ -n "$mongo_pid" ]]; then
    echo "  MongoDB  :2700  ✓ (pid $mongo_pid)"
else
    echo "  MongoDB  :2700  ✗ NOT RUNNING"
fi

if [[ -n "$server_pid" ]]; then
    echo "  Server   :3001  ✓ (pid $server_pid)"
else
    echo "  Server   :3001  ✗ NOT RUNNING"
fi
echo ""

# ── MongoDB check ────────────────────────────────────────────

if [[ -n "$mongo_pid" ]]; then
    echo "── MongoDB ping ──"
    mongosh 'mongodb://root:Generic0626Skills@127.0.0.1:2700/?authSource=admin' \
        --quiet --eval 'db.runCommand({ping:1})' 2>/dev/null \
        && echo "  ✓ ok" \
        || echo "  ✗ auth failed"
    echo ""
fi

# ── Server health endpoint ───────────────────────────────────

if [[ -n "$server_pid" ]]; then
    echo "── Server health endpoint ──"
    response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$SERVER_PORT/health 2>/dev/null)
    if [[ "$response" == "200" ]]; then
        echo "  GET /health → 200 ✓"
    else
        echo "  GET /health → ${response:-timeout} (may be normal if endpoint doesn't exist)"
    fi
    echo ""
fi

# ── Recent logs ──────────────────────────────────────────────

echo "── Recent server logs (last 15 lines) ──"
if [[ -f "$SERVICE_LOG" ]]; then
    tail -f "$SERVICE_LOG"
else
    echo "  (no log file at $SERVICE_LOG)"
fi
