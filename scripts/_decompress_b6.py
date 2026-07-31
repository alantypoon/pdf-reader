#!/usr/bin/env python3
"""Decompress the large Form XObjects from Book 6 to identify the watermark pattern."""
import re, zlib, struct

with open('/var/www/html/pdf-reader/_ref/math-oup-tn/OSM_TBPDF_601_e.pdf', 'rb') as f:
    data = f.read()

# Find ALL stream objects and try to decompress them
pat = re.compile(rb'stream\r?\n(.*?)endstream', re.DOTALL)
streams = pat.findall(data)

print(f"Total streams found: {len(streams)}")

# For each stream, decompress and check characteristics
for i, raw in enumerate(streams):
    raw = raw.rstrip()
    try:
        dec = zlib.decompress(raw)
    except:
        continue
    
    text = dec.decode('latin-1', errors='ignore')
    
    # Check for Form XObject-like content
    if len(dec) < 500 and len(dec) > 50:
        # This is a short stream - could be a watermark stamp
        print(f"\n=== Stream {i}: {len(dec)} bytes ===")
        print(text[:1000])
        
        # Check what it contains
        for kw in ['PlacedPDF', 'EMC', 'BDC', '/Figure', 'BT', 'Tj', 'TJ', 're', 'f', 'W', 'n', 'q', 'Q', 'cm', 'Do']:
            if kw in text:
                print(f"  Contains: {kw}")

# Also look for specific patterns in the larger streams
print("\n\n=== Looking for larger Form XObjects with repetitive patterns ===")
for i, raw in enumerate(streams):
    raw = raw.rstrip()
    try:
        dec = zlib.decompress(raw)
    except:
        continue
    
    text = dec.decode('latin-1', errors='ignore')
    
    # Look for streams with many 're' (rectangle) or 'm' (move) operators - 
    # could indicate a tiled watermark pattern
    re_count = text.count(' re ')
    if re_count > 5:
        print(f"\nStream {i} ({len(dec)} bytes): {re_count} rectangle ops")
        print(f"  First 300: {text[:300]}")