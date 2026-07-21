#!/bin/bash
npm install

rm -rf dist/assets
rm -rf public/assets

npm run build

# Inject polyfills into the PDF worker (runs in Web Worker context, separate from main thread)
WORKER_FILE=$(ls dist/assets/pdf.worker.min-*.mjs dist/assets/pdf.worker.min-*.js 2>/dev/null | head -1)
if [ -n "$WORKER_FILE" ]; then
  POLYFILLS="if(!URL.parse){URL.parse=(u,b)=>{try{return new URL(u,b)}catch{return null}};}if(!Promise.try){Promise.try=fn=>new Promise(r=>r(fn()));}"
  echo "$POLYFILLS" | cat - "$WORKER_FILE" > "${WORKER_FILE}.tmp" && mv "${WORKER_FILE}.tmp" "$WORKER_FILE"
  echo "=== Polyfills injected into $WORKER_FILE ==="
fi

echo "=== dist/index.html ==="
cat dist/index.html

echo "=== Syncing dist/ → public/ ==="
cp dist/index.html public/index.html
mkdir -p public/assets
cp dist/assets/*.js dist/assets/*.css public/assets/ 2>/dev/null
# Remove stale assets not in current dist
for f in public/assets/*.js public/assets/*.css; do
  base=$(basename "$f")
  if [ ! -f "dist/assets/$base" ]; then
    rm -f "$f"
    echo "Removed stale: public/assets/$base"
  fi
done
echo "=== Sync complete ==="