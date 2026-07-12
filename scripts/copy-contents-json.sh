#!/bin/bash
set -euo pipefail

SRC="/var/www/html/devtest/dse/pdf-reader/_out/physics-oup-zzz"
DST="/var/www/html/devtest/dse/pdf-reader/data/physics-oup"

if [ ! -d "$SRC" ]; then
    echo "Error: Source directory does not exist: $SRC"
    exit 1
fi

if [ ! -d "$DST" ]; then
    echo "Error: Destination directory does not exist: $DST"
    exit 1
fi

echo "Copying files from $SRC to $DST ..."
cp -rf "$SRC"/* "$DST"/

echo "Done."
