#!/bin/bash
set -euo pipefail

HTPASSWD_FILE="/etc/nginx/.htpasswd_dse"

if [ $# -ne 2 ]; then
    echo "Usage: $0 <username> <password>"
    exit 1
fi

USERNAME="$1"
PASSWORD="$2"

# Check if user already exists
if sudo grep -q "^${USERNAME}:" "$HTPASSWD_FILE" 2>/dev/null; then
    echo "User '${USERNAME}' already exists. Remove the existing entry first or use a different username."
    exit 1
fi

# Generate bcrypt hash using PHP
HASH=$(php8.3 -r "echo password_hash('$PASSWORD', PASSWORD_BCRYPT);")

# Append to htpasswd file
echo "${USERNAME}:${HASH}" | sudo tee -a "$HTPASSWD_FILE" > /dev/null

echo "User '${USERNAME}' added successfully to $HTPASSWD_FILE"
