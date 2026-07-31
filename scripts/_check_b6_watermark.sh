#!/bin/bash
# Check Book 6 watermark pattern
set -e

PDF="/var/www/html/pdf-reader/_ref/math-oup-tn/OSM_TBPDF_601_e.pdf"

echo "=== PDF Info ==="
ls -la "$PDF"
echo ""

echo "=== Strings analysis ==="
echo "EMC count: $(strings "$PDF" | grep -c 'EMC')"
echo "PlacedPDF: $(strings "$PDF" | grep -c 'PlacedPDF')"  
echo "Watermark: $(strings "$PDF" | grep -c 'Watermark')"
echo "Artifact:  $(strings "$PDF" | grep -c 'Artifact')"
echo ""

echo "=== Large Form XObjects (BBox area > 50% page) ==="
strings "$PDF" | grep -oP '/BBox\[[^\]]+\]' | while read bbox; do
    vals=($(echo "$bbox" | grep -oP '[-.\d]+'))
    if [ ${#vals[@]} -eq 4 ]; then
        w=$(python3 -c "print(abs(${vals[2]} - ${vals[0]}))")
        h=$(python3 -c "print(abs(${vals[3]} - ${vals[1]}))")
        area=$(python3 -c "print($w * $h)")
        pct=$(python3 -c "print(int($area / 918680 * 100))")
        if [ "$area" -gt 400000 ]; then
            echo "  $bbox -> ${w}x${h} = area $area ($pct%)"
        fi
    fi
done

echo ""
echo "=== PDF Metadata ==="
python3 -c "
import sys
# Try to use pdftotext for metadata
import subprocess
result = subprocess.run(['pdftotext', '$PDF', '-', '-l', '1'], capture_output=True, text=True)
print('Page 1 text (first 500 chars):')
print(result.stdout[:500])
" 2>/dev/null || echo "pdftotext not available"

echo ""
echo "=== Decompress first few streams ==="
python3 -c "
import re, zlib
with open('$PDF', 'rb') as f:
    data = f.read()
pat = re.compile(rb'stream\r?\n(.*?)endstream', re.DOTALL)
streams = pat.findall(data)
print(f'Found {len(streams)} streams')
for i, s in enumerate(streams):
    s = s.rstrip()
    try:
        dec = zlib.decompress(s)
    except:
        continue
    if len(dec) < 500 and len(dec) > 30:
        text = dec.decode('latin-1', errors='ignore')
        print(f'Stream {i}: {len(dec)} bytes')
        print(text[:600])
        print('---')
    if i > 100:
        break
"