#!/usr/bin/env python3
"""
Comprehensive diagnostic: compare book 4A vs book 6 watermark structures.
Usage: python3 _diag_book6.py
"""
import pikepdf
import re
import sys
import os

REF_DIR = "/var/www/html/pdf-reader/_ref/math-oup-tn"
BOOK4A = os.path.join(REF_DIR, "OSM_TBPDF_4A01_e.pdf")
BOOK6 = os.path.join(REF_DIR, "OSM_TBPDF_601_e.pdf")

def read_page_text(page):
    contents = page.get("/Contents")
    if contents is None:
        return ""
    if isinstance(contents, pikepdf.Array):
        streams = list(contents)
    else:
        streams = [contents]
    all_data = b""
    for s in streams:
        try:
            all_data += s.read_bytes()
        except Exception:
            pass
    try:
        return all_data.decode("latin-1")
    except Exception:
        return ""

def page_area(pdf):
    page0 = pdf.pages[0]
    mb = page0.get("/MediaBox", None)
    if mb is None or len(mb) != 4:
        return 612, 792, 612 * 792
    w = abs(float(mb[2]) - float(mb[0]))
    h = abs(float(mb[3]) - float(mb[1]))
    return w, h, w * h

def analyze_pdf(label, path):
    print(f"\n{'='*80}")
    print(f"ANALYZING: {label}")
    print(f"FILE: {path}")
    print(f"{'='*80}")

    if not os.path.exists(path):
        print(f"  FILE NOT FOUND!")
        return {}

    pdf = pikepdf.open(path)
    pw, ph, pa = page_area(pdf)
    total = len(pdf.pages)
    print(f"  Pages: {total}")
    print(f"  Page size: {pw:.1f} x {ph:.1f} (area={pa:.0f})")

    # --- Collect Form XObject stats ---
    form_stats = {}
    all_post_emc_forms = set()

    for page_num, page in enumerate(pdf.pages, start=1):
        xobj_dict = page.get("/Resources", {}).get("/XObject", {})
        for name, obj in xobj_dict.items():
            try:
                subtype = str(obj.get("/Subtype", ""))
            except Exception:
                continue
            if subtype != "/Form":
                continue

            bbox = obj.get("/BBox", None)
            if bbox is None or len(bbox) != 4:
                continue

            w = abs(float(bbox[2]) - float(bbox[0]))
            h = abs(float(bbox[3]) - float(bbox[1]))
            area_pct = (w * h) / pa * 100 if pa > 0 else 0

            try:
                data = obj.read_bytes()
            except Exception:
                data = b""

            has_placedpdf = b"/PlacedPDF" in data
            wraps_other = bool(re.search(rb"/[Ff]m\d+\s+Do", data))
            has_text = b"Tj" in data or b"TJ" in data
            has_image = bool(re.search(rb"/Im\d+\s+Do", data))

            is_pure_placedpdf_stamp = False
            if has_placedpdf:
                try:
                    text = data.decode("latin-1", errors="ignore")
                    m = re.search(r"/PlacedPDF\s*[^E]+BDC\s*.*?EMC", text, re.DOTALL)
                    if m and len(text) > 0 and (len(m.group()) / len(text)) > 0.95:
                        is_pure_placedpdf_stamp = True
                except:
                    pass

            is_near_white = False
            near_white_rgb = None
            if not has_placedpdf and not has_text and not has_image and not wraps_other:
                m = re.search(rb"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:scn|rg)", data)
                if m:
                    try:
                        vals = [float(x) for x in m.groups()]
                        if min(vals) >= 0.85:
                            is_near_white = True
                            near_white_rgb = vals
                    except:
                        pass

            key = str(name)
            if key not in form_stats:
                form_stats[key] = {
                    "name": key,
                    "area_pct": area_pct,
                    "bbox": list(bbox),
                    "pages": set(),
                    "stream_size": len(data),
                    "placedpdf": has_placedpdf,
                    "pure_placedpdf_stamp": is_pure_placedpdf_stamp,
                    "wraps_other": wraps_other,
                    "has_text": has_text,
                    "has_image": has_image,
                    "is_near_white": is_near_white,
                    "near_white_rgb": near_white_rgb,
                    "stream_head": data[:300],
                }
            form_stats[key]["pages"].add(page_num)

        text = read_page_text(page)
        last_emc = text.rfind("EMC")
        if last_emc > 0:
            after = text[last_emc:]
            fm_draws = re.findall(r"/([Ff]m\d+)\s+Do", after)
            for fm in fm_draws:
                all_post_emc_forms.add(fm)

    print(f"\n  --- Form XObjects ({len(form_stats)} distinct) ---")
    for name in sorted(form_stats.keys(), key=lambda n: (form_stats[n]["area_pct"], n), reverse=True):
        info = form_stats[name]
        page_count = len(info["pages"])
        page_pct = page_count / total * 100 if total > 0 else 0
        bbox_str = f"[{info['bbox'][0]:.0f} {info['bbox'][1]:.0f} {info['bbox'][2]:.0f} {info['bbox'][3]:.0f}]"
        flags = []
        if info["placedpdf"]:
            flags.append("PlacedPDF")
        if info["pure_placedpdf_stamp"]:
            flags.append("PURE_STAMP")
        if info["wraps_other"]:
            flags.append("WRAPS_OTHER")
        if info["has_text"]:
            flags.append("TEXT")
        if info["has_image"]:
            flags.append("IMAGE")
        if info["is_near_white"]:
            flags.append(f"NEAR_WHITE({info['near_white_rgb']})")
        flag_str = " ".join(flags) if flags else "(none)"

        print(f"    /{name}: area={info['area_pct']:.1f}% bbox={bbox_str} "
              f"size={info['stream_size']}B pages={page_count}/{total} ({page_pct:.0f}%) "
              f"flags=[{flag_str}]")

    print(f"\n  --- Strategy Simulation ---")

    s1 = {n for n, i in form_stats.items() if i["placedpdf"] and i["pure_placedpdf_stamp"] and i["area_pct"] > 50}
    print(f"  Strategy 1 (PlacedPDF pure stamp >50%): MATCHES = {sorted(s1) if s1 else 'NONE'}")

    post_emc_count = 0
    compact_count = 0
    for page in pdf.pages:
        text = read_page_text(page)
        if not text:
            continue
        last_emc = text.rfind("EMC")
        if last_emc > 0:
            if re.search(r"/[Ff]m\d+\s+Do", text[last_emc:]):
                post_emc_count += 1
        blocks = re.findall(r"/PlacedPDF\s+/MC\d+\s+BDC\s+.*?EMC", text, re.DOTALL)
        compact = [b for b in blocks if len(b) < 5000]
        if compact:
            compact_count += 1
    print(f"  Strategy 2a (post-EMC): {post_emc_count}/{total} pages ({post_emc_count/total*100:.0f}%) — threshold=50%")
    print(f"  Strategy 2b (compact PlacedPDF): {compact_count}/{total} pages ({compact_count/total*100:.0f}%) — threshold=30%")

    artifact_count = 0
    for page in pdf.pages:
        text = read_page_text(page)
        if re.search(r"/Artifact\s*<<.*?/Subtype\s*/\s*Watermark", text):
            artifact_count += 1
    print(f"  Strategy 3 (/Artifact/Watermark): {artifact_count}/{total} pages ({artifact_count/total*100:.0f}%) — threshold=50%")

    near_white_count = 0
    for page in pdf.pages:
        xobj_dict = page.get("/Resources", {}).get("/XObject", {})
        for _, obj in xobj_dict.items():
            try:
                if str(obj.get("/Subtype", "")) != "/Form":
                    continue
                bbox = obj.get("/BBox", None)
                if bbox is None or len(bbox) != 4:
                    continue
                w = abs(float(bbox[2]) - float(bbox[0]))
                h = abs(float(bbox[3]) - float(bbox[1]))
                if (w * h) / pa * 100 <= 50:
                    continue
                data = obj.read_bytes()
                if b"/PlacedPDF" in data:
                    continue
                if b"Tj" in data or b"TJ" in data:
                    continue
                if re.search(rb"/[Ff]m\d+\s+Do", data):
                    continue
                if re.search(rb"/Im\d+\s+Do", data):
                    continue
                m = re.search(rb"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:scn|rg)", data)
                if m:
                    vals = [float(x) for x in m.groups()]
                    if min(vals) >= 0.85:
                        near_white_count += 1
                        break
            except:
                pass
    print(f"  Strategy 4 (near-white large form): {near_white_count}/{total} pages ({near_white_count/total*100:.0f}%) — threshold=50%")

    print(f"\n  --- Post-EMC Form Draws (across all pages) ---")
    if all_post_emc_forms:
        for fm in sorted(all_post_emc_forms):
            print(f"    /{fm}")
    else:
        print(f"    NONE")

    text = read_page_text(pdf.pages[0])
    last_emc = text.rfind("EMC")
    print(f"\n  --- Page 1 content analysis ---")
    print(f"    Total content length: {len(text)} chars")
    print(f"    EMC count: {text.count('EMC')}")
    print(f"    PlacedPDF count: {text.count('/PlacedPDF')}")
    if last_emc > 0:
        after = text[last_emc:]
        print(f"    Last EMC position: {last_emc}")
        print(f"    After last EMC: {len(after)} chars")
        print(f"    After last EMC (first 500 chars):")
        print(f"    {after[:500]}")
    else:
        print(f"    No EMC found!")

    print(f"\n  --- PDF Metadata ---")
    try:
        info = pdf.trailer.get("/Info", {})
        if info:
            producer = str(info.get("/Producer", "N/A"))
            print(f"    Producer: {producer}")
    except:
        pass

    pdf.close()
    return {
        "form_stats": form_stats,
        "post_emc_count": post_emc_count,
        "compact_count": compact_count,
        "artifact_count": artifact_count,
        "near_white_count": near_white_count,
        "total": total,
        "s1_matches": s1,
    }

