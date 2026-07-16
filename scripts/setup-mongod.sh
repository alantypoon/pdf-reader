#!/bin/bash
set -euo pipefail

# ============================================================
# setup-mongod.sh
# Installs MongoDB Community Edition, configures it to listen
# on port 2700 with authentication, and creates a root user.
#
# After running this script, use the printed URI to connect:
#   mongodb://root:<password>@localhost:2700/?authSource=admin
# ============================================================

MONGO_PORT="${MONGO_PORT:-2700}"
MONGO_DB_PATH="${MONGO_DB_PATH:-/opt/homebrew/var/mongodb}"
MONGO_LOG_PATH="${MONGO_LOG_PATH:-/opt/homebrew/var/log/mongodb/mongo.log}"
MONGO_CONF="/opt/homebrew/etc/mongod-2700.conf"
MONGO_ROOT_USER="${MONGO_ROOT_USER:-root}"
MONGO_ROOT_PASSWORD="${MONGO_ROOT_PASSWORD:-Generic0626Skills}"

# ── helpers ──────────────────────────────────────────────────

print_banner() {
    echo "=============================================="
    echo "  MongoDB Setup Script"
    echo "  Port:    $MONGO_PORT"
    echo "  DB Path: $MONGO_DB_PATH"
    echo "=============================================="
}

# ── pre-flight checks ────────────────────────────────────────

print_banner

if ! command -v brew &> /dev/null; then
    echo "ERROR: Homebrew is not installed."
    echo "Install it from https://brew.sh then re-run this script."
    exit 1
fi

# ── 1. Install MongoDB ───────────────────────────────────────

echo ""
echo "[1/5] Installing MongoDB Community Edition via Homebrew …"
if brew list mongodb-community &> /dev/null; then
    echo "  → mongodb-community is already installed."
else
    brew tap mongodb/brew
    brew trust mongodb/brew
    brew install mongodb-community
    echo "  → Installation complete."
fi

MONGO_BIN="$(brew --prefix mongodb-community)/bin"
MONGO_EXEC="${MONGO_BIN}/mongod"
MONGOSH_EXEC="${MONGO_BIN}/mongosh"

if [[ ! -x "$MONGO_EXEC" ]]; then
    echo "ERROR: mongod not found at $MONGO_EXEC"
    exit 1
fi

# ── 2. Stop any default instance & create directories ─────────

echo ""
echo "[2/5] Preparing directories …"

# Stop the default Homebrew-managed mongod if running on 27017
brew services stop mongodb-community 2>/dev/null || true

sudo mkdir -p "$MONGO_DB_PATH"
sudo mkdir -p "$(dirname "$MONGO_LOG_PATH")"
sudo touch "$MONGO_LOG_PATH"
sudo chown -R "$(whoami)":staff "$MONGO_DB_PATH" "$(dirname "$MONGO_LOG_PATH")"

# ── 3. Generate config file ───────────────────────────────────

echo ""
echo "[3/5] Writing MongoDB config → $MONGO_CONF"

sudo tee "$MONGO_CONF" > /dev/null <<CONFEOF
# MongoDB configuration – port $MONGO_PORT with auth
net:
  port: $MONGO_PORT
  bindIp: 127.0.0.1

security:
  authorization: enabled

storage:
  dbPath: $MONGO_DB_PATH

systemLog:
  destination: file
  path: $MONGO_LOG_PATH
  logAppend: true

processManagement:
  fork: false
CONFEOF

# macOS does not support mongod --fork; we use background processes instead.
# We also toggle authorization in the config file to avoid CLI parsing issues.

start_mongod_bg() {
    local conf="$1"
    nohup "$MONGO_EXEC" --config "$conf" >> "$MONGO_LOG_PATH" 2>&1 &
    local pid=$!
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "ERROR: mongod failed to start. Check $MONGO_LOG_PATH"
        return 1
    fi
    echo "  → mongod started (pid $pid)"
}

# ── 4. Create root user (with auth temporarily disabled) ─────

echo ""
echo "[4/5] Creating root user (auth temporarily disabled) …"

# Temporarily disable auth in the config
sed -i '' 's/^  authorization: enabled/  authorization: disabled/' "$MONGO_CONF"
start_mongod_bg "$MONGO_CONF"

# Create root user
echo "  → Creating root user …"
"$MONGO_BIN/mongosh" --port "$MONGO_PORT" --quiet <<JSEOF
use admin;
try {
    db.createUser({
        user: "$MONGO_ROOT_USER",
        pwd: "$MONGO_ROOT_PASSWORD",
        roles: [{ role: "root", db: "admin" }]
    });
    print("  → Root user '$MONGO_ROOT_USER' created.");
} catch(e) {
    if (e.code === 51003) {
        print("  → Root user '$MONGO_ROOT_USER' already exists.");
    } else {
        print("  → ERROR: " + e.message);
        quit(1);
    }
}
JSEOF

# ── 5. Restart with authentication enabled ────────────────────

echo ""
echo "[5/5] Restarting with authentication enabled …"

# Kill the auth-disabled instance
"$MONGO_BIN/mongosh" --port "$MONGO_PORT" --quiet --eval "db.getSiblingDB('admin').shutdownServer()" 2>/dev/null || true
sleep 1

# Re-enable auth in config
sed -i '' 's/^  authorization: disabled/  authorization: enabled/' "$MONGO_CONF"
start_mongod_bg "$MONGO_CONF"

# Verify auth is working
if "$MONGO_BIN/mongosh" \
    "mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@localhost:${MONGO_PORT}/?authSource=admin" \
    --quiet --eval "db.runCommand({connectionStatus:1})" 2>/dev/null | grep -q 'authenticatedUsers'; then
    echo "  → Authentication verified successfully."
else
    echo "  ⚠ Could not verify authentication, but mongod is running."
fi

# ── Done ──────────────────────────────────────────────────────

MONGO_URI="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@localhost:${MONGO_PORT}/?authSource=admin"
MONGO_URI_REDACTED="mongodb://${MONGO_ROOT_USER}:********@localhost:${MONGO_PORT}/?authSource=admin"

echo ""
echo "=============================================="
echo "  MongoDB setup complete!"
echo "=============================================="
echo ""
echo "  Config:   $MONGO_CONF"
echo "  DB path:  $MONGO_DB_PATH"
echo "  Log:      $MONGO_LOG_PATH"
echo ""
echo "  Root URI (SAVE THIS – it will not be shown again):"
echo "  $MONGO_URI"
echo ""
echo "  To stop:   $MONGO_BIN/mongosh --port $MONGO_PORT --eval 'db.adminCommand({shutdown:1})'"
echo "  To start:  nohup $MONGO_EXEC --config $MONGO_CONF >> $MONGO_LOG_PATH 2>&1 &"
echo ""
echo "=============================================="

# Save credentials to a protected file
CRED_FILE="$HOME/.mongodb-2700-credentials"
echo "$MONGO_URI" > "$CRED_FILE"
chmod 600 "$CRED_FILE"
echo "Credentials also saved to $CRED_FILE (chmod 600)"
