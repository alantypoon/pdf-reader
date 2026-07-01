#!/usr/bin/env python3
"""
split-pdf-pages.py

Splits each multi-page PDF into individual PNG images.

Usage:
    python3 scripts/split-pdf-pages.py biology-oup/1a

This reads every PDF in:
    data/biology-oup/1a/en/*.pdf
    data/biology-oup/1a/tc/*.pdf

and writes numbered PNGs into:
    data/biology-oup/1a/en/pages/1-1.png   (section 1, page 1)
    data/biology-oup/1a/en/pages/1-2.png   (section 1, page 2)
    ...
    data/biology-oup/1a/tc/pages/1-1.png
    ...
"""

import argparse
import os
import sys

import fitz  # PyMuPDF


def main():
    parser = argparse.ArgumentParser(description="Split PDF pages into PNG images")
    parser.add_argument(
        "chapter_path",
        help="Relative path under data/, e.g. biology-oup/1a",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=200,
        help="Output resolution in DPI (default: 200)",
    )
    parser.add_argument(
        "--format",
        choices=("png", "jpg"),
        default="png",
        help="Output image format (default: png)",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_dir = os.path.join(base_dir, "data", args.chapter_path)

    if not os.path.isdir(data_dir):
        print(f"ERROR: directory not found: {data_dir}", file=sys.stderr)
        sys.exit(1)

    for language in ("en", "tc"):
        lang_dir = os.path.join(data_dir, language)
        if not os.path.isdir(lang_dir):
            print(f"  [skip] {lang_dir} — not found")
            continue

        pages_dir = os.path.join(lang_dir, "pages")
        os.makedirs(pages_dir, exist_ok=True)

        pdf_files = sorted(
            f for f in os.listdir(lang_dir)
            if f.endswith(".pdf") and f[:-4].isdigit()
        )

        if not pdf_files:
            print(f"  [skip] {lang_dir} — no numbered PDFs")
            continue

        print(f"\n{'='*60}")
        print(f"  {lang_dir}/")
        print(f"{'='*60}")

        for pdf_name in pdf_files:
            section_num = pdf_name[:-4]  # e.g. "1" from "1.pdf"
            pdf_path = os.path.join(lang_dir, pdf_name)

            doc = fitz.open(pdf_path)
            num_pages = doc.page_count
            print(f"  {pdf_name} → {num_pages} pages")

            for page_idx in range(num_pages):
                page_num = page_idx + 1
                out_name = f"{section_num}-{page_num}.{args.format}"
                out_path = os.path.join(pages_dir, out_name)

                # Skip if already exists (resume support)
                if os.path.exists(out_path):
                    continue

                page = doc[page_idx]
                # Render at specified DPI
                mat = fitz.Matrix(args.dpi / 72, args.dpi / 72)
                pix = page.get_pixmap(matrix=mat)

                if args.format == "jpg":
                    pix.pil_save(out_path, optimize=True, quality=85)
                else:
                    pix.save(out_path)

            doc.close()

        # Summary
        existing = sorted(os.listdir(pages_dir))
        img_count = len([f for f in existing if f.endswith(f".{args.format}")])
        print(f"  → {img_count} images in {pages_dir}/")


if __name__ == "__main__":
    main()
