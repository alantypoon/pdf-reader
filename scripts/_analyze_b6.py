#!/usr/bin/env python3
import re, zlib

with open('/var/www/html/pdf-reader/_ref/math-oup-tn/OSM_TBPDF_601_e.pdf', 'rb') as f:
    data = f.read()

# Find all streams
pat = re.compile(rb'stream\r?\n(.*?)endstream', re.DOTALL)
streams = pat.findall(data)

print(f"Total streams: {len(streams)}")

# Decompress and look for large Form XObjects
for i, s in enumerate(streams):
    raw = s.rstrip()
    try:
        dec = zlib.decompress(raw)
    except:
        continue
    text = dec.decode('latin-1', errors='ignore')
    
    # Check for Form XObjects
    for m in re.finditer(r'/BBox\s*\[([^\]]+)\]', text):
        parts = [float(x) for x in m.group(1).split()]
        if len(parts) != 4:
            continue
        w = abs(parts[2] - parts[0])
        h = abs(parts[3] - parts[1])
        area = w * h
        
        # Page area for 1190x772 ~ 918680
        pct = area / 918680 * 100
        
        if area > 400000:  # >43% of page - potential watermark
            print(f"\nStream {i}: LARGE Form BBox={m.group(1).decode()}, area={area:.0f} ({pct:.0f}%)")
            # Show first 1500 chars of the stream content
            print(f"  Content preview: {text[:1500]}")
            
            # Check key properties
            has_placedpdf = 'PlacedPDF' in text
            has_emc = 'EMC' in text
            has_bdc = 'BDC' in text
            
            # Find colors
            rg = re.findall(r'([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg', text)
            scn = re.findall(r'([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+scn', text)
            k_vals = re.findall(r'([\d.]+)\s+[kK]', text)
            g_vals = re.findall(r'([\d.]+)\s+g', text)
            
            print(f"  PlacedPDF={has_placedpdf}, EMC={has_emc}, BDC={has_bdc}")
            print(f"  rg colors: {rg[:5]}")
            print(f"  scn colors: {scn[:5]}")
            print(f"  K colors: {k_vals[:5]}")
            print(f"  g gray: {g_vals[:5]}")
            
            # Check for text operators
            has_tj = 'Tj' in text
            has_TJ = 'TJ' in text
            print(f"  Text ops: Tj={has_tj}, TJ={has_TJ}")