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


class WatermarkRemovalError(Exception):
    """Raised when one or more pages still contain a watermark after
    all removal strategies have been applied."""
    pass


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


def _find_compact_placedpdf_markers(page_text):
    """
    Find small `/PlacedPDF /MCx BDC ... EMC` blocks embedded directly in a
    page content stream.

    Some math teacher-note PDFs wrap the full page content in one large
    `/PlacedPDF` block, then append additional compact `/PlacedPDF` marker
    blocks for overlay widgets. Those compact blocks are the watermark/help
    markers that should be removed, while the main full-page block must be
    preserved.
    """
    blocks = []
    pattern = re.compile(r"/PlacedPDF\s+/MC\d+\s+BDC\s+.*?EMC", re.DOTALL)
    for match in pattern.finditer(page_text):
        block = match.group(0)
        if len(block) < 5000:
            blocks.append(block)
    return blocks


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
      1.  Form XObjects whose stream contains "/PlacedPDF", whose BBox
          covers >50% of the page area, AND whose entire content stream
          is consumed by the /PlacedPDF …EMC block (i.e. the form IS the
          watermark stamp, not real content that merely embeds an image
          tagged /PlacedPDF).  (English-edition pattern)
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
            is_pure_placedpdf_stamp = False
            try:
                data = obj.read_bytes()
                has_placedpdf = b"/PlacedPDF" in data
                # Check if this XObject re-draws another XObject (wrapper pattern)
                wraps_other = bool(re.search(rb"/[Ff]m\d+\s+Do", data))
                if has_placedpdf:
                    # A genuine watermark stamp's *entire* content stream
                    # is the /PlacedPDF …EMC block.  Real content forms
                    # that merely embed a /PlacedPDF-tagged image alongside
                    # other drawing operations only have this block cover
                    # a fraction of the stream — those must NOT be treated
                    # as watermarks.
                    text = data.decode("latin-1", errors="ignore")
                    m = re.search(r"/PlacedPDF\s*[^E]+BDC\s*.*?EMC", text, re.DOTALL)
                    if m and len(text) > 0 and (len(m.group()) / len(text)) > 0.95:
                        is_pure_placedpdf_stamp = True
            except Exception:
                pass

            key = str(name)
            if key not in form_stats:
                form_stats[key] = {
                    "area_pct": area_pct,
                    "pages": set(),
                    "placedpdf": has_placedpdf,
                    "wraps_other_xobj": wraps_other,
                    "pure_placedpdf_stamp": is_pure_placedpdf_stamp,
                }
            form_stats[key]["pages"].add(page_num)

    # Strategy 1: PlacedPDF stamp that consumes its entire form content,
    # covering >50% of the page area (English-edition pattern)
    watermarks = set()
    for name, info in form_stats.items():
        if info["placedpdf"] and info["pure_placedpdf_stamp"] and info["area_pct"] > 50:
            watermarks.add(name)

    # Strategy 2 (Chinese editions): if most pages have a Form XObject drawn
    # after the final EMC, strip *all* post-EMC content indiscriminately.
    # Chinese-edition watermarks always appear after EMC, while real content
    # lives inside the /Figure … /PlacedPDF BDC block.
    if not watermarks:
        post_emc_count = 0
        compact_placedpdf_pages = 0
        for page in pdf.pages:
            text = _read_page_text(page)
            if not text:
                continue
            last_emc = text.rfind("EMC")
            if last_emc > 0:
                after = text[last_emc:]
                if re.search(r"/[Ff]m\d+\s+Do", after):
                    post_emc_count += 1
            if _find_compact_placedpdf_markers(text):
                compact_placedpdf_pages += 1

        if post_emc_count >= total * 0.5:
            watermarks = {"__ALL_POST_EMC__"}
        elif compact_placedpdf_pages >= total * 0.3:
            watermarks = {"__COMPACT_PLACEDPDF_MARKERS__"}

    # Strategy 3: /Artifact <</Subtype /Watermark blocks in content streams
    # (InDesign-exported OUP watermarks).  These are clearly marked in the
    # original PDF but stripped by Ghostscript, so process before unlocking.
    if not watermarks:
        artifact_count = 0
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
            # Look for /Artifact with /Subtype /Watermark
            if re.search(r"/Artifact\s*<<.*?/Subtype\s*/\s*Watermark", text):
                artifact_count += 1

        if artifact_count >= total * 0.5:
            watermarks = {"__ARTIFACT_WATERMARK__"}

    # Strategy 4: a large, near-white, purely-vector Form XObject drawn
    # directly on most pages (no /PlacedPDF tag, no text, no nested
    # image/form draws).  This is a distinct OUP watermark pattern found
    # in some biology-oup-tn files: the watermark shape/logo is tiled
    # across >50% of the page area using a near-white fill color and is
    # NOT wrapped in the /PlacedPDF or post-EMC patterns handled above.
    if not watermarks:
        if _pages_with_near_white_large_form(pdf, page_area) >= total * 0.5:
            watermarks = {"__NEAR_WHITE_LARGE_FORM__"}

    return watermarks


