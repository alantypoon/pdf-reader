#!/usr/bin/env python3
"""
Copy biology OUP TN (teacher's notes) PDFs from _ref/biology-oup-tn/ to
data/biology-oup/ with watermark removal.

Source layout:
    _ref/biology-oup-tn/
        en/NSSBIO3E_SB<bookId>_Ch<sectionId>_e.pdf
        tc/NSSBIO3E_SB<bookId>_Ch<sectionId>_c.pdf

Target layout:
    data/biology-oup/<bookId_lower>/en/contents.tn/<sectionId>.pdf
    data/biology-oup/<bookId_lower>/tc/contents.tn/<sectionId>.pdf

Rules:
    - bookId is lowercased for the target path
    - sectionId is zero-padded to 2 digits
    - e → en, c → tc
    - Does NOT overwrite existing target files
    - Creates contents.tn folders when they don't exist
    - Removes watermark before writing the target file
"""

import os
import re
import sys
import shutil
import tempfile

# Allow importing remove_watermark from the same directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from remove_watermark import remove_watermarks, WatermarkRemovalError

BASE_DIR = "/var/www/html/pdf-reader"
SOURCE_DIR = os.path.join(BASE_DIR, "_ref", "biology-oup-tn")
TARGET_ROOT = os.path.join(BASE_DIR, "data", "biology-oup")

# Pattern: NSSBIO3E_SB<bookId>_Ch<sectionId>_<e|c>.pdf
FILE_PATTERN = re.compile(
    r"^NSSBIO3E_SB(\w+)_Ch(\d+)_([ec])\.pdf$"
)

LANG_MAP = {"e": "en", "c": "tc"}


def main():
    # Parse optional filter: "book/section" e.g. "1a/1" or "1a/01"
    # and optional -f/--force flag to overwrite existing target files.
    args = sys.argv[1:]
    force = False
    if "-f" in args:
        force = True
        args.remove("-f")
    if "--force" in args:
        force = True
        args.remove("--force")

    filter_book = None
    filter_section = None
    if len(args) >= 1:
        filter_arg = args[0]
        if "/" in filter_arg:
            parts = filter_arg.split("/", 1)
            filter_book = parts[0].lower()
            filter_section = parts[1].zfill(2)
            print(f"Filter: book={filter_book} section={filter_section}")
        else:
            filter_book = filter_arg.lower()
            print(f"Filter: book={filter_book} (all sections)")
    elif len(args) > 1:
        print(f"Usage: {os.path.basename(__file__)} [bookId/sectionId] [-f|--force]",
              file=sys.stderr)
        print(f"  Examples: {os.path.basename(__file__)} 1a/1", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 1a   (all sections in book 1a)", file=sys.stderr)
        print(f"            {os.path.basename(__file__)}      (all books, all sections)", file=sys.stderr)
        print(f"            {os.path.basename(__file__)} 1a/1 -f   (overwrite existing output)", file=sys.stderr)
        sys.exit(1)

    if force:
        print("Force mode: existing target files WILL be overwritten.")

    if not os.path.isdir(SOURCE_DIR):
        print(f"ERROR: Source directory not found: {SOURCE_DIR}", file=sys.stderr)
        sys.exit(1)

    total_copied = 0
    total_skipped = 0
    total_errors = 0

    for lang_dir_name in ["en", "tc"]:
        lang_src = os.path.join(SOURCE_DIR, lang_dir_name)
        if not os.path.isdir(lang_src):
            print(f"  Skipping missing language dir: {lang_src}")
            continue

        print(f"\nProcessing {lang_dir_name}/ ...")

        for fname in sorted(os.listdir(lang_src)):
            src_path = os.path.join(lang_src, fname)
            if not os.path.isfile(src_path):
                continue

            m = FILE_PATTERN.match(fname)
            if not m:
                print(f"  SKIP (no match): {fname}")
                continue

            book_id_raw = m.group(1)       # e.g. "1A", "E1"
            section_num = m.group(2)       # e.g. "1", "01"
            lang_char = m.group(3)         # "e" or "c"

            book_id = book_id_raw.lower()  # "1a", "e1"
            section_id = section_num.zfill(2)  # "01"
            lang = LANG_MAP.get(lang_char, lang_char)

            # Apply optional book/section filter
            if filter_book is not None and book_id != filter_book:
                continue
            if filter_section is not None and section_id != filter_section:
                continue

            # Verify that the language subdir matches the file's suffix
            if lang != lang_dir_name:
                print(f"  WARN: {fname} suffix={lang} but file is in {lang_dir_name}/, using suffix")
                # Still proceed with the suffix-based lang

            target_dir = os.path.join(TARGET_ROOT, book_id, lang, "contents.tn")
            target_path = os.path.join(target_dir, f"{section_id}.pdf")

            if os.path.exists(target_path) and not force:
                print(f"  SKIP (exists): {target_path}")
                total_skipped += 1
                continue

            # Create target directory if needed
            os.makedirs(target_dir, exist_ok=True)

            print(f"  COPY + watermark removal: {fname} → {target_path}")

            try:
                success = remove_watermarks(src_path, target_path)
                if success:
                    total_copied += 1
                    print(f"    OK")
                else:
                    # remove_watermarks returns False when no watermark found
                    # In that case, just copy the file as-is
                    shutil.copy2(src_path, target_path)
                    total_copied += 1
                    print(f"    OK (no watermark detected, copied as-is)")
            except WatermarkRemovalError as e:
                # Do NOT fall back to copying the watermarked file — that
                # would silently ship watermarked content.  Skip the file
                # and record it as an error so it can be investigated.
                print(f"    ERROR: watermark removal failed: {e}", file=sys.stderr)
                total_errors += 1
                if os.path.exists(target_path):
                    os.remove(target_path)
            except Exception as e:
                print(f"    ERROR: {e}", file=sys.stderr)
                total_errors += 1
                # Clean up partial target if created
                if os.path.exists(target_path):
                    os.remove(target_path)

    print(f"\nDone. Copied: {total_copied}, Skipped: {total_skipped}, Errors: {total_errors}")

    if total_errors > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()