if __name__ == "__main__":
    r4a = analyze_pdf("Book 4A (works)", BOOK4A)
    r6 = analyze_pdf("Book 6 (fails)", BOOK6)

    print(f"\n{'='*80}")
    print("SUMMARY / ROOT CAUSE ANALYSIS")
    print(f"{'='*80}")

    print(f"\n  Book 4A: S1={sorted(r4a['s1_matches']) if r4a['s1_matches'] else 'NONE'}, "
          f"S2a={r4a['post_emc_count']}/{r4a['total']}, S2b={r4a['compact_count']}/{r4a['total']}, "
          f"S3={r4a['artifact_count']}/{r4a['total']}, S4={r4a['near_white_count']}/{r4a['total']}")

    print(f"  Book 6:  S1={sorted(r6['s1_matches']) if r6['s1_matches'] else 'NONE'}, "
          f"S2a={r6['post_emc_count']}/{r6['total']}, S2b={r6['compact_count']}/{r6['total']}, "
          f"S3={r6['artifact_count']}/{r6['total']}, S4={r6['near_white_count']}/{r6['total']}")

    issues = []
    if not r4a['s1_matches'] and not r6['s1_matches']:
        issues.append("- Both books fail Strategy 1 (no pure PlacedPDF stamp)")
    if r4a['post_emc_count'] >= r4a['total'] * 0.5 and r6['post_emc_count'] < r6['total'] * 0.5:
        issues.append(f"- CRITICAL: Book 4A passes S2a ({r4a['post_emc_count']} >= {r4a['total']*0.5:.0f}), "
                      f"Book 6 FAILS ({r6['post_emc_count']} < {r6['total']*0.5:.0f})")
    if r4a['compact_count'] >= r4a['total'] * 0.3 and r6['compact_count'] < r6['total'] * 0.3:
        issues.append(f"- CRITICAL: Book 4A passes S2b ({r4a['compact_count']} >= {r4a['total']*0.3:.0f}), "
                      f"Book 6 FAILS ({r6['compact_count']} < {r6['total']*0.3:.0f})")

    if not issues:
        issues.append("- Both books trigger the same strategy — investigate further")

    print("\n  Key Differences:")
    for i in issues:
        print(f"  {i}")