def _is_near_white_large_form(obj, page_area):
    """
    Return True if `obj` (a Form XObject) looks like a watermark stamp:
    covers >50% of the page area, contains no text or nested image/form
    draws, and is filled with a near-white color (all RGB components
    >= 0.85).  Used by the NEAR_WHITE_LARGE_FORM watermark strategy.
    """
    try:
        subtype = str(obj.get("/Subtype", ""))
    except Exception:
        return False
    if subtype != "/Form":
        return False

    bbox = obj.get("/BBox", None)
    if bbox is None or len(bbox) != 4:
        return False
    w = abs(float(bbox[2]) - float(bbox[0]))
    h = abs(float(bbox[3]) - float(bbox[1]))
    area_pct = (w * h) / page_area * 100 if page_area > 0 else 0
    if area_pct <= 50:
        return False

    try:
        data = obj.read_bytes()
    except Exception:
        return False

    if b"/PlacedPDF" in data:
        return False
    if b"Tj" in data or b"TJ" in data:
        return False
    if re.search(rb"/[Ff]m\d+\s+Do", data):
        return False
    if re.search(rb"/Im\d+\s+Do", data):
        return False

    m = re.search(rb"([\d.]+) ([\d.]+) ([\d.]+)\s+(?:scn|rg)", data)
    if not m:
        return False
    try:
        vals = [float(x) for x in m.groups()]
    except Exception:
        return False
    if min(vals) < 0.85:
        return False

    return True


def _pages_with_near_white_large_form(pdf, page_area):
    """Count pages that contain at least one near-white large Form XObject."""
    count = 0
    for page in pdf.pages:
        xobj_dict = page.get("/Resources", {}).get("/XObject", {})
        for _, obj in xobj_dict.items():
            if _is_near_white_large_form(obj, page_area):
                count += 1
                break
    return count


def _strip_pre_tn_form_watermark(text):
    """
    Remove the math-OUP watermark Form draw that appears immediately after an
    `EMC` marker and before teacher-note overlay content.

    Student pages end after this block, so the existing post-EMC cleanup removes
    it. Teacher-note pages append real TN content after the same block, so it is
    no longer in the final tail. The block is still identifiable by the exact
    compact wrapper used by the student PDF: optional `Q`, a single `q`, graphics
    state/color setup, `0 TL/FmX Do`, and a matching `Q`, followed by text or a
    `/PlacedPDF` teacher-note block. Do not remove Form draws that are inside a
    `/PlacedPDF` block; those are legitimate page/TN content.
    """
    pattern = re.compile(
        r"(EMC(?:(?!EMC).)*?)"
        r"(?:Q\s+)?"
        r"("
        r"(?:q\s+0\s+0\s+609\.449\s+799\.37\s+re\s+W\s+n\s+)?"
        r"q\s+"
        r"(?:0\s+Tc\s+)?"
        r"(?:0\s+Tw\s+)?"
        r"0\s+g\s+"
        r"(?:0\s+G\s+)?"
        r"(?:\d+(?:\.\d+)?\s+w\s+)?"
        r"(?:\d+(?:\.\d+)?\s+M\s+)?"
        r"(?:\d+(?:\.\d+)?\s+J\s+)?"
        r"(?:/(?:RelativeColorimetric|Perceptual)\s+ri\s+)?"
        r"(?:/GS\d+\s+gs\s+)?"
        r"0\s+TL\s*/[Ff]m\d+\s+Do\s+Q\s*"
        r"(?:Q\s*)?"
        r")"
        r"(?=(?:BT|/PlacedPDF)\b)",
        re.DOTALL,
    )

    def keep_emc_if_outside_placedpdf(match):
        prefix_since_emc = match.group(1)
        if "/PlacedPDF" in prefix_since_emc:
            return match.group(0)
        return match.group(1)

    return pattern.subn(keep_emc_if_outside_placedpdf, text)


