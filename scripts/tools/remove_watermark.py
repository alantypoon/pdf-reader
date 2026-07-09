#!/usr/bin/env python3
"""
Remove watermarks from OUP textbook PDFs.

Supports both English and Chinese editions with automatic watermark detection:

  English editions — watermarks are Form XObjects containing "/PlacedPDF"
                      that span most of the page (InDesign stamp pattern).

  Chinese editions — watermarks are Form XObjects drawn a second time
                      after the final "EMC" marker on each page.  The
                      script detects this pattern and strips all content
                      after the last EMC.

Usage:
    python3 remove_watermark.py input.pdf output.pdf [--watermark template.pdf]
"""

import pikepdf
import re
import sys
import os


def _page_area(pdf):
    """Return (width, height, area) of the first page."""
    page0 = pdf.pages[0]
    mb = page0.get("/MediaBox", None)
    if mb is None or len(mb) != 4:
        return 612, 792, 612 * 792
    w = abs(float(mb[2]) - float(mb[0]))
    h = abs(float(mb[3]) - float(mb[1]))
    return w, h, w * h


def _read_page_text(page):
    """Read and concatenate all content streams of a page into one string."""
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


def build_template_regex(template_pdf_path):
    """
    Read the watermark template PDF and build a regex that matches the
    watermark pattern on any page.

    The template PDF contains a pure watermark: a /Figure … BDC block that
    may include /PlacedPDF … BDC.  We extract the structural fingerprint:
      /Figure … BDC [/PlacedPDF … BDC] … EMC

    The returned regex matches any such block, regardless of the specific
    XObject / resource names used.
    """
    tmpl = pikepdf.open(template_pdf_path)
    tmpl_text = _read_page_text(tmpl.pages[0])
    tmpl.close()

    if not tmpl_text:
        return None

    # Check which structural pattern the template uses
    has_placedpdf = "/PlacedPDF" in tmpl_text

    if has_placedpdf:
        # English-edition pattern: /Figure … BDC /PlacedPDF … BDC … EMC
        # Use \s* (not \s+) because some PDFs have no space: /Figure/R11 BDC
        pattern = r"/Figure\s*[^E]+BDC\s*/PlacedPDF\s*[^E]+BDC\s*.*?EMC"
    else:
        # Chinese-edition pattern: /Figure … BDC … EMC
        pattern = r"/Figure\s*[^E]+BDC\s*.*?EMC"

    return re.compile(pattern, re.DOTALL)


def find_watermark_xobjects(pdf):
    """
    Find Form XObjects that are watermarks.
    Uses two strategies:
      1.  Form XObjects whose stream contains "/PlacedPDF" AND whose BBox
          covers >50% of the page area.  (English-edition pattern)
      2.  Form XObjects whose BBox covers >80% of the page area AND appear
          on ≥40% of pages.  (Chinese-edition pattern)
    """
    pw, ph, page_area = _page_area(pdf)
    total = len(pdf.pages)

    # Collect stats
    form_stats = {}  # name → {area_pct, pages:set, placedpdf:bool}

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
            area_pct = (w * h) / page_area * 100 if page_area > 0 else 0

            has_placedpdf = False
            wraps_other = False
            try:
                data = obj.read_bytes()
                has_placedpdf = b"/PlacedPDF" in data
                # Check if this XObject re-draws another XObject (wrapper pattern)
                wraps_other = bool(re.search(rb"/[Ff]m\d+\s+Do", data))
            except Exception:
                pass

            key = str(name)
            if key not in form_stats:
                form_stats[key] = {
                    "area_pct": area_pct,
                    "pages": set(),
                    "placedpdf": has_placedpdf,
                    "wraps_other_xobj": wraps_other,
                }
            form_stats[key]["pages"].add(page_num)

    # Strategy 1: PlacedPDF + >50% page area (English-edition pattern)
    watermarks = set()
    for name, info in form_stats.items():
        if info["placedpdf"] and info["area_pct"] > 50:
            watermarks.add(name)

    # Strategy 2 (Chinese editions): if most pages have a Form XObject drawn
    # after the final EMC, strip *all* post-EMC content indiscriminately.
    # Chinese-edition watermarks always appear after EMC, while real content
    # lives inside the /Figure … /PlacedPDF BDC block.
    if not watermarks:
        post_emc_count = 0
        for page in pdf.pages:
            contents = page.get("/Contents")
            if contents is None:
                continue
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
                text = all_data.decode("latin-1")
            except Exception:
                continue
            last_emc = text.rfind("EMC")
            if last_emc > 0:
                after = text[last_emc:]
                if re.search(r"/[Ff]m\d+\s+Do", after):
                    post_emc_count += 1

        if post_emc_count >= total * 0.5:
            watermarks = {"__ALL_POST_EMC__"}

    return watermarks


