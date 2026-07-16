#!/bin/bash
set -euo pipefail

# ============================================================
# install.sh — installs pdf-reader as an OS service
#
# Detects platform automatically:
#   macOS  → launchd  (LaunchAgent, user-scoped)
#   Linux  → systemd  (system service)
#
# After install, the server stays alive 24/7 and auto-restarts
# within seconds if it ever crashes.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="${SCRIPT_DIR}/run-server.sh"
SERVICE_NAME="com.pdf-reader.server"

# ── helpers ──────────────────────────────────────────────────

detect_platform() {
    local os
    os="$(uname -s)"

    case "$os" in
        Darwin)  echo "macos"   ;;
        Linux)   echo "linux"   ;;
        *)       echo "unknown" ;;
    esac
}

ensure_executable() {
    local file="$1"
    if [[ ! -x "$file" ]]; then
        chmod +x "$file"
    fi
}

# ── main ─────────────────────────────────────────────────────

PLATFORM="$(detect_platform)"
echo "=== pdf-reader service installer ==="
echo "  Platform: $PLATFORM"
echo "  Runner:   $RUNNER"
echo ""

ensure_executable "$RUNNER"

case "$PLATFORM" in
# ── macOS: launchd ───────────────────────────────────────────
macos)
    PLIST="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
    MONGO_PLIST="$HOME/Library/LaunchAgents/com.mongodb.2700.plist"
    MONGO_CONF="/opt/homebrew/etc/mongod-2700.conf"
    MONGO_LOG="/opt/homebrew/var/log/mongodb/mongo.log"
    LOG="/tmp/pdf-reader-service.log"
    ERRLOG="/tmp/pdf-reader-service-error.log"

    mkdir -p "$HOME/Library/LaunchAgents"

    # ── MongoDB service ────────────────────────────────────
    echo "  Installing MongoDB service → $MONGO_PLIST"

    launchctl unload "$MONGO_PLIST" 2>/dev/null || true
    # Kill any running mongod on port 2700 from previous sessions
    lsof -tiTCP:2700 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true

    cat > "$MONGO_PLIST" <<MONGOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mongodb.2700</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/mongod</string>
        <string>--config</string>
        <string>${MONGO_CONF}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>${MONGO_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${MONGO_LOG}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
MONGOPLIST

    launchctl load "$MONGO_PLIST"
    echo "  MongoDB service started."

    # ── PDF Reader server service ──────────────────────────

    # Stop and unload any previous version
    launchctl unload "$PLIST" 2>/dev/null || true

    echo "  Installing PDF Reader service → $PLIST"

    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${RUNNER}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>2</integer>

    <key>StandardOutPath</key>
    <string>${LOG}</string>

    <key>StandardErrorPath</key>
    <string>${ERRLOG}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/miniconda3/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
PLISTEOF

    launchctl load "$PLIST"
    echo ""
    echo "=== Services installed and started ==="
    echo ""
    echo "  MongoDB:"
    echo "    Status: launchctl list | grep com.mongodb.2700"
    echo "    Stop:   launchctl unload $MONGO_PLIST"
    echo ""
    echo "  PDF Reader:"
    echo "    Logs:    tail -f $LOG"
    echo "    Errors:  tail -f $ERRLOG"
    echo "    Stop:    launchctl unload $PLIST"
    echo "    Restart: launchctl unload $PLIST && launchctl load $PLIST"
    ;;

# ── Linux: systemd ───────────────────────────────────────────
linux)
    UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

    echo "  Writing systemd unit → $UNIT"

    sudo tee "$UNIT" > /dev/null <<UNITEOF
[Unit]
Description=PDF Reader Server (Node.js)
After=network.target mongod.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/bin/bash ${RUNNER}
Restart=always
RestartSec=2
StandardOutput=append:/tmp/pdf-reader-service.log
StandardError=append:/tmp/pdf-reader-service-error.log
Environment="PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/miniconda3/bin"
Environment="HOME=${HOME}"

[Install]
WantedBy=multi-user.target
UNITEOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"

    echo ""
    echo "=== Service installed and started ==="
    echo "  Status:  sudo systemctl status $SERVICE_NAME"
    echo "  Logs:    sudo journalctl -u $SERVICE_NAME -f"
    echo "  Stop:    sudo systemctl stop $SERVICE_NAME"
    echo "  Restart: sudo systemctl restart $SERVICE_NAME"
    ;;

*)
    echo "ERROR: Unsupported platform '$PLATFORM'"
    echo "Only macOS and Linux are supported."
    exit 1
    ;;
esac
