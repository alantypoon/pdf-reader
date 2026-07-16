#!/bin/bash
# ============================================================
# restart.sh — restarts the pdf-reader server service
#
# Detects platform and uses the appropriate service manager:
#   macOS  → launchctl unload + load
#   Linux  → systemctl restart
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="com.pdf-reader.server"
PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
MONGO_PLIST="$HOME/Library/LaunchAgents/com.mongodb.2700.plist"

detect_platform() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        *)      echo "unknown" ;;
    esac
}

PLATFORM="$(detect_platform)"

case "$PLATFORM" in
macos)
    echo "=== Restarting pdf-reader (launchd) ==="

    # Restart MongoDB first
    if [[ -f "$MONGO_PLIST" ]]; then
        echo "[1/2] Restarting MongoDB..."
        launchctl unload "$MONGO_PLIST" 2>/dev/null || true
        sleep 1
        launchctl load "$MONGO_PLIST"
    fi

    # Restart PDF Reader server
    echo "[2/2] Restarting PDF Reader server..."
    launchctl unload "$PLIST" 2>/dev/null || true
    sleep 1
    launchctl load "$PLIST"

    echo ""
    echo "=== Services restarted ==="
    echo ""
    launchctl list | grep -E "com.mongodb.2700|com.pdf-reader"
    ;;

linux)
    echo "=== Restarting pdf-reader (systemd) ==="
    sudo systemctl restart "$SERVICE_NAME"
    sudo systemctl status "$SERVICE_NAME" --no-pager
    ;;

*)
    echo "ERROR: Unsupported platform '$PLATFORM'"
    exit 1
    ;;
esac

./check.sh