def remove_watermarks(pdf_path, output_path, template_regex=None):
    pdf = pikepdf.open(pdf_path)

    is_template_mode = template_regex is not None

    if is_template_mode:
        # Template provided — use it exclusively, skip auto-detection
        watermark_names = {"__TEMPLATE__"}
        print("  Using watermark template for detection.")
    else:
        # Auto-detect watermark type
        watermark_names = find_watermark_xobjects(pdf)
        if not watermark_names:
            print("  No watermark XObjects found — skipping.")
            pdf.close()
            return False
        print(f"  Watermark XObjects detected: {sorted(watermark_names)}")

    is_post_emc_mode = "__ALL_POST_EMC__" in watermark_names

    if is_post_emc_mode:
        print("  (using post-EMC strip mode — all content after final EMC removed)")

    patterns_to_remove = []

    if is_template_mode:
        # Only the template regex — nothing else
        patterns_to_remove.append(template_regex)

        # Check first page: if template matches >80% of content, it's
        # consuming the main content, not just the watermark.  Fall back
        # to auto-detection for this PDF.
        first_page = pdf.pages[0]
        first_text = _read_page_text(first_page)
        m = template_regex.search(first_text)
        if m and len(m.group()) > len(first_text) * 0.8:
            # Template matches most of the page.  Check whether a
            # post-EMC watermark also exists — if so, the template
            # matched main content and we should fall back to auto-
            # detection.  If no post-EMC watermark, the template
            # IS the watermark and we remove it directly.
            last_emc = first_text.rfind("EMC")
            has_post_emc = False
            if last_emc > 0:
                after = first_text[last_emc:]
                if re.search(r"/[Ff]m\d+\s+Do", after):
                    has_post_emc = True

            if has_post_emc:
                print("  (template matches entire page, post-EMC watermark found — switching to auto-detection)")
                patterns_to_remove.clear()
                is_template_mode = False
                watermark_names = find_watermark_xobjects(pdf)
                if not watermark_names:
                    print("  No watermark XObjects found — skipping.")
                    pdf.close()
                    return False
                print(f"  Watermark XObjects detected: {sorted(watermark_names)}")
                is_post_emc_mode = "__ALL_POST_EMC__" in watermark_names
                if is_post_emc_mode:
                    print("  (using post-EMC strip mode)")
                elif watermark_names:
                    for wm_name in watermark_names:
                        escaped = re.escape(wm_name)
                        patterns_to_remove.append(
                            r"/Figure[^q]*?q\s+.*?" + escaped + r"\s+Do\s+EMC\s+Q"
                        )
                        patterns_to_remove.append(
                            r"q\s+.*?" + escaped + r"\s+Do\s+Q"
                        )
    elif not is_post_emc_mode:
        for wm_name in watermark_names:
            escaped = re.escape(wm_name)
            patterns_to_remove.append(
                r"/Figure/R\d+\s+BDC\s+q\s+.*?" + escaped + r"\s+Do\s+EMC\s+Q"
            )
            patterns_to_remove.append(
                r"q\s+.*?" + escaped + r"\s+Do\s+Q"
            )

    pages_modified = 0
    total_pages = len(pdf.pages)
    for page_num, page in enumerate(pdf.pages, start=1):
        contents = page.get("/Contents")
        if contents is None:
            continue

        # Concatenate ALL content streams into one text blob
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
            text = all_data.decode("latin-1")
        except Exception:
            continue

        modified = False
        for pattern in patterns_to_remove:
            if isinstance(pattern, re.Pattern):
                new_text, n = pattern.subn("", text)
            else:
                new_text, n = re.subn(pattern, "", text, flags=re.DOTALL)
            if n > 0:
                text = new_text
                modified = True

        # Post-EMC strip (only in non-template post-EMC mode)
        if is_post_emc_mode and not is_template_mode:
            # Find the double-EMC that closes the main content block,
            # then remove only the watermark q…/FmX Do…Q blocks after it.
            double_emc = text.rfind("EMC")
            if double_emc > 0:
                # Find the start of double EMC: "EMC \nEMC"
                # Search backwards from the last EMC
                before_last = text.rfind("EMC", 0, double_emc)
                if before_last > 0 and before_last < double_emc - 1:
                    # We have a double EMC.  Now find the Q that closes
                    # the main block (it's between the EMCs and the watermark).
                    between = text[before_last:double_emc + 3]
                    q_after = re.search(r"Q\s+", text[double_emc + 3:])
                    if q_after:
                        post_start = double_emc + 3 + q_after.end()
                        post_content = text[post_start:]
                        # Remove q…/FmX Do…Q blocks from post content
                        cleaned_post, n = re.subn(
                            r"q\s+.*?/[Ff]m\d+\s+Do\s+Q\s*",
                            "",
                            post_content,
                            flags=re.DOTALL,
                        )
                        if n > 0:
                            text = text[:post_start] + cleaned_post
                            modified = True

        if modified:
            # Write everything back to the first stream, clear the rest
            encoded = text.encode("latin-1")
            streams[0].write(encoded)
            for s in streams[1:]:
                s.write(b"")
            pages_modified += 1

        # Progress indicator every 10 pages (or every page for small docs)
        if total_pages <= 20 or page_num % 10 == 0 or page_num == total_pages:
            print(f"  … page {page_num}/{total_pages}", flush=True)

    print(f"  Modified {pages_modified}/{len(pdf.pages)} pages.")

    pdf.save(output_path)
    pdf.close()
    return True


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <input.pdf> <output.pdf> [--watermark template.pdf]",
              file=sys.stderr)
        sys.exit(1)

    # Parse optional --watermark argument
    args = sys.argv[1:]
    template_path = None
    if "--watermark" in args:
        idx = args.index("--watermark")
        if idx + 1 < len(args):
            template_path = args[idx + 1]
            args.pop(idx)  # remove --watermark
            args.pop(idx)  # remove the path
        else:
            print("ERROR: --watermark requires a path", file=sys.stderr)
            sys.exit(1)

    if len(args) < 2:
        print(f"Usage: {sys.argv[0]} <input.pdf> <output.pdf> [--watermark template.pdf]",
              file=sys.stderr)
        sys.exit(1)

    in_path = args[0]
    out_path = args[1]

    if not os.path.exists(in_path):
        print(f"ERROR: File not found: {in_path}", file=sys.stderr)
        sys.exit(1)

    # Build template regex if watermark template provided
    template_regex = None
    if template_path:
        if not os.path.exists(template_path):
            print(f"ERROR: Watermark template not found: {template_path}", file=sys.stderr)
            sys.exit(1)
        print(f"  Loading watermark template: {template_path}")
        template_regex = build_template_regex(template_path)
        if template_regex is None:
            print("  ERROR: Could not build regex from template", file=sys.stderr)
            sys.exit(1)

    ok = remove_watermarks(in_path, out_path, template_regex)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
