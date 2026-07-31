import re, zlib, sys

with open(sys.argv[1], 'rb') as f:
    data = f.read()

# Find all ObjStm objects
pattern = re.compile(rb'(\d+)\s+(\d+)\s+obj\s*<<.*?/Type\s*/\s*ObjStm.*?>>\s*stream\s*\n(.*?)endstream', re.DOTALL)

total_streams = 0
interesting = 0

for m in pattern.finditer(data):
    total_streams += 1
    obj_num = m.group(1).decode()
    stream_data = m.group(3).rstrip(b'\n').rstrip()
    try:
        decompressed = zlib.decompress(stream_data)
        text = decompressed.decode('latin-1', errors='ignore')
        if 'PlacedPDF' in text or 'Watermark' in text or 'EMC' in text or '/Figure' in text or '/Artifact' in text:
            interesting += 1
            print(f"=== ObjStm {obj_num} (size: {len(decompressed)}) ===")
            print(text[:2000])
            print()
            if interesting >= 10:
                print(f"...(truncated after {interesting} interesting streams)...")
                break
    except:
        pass

print(f"\nTotal ObjStm: {total_streams}, interesting: {interesting}")