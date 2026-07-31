#!/usr/bin/env python3
"""Compare PDF structures to find why book 6 watermark detection fails."""
import re, zlib, sys

filepath = sys.argv[1]
with open(filepath, 'rb') as f:
    data = f.read()

print(f"File: {sys.argv[1]}")
print(f"Size: {len(data)} bytes")

# Find all stream objects
stream_pattern = re.compile(rb'stream\r?\n(.*?)endstream', re.DOTALL)
streams = []
for m in stream_pattern.finditer(data):
    raw = m.group(1)
    try:
        dec = zlib.decompress(raw.rstrip())
        streams.append(dec)
    except:
        streams.append(raw)

print(f"Total streams: {len(streams)}")
print(f"Decompressible: {sum(1 for s in streams if isinstance(s, bytes))}")

# Look for watermark-related text in de-duplicated content
all_keywords = {}
for s in streams:
    try:
        text = s.decode('latin-1', errors='ignore') if isinstance(s, bytes) else str(s)
    except:
        continue
    for kw in ['PlacedPDF', 'EMC', 'Watermark', 'Artifact', '/Figure', 'BDC']:
        if kw in text:
            all_keywords[kw] = all_keywords.get(kw, 0) + text.count(kw)

print("\nKeyword counts across all streams:")
for kw, count in sorted(all_keywords.items()):
    print(f"  {kw}: {count}")

# Check for Form XObjects in streams
form_count = 0
large_form_count = 0
for s in streams:
    try:
        text = s.decode('latin-1', errors='ignore') if isinstance(s, bytes) else str(s)
    except:
        continue
    for m in re.finditer(r'/BBox\s*\[([^\]]+)\]', text):
        parts = [float(x) for x in m.group(1).split()]
        if len(parts) == 4:
            w = abs(parts[2] - parts[0])
            h = abs(parts[3] - parts[1])
            form_count += 1
            if w * h > 250000:  # >50% of ~612*792 page
                large_form_count += 1

print(f"\nForm XObjects (by BBox ref): {form_count}")
print(f"Large Form XObjects (>250K area): {large_form_count}")

# Find all color operations (potential watermark colors)
for s in streams:
    try:
        text = s.decode('latin-1', errors='ignore') if isinstance(s, bytes) else str(s)
    except:
        continue
    rg_colors = re.findall(r'([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg', text)
    if rg_colors:
        # Only show near-white colors (all components >= 0.85)
        near_white = [(r,g,b) for r,g,b in rg_colors if float(r)>=0.85 and float(g)>=0.85 and float(b)>=0.85]
        if near_white:
            print(f"\nNear-white RGB colors: {near_white[:10]}")
            break