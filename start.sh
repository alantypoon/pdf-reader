#!/bin/bash

sudo sh ./stop.sh

set -e
cd "$(dirname "$0")"

LOG_DIR="logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"

echo "=== Killing old server ==="
pkill -f "node server/index.js" 2>/dev/null || true
rm -f "$PID_FILE"

echo "=== Building frontend ==="
sh build.sh

echo "=== Starting PDF Reader server ==="
mkdir -p "$LOG_DIR"
nohup node server/index.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

echo "=== Server started ==="
echo "PID: $SERVER_PID"
echo "Log: $LOG_FILE"
echo "=== Tailing server log (Ctrl+C to stop) ==="
tail -f "$LOG_FILE"