def reveal_teaching_notes(pdf):
    """
    Some OUP teacher's-notes PDFs use AcroForm widget annotations to
    implement an interactive "key button" toggle mechanism: the actual
    teaching notes / answer content sits inside NoView-flagged widgets
    (F flag includes bit 5 → viewer skips drawing them), and a clickable
    toggle button on the page runs a /Hide JS action to flip those
    widgets visible/hidden at runtime.

    This permanently clears Hidden, Invisible and NoView flags on every
    widget that has real content (an appearance stream with data) and is
    NOT itself a toggle button (no /A action dictionary), making the notes
    and answers always visible regardless of viewer JS support.

    Returns the number of widgets revealed.
    """
    HIDDEN = 1 << 1
    INVISIBLE = 1 << 0
    NOVIEW = 1 << 5
    MASK = ~(HIDDEN | INVISIBLE | NOVIEW)

    revealed = 0
    for page in pdf.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        for annot in annots:
            flags = annot.get("/F")
            if flags is None:
                continue
            f = int(flags)
            if not (f & NOVIEW):
                continue  # already viewable — nothing to do

            # Skip toggle buttons (they have a JS /A action and are just
            # icons — revealing them adds no content and creates visual
            # clutter from orphaned show/hide button faces).
            if annot.get("/A") is not None:
                continue

            # Require a non-trivial appearance stream — widgets with an
            # empty AP are just placeholder shells.
            ap = annot.get("/AP")
            if ap is None:
                continue
            ap_n = ap.get("/N")
            if not hasattr(ap_n, "read_bytes"):
                continue
            try:
                ap_data = ap_n.read_bytes()
            except Exception:
                continue
            if len(ap_data) == 0:
                continue

            new_flags = f & MASK
            if new_flags != f:
                annot["/F"] = new_flags
                revealed += 1

    return revealed


