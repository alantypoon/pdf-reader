#!/usr/bin/env python3
"""
Copy math OUP TN (teacher's notes) PDFs from _ref/math-oup-tn/ to
data/math-oup/ with watermark removal.

Source layout (flat directory, or optionally en/ and tc/ subdirs):
    _ref/math-oup-tn/
        OSM_TBPDF_<bookId><sectionId>_<e|c>.pdf
        OSM_TBPDF_TN_<bookId><sectionId>_<e|c>.pdf

Target layout:
    data/math-oup/<bookId_lower>/<lang>/contents/<sectionId>.pdf
    data/math-oup/<bookId_lower>/<lang>/contents.tn/<sectionId>.pdf

Rules:
    - bookId+sectionId are concatenated in the source filename (no separator)
    - sectionId is the last 2 characters (digits), bookId is the prefix
    - bookId is lowercased for the target path
    - sectionId is zero-padded to 2 digits
    - e → en, c → tc
    - Does NOT overwrite existing target files
    - Creates target folders when they don't exist
    - Removes watermark before writing the target file

Filter examples:
    python copy-math-oup.py 4a -f         # all 4a student + TN PDFs
    python copy-math-oup.py 4a/1 -f       # section 01 student + TN PDFs
    python copy-math-oup.py 4a/1/tn -f    # section 01 TN PDF only
    python copy-math-oup.py 4a/1/21/tn -f # section 01 TN page image 21 only
    python copy-math-oup.py 4a/1/student -f  # section 01 student PDF only
"""

import os
import re
import sys
import shutil

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

# Allow importing remove_watermark from the same directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from remove_watermark import remove_watermarks, WatermarkRemovalError

BASE_DIR = "/var/www/html/pdf-reader"
SOURCE_DIR = os.path.join(BASE_DIR, "_ref", "math-oup-tn")
TARGET_ROOT = os.path.join(BASE_DIR, "data", "math-oup")

# Matches: OSM_TBPDF_<bookId><sectionId>_<e|c>.pdf
# and:    OSM_TBPDF_TN_<bookId><sectionId>_<e|c>.pdf
# bookId+sectionId are concatenated; sectionId = last 2 chars (digits or AR)
CONTENTS_PATTERN = re.compile(
    r"^OSM_TBPDF_(\w+?)([0-9]{2})_([ec])\.pdf$"
)
TN_PATTERN = re.compile(
    r"^OSM_TBPDF_TN_(\w+?)([0-9]{2})_([ec])\.pdf$"
)

# Skip these entirely
SKIP_PATTERNS = [
    re.compile(r"^OSM_TBPDF_TPage_"),   # Title pages
    re.compile(r".*_AR_"),              # Answer/review sections
]

LANG_MAP = {"e": "en", "c": "tc"}

PAGE_IMAGE_DPI = 200
PAGE_IMAGE_FORMAT = "png"
KIND_ALIASES = {
    "tn": True,
    "teacher": True,
    "teacher-notes": True,
    "teacher_notes": True,
    "contents.tn": True,
    "student": False,
    "contents": False,
    "textbook": False,
}


def should_skip(fname: str) -> bool:
    for pat in SKIP_PATTERNS:
        if pat.search(fname):
            return True
    return False


def remove_stale_page_images(pages_dir: str, section_id: str, page_number=None) -> int:
    if not os.path.isdir(pages_dir):
        return 0
    removed = 0
    prefix = f"{section_id}-{page_number}." if page_number is not None else f"{section_id}-"
    for fname in os.listdir(pages_dir):
        if not fname.startswith(prefix):
            continue
        if not fname.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        os.remove(os.path.join(pages_dir, fname))
        removed += 1
    return removed


