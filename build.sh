#!/bin/bash
npm install
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