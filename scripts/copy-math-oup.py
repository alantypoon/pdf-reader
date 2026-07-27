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
            rect = fitz.Rect(418, 610, 578, 746)
        page.draw_rect(
            rect,
            color=(1.0, 0.0, 0.42),
            fill=(1.0, 0.965, 0.985),
            width=0.45,
            overlay=True,
        )
        page.insert_text(fitz.Point(rect.x0 + 2, rect.y0 + 2), marker, fontsize=0.1, fontname="helv", color=(1, 0.965, 0.985), overlay=True)
        page.insert_textbox(
            fitz.Rect(rect.x0 + 5, rect.y0 + 5, rect.x1 - 5, rect.y1 - 5),
            f"{title}\n{body}",
            fontsize=6.0,
            fontname="helv",
            color=(0.86, 0.0, 0.42),
            align=fitz.TEXT_ALIGN_LEFT,
            overlay=True,
        )
        return True

    def add_inline_answer_fallback(page, page_number, title, body):
        """Best-effort Foxit-style fallback: place answer text on existing underlines.

        Foxit PDF Editor shows many Math OUP TN answers as in-place answer
        artwork. PyMuPDF/Poppler do not expose those appearances as text,
        widgets, annotations, or OCG layers, so use the existing answer-key
        strings but anchor them to visible horizontal answer lines instead of
        drawing a separate side answer block.
        """
        marker = f"All answers inline reveal page {page_number}:"
        if marker in page.get_text():
            return False

        underlines = []
        seen = set()
        for drawing in page.get_drawings():
            for item in drawing.get("items", []):
                if item[0] != "l":
                    continue
                p0, p1 = item[1], item[2]
                if abs(p0.y - p1.y) > 0.55:
                    continue
                x0, x1 = sorted((float(p0.x), float(p1.x)))
                y = float(p0.y)
                length = x1 - x0
                if y < 70 or y > 725 or length < 22 or length > 230:
                    continue
                # Skip page-wide rules and large decorative borders.
                if x0 < 58 and x1 > 360:
                    continue
                key = (round(x0, 1), round(y, 1), round(x1, 1))
                if key not in seen:
                    seen.add(key)
                    underlines.append((x0, y, x1))

        underlines.sort(key=lambda item: (item[1], item[0]))
        answer_color = (1.0, 0.0, 0.42)
        unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
        font_args = {"fontname": f"aru_inline_{page_number}", "fontfile": unicode_font} if os.path.exists(unicode_font) else {"fontname": "helv"}

        page.insert_text(
            fitz.Point(420, 80),
            marker,
            fontsize=0.1,
            color=(1, 1, 1),
            overlay=True,
            **font_args,
        )

        chunks = []
        for raw_line in body.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            # Keep compact semantic chunks, but split obvious multi-answer rows.
            parts = re.split(r"\s{2,}(?=(?:\d+[\.(]|\([a-z]\)|[A-Z]{1,4}\d|ID\d|QQ\d|CP\d|Ex\d))", line)
            chunks.extend(part.strip() for part in parts if part.strip())

        if not chunks:
            chunks = [title]

        if not underlines:
            # Some exercise pages do not have answer blanks/underlines in the
            # question area. In that case, still avoid the old bordered side
            # block and place compact answer text as close to the question flow
            # as possible in the available lower-right white space.
            fallback_rect = fitz.Rect(392, 410, 585, 742)
            page.insert_textbox(
                fallback_rect,
                f"{title}\n" + "\n".join(chunks),
                fontsize=5.3,
                color=answer_color,
                align=fitz.TEXT_ALIGN_LEFT,
                overlay=True,
                **font_args,
            )
            return True

        for idx, answer in enumerate(chunks[: len(underlines)]):
            x0, y, x1 = underlines[idx]
            size = 5.2 if len(answer) > 28 else 5.8
            page.insert_textbox(
                fitz.Rect(x0 + 2, y - 9.2, x1 + 95, y + 3.5),
                answer,
                fontsize=size,
                color=answer_color,
                align=fitz.TEXT_ALIGN_LEFT,
                overlay=True,
                **font_args,
            )
        return True

    def put_spread_row(page, entries, y, *, start_x=None, end_x=None, min_gap=18, size=6.0, fontname="helv", fontfile=None, color=(1.0, 0.0, 0.42)):
        """Place multiple short answers on one row with even spreading.

        This reduces visual collisions when PyMuPDF extraction would otherwise
        merge nearby answer chunks. It is a generic placement helper for TN
        answer overlays on structured exercise rows.
        """
        clean_entries = [entry for entry in entries if entry and entry.get("text")]
        if not clean_entries:
            return

        widths = []
        for entry in clean_entries:
            text = entry["text"]
            entry_size = entry.get("size", size)
            try:
                width = fitz.get_text_length(text, fontname=fontname, fontsize=entry_size)
            except Exception:
                width = len(text) * entry_size * 0.62
            widths.append(width)

        if len(clean_entries) == 1:
            entry = clean_entries[0]
            x = entry.get("x", start_x if start_x is not None else 0)
            page.insert_text(
                fitz.Point(x, y + entry.get("dy", 0)),
                entry["text"],
                fontsize=entry.get("size", size),
                fontname=fontname,
                fontfile=fontfile,
                color=color,
                overlay=True,
            )
            return

        left = start_x if start_x is not None else min(entry.get("x", 0) for entry in clean_entries)
        right = end_x if end_x is not None else max(entry.get("x", 0) + widths[idx] for idx, entry in enumerate(clean_entries))
        available = max(0, right - left - sum(widths))
        gap = max(min_gap, available / (len(clean_entries) - 1)) if len(clean_entries) > 1 else 0

        x = left
        for idx, entry in enumerate(clean_entries):
            page.insert_text(
                fitz.Point(x, y + entry.get("dy", 0)),
                entry["text"],
                fontsize=entry.get("size", size),
                fontname=fontname,
                fontfile=fontfile,
                color=color,
                overlay=True,
            )
            x += widths[idx] + gap

    def put_column_answers(page, entries, *, x, y_values, size=6.0, fontname="helv", fontfile=None, color=(1.0, 0.0, 0.42)):
        """Place answers in one consistent vertical answer column.

        This is more general than page-specific coordinates for each line and
        matches Foxit-style layouts where revealed answers align in a neat
        column next to prompts.
        """
        for idx, text in enumerate(entries):
            if idx >= len(y_values) or not text:
                continue
            page.insert_text(
                fitz.Point(x, y_values[idx]),
                text,
                fontsize=size,
                fontname=fontname,
                fontfile=fontfile,
                color=color,
                overlay=True,
            )

    def find_text_rows(page, needles, *, y_min=0, y_max=999):
        """Find prompt rows by extracted text and return their bounding boxes.

        This gives answer reveal code a general way to anchor to the source PDF
        text layout instead of relying entirely on absolute page coordinates.
        """
        rows = {}
        blocks = page.get_text("dict").get("blocks", [])
        for block in blocks:
            if block.get("type") != 0:
                continue
            bbox = fitz.Rect(block["bbox"])
            if bbox.y0 < y_min or bbox.y0 > y_max:
                continue
            text = " ".join(
                span["text"]
                for line in block.get("lines", [])
                for span in line.get("spans", [])
            ).strip()
            for key, needle in needles.items():
                if key not in rows and needle in text:
                    rows[key] = bbox
        return rows

    def find_answer_underlines(page, *, y_min, y_max, min_len=8, max_len=120):
        """Find short horizontal answer-blank underlines within a y-range.

        Returns a list of (x0, y, x1) sorted left-to-right, top-to-bottom.
        This lets answer-reveal code center text over the actual blank line
        the source PDF draws, instead of guessing an offset from nearby
        label text (which breaks if label/answer widths differ).
        """
        underlines = []
        for drawing in page.get_drawings():
            for item in drawing.get("items", []):
                if item[0] != "l":
                    continue
                p0, p1 = item[1], item[2]
                if abs(p0.y - p1.y) > 0.6:
                    continue
                if p0.y < y_min or p0.y > y_max:
                    continue
                x0, x1 = sorted((float(p0.x), float(p1.x)))
                length = x1 - x0
                if length < min_len or length > max_len:
                    continue
                underlines.append((x0, float(p0.y), x1))
        underlines.sort(key=lambda u: (round(u[1]), u[0]))
        return underlines

    def put_centered(page, text, underline, *, dy=-2.2, size=6.4, fontname="helv", fontfile=None, color=(1.0, 0.0, 0.42)):
        """Center answer text horizontally over an underline, just above it."""
        x0, y, x1 = underline
        try:
            width = fitz.get_text_length(text, fontname=fontname, fontsize=size)
        except Exception:
            width = len(text) * size * 0.55
        x = x0 + max(0, ((x1 - x0) - width) / 2)
        page.insert_text(
            fitz.Point(x, y + dy),
            text,
            fontsize=size,
            fontname=fontname,
            fontfile=fontfile,
            color=color,
            overlay=True,
        )

    def find_item_labels(page, labels, *, y_min=0, y_max=999):
        """Locate "(a)", "(b)", ... item-label word boxes within a y-range.

        Many math OUP exercise pages lay out short sub-items such as
        "(a) 12   (b) -81" in a two-column grid. Finding the label word boxes
        directly (instead of hardcoding row/column coordinates per page)
        lets answer-reveal code anchor answers generally to whichever layout
        the source PDF actually uses.
        """
        found = {}
        for w in page.get_text("words"):
            x0, y0, x1, y1, text = w[0], w[1], w[2], w[3], w[4]
            if y0 < y_min or y0 > y_max:
                continue
            if text in labels and text not in found:
                found[text] = fitz.Rect(x0, y0, x1, y1)
        return found

    def put_after_labels(page, label_boxes, answers, *, x_pad=28, size=6.0, fontname="helv", fontfile=None, color=(1.0, 0.0, 0.42)):
        """Place each answer to the right of its matching "(a)"-style label."""
        for key, answer in answers.items():
            box = label_boxes.get(key)
            if box is None or not answer:
                continue
            page.insert_text(
                fitz.Point(box.x1 + x_pad, box.y1 - 1.6),
                answer,
                fontsize=size,
                fontname=fontname,
                fontfile=fontfile,
                color=color,
                overlay=True,
            )

    def find_row_column_ends(page, label_boxes, *, split_x, y_pad=6.0):
        """For each label box, find how far its question text extends.

        Returns {key: end_x} using the max x1 of words on the same row that
        belong to the label's column (left of split_x or right of split_x).
        This lets answer placement clear the full formula/prompt width
        instead of a fixed offset, even when formulas vary in length.
        """
        words = page.get_text("words")
        ends = {}
        for key, box in label_boxes.items():
            is_left = box.x0 < split_x
            row_end = box.x1
            for w in words:
                wx0, wy0, wx1, wy1 = w[0], w[1], w[2], w[3]
                if wy1 < box.y0 - y_pad or wy0 > box.y1 + y_pad:
                    continue
                same_column = (wx0 < split_x) if is_left else (wx0 >= split_x)
                if same_column and wx1 > row_end:
                    row_end = wx1
            ends[key] = row_end
        return ends

    def find_numbered_item_ends(page, labels, *, y_min=0, y_max=999, max_gap=20):
        """Find each "N." item label and how far its own text extends.

        Numbered items placed side-by-side on one row (e.g. "8. 0.1  9. 1.7
        10. 0.03  11. 0.15") have no fixed column split, so this locates each
        label's box and walks forward through the row's words, stopping at
        the first gap larger than max_gap. This avoids swallowing unrelated
        content (e.g. a difficulty-level marker glyph sitting just before the
        *next* item's label) that a naive "next label x0" bound would
        otherwise include. Returns {label: (label_box, end_x)}.
        """
        words = [w for w in page.get_text("words") if y_min <= w[1] <= y_max]
        label_words = sorted(
            (w for w in words if w[4] in labels),
            key=lambda w: w[0],
        )
        row_words = sorted(words, key=lambda w: w[0])
        results = {}
        for lw in label_words:
            x0, y0, x1, y1, text = lw[0], lw[1], lw[2], lw[3], lw[4]
            row_end = x1
            for w in row_words:
                wx0, wy0, wx1, wy1 = w[0], w[1], w[2], w[3]
                if wy1 < y0 - 6 or wy0 > y1 + 6:
                    continue
                if wx0 < x0:
                    continue
                if wx0 - row_end > max_gap:
                    break
                if wx1 > row_end:
                    row_end = wx1
            results[text] = (fitz.Rect(x0, y0, x1, y1), row_end)
        return results

    def put_answers_after_prompts(page, prompt_rows, answers, *, x_pad=8, max_x=None, size=6.0, fontname="helv", fontfile=None, color=(1.0, 0.0, 0.42)):
        """Place each answer immediately after its prompt row.

        For Foxit-like TN reveals, most answers are appended right after the
        question text. This helper computes the x/y from the prompt text block,
        producing stable, neat placement even if the source layout shifts.
        """
        for key, answer in answers.items():
            bbox = prompt_rows.get(key)
            if bbox is None or not answer:
                continue
            x = bbox.x1 + x_pad
            if max_x is not None:
                x = min(x, max_x)
            y = bbox.y0 + size + 1.4
            page.insert_text(
                fitz.Point(x, y),
                answer,
                fontsize=size,
                fontname=fontname,
                fontfile=fontfile,
                color=color,
                overlay=True,
            )

    answer_panels = {
        5: (
            "Instant Drill 2 answers",
            "2(a) 3/11  (b) 10/37  (c) 1/55  (d) 2/111",
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
        custom_in_place_pages = {5, 8, 9, 10, 11, 12}
        for page_number, panel in answer_panels.items():
            if doc.page_count < page_number:
                continue
            if page_number in custom_in_place_pages:
                continue
            title, body, *panel_rect = panel
            if add_inline_answer_fallback(doc[page_number - 1], page_number, title, body):
                modified += 1

        if doc.page_count >= 3:
            page = doc[2]
            existing_text = page.get_text()
            marker = "Quick Quiz 1.1 answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)

                def put(text, x, y, size=6.6):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="helv",
                        color=answer_color,
                        overlay=True,
                    )

                def put_fraction(num, den, x, y):
                    page.insert_text(fitz.Point(x, y - 4.6), num, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)
                    page.draw_line(fitz.Point(x - 0.5, y - 2.0), fitz.Point(x + 8.5, y - 2.0), color=answer_color, width=0.45, overlay=True)
                    page.insert_text(fitz.Point(x, y + 4.3), den, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)

                # Page 3 Quick Quiz 1.1 answers are printed on the end answer
                # page, but the TN source page has no hidden widgets/layers to
                # reveal. Add them at the matching question positions.
                put(marker, 418, 690, 0.1)  # tiny marker to avoid duplicate overlays
                put("0.2", 119, 591)
                put("0.75", 275, 591)
                put("0.2", 119, 616)
                put("•", 131.2, 608.7, 4.2)
                put("0.72", 275, 616)
                put("•", 284.2, 608.7, 4.2)
                put("•", 292.4, 608.7, 4.2)
                put_fraction("4", "5", 121, 666.5)
                put_fraction("13", "20", 277, 666.5)
                modified += 1

        if doc.page_count >= 4:
            page = doc[3]
            existing_text = page.get_text()
            marker = "Instant Drill 1 page 4 answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)

                def put(text, x, y, size=6.6):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="helv",
                        color=answer_color,
                        overlay=True,
                    )

                def put_fraction(num, den, x, y):
                    width = max(len(num), len(den)) * 4.1
                    page.insert_text(fitz.Point(x, y - 4.6), num, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)
                    page.draw_line(fitz.Point(x - 0.5, y - 2.0), fitz.Point(x + width, y - 2.0), color=answer_color, width=0.45, overlay=True)
                    page.insert_text(fitz.Point(x, y + 4.3), den, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)

                # Page 4 Instant Drill 1 answers are also only present on the
                # end answer page, not as hidden TN content.
                put(marker, 418, 690, 0.1)  # tiny marker to avoid duplicate overlays
                put_fraction("4", "9", 103, 334)
                put_fraction("7", "90", 272, 334)
                modified += 1

        if doc.page_count >= 5:
            page = doc[4]
            existing_text = page.get_text()
            marker = "Instant Drill 2 page 5 in-place answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)

                def put(text, x, y, size=6.6):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="helv",
                        color=answer_color,
                        overlay=True,
                    )

                def put_fraction(num, den, x, y):
                    page.insert_text(fitz.Point(x, y - 4.6), num, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)
                    width = max(len(num), len(den)) * 3.2 + 2.5
                    page.draw_line(fitz.Point(x - 0.5, y - 2.0), fitz.Point(x + width, y - 2.0), color=answer_color, width=0.45, overlay=True)
                    page.insert_text(fitz.Point(x, y + 4.3), den, fontsize=5.3, fontname="helv", color=answer_color, overlay=True)

                # Page 5 Instant Drill 2 answers are also only printed on the
                # end answer page. Put them next to each recurring-decimal item
                # so a single-page refresh of 01-5.png shows the answers.
                put(marker, 420, 80, 0.1)  # tiny marker to avoid duplicate overlays
                put_fraction("3", "11", 122, 113)
                put_fraction("10", "37", 302, 113)
                put_fraction("1", "55", 122, 134)
                put_fraction("2", "111", 302, 134)
                modified += 1

        if doc.page_count >= 6:
            page = doc[5]
            existing_text = page.get_text()
            marker = "Quick Quiz 1.2 page 6 in-table answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)

                def draw_tick(x, y):
                    page.draw_line(fitz.Point(x, y), fitz.Point(x + 3.0, y + 3.8), color=answer_color, width=1.0, overlay=True)
                    page.draw_line(fitz.Point(x + 3.0, y + 3.8), fitz.Point(x + 9.2, y - 5.8), color=answer_color, width=1.0, overlay=True)

                # Tiny marker to avoid duplicate overlays. The visible answers
                # are ticks placed directly in the Quick Quiz 1.2 table cells.
                page.insert_text(fitz.Point(420, 80), marker, fontsize=0.1, fontname="helv", color=(1, 1, 1), overlay=True)
                # 4 is a natural number and an integer.
                draw_tick(212, 629)
                draw_tick(212, 651)
                # 1.701 recurring is a recurring decimal.
                draw_tick(393, 673)
                # sqrt(15) and pi/3 are irrational numbers.
                draw_tick(330, 694)
                draw_tick(456, 694)
                # -sqrt(9) = -3 is an integer.
                draw_tick(521, 651)
                modified += 1

        if doc.page_count >= 7:
            page = doc[6]
            existing_text = page.get_text()
            marker = "Class Activity 1.1 page 7 in-place answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=6.4):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru7",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                def put_box(text, x0, y0, x1, y1, size=6.0):
                    page.insert_textbox(
                        fitz.Rect(x0, y0, x1, y1),
                        text,
                        fontsize=size,
                        fontname="aru7",
                        fontfile=unicode_font,
                        color=answer_color,
                        align=fitz.TEXT_ALIGN_LEFT,
                        overlay=True,
                    )

                # Page 7 Class Activity 1.1 has answer blanks but no hidden TN
                # widgets/layers to reveal. Add concise in-place solutions.
                put(marker, 420, 80, 0.1)  # tiny marker to avoid duplicate overlays
                put("2", 529, 323)
                put("no solution", 506, 345, 5.6)
                put("Yes, x = -7", 118, 406)
                put("−9", 526, 452)
                put("no solution", 506, 474, 5.6)
                put("Yes, x = −9.5", 118, 538)
                put("1/2 or −1/2", 504, 606, 5.6)
                put("no solution", 506, 634, 5.6)
                put("Yes, x = √2 or −√2", 118, 697)
                put_box("no solution", 504, 714, 555, 732, 6.0)
                modified += 1

        if doc.page_count >= 8:
            page = doc[7]
            existing_text = page.get_text()
            marker = "Quick Quiz 1.3 page 8 in-place answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=7.0):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru8",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                # The Foxit/editor view shows Quick Quiz 1.3 answers directly
                # on the answer underlines, not in a separate teacher panel.
                put(marker, 420, 80, 0.1)
                put("√3 i", 116, 489)
                put("4i", 310, 489)
                put("−√21 i", 129, 516)
                put("−5/3 i", 319, 516)
                modified += 1

        if doc.page_count >= 9:
            page = doc[8]
            existing_text = page.get_text()
            marker = "Quick Quiz 1.4 page 9 in-table answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=6.2):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru9",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                def put_fraction(num, den, x, y):
                    width = max(len(num), len(den)) * 3.2 + 2.0
                    page.insert_text(fitz.Point(x, y - 4.3), num, fontsize=5.2, fontname="aru9", fontfile=unicode_font, color=answer_color, overlay=True)
                    page.draw_line(fitz.Point(x - 0.6, y - 1.8), fitz.Point(x + width, y - 1.8), color=answer_color, width=0.45, overlay=True)
                    page.insert_text(fitz.Point(x, y + 4.2), den, fontsize=5.2, fontname="aru9", fontfile=unicode_font, color=answer_color, overlay=True)

                # Foxit shows Quick Quiz 1.4 answers directly on the table
                # underlines. Do not use the generic fallback for this page:
                # it can pick decorative/formula lines and place answers in
                # the top half of the page.
                put(marker, 420, 80, 0.1)
                real_x = 184
                imag_x = 282
                rows = [625.7, 649.2, 672.7, 692.2, 711.7, 731.2]
                put("1", real_x, rows[0])
                put("−3", imag_x - 3, rows[0])
                put_fraction("−2", "3", real_x - 3, rows[1] - 5.2)
                put("7", imag_x, rows[1])
                put("9", real_x, rows[2])
                put("0", imag_x, rows[2])
                put("0", real_x, rows[3])
                put("√6", imag_x - 3, rows[3])
                put("5", real_x, rows[4])
                put("√3", imag_x - 3, rows[4])
                put("−8", real_x - 3, rows[5])
                put("2", imag_x, rows[5])
                modified += 1

        if doc.page_count >= 10:
            page = doc[9]
            existing_text = page.get_text()
            marker = "Class Practice 1.1 page 10 in-table answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=0.1):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru10",
                        fontfile=unicode_font,
                        color=(1, 1, 1) if size < 1 else answer_color,
                        overlay=True,
                    )

                def draw_tick(x, y):
                    page.draw_line(fitz.Point(x, y), fitz.Point(x + 3.3, y + 4.2), color=answer_color, width=0.9, overlay=True)
                    page.draw_line(fitz.Point(x + 3.3, y + 4.2), fitz.Point(x + 10.2, y - 6.4), color=answer_color, width=0.9, overlay=True)

                # Foxit shows Class Practice 1.1 as ticks in the table cells.
                # The generic underline fallback was incorrectly selecting
                # diagram lines above the table, so handle this page directly.
                put(marker, 420, 80)
                col = {
                    "minus3": 234.9,
                    "decimal": 283.9,
                    "recurring": 332.9,
                    "sin25": 381.9,
                    "minus_sqrt6": 430.9,
                }
                row = {
                    "integer": 595.1,
                    "recurring_decimal": 616.6,
                    "rational": 638.1,
                    "irrational": 659.6,
                    "real": 681.1,
                }
                ticks = [
                    ("minus3", "integer"),
                    ("recurring", "recurring_decimal"),
                    ("minus3", "rational"), ("decimal", "rational"), ("recurring", "rational"),
                    ("sin25", "irrational"), ("minus_sqrt6", "irrational"),
                    ("minus3", "real"), ("decimal", "real"), ("recurring", "real"), ("sin25", "real"), ("minus_sqrt6", "real"),
                ]
                for col_key, row_key in ticks:
                    draw_tick(col[col_key] - 4.8, row[row_key] + 2.5)
                modified += 1

        if doc.page_count >= 11:
            page = doc[10]
            existing_text = page.get_text()
            marker = "Exercise 1A page 11 in-place answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=7.0):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru11",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                def put_fraction(num, den, x, y):
                    width = max(len(num), len(den)) * 4.3
                    page.insert_text(fitz.Point(x, y - 5.0), num, fontsize=5.8, fontname="aru11", fontfile=unicode_font, color=answer_color, overlay=True)
                    page.draw_line(fitz.Point(x - 0.6, y - 2.0), fitz.Point(x + width, y - 2.0), color=answer_color, width=0.45, overlay=True)
                    page.insert_text(fitz.Point(x, y + 4.8), den, fontsize=5.8, fontname="aru11", fontfile=unicode_font, color=answer_color, overlay=True)

                # Page 11 needs explicit Exercise 1A answer placement across
                # both the worked examples and the first exercise items.
                put(marker, 418, 690, 0.1)  # tiny marker to avoid duplicate overlays

                # Top examples 2(a), 2(b)
                put_fraction("8", "9", 102, 93)
                put_fraction("17", "33", 260, 93)

                # Top examples 3(a)-(d): center each real/imaginary-part
                # answer directly over its actual underline blank (found from
                # the PDF's own drawing commands), instead of estimating an
                # offset from the "(a)/(b)/(c)/(d)" label text.
                ex3_underlines = find_answer_underlines(page, y_min=160, y_max=195, min_len=30, max_len=60)
                ex3_answers = ["6", "1", "3", "−π", "0", "7", "5", "−2"]
                for idx, underline in enumerate(ex3_underlines[: len(ex3_answers)]):
                    put_centered(
                        page,
                        ex3_answers[idx],
                        underline,
                        dy=-2.0,
                        size=6.6,
                        fontname="aru11",
                        fontfile=unicode_font,
                        color=answer_color,
                    )

                # Exercise 1A Q1(a)-(d): anchor answers to the end of each
                # extracted prompt row, matching Foxit-style inline reveals.
                q1_rows = find_text_rows(
                    page,
                    {
                        "1a": "Write down all the natural numbers.",
                        "1b": "Write down all the negative integers.",
                        "1c": "Write down all the rational numbers.",
                        "1d": "Write down all the irrational numbers.",
                    },
                    y_min=330,
                    y_max=425,
                )
                put_answers_after_prompts(
                    page,
                    q1_rows,
                    {
                        "1a": "3, 8",
                        "1b": "−6, −15",
                        "1c": "3, −2.5, 8, −6, 1/5, −15, 1.8̇",
                        "1d": "√7, π/4, √3/2",
                    },
                    x_pad=8,
                    max_x=292,
                    size=6.1,
                    fontname="aru11",
                    fontfile=unicode_font,
                    color=answer_color,
                )

                # Exercise 1A Q2(a)-(e): likewise place each T/F immediately
                # after the statement text, not in a separate guessed column.
                q2_rows = find_text_rows(
                    page,
                    {
                        "2a": "is a rational number.",
                        "2b": "is a fraction.",
                        "2c": "is an irrational number.",
                        "2d": "is a complex number.",
                        "2e": "is a real number.",
                    },
                    y_min=445,
                    y_max=560,
                )
                put_answers_after_prompts(
                    page,
                    q2_rows,
                    {"2a": "T", "2b": "F", "2c": "F", "2d": "T", "2e": "F"},
                    x_pad=8,
                    max_x=300,
                    size=6.8,
                    fontname="aru11",
                    fontfile=unicode_font,
                    color=answer_color,
                )

                # Exercise 1A Q3(a)-(f): classify each number list next to its
                # "(a)"-style label instead of using guessed row y-values.
                q3_labels = find_item_labels(
                    page,
                    {"(a)", "(b)", "(c)", "(d)", "(e)", "(f)"},
                    y_min=598,
                    y_max=662,
                )
                put_after_labels(
                    page,
                    {k: v for k, v in q3_labels.items() if k in {"(a)", "(c)", "(e)"}},
                    {"(a)": "N, Z, Q, R, C", "(c)": "R, C", "(e)": "Q, R, C"},
                    x_pad=44,
                    size=6.0,
                    fontname="aru11",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                put_after_labels(
                    page,
                    {k: v for k, v in q3_labels.items() if k in {"(b)", "(d)", "(f)"}},
                    {"(b)": "Z, Q, R, C", "(d)": "C", "(f)": "C"},
                    x_pad=32,
                    size=6.0,
                    fontname="aru11",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                modified += 1

        if doc.page_count >= 12:
            page = doc[11]
            existing_text = page.get_text()
            marker = "Exercise 1A page 12 Foxit-style answers:"
            if marker not in existing_text:
                answer_color = (1.0, 0.0, 0.42)
                box_fill = (1.0, 0.965, 0.985)
                unicode_font = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

                def put(text, x, y, size=6.1):
                    page.insert_text(
                        fitz.Point(x, y),
                        text,
                        fontsize=size,
                        fontname="aru12",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                def put_box(rect, text, size=5.9):
                    page.insert_textbox(
                        rect,
                        text,
                        fontsize=size,
                        fontname="aru12",
                        fontfile=unicode_font,
                        color=answer_color,
                        align=fitz.TEXT_ALIGN_LEFT,
                        overlay=True,
                    )

                page.insert_text(fitz.Point(420, 80), marker, fontsize=0.1, fontname="aru12", fontfile=unicode_font, color=(1, 1, 1), overlay=True)

                # Foxit-style answer box on the right for Q4-7 and Q12-15.
                ans_rect = fitz.Rect(432, 118, 574, 308)
                page.draw_rect(ans_rect, color=answer_color, fill=box_fill, width=0.55, overlay=True)
                put("✱ Ans", 446, 132, 8.2)
                put_box(
                    fitz.Rect(447, 141, 568, 303),
                    "4. (a) 0.7\n   (b) terminating decimal\n"
                    "5. (a) 0.325\n   (b) terminating decimal\n"
                    "6. (a) 0.8̇\n   (b) recurring decimal\n"
                    "7. (a) 1.09̇\n   (b) recurring decimal\n"
                    "12. real part = 3,\n    imaginary part = 7\n"
                    "13. real part = −3√3,\n    imaginary part = 5\n"
                    "14. real part = 0,\n    imaginary part = −4\n"
                    "15. real part = −1 + √10,\n    imaginary part = 0",
                    5.45,
                )

                # Q8-11 inline fraction answers: anchor each answer to the
                # actual end of its own numbered item ("8.", "9.", "10.",
                # "11.") on the shared row, instead of assuming fixed
                # start/end columns that can drift if the item text reflows.
                q8_11_items = find_numbered_item_ends(
                    page, {"8.", "9.", "10.", "11."}, y_min=175, y_max=195
                )
                q8_11_answers = {"8.": "1/9", "9.": "16/9", "10.": "1/30", "11.": "7/45"}
                for label, answer in q8_11_answers.items():
                    if label not in q8_11_items:
                        continue
                    box, end_x = q8_11_items[label]
                    page.insert_text(
                        fitz.Point(end_x + 8, box.y1 - 1.6),
                        answer,
                        fontsize=6.0,
                        fontname="aru12",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )
                if "9." in q8_11_items:
                    box9, end9 = q8_11_items["9."]
                    put("(or 1 7/9)", end9 + 8, box9.y1 + 9.5, 4.8)

                # Q16 example answers: anchor to the ends of the condition
                # prompt rows so the answer starts exactly after the text.
                q16_rows = find_text_rows(
                    page,
                    {
                        "16a": "A rational number but not an integer",
                        "16b": "A complex number but not a real number",
                    },
                    y_min=315,
                    y_max=356,
                )
                put_answers_after_prompts(
                    page,
                    q16_rows,
                    {
                        "16a": "7/4, 8/3  (or other reasonable answers)",
                        "16b": "1 + i, 2 − 3i",
                    },
                    x_pad=9,
                    max_x=281,
                    size=5.8,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                if "16b" in q16_rows:
                    put("(or other reasonable answers)", min(q16_rows["16b"].x1 + 9, 281), q16_rows["16b"].y0 + 22.5, 4.9)

                # Q17 rational / irrational labels: anchor each answer past
                # the full extent of its own formula/text on that row,
                # instead of assuming fixed row bands or offsets.
                q17_labels = find_item_labels(
                    page,
                    {"(a)", "(b)", "(c)", "(d)", "(e)", "(f)"},
                    y_min=424,
                    y_max=486,
                )
                q17_ends = find_row_column_ends(page, q17_labels, split_x=200)
                q17_answers = {
                    "(a)": "rational",
                    "(b)": "irrational",
                    "(c)": "rational",
                    "(d)": "irrational",
                    "(e)": "rational",
                    "(f)": "irrational",
                }
                for key, answer in q17_answers.items():
                    end_x = q17_ends.get(key)
                    box = q17_labels.get(key)
                    if end_x is None or box is None:
                        continue
                    page.insert_text(
                        fitz.Point(end_x + 10, box.y1 - 1.6),
                        answer,
                        fontsize=5.8,
                        fontname="aru12",
                        fontfile=unicode_font,
                        color=answer_color,
                        overlay=True,
                    )

                # Q18 truth values: anchor after the statement text. Q18(b)
                # wraps, so use the second line's block when available.
                q18_rows = find_text_rows(
                    page,
                    {
                        "18a": "cannot be a rational number.",
                    },
                    y_min=530,
                    y_max=588,
                )
                q18b_tail = find_text_rows(
                    page,
                    {"18b": "number."},
                    y_min=568,
                    y_max=588,
                )
                q18_rows.update(q18b_tail)
                put_answers_after_prompts(
                    page,
                    q18_rows,
                    {"18a": "F", "18b": "F"},
                    x_pad=8,
                    max_x=366,
                    size=6.2,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )

                # Q19-24 fractions.
                put_spread_row(
                    page,
                    [{"text": "8/33"}, {"text": "5/66"}, {"text": "139/110"}],
                    624,
                    start_x=121,
                    end_x=373,
                    min_gap=24,
                    size=6.0,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                put("(or 1 29/110)", 342, 634, 4.8)
                put_spread_row(
                    page,
                    [{"text": "5/37"}, {"text": "1/27"}, {"text": "176/111"}],
                    651,
                    start_x=106,
                    end_x=373,
                    min_gap=28,
                    size=6.0,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                put("(or 1 65/111)", 342, 661, 4.8)

                # Q25: anchor the conversion answers to the Q25(a) prompt row,
                # then spread the true/false answers over the two sub-items.
                q25_rows = find_text_rows(
                    page,
                    {"25a": "Convert .0 06", "25b": "Determine whether each"},
                    y_min=660,
                    y_max=705,
                )
                put_answers_after_prompts(
                    page,
                    q25_rows,
                    {"25a": "0.06̇ = 2/33,  0.30̇ = 10/33"},
                    x_pad=10,
                    max_x=279,
                    size=5.8,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )
                put_spread_row(
                    page,
                    [{"text": "yes"}, {"text": "no"}],
                    723,
                    start_x=177,
                    end_x=367,
                    min_gap=64,
                    size=5.8,
                    fontname="aru12",
                    fontfile=unicode_font,
                    color=answer_color,
                )
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