def regenerate_page_images(pdf_path: str, target_dir: str, section_id: str, page_number=None) -> int:
    """Render a copied PDF to target_dir/pages/<section>-<page>.png.

    Existing images for the same section are removed first.  This keeps the
    web app from serving stale, watermarked PNGs after the source PDF has
    been cleaned and overwritten.
    """
    pages_dir = os.path.join(target_dir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    removed = remove_stale_page_images(pages_dir, section_id, page_number)
    if removed:
        print(f"    Removed {removed} stale page image(s).")

    if fitz is None:
        print("    WARNING: PyMuPDF not installed; page images were not regenerated.", file=sys.stderr)
        return 0

    rendered = 0
    doc = fitz.open(pdf_path)
    try:
        if page_number is not None:
            if page_number < 1 or page_number > doc.page_count:
                raise ValueError(f"page {page_number} is outside PDF page range 1..{doc.page_count}")
            page_indexes = [page_number - 1]
        else:
            page_indexes = range(doc.page_count)
        matrix = fitz.Matrix(PAGE_IMAGE_DPI / 72, PAGE_IMAGE_DPI / 72)
        for page_idx in page_indexes:
            page_num = page_idx + 1
            out_path = os.path.join(pages_dir, f"{section_id}-{page_num}.{PAGE_IMAGE_FORMAT}")
            pix = doc[page_idx].get_pixmap(matrix=matrix)
            pix.save(out_path)
            rendered += 1
    finally:
        doc.close()
    print(f"    Rendered {rendered} page image(s).")
    return rendered


def apply_custom_answer_reveals(pdf_path: str, book_id: str, lang: str, section_id: str, is_tn: bool) -> int:
    """Apply small PDF-layer fixes for answer content missing from TN pages.

    Some math OUP TN source pages do not contain hidden annotations/layers for
    Instant Drill answers; the official answers are only on the answer pages at
    the end of the same section PDF.  These fixes copy the missing answer text
    onto the affected TN page before page images are rendered.
    """
    if fitz is None or not is_tn:
        return 0
    if (book_id, lang, section_id) != ("4a", "en", "01"):
        return 0

    doc = fitz.open(pdf_path)
    modified = 0
    tmp_path = f"{pdf_path}.tmp"

    def add_answer_panel(page, page_number, title, body, rect=None):
        """Add a compact teacher-answer panel to a content page once."""
        marker = f"All answers reveal panel page {page_number}:"
        if marker in page.get_text():
            return False
        if rect is None:
            rect = fitz.Rect(392, 390, 585, 746)
        page.draw_rect(
            rect,
            color=(1.0, 0.0, 0.42),
            fill=(1.0, 0.975, 0.99),
            width=0.45,
            overlay=True,
        )
        page.insert_text(fitz.Point(rect.x0 + 2, rect.y0 + 2), marker, fontsize=0.1, fontname="helv", color=(1, 0.975, 0.99), overlay=True)
        page.insert_textbox(
            fitz.Rect(rect.x0 + 5, rect.y0 + 5, rect.x1 - 5, rect.y1 - 5),
            f"{title}\n{body}",
            fontsize=6.2,
            fontname="helv",
            color=(0.86, 0.0, 0.42),
            align=fitz.TEXT_ALIGN_LEFT,
            overlay=True,
        )
        return True

    answer_panels = {
        3: (
            "Quick Quiz 1.1 answers",
            "1. 0.2  and  0.75\n2. 0.2̇  and  0.7̇2̇\n3. 4/5  and  13/20",
        ),
        4: (
            "Instant Drill 1 answers",
            "1(a) 4/9\n1(b) 7/90",
        ),
        5: (
            "Instant Drill 2 answers",
            "2(a) 3/11  (b) 10/37  (c) 1/55  (d) 2/111",
        ),
        6: (
            "Quick Quiz 1.2 answers",
            "4 is a natural number and an integer\n1.701̇ is a recurring decimal\n√15 and π/3 are irrational numbers\n−√9 (= −3) is an integer",
        ),
        7: (
            "Class Activity 1.1 answers",
            "1(a) x = 2\n1(b) no solution\n1(d) Yes, x = −7\n2(a) x = −9\n2(b) no solution\n2(d) Yes, x = −9.5\n3(a) x = 1/2 or −1/2\n3(b) no solution\n3(d) Yes, x = √2 or −√2\n3(e) no solution",
        ),
        8: (
            "Quick Quiz 1.3 answers",
            "1. 3i\n2. 4i\n3. -21i\n4. -(3/5)i",
        ),
        9: (
            "Quick Quiz 1.4 answers",
            "1. real part = 1, imaginary part = -3\n2. real part = -3/2, imaginary part = 7\n3. real part = 9, imaginary part = 0\n4. real part = 0, imaginary part = 6\n5. real part = 5, imaginary part = 3\n6. real part = -8, imaginary part = 2",
        ),
        10: (
            "Class Practice 1.1 answers",
            "1(a) -3\n(b) recurring 1.462\n(c) -3, 2.6, recurring 1.462\n(d) sin 25°, -6\n(e) -3, 2.6, recurring 1.462, sin 25°, -6",
        ),
        11: (
            "Exercise 1A answers 1-3",
            "1(a) 3, 8  (b) -6, -15\n(c) 3, -2.5, 8, -6, 1/5, -15, recurring 1.8\n(d) sqrt(7), 4pi, 2/3\n2(a) T (b) F (c) F (d) T (e) F\n3(a) N,Z,Q,R,C (b) Z,Q,R,C (c) R,C (d) C (e) Q,R,C (f) C",
        ),
        12: (
            "Exercise 1A answers 4-25",
            "4(a) 0.7 (b) terminating\n5(a) 0.325 (b) terminating\n6(a) recurring 0.8 (b) recurring\n7(a) recurring 1.09 (b) recurring\n8. 1/9  9. 16/9 or 7/9  10. 1/30  11. 7/45\n12. real=3, imag=7\n13. real=-3sqrt(3), imag=5\n14. real=0, imag=-4\n15. real=-1+sqrt(10), imag=0\n16(a) 4/7, 3/8 (or other)  (b) 1+i, 2-3i (or other)\n17(a) rational (b) irrational (c) rational (d) irrational (e) rational (f) irrational\n18(a) F (b) F\n19. 8/33  20. 5/66  21. 139/110 or 29/110\n22. 5/37  23. 1/27  24. 176/111 or 65/111\n25(a) 0.0606...=2/33, 0.3030...=10/33  (b)(i) yes (ii) no",
            fitz.Rect(392, 405, 585, 746),
        ),
        13: (
            "Exercise 1A answers 26-29",
            "26(a) -2  (b) -10\n27(a) -5  (b) 1/4\n28. no\n29(a)(i) 4  (ii) 14  (iii) 12\n29(b) yes",
        ),
        14: (
            "Instant Drill 3 answers",
            "3(a) 5i  (b) -11  (c) 14  (d) 3i",
        ),
        15: (
            "Quick Quiz 1.5 answers",
            "(a) i\n(b) 1",
        ),
        16: (
            "Instant Drill 4-5 answers",
            "4(a) -8  (b) -8i  (c) 10  (d) -6i\n5(a) 6i  (b) 11i  (c) -20  (d) 2/3",
        ),
        17: (
            "Instant Drill 6 answers",
            "6(a) 7 - i  (b) 6 - 4i\n(c) -1 + 2i  (d) -7 + 9i",
        ),
        18: (
            "Instant Drill 7-8 answers",
            "7(a) -4 - 2i  (b) 6 + 4i\n8(a) -12 + 2i  (b) 4 - 3i\n(c) 7 + 24i  (d) 5  (e) 53",
        ),
        19: (
            "Quick Quiz 1.6 answers",
            "(a) 5 - 3i\n(b) 2 + (3/4)i",
        ),
        20: (
            "Instant Drill 9 / Quick Quiz 1.7",
            "ID9: (a) -5i  (b) (1/4)i  (c) 2 - i  (d) -1/2 - (1/5)i\nQQ1.7: (a) 2 - 5i  (b) 7 + 4i  (c) -1 - 6i",
        ),
        22: (
            "Instant Drill 11-12 answers",
            "11(a) 2 + i  (b) 1 - i  (c) 2 - 11i\n12(1) 1/2  12(2) 1/5",
        ),
        23: (
            "Instant Drill 13 answers",
            "13(a) z1 = k + 2ki, z2 = k(-3/13 + 10/13) + k(2/13 + 15/13)i\n13(b) -1",
            fitz.Rect(390, 566, 585, 735),
        ),
        24: (
            "Instant Drill 14 answers",
            "14(a) x = -8, y = -5\n14(b) x = 4, y = -1",
        ),
        25: (
            "Class Practice 1.2 / Exercise 1B answers",
            "CP1.2: 1(a)-4i (b)8 (c)-9i (d)i; 2(a)-10+11i (b)29+3i (c)4-6i (d)1+3i; 3 x=1,y=-4\nEx1B 1(a)9i (b)11i; 2(a)54i (b)12i; 3(a)-3 (b)4; 4(a)-55 (b)-9; 5(a)10 (b)-2i; 6(a)4i (b)2i (c)-6 (d)5; 7(a)-i (b)-1 (c)1 (d)-i",
            fitz.Rect(392, 450, 585, 745),
        ),
        26: (
            "Exercise 1B answers 8-21",
            "8(a)4+7i (b)4+i (c)8-3i\n9(a)9-i (b)-4+7i (c)-5+4i\n10(a)1+i (b)7+i (c)36-50i\n11(a)15-8i (b)-45+28i (c)29\n12(a)3+4i (b)3/2 - (5/2)i\n13(a)-1/3 i (b) ...\n14(a)7-3i (b)-5/2 - (1/2)i\n15(a)4/17 - (1/17)i (b)3/13 + (2/13)i\n16(a)1-2i (b)10/17 + (6/17)i\n17 x=2,y=4; 18 x=3,y=-6; 19 x=2,y=11\n20(a)-i (b)15 (c)8 (d)7i\n21(a)2/3 i (b)-2sqrt(15)",
            fitz.Rect(390, 415, 585, 746),
        ),
        27: (
            "Exercise 1B answers 22-33",
            "22(a)9-i (b)5-3i (c)3+i (d)-2+3i\n23(a)29+11i (b)52+65i\n24(a)2/5 + (1/5)i (b)-3+2i\n25(a)1/2 - (2/3)i (b)-15/17 + (8/17)i\n26(a)1+2i (b)4+i\n27(a)-1/10 - (1/25)i (b)-1/2 + (1/2)i\n28(a)-4+ki (b)k-5+4ki\n29. 2  30. 4  31. -21/25  32. k=12/5\n33(a)2+i (b)3",
            fitz.Rect(392, 410, 585, 745),
        ),
        28: (
            "Exercise 1B answers 34-43",
            "34 x=-2,y=9; 35 x=-7,y=11; 36 -4; 37 20\n38(a) z1 = ... , z2 = ...  (b) 8\n39(a)3 (b)5/7 + (4/5)i\n40(a) i (b) yes\n41(a)0 (b) no\n42 -18\n43(a) a=3,b=2 (b) yes",
            fitz.Rect(390, 500, 585, 742),
        ),
        31: (
            "Checkpoint answers",
            "1 ✓  2 ✓  3 ✗  4 ✗\n5(a) 5  (b) recurring 12.7  (c) tan20°, 4sqrt(3)\n(d) 5, 1/4, recurring 12.7, tan20°, 4sqrt(3)\n(e) 5, 1/4, recurring 12.7, tan20°, 4sqrt(3), 6-i",
        ),
        32: (
            "Supplementary Exercise 1 answers 1-16",
            "1(a)4,0,-9 (b)2pi,8\n2(a)-3/8,-sqrt(25) (b)8i,sqrt(-4),9-2i\n3(a)-7/8,10/13,4sqrt(3) (b)5/6,-19/9\n4. 5/9  5. 13/9 or 4/9  6. 1/45  7. 19/15 or 4/15\n8 real=9, imag=-3; 9 real=5, imag=0; 10 real=-5, imag=6; 11 real=0, imag=-2\n12(a)-15 (b)-1/3 (c)81\n13(a)9i (b)-36 (c)5\n14(a)4-3i (b)-3+i (c)-5+5i\n15(a)-15-5i (b)3-10i (c)7-24i\n16(a)-1-8i (b)5/26+(1/26)i (c)3/20-(9/20)i",
            fitz.Rect(390, 310, 585, 745),
        ),
        33: (
            "Supplementary Exercise 1 answers 17-25",
            "17 x=1,y=-1; 18 x=2,y=3\n19(a) irrational (b) irrational (c) rational, integer\n20(a) real, irrational (b) non-real (c) real, irrational\n21(a) 0.297(recur variants) (b) smallest 11/37, largest 59/198\n22(a)4 (b)-5\n23(a)2/3 (b)1 (c)-sqrt(6/12) (d)0\n24(a)0 (b)-1+i (c) yes\n25(a)5 (b)-12+5i (c)-24+32i (d)-130i (e)-8/5+(6/5)i (f)-4+9i",
            fitz.Rect(390, 395, 585, 745),
        ),
        34: (
            "Supplementary Exercise 1 answers 26-37",
            "26(a)2i (b)32i\n27. 2+9i\n28(a)4k+4i (b)2k-5i\n29. 2  30. -5/2  31. -1/2\n32(a) k/10+12/10 + (4/10-3k/10)i (b)-2\n33(a)2/5 (b)-4+2i\n34 x=-1,y=-3; 35 2:5\n36(a)2-i (b)x=2,y=1\n37(a)1-6i (b)no",
            fitz.Rect(390, 455, 585, 745),
        ),
        35: (
            "Supplementary / MC answers",
            "38(a)2a, rational (b)sqrt(a/6), irrational\n39(a)m=1,n=4; m=2,n=1 (b)x=1,y=4\n40(a)x=1,y=3; x=3,y=1 (b)yes\n41(a)i (b)-2+i\n42 D  43 A  44 B  45 C",
            fitz.Rect(390, 435, 585, 720),
        ),
        36: (
            "Multiple-choice answers",
            "46 A  47 B  48 B  49 C  50 A  51 B  52 A  53 B  54 D",
        ),
        37: (
            "Competition Corner answer",
            "1. C",
        ),
        38: (
            "Exam Drill answers",
            "1 D\n2 D",
        ),
        39: (
            "Exam-type Questions answers",
            "1 A  2 A  3 C  4 B  5 B  6 D  7 D  8 C  9 A\n10 A\n6. 30/11\n7. 6 + 2i\n8. 7 - i\n9. 24 + 23i\n10. -2 - i\n11. -(7/5)i\n12. -2/5 + (1/5)i",
            fitz.Rect(390, 360, 585, 725),
        ),
        40: (
            "Public Exam Questions answers",
            "1 A  2 C  3 D  4 D  5 B  6 B  7 C  8 A  9 A  10 A",
        ),
    }

    try:
        for page_number, panel in answer_panels.items():
            if doc.page_count < page_number:
                continue
            title, body, *panel_rect = panel
            rect = panel_rect[0] if panel_rect else None
            if add_answer_panel(doc[page_number - 1], page_number, title, body, rect):
                modified += 1

        if doc.page_count >= 21:
            page = doc[20]
            existing_text = page.get_text()
            marker = "Instant Drill 10 answers:"
            if marker not in existing_text:
                # Page 21 points Instant Drill 10 to Exercise 1B 15, 16.
                # The section answer page gives:
                #   15(a) 4/17 - 1/17 i, 15(b) 3/13 + 2/13 i
                #   16(a) 1 - 2i,        16(b) 10/17 + 6/17 i
                page.draw_rect(
                    fitz.Rect(56, 429, 510, 457),
                    color=None,
                    fill=(1, 0.965, 0.985),
                    overlay=True,
                )
                page.insert_textbox(
                    fitz.Rect(60, 431, 506, 456),
                    "Instant Drill 10 answers: 15(a) 4/17 - 1/17 i   15(b) 3/13 + 2/13 i\n"
                    "16(a) 1 - 2i   16(b) 10/17 + 6/17 i",
                    fontsize=8.2,
                    fontname="helv",
                    color=(0.86, 0.0, 0.42),
                    align=fitz.TEXT_ALIGN_LEFT,
                    overlay=True,
                )
                modified += 1

        if modified:
            doc.save(tmp_path, garbage=4, deflate=True)
    finally:
        doc.close()

    if modified:
        os.replace(tmp_path, pdf_path)
    elif os.path.exists(tmp_path):
        os.remove(tmp_path)
    return modified


def parse_filter_arg(filter_arg: str):
    parts = [part.strip().lower() for part in filter_arg.split("/")]
    if not parts or not parts[0]:
        raise ValueError("bookId is required")
    if len(parts) > 4:
        raise ValueError("filter must be bookId, bookId/sectionId, bookId/sectionId/kind, or bookId/sectionId/page/kind")

    filter_book = parts[0]
    filter_section = None
    filter_page = None
    filter_kind = None

    if len(parts) >= 2 and parts[1]:
        filter_section = parts[1].zfill(2)

    if len(parts) == 3:
        if not parts[1]:
            raise ValueError("sectionId is required when kind is provided")
        kind = parts[2]
        if kind not in KIND_ALIASES:
            allowed = ", ".join(sorted(KIND_ALIASES.keys()))
            raise ValueError(f"unknown kind {kind!r}; expected one of: {allowed}")
        filter_kind = KIND_ALIASES[kind]

    if len(parts) == 4:
        if not parts[1]:
            raise ValueError("sectionId is required when page is provided")
        if not parts[2].isdigit() or int(parts[2]) < 1:
            raise ValueError("page must be a positive integer")
        filter_page = int(parts[2])
        kind = parts[3]
        if kind not in KIND_ALIASES:
            allowed = ", ".join(sorted(KIND_ALIASES.keys()))
            raise ValueError(f"unknown kind {kind!r}; expected one of: {allowed}")
        filter_kind = KIND_ALIASES[kind]

    return filter_book, filter_section, filter_page, filter_kind


def format_filter_kind(filter_kind):
    if filter_kind is None:
        return "student+tn"
    return "tn" if filter_kind else "student"


def process_src_dir(lang_src: str, output_lang: str, filter_book=None, filter_section=None, filter_page=None, filter_kind=None, force=False):
    """
    Process all files in lang_src, mapping them to output_lang target.
    output_lang is "en" or "tc".

    filter_book / filter_section / filter_page / filter_kind: optional
    bookId/sectionId/page/kind filter. filter_kind is True for TN only,
    False for student only, or None for both. filter_page limits page-image
    rendering to a single page while still refreshing the cleaned section PDF.
    force: when True, overwrite existing target files.
    """
    if not os.path.isdir(lang_src):
        print(f"  Skipping missing directory: {lang_src}")
        return 0, 0, 0

    copied = 0
    skipped = 0
    errors = 0

    for fname in sorted(os.listdir(lang_src)):
        src_path = os.path.join(lang_src, fname)
        if not os.path.isfile(src_path):
            continue

        if should_skip(fname):
            continue

        # Try TN pattern first (more specific), then contents pattern
        m = TN_PATTERN.match(fname)
        if m:
            book_id_raw = m.group(1)
            section_id = m.group(2)     # already 2 digits
            lang_char = m.group(3)
            is_tn = True
        else:
            m = CONTENTS_PATTERN.match(fname)
            if m:
                book_id_raw = m.group(1)
                section_id = m.group(2)  # already 2 digits
                lang_char = m.group(3)
                is_tn = False
            else:
                continue  # no match

        book_id = book_id_raw.lower()
        lang = LANG_MAP.get(lang_char, lang_char)

        # Apply optional book/section filter
        if filter_book is not None and book_id != filter_book:
            continue
        if filter_section is not None and section_id != filter_section:
            continue
        if filter_kind is not None and is_tn != filter_kind:
            continue

        # Use the output_lang (derived from dir name or flat-dir mapping)
        # Only process if this file's lang matches the output_lang target
        if lang != output_lang:
            continue

        # Build target path
        if is_tn:
            target_dir = os.path.join(TARGET_ROOT, book_id, lang, "contents.tn")
        else:
            target_dir = os.path.join(TARGET_ROOT, book_id, lang, "contents")
        target_path = os.path.join(target_dir, f"{section_id}.pdf")

        if os.path.exists(target_path) and not force:
            print(f"  SKIP (exists): {target_path}")
            skipped += 1
            continue

        os.makedirs(target_dir, exist_ok=True)

        label = "TN" if is_tn else "contents"
        print(f"  COPY + watermark removal ({label}): {fname} → {target_path}")

        try:
            success = remove_watermarks(src_path, target_path, reveal_notes=is_tn)
            if success:
                revealed = apply_custom_answer_reveals(target_path, book_id, lang, section_id, is_tn)
                if revealed:
                    print(f"    Applied {revealed} custom answer reveal(s).")
                regenerate_page_images(target_path, target_dir, section_id, filter_page)
                copied += 1
                print(f"    OK")
            else:
                # No watermark found — copy as-is
                shutil.copy2(src_path, target_path)
                revealed = apply_custom_answer_reveals(target_path, book_id, lang, section_id, is_tn)
                if revealed:
                    print(f"    Applied {revealed} custom answer reveal(s).")
                regenerate_page_images(target_path, target_dir, section_id, filter_page)
                copied += 1
                print(f"    OK (no watermark detected, copied as-is)")
        except WatermarkRemovalError as e:
            # Do NOT fall back to copying the watermarked file — that
            # would silently ship watermarked content.  Skip the file
            # and record it as an error so it can be investigated.
            print(f"    ERROR: watermark removal failed: {e}", file=sys.stderr)
            errors += 1
            if os.path.exists(target_path):
                os.remove(target_path)
        except Exception as e:
            print(f"    ERROR: {e}", file=sys.stderr)
            errors += 1
            if os.path.exists(target_path):
                os.remove(target_path)

    return copied, skipped, errors


def main():
    # Parse optional filter: "book/section/kind" e.g. "4a/01/tn"
    # and optional -f/--force flag to overwrite existing target files.
    args = sys.argv[1:]
    force = False
    if "-f" in args:
        force = True
        args.remove("-f")
    if "--force" in args:
        force = True
        args.remove("--force")

    if len(args) > 1:
        print(f"Usage: {os.path.basename(__file__)} [-f|--force] [bookId[/sectionId[/pageNumber/][student|tn]]]",
              file=sys.stderr)
        print(f"  Examples: {os.path.basename(__file__)} -f", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} -f 4a/1", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 4a/1/tn -f", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 4a/1/21/tn -f", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 4a/1/student -f", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 4a   (all sections in book 4a)", file=sys.stderr)
        print(f"            {os.path.basename(__file__)}      (all books, all sections)", file=sys.stderr)
        sys.exit(1)

    filter_book = None
    filter_section = None
    filter_page = None
    filter_kind = None
    if len(args) >= 1:
        filter_arg = args[0]
        try:
            filter_book, filter_section, filter_page, filter_kind = parse_filter_arg(filter_arg)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)
        if filter_section is not None:
            page_label = f" page={filter_page}" if filter_page is not None else ""
            print(f"Filter: book={filter_book} section={filter_section}{page_label} kind={format_filter_kind(filter_kind)}")
        else:
            print(f"Filter: book={filter_book} (all sections, kind={format_filter_kind(filter_kind)})")

    if force:
        print("Force mode: existing target files WILL be overwritten.")

    if not os.path.isdir(SOURCE_DIR):
        print(f"ERROR: Source directory not found: {SOURCE_DIR}", file=sys.stderr)
        sys.exit(1)

    total_copied = 0
    total_skipped = 0
    total_errors = 0

    # Check if source has en/ and tc/ subdirectories
    en_dir = os.path.join(SOURCE_DIR, "en")
    tc_dir = os.path.join(SOURCE_DIR, "tc")

    if os.path.isdir(en_dir) or os.path.isdir(tc_dir):
        # Structured: en/ and tc/ subdirectories
        print("Source has en/tc subdirectories.\n")

        for lang in ["en", "tc"]:
            lang_src = os.path.join(SOURCE_DIR, lang)
            print(f"Processing {lang}/ ...")
            c, s, e = process_src_dir(lang_src, lang, filter_book, filter_section, filter_page, filter_kind, force)
            total_copied += c
            total_skipped += s
            total_errors += e
    else:
        # Flat directory — all files are English (_e suffix)
        print("Flat source directory (all files are English).\n")
        c, s, e = process_src_dir(SOURCE_DIR, "en", filter_book, filter_section, filter_page, filter_kind, force)
        total_copied += c
        total_skipped += s
        total_errors += e

    print(f"\nDone. Copied: {total_copied}, Skipped: {total_skipped}, Errors: {total_errors}")

    if total_errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()