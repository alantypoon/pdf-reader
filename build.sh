#!/bin/bash
npm install
npm run build

echo "=== dist/index.html ==="
cat dist/index.html