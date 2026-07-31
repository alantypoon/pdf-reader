#!/usr/bin/env python3
"""Inspect PDF streams for watermark-related content."""
import re
import zlib
import sys

filepath = sys.argv[1]
with open(filepath, 'rb') as f:
    data = f.read()

# Find all "stream...endstream" patterns
pattern = re.compile(rb'stream\s*\n(.*?)endstream', re.DOTALL)
streams = pattern.findall(data)
print(f"Total streams found: {len(streams)}")

# Try to decompress each and look for watermark markers
found = 0
for i, s in enumerate(streams):
    s = s.rstrip()
    try:
        decompressed = zlib.decompress(s)
        text = decompressed.decode('latin-1', errors='ignore')
        if any(kw in text for kw in ['PlacedPDF', 'Watermark', 'EMC', '/Figure', '/Artifact']):
            found += 1
            print(f"\n=== Stream {i} (size: {len(decompressed)} bytes) ===")
            print(text[:2000])
            if found >= 10:
                print(f"\n...(truncated after {found} interesting streams)...")
                break
    except:
        pass
print(f"\nInteresting streams: {found}")
print(f"\nObjStm references in PDF: {data.count(b'ObjStm')}")
print(f"Type/ObjStm: {data.count(b'/Type /ObjStm')} + {data.count(b'/Type/ObjStm')}")