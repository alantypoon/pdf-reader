#!/usr/bin/env python3
"""Quick check: decompress the large Form XObjects in book 6."""
import re, zlib, sys

PDF = '/var/www/html/pdf-reader/_ref/math-oup-tn/OSM_TBPDF_601_e.pdf'

with open(PDF, 'rb') as f:
    data = f.read()

pat = re.compile(rb'stream\r?\n(.*?)endstream', re.DOTALL)
streams = pat.findall(data)

print(f"Total streams: {len(streams)}")

# Find the two full-page form streams (around 224 bytes)
for i, raw in enumerate(streams):
    raw = raw.rstrip()
    try:
        dec = zlib.decompress(raw)
    except:
        continue
    
    text = dec.decode('latin-1', errors='ignore')
    
    # Check for the specific BBox values that span the full page
    if ('0 TL' in text and 'Do' in text) or len(dec) < 500:
        print(f"\nStream {i}: {len(raw)}->{len(dec)} bytes")
        print(repr(text[:500]))
        print()