def remove_watermarks(pdf_path, output_path, template_regex=None, reveal_notes=True):
    pdf = pikepdf.open(pdf_path)
    _pw, _ph, page_area = _page_area(pdf)

    revealed = reveal_teaching_notes(pdf) if reveal_notes else 0
    if revealed:
        print(f"  Revealed {revealed} hidden teaching-notes widget(s).")

    is_template_mode = template_regex is not None

    if is_template_mode:
        # Template provided — use it exclusively, skip auto-detection
        watermark_names = {"__TEMPLATE__"}
        print("  Using watermark template for detection.")
    else:
        # Auto-detect watermark type
        watermark_names = find_watermark_xobjects(pdf)
        if not watermark_names:
            if revealed:
                # No watermark, but we still need to persist the revealed
                # teaching-notes flags instead of leaving the caller to
                # fall back to a raw copy of the original (hidden) file.
                print("  No watermark XObjects found — saving with revealed notes only.")
                pdf.save(output_path)
                pdf.close()
                return True
            print("  No watermark XObjects found — skipping.")
            pdf.close()
            return False
        print(f"  Watermark XObjects detected: {sorted(watermark_names)}")

    is_post_emc_mode = "__ALL_POST_EMC__" in watermark_names
    is_artifact_watermark_mode = "__ARTIFACT_WATERMARK__" in watermark_names
    is_near_white_form_mode = "__NEAR_WHITE_LARGE_FORM__" in watermark_names
    is_compact_placedpdf_mode = "__COMPACT_PLACEDPDF_MARKERS__" in watermark_names

    if is_post_emc_mode:
        print("  (using post-EMC strip mode — all content after final EMC removed)")
    if is_artifact_watermark_mode:
        print("  (using artifact /Watermark strip mode — removing /Artifact /Watermark blocks)")
    if is_near_white_form_mode:
        print("  (using near-white large-form strip mode — clearing watermark XObject streams)")
    if is_compact_placedpdf_mode:
        print("  (using compact placed-PDF detection mode — preserving `/PlacedPDF` content and stripping trailing form watermarks)")

    patterns_to_remove = []

    # Build removal patterns for artifact watermark mode
    if is_artifact_watermark_mode:
        # Remove /Artifact <</Subtype /Watermark ... >>BDC ... EMC blocks
        # Pattern matches from /Artifact through the closing EMC of the block
        patterns_to_remove.append(
            r"/Artifact\s*<<[^>]*/Subtype\s*/\s*Watermark[^>]*>>\s*BDC\s*.*?EMC\s*"
        )

    # Compact `/PlacedPDF` blocks in math OUP PDFs are real page content, not
    # the watermark itself.  They are useful only as a signal that this PDF uses
    # the same trailing form-watermark pattern as the student copy.  Do not add
    # them to `patterns_to_remove`; compact mode runs the post-EMC cleanup below.

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
                is_artifact_watermark_mode = "__ARTIFACT_WATERMARK__" in watermark_names
                if is_post_emc_mode:
                    print("  (using post-EMC strip mode)")
                if is_artifact_watermark_mode:
                    print("  (using artifact /Watermark strip mode)")
                    patterns_to_remove.append(
                        r"/Artifact\s*<<[^>]*/Subtype\s*/\s*Watermark[^>]*>>\s*BDC\s*.*?EMC\s*"
                    )
                elif watermark_names:
                    for wm_name in watermark_names:
                        escaped = re.escape(wm_name)
                        patterns_to_remove.append(
                            r"/Figure[^q]*?q\s+.*?" + escaped + r"\s+Do\s+EMC\s+Q"
                        )
                        patterns_to_remove.append(
                            r"q\s+.*?" + escaped + r"\s+Do\s+(?:EMC\s+)?Q"
                        )
    elif not is_post_emc_mode and not is_artifact_watermark_mode and not is_compact_placedpdf_mode:
        for wm_name in watermark_names:
            escaped = re.escape(wm_name)
            patterns_to_remove.append(
                r"/Figure/R\d+\s+BDC\s+(?:Q\s+)?q\s+.*?" + escaped + r"\s+Do\s+EMC\s+Q"
            )
            patterns_to_remove.append(
                r"q\s+.*?" + escaped + r"\s+Do\s+(?:EMC\s+)?Q"
            )

    pages_modified = 0
    total_pages = len(pdf.pages)

    if is_near_white_form_mode:
        # Pass 1: identify, per page, which watermark objgens are present
        # BEFORE any mutation (clearing one shared object would otherwise
        # make it fail the near-white-form test on later pages that
        # reference the same already-cleared object).
        page_watermark_objgens = []
        all_objgens = set()
        for page in pdf.pages:
            xobj_dict = page.get("/Resources", {}).get("/XObject", {})
            found = set()
            for _, obj in xobj_dict.items():
                if _is_near_white_large_form(obj, page_area):
                    found.add(obj.objgen)
            page_watermark_objgens.append(found)
            all_objgens.update(found)

        # Pass 2: clear each distinct watermark object once.
        cleared = set()
        for page in pdf.pages:
            xobj_dict = page.get("/Resources", {}).get("/XObject", {})
            for _, obj in xobj_dict.items():
                if obj.objgen in all_objgens and obj.objgen not in cleared:
                    obj.write(b"")
                    cleared.add(obj.objgen)

        for page_num, found in enumerate(page_watermark_objgens, start=1):
            if found:
                pages_modified += 1
            if total_pages <= 20 or page_num % 10 == 0 or page_num == total_pages:
                print(f"  … page {page_num}/{total_pages}", flush=True)

    for page_num, page in enumerate(pdf.pages, start=1):
        if is_near_white_form_mode:
            continue

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
        page_had_target = False
        for pattern in patterns_to_remove:
            if isinstance(pattern, re.Pattern):
                page_had_target = page_had_target or bool(pattern.search(text))
            else:
                page_had_target = page_had_target or bool(re.search(pattern, text, flags=re.DOTALL))
            if isinstance(pattern, re.Pattern):
                new_text, n = pattern.subn("", text)
            else:
                new_text, n = re.subn(pattern, "", text, flags=re.DOTALL)
            if n > 0:
                text = new_text
                modified = True

        # Post-EMC strip (only in non-template modes).  Some OUP teacher-note
        # PDFs contain BOTH compact `/PlacedPDF` overlay markers and a visible
        # form watermark after the final EMC.  Removing compact markers can make
        # that post-EMC watermark become the new trailing content, so compact
        # mode must run the same post-EMC cleanup as explicit post-EMC mode.
        if (is_post_emc_mode or is_compact_placedpdf_mode) and not is_template_mode:
            # Strategy A: Strip ALL q…/FmX Do…Q blocks after the last EMC.
            # The watermark may appear before or after the first Q in the
            # post-EMC region, so we scan the entire tail rather than
            # limiting to content after the first Q.  This applies even
            # when the page has only a single EMC marker (i.e. the
            # watermark q…/FmX Do…Q block is the only thing after it).
            last_emc = text.rfind("EMC")
            if last_emc > 0:
                after_emc = text[last_emc + 3:]
                cleaned, n = re.subn(
                    r"q\s+.*?/[Ff]m\d+\s+Do\s+Q\s*",
                    "",
                    after_emc,
                    flags=re.DOTALL,
                )
                if n > 0:
                    text = text[:last_emc + 3] + cleaned
                    modified = True

            # Strategy B: Also strip watermarks embedded in double-EMC
            # patterns elsewhere on the page (not just after the last EMC).
            # Pattern: EMC\nEMC\n[Q\n]q\n.../FmX Do\nQ\n  → keep EMC\nEMC\n
            # The Q between the double EMC and the q is optional — some
            # pages place the watermark q-block directly after EMC EMC.
            new_text, n = re.subn(
                r"(EMC\s+EMC\s+)(?:Q\s+)?(q\s+.*?/[Ff]m\d+\s+Do\s+Q\s*)",
                r"\1",
                text,
                flags=re.DOTALL,
            )
            if n > 0:
                text = new_text
                modified = True

            # Strategy C: In math-OUP teacher-note pages, the same watermark
            # form draw that student pages place at the end is followed by real
            # TN text/icons. Strip that form block in-place instead of removing
            # the following legitimate teacher-note content.
            if is_post_emc_mode or is_compact_placedpdf_mode:
                new_text, n = _strip_pre_tn_form_watermark(text)
                if n > 0:
                    text = new_text
                    modified = True

        if modified:
            # Write everything back to the first stream, clear the rest
            encoded = text.encode("latin-1")
            streams[0].write(encoded)
            for s in streams[1:]:
                s.write(b"")
            pages_modified += 1
        elif not page_had_target:
            pages_modified += 1

        # Progress indicator every 10 pages (or every page for small docs)
        if total_pages <= 20 or page_num % 10 == 0 or page_num == total_pages:
            print(f"  … page {page_num}/{total_pages}", flush=True)

    print(f"  Modified {pages_modified}/{len(pdf.pages)} pages.")

    if pages_modified < len(pdf.pages):
        missed = len(pdf.pages) - pages_modified
        print(f"\033[1;31m  FATAL: {missed} page(s) still contain watermarks! Aborting.\033[0m",
              file=sys.stderr)
        pdf.close()
        raise WatermarkRemovalError(
            f"{missed} page(s) still contain watermarks in {pdf_path!r}"
        )

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

    try:
        ok = remove_watermarks(in_path, out_path, template_regex)
    except WatermarkRemovalError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
