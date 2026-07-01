#!/usr/bin/env python3
"""
all-in-one.py

Usage:
    python3 scripts/all-in-one.py biology-oup/1a

Output:
    1. Splits each multi-page PDF into individual PNG images.

        This reads every PDF in:
            data/biology-oup/1a/en/contents/*.pdf
            data/biology-oup/1a/tc/contents/*.pdf

        and writes numbered PNGs into:
            data/biology-oup/1a/en/contents/pages/1-1.png   (section 1, page 1)
            data/biology-oup/1a/en/contents/pages/1-2.png   (section 1, page 2)
            ...
            data/biology-oup/1a/tc/contents/pages/1-1.png
            
    2. Reads all resource files and updates <book>/contents.json by filling resources into the correct section.

            <book>/contents.json e.g. data/biology-oup/1a/contents.json

            data/biology-oup/1a/en/resources/resource-*.json
            data/biology-oup/1a/tc/resources/resource-*.json

        The section number is extracted from the part before the hyphen in the
        "page" field of each resource (e.g., "6" from "6-5").
        

    3. Fixes resource URLs in contents.json that are missing the /isolution-web/
        path segment.

        Before:
            https://isolution.oupchina.com.hk/.iSolution/ebook_user_content/...

        After:
            https://isolution.oupchina.com.hk/isolution-web/.iSolution/ebook_user_content/...


"""

import argparse
import glob
import json
import os
import re
import sys
from urllib.parse import urlparse
from urllib.request import urlretrieve

import fitz  # PyMuPDF


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 1 — PDF splitting
# ═══════════════════════════════════════════════════════════════════════════════

def split_pdfs(data_dir, args):
    """Split multi-page PDFs into individual PNG (or JPG) images."""
    for language in ("en", "tc"):
        lang_dir = os.path.join(data_dir, language)
        if not os.path.isdir(lang_dir):
            print(f"  [skip] {lang_dir} — not found")
            continue

        # PDFs live under {lang}/contents/
        contents_dir = os.path.join(lang_dir, "contents")
        if not os.path.isdir(contents_dir):
            print(f"  [skip] {contents_dir} — not found")
            continue

        pages_dir = os.path.join(contents_dir, "pages")
        os.makedirs(pages_dir, exist_ok=True)

        # Collect ALL PDFs. Derive section name from filename stem:
        #   "1.pdf" → "1"
        #   "1.1-sba-157.pdf" → "1.1"
        #   "appendix.pdf" → "appendix"
        #   "cover.pdf" → "cover"  (fallback: whole stem)
        pdf_entries = []
        for f in os.listdir(contents_dir):
            if not f.endswith(".pdf"):
                continue
            stem = f[:-4]
            # If stem contains "-", use the part before the first "-" as section
            if "-" in stem:
                section = stem.split("-")[0]
            else:
                section = stem
            pdf_entries.append((section, f))

        if not pdf_entries:
            print(f"  [skip] {contents_dir} — no PDFs found")
            continue

        # Sort by section (try numeric first, then string)
        def _sort_key(entry):
            sec = entry[0]
            try:
                return (0, float(sec), "")
            except ValueError:
                return (1, 0, sec)

        pdf_entries.sort(key=_sort_key)

        print(f"\n{'='*60}")
        print(f"  {contents_dir}/")
        print(f"{'='*60}")

        for section_num, pdf_name in pdf_entries:
            pdf_path = os.path.join(contents_dir, pdf_name)

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


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 2 — Fill resources into contents.json
# ═══════════════════════════════════════════════════════════════════════════════

def _create_skeleton_from_pdfs(data_dir):
    """Create a skeleton contents.json from PDF files found in
    {en,tc}/contents/ directories."""
    sections = set()
    for lang in ("en", "tc"):
        contents_dir = os.path.join(data_dir, lang, "contents")
        if not os.path.isdir(contents_dir):
            continue
        for f in os.listdir(contents_dir):
            if not f.endswith(".pdf"):
                continue
            stem = f[:-4]
            # Derive section: part before first "-", or whole stem
            if "-" in stem:
                sec = stem.split("-")[0]
            else:
                sec = stem
            sections.add(sec)

    if not sections:
        return None

    # Sort sections naturally: try numeric first, then string
    def _sort_sec(s):
        try:
            return (0, float(s), "")
        except ValueError:
            return (1, 0, s)

    chapter_name = os.path.basename(data_dir)
    skeleton = {
        "chapter": chapter_name,
        "contents": []
    }
    for sec in sorted(sections, key=_sort_sec):
        # page field: use int if purely numeric, else float for 1.1 style
        try:
            page_num = int(sec)
        except ValueError:
            try:
                page_num = float(sec)
            except ValueError:
                page_num = sec
        skeleton["contents"].append({
            "section": sec,
            "page": page_num,
            "en": {"name": "", "resources": []},
            "tc": {"name": "", "resources": []},
        })
    return skeleton


def fill_resources(data_dir):
    """Read resource-*.json files and merge them into contents.json."""
    contents_path = os.path.join(data_dir, "contents.json")

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            contents = json.load(f)
    else:
        # Create skeleton from PDF files so we have sections to fill into
        contents = _create_skeleton_from_pdfs(data_dir)
        if not contents:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(contents, f, ensure_ascii=False, indent=4)
        print(f"  Created skeleton {contents_path} ({len(contents['contents'])} sections)")

    # Build lookup: section (str) → {"en": [...], "tc": [...]}
    # Preserve any resources already present in contents.json.
    section_map = {}
    for item in contents.get("contents", []):
        sec = item["section"]
        section_map[sec] = {
            "en": list(item.get("en", {}).get("resources", [])),
            "tc": list(item.get("tc", {}).get("resources", [])),
        }

    # Merge in any newly discovered sections from PDFs that aren't in
    # contents.json yet (e.g. "1.1" alongside existing "1").
    skeleton = _create_skeleton_from_pdfs(data_dir)
    if skeleton:
        for item in skeleton.get("contents", []):
            sec = item["section"]
            if sec not in section_map:
                section_map[sec] = {"en": [], "tc": []}
                contents["contents"].append(item)
                print(f"  Added new section {sec} from PDFs")

    # Read resource files from {data_dir}/{lang}/resources/resource*.json
    for lang in ("en", "tc"):
        resources_dir = os.path.join(data_dir, lang, "resources")
        if not os.path.isdir(resources_dir):
            print(f"  [skip] {resources_dir} — not found")
            continue

        pattern = os.path.join(resources_dir, "resource*.json")
        resource_files = sorted(glob.glob(pattern))

        if not resource_files:
            print(f"  [skip] {resources_dir} — no resource*.json files")
            continue

        print(f"\n  Reading {len(resource_files)} resource file(s) from {resources_dir}/")

        for filepath in resource_files:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            for content_item in data.get("contents", []):
                # Process both en and tc from each file (some files have both)
                for res_lang in ("en", "tc"):
                    resources = content_item.get(res_lang, {}).get("resources", [])
                    for res in resources:
                        page = res.get("page", "")
                        if not page or "-" not in str(page):
                            continue

                        section_num = str(page).split("-")[0]
                        if section_num not in section_map:
                            continue

                        # Deduplicate by URL
                        existing_urls = {
                            r.get("url", "") for r in section_map[section_num][res_lang]
                        }
                        if res.get("url", "") not in existing_urls:
                            section_map[section_num][res_lang].append(res)

    # Write back to contents.json
    for item in contents["contents"]:
        sec = item["section"]
        if sec in section_map:
            if "en" not in item:
                item["en"] = {}
            if "tc" not in item:
                item["tc"] = {}
            item["en"]["resources"] = section_map[sec]["en"]
            item["tc"]["resources"] = section_map[sec]["tc"]

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    # Summary
    print(f"\n  Updated {contents_path}")
    total_en = 0
    total_tc = 0
    def _summary_sort_key(s):
        try:
            return (0, float(s), "")
        except ValueError:
            return (1, 0, s)
    for sec in sorted(section_map.keys(), key=_summary_sort_key):
        en_n = len(section_map[sec]["en"])
        tc_n = len(section_map[sec]["tc"])
        total_en += en_n
        total_tc += tc_n
        print(f"    Section {sec}: {en_n:3d} EN, {tc_n:3d} TC")

    print(f"    Total:       {total_en:3d} EN, {total_tc:3d} TC")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 3 — Fix resource URLs
# ═══════════════════════════════════════════════════════════════════════════════

def fix_url(url):
    """Insert /isolution-web/ after the host for isolution.oupchina.com.hk URLs
    that are missing it."""
    if not isinstance(url, str):
        return url

    # Already correct — do nothing
    if "/isolution-web/.iSolution/" in url:
        return url

    # Needs fixing
    prefix = "https://isolution.oupchina.com.hk/.iSolution/"
    if prefix in url:
        return url.replace(
            "https://isolution.oupchina.com.hk/.iSolution/",
            "https://isolution.oupchina.com.hk/isolution-web/.iSolution/",
        )
    return url


def fix_urls_in_resources(resources):
    """Fix all resource URLs in a resources list. Returns count of fixed URLs."""
    count = 0
    for res in resources:
        old = res.get("url", "")
        new = fix_url(old)
        if new != old:
            res["url"] = new
            count += 1
    return count


def fix_urls(data_dir):
    """Fix resource URLs in contents.json that are missing /isolution-web/."""
    contents_path = os.path.join(data_dir, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    total = 0
    for section in data.get("contents", []):
        for lang in ("en", "tc"):
            resources = section.get(lang, {}).get("resources", [])
            n = fix_urls_in_resources(resources)
            if n:
                print(f"    section {section['section']} {lang}: fixed {n} URL(s)")
            total += n

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"\n  Fixed {total} URL(s) in {contents_path}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 4 — Download MP3 resources
# ═══════════════════════════════════════════════════════════════════════════════

def download_mp3s(data_dir):
    """Download all MP3 resources referenced in contents.json to local mp3s/
    folders and rewrite URLs to local paths."""

    contents_path = os.path.join(data_dir, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    book = data.get("chapter", os.path.basename(data_dir))
    total_downloaded = 0
    total_skipped = 0
    total_errors = 0

    for section in data.get("contents", []):
        sec = section["section"]
        for lang in ("en", "tc"):
            resources = section.get(lang, {}).get("resources", [])
            for res in resources:
                url = res.get("url", "")
                if not url or not re.search(r'\.mp3(\?|$)', url, re.IGNORECASE):
                    continue

                # Derive local filename from the last path segment
                parsed = urlparse(url)
                filename = os.path.basename(parsed.path)
                if not filename:
                    filename = f"audio_{abs(hash(url))}.mp3"

                # Local directory: data/{book}/{lang}/mp3s/
                mp3_dir = os.path.join(data_dir, lang, "mp3s")
                os.makedirs(mp3_dir, exist_ok=True)
                local_path = os.path.join(mp3_dir, filename)

                if os.path.exists(local_path):
                    total_skipped += 1
                else:
                    try:
                        print(f"    downloading {filename} ...", end=" ", flush=True)
                        urlretrieve(url, local_path)
                        print("ok")
                        total_downloaded += 1
                    except Exception as e:
                        print(f"FAILED ({e})")
                        total_errors += 1
                        continue

                # Rewrite URL to local path.
                # data_dir is e.g. .../data/biology-oup/1a
                # Build relative path: biology-oup/1a
                parts = os.path.normpath(data_dir).split(os.sep)
                rel_book = os.sep.join(parts[-2:])  # e.g. "biology-oup/1a"
                local_url = f"/pdf-reader/data/{rel_book}/{lang}/mp3s/{filename}"
                res["url"] = local_url

    if total_downloaded or total_skipped or total_errors:
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"\n  MP3s: {total_downloaded} downloaded, {total_skipped} skipped, "
          f"{total_errors} errors  → {contents_path}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="All-in-one: split PDFs, fill resources, and fix URLs"
    )
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
    parser.add_argument(
        "--skip-pdfs",
        action="store_true",
        help="Skip step 1 (PDF splitting)",
    )
    parser.add_argument(
        "--skip-resources",
        action="store_true",
        help="Skip step 2 (fill resources)",
    )
    parser.add_argument(
        "--skip-urls",
        action="store_true",
        help="Skip step 3 (fix URLs)",
    )
    parser.add_argument(
        "--skip-mp3s",
        action="store_true",
        help="Skip step 4 (download MP3s)",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_dir = os.path.join(base_dir, "data", args.chapter_path)

    if not os.path.isdir(data_dir):
        print(f"ERROR: directory not found: {data_dir}", file=sys.stderr)
        sys.exit(1)

    # Determine if chapter_path points to a parent directory (e.g. biology-oup)
    # containing multiple books, or to a single book (e.g. biology-oup/1a).
    # A book directory contains an "en/" (and optionally "tc/") subdirectory.
    subdirs = sorted(
        d for d in os.listdir(data_dir)
        if os.path.isdir(os.path.join(data_dir, d))
        and os.path.isdir(os.path.join(data_dir, d, "en"))
    )

    if subdirs:
        books = subdirs
    else:
        books = [None]  # single book — data_dir itself is the book

    for i, book in enumerate(books):
        if book is not None:
            book_dir = os.path.join(data_dir, book)
            label = f"{args.chapter_path}/{book}"
        else:
            book_dir = data_dir
            label = args.chapter_path

        if i > 0:
            print("\n\n")

        print("#" * 60)
        print(f"  Book: {label}")
        print("#" * 60)

        # ── Step 1: Split PDFs ──────────────────────────────────────
        if not args.skip_pdfs:
            print("\n" + "=" * 60)
            print("  Step 1 — Splitting PDFs into images")
            print("=" * 60)
            split_pdfs(book_dir, args)
        else:
            print("[skip] Step 1 — PDF splitting")

        # ── Step 2: Fill resources ──────────────────────────────────
        if not args.skip_resources:
            print("\n" + "=" * 60)
            print("  Step 2 — Filling resources into contents.json")
            print("=" * 60)
            fill_resources(book_dir)
        else:
            print("[skip] Step 2 — Fill resources")

        # ── Step 3: Fix URLs ────────────────────────────────────────
        if not args.skip_urls:
            print("\n" + "=" * 60)
            print("  Step 3 — Fixing resource URLs")
            print("=" * 60)
            fix_urls(book_dir)
        else:
            print("[skip] Step 3 — Fix URLs")

        # ── Step 4: Download MP3s ──────────────────────────────────
        if not args.skip_mp3s:
            print("\n" + "=" * 60)
            print("  Step 4 — Downloading MP3 resources")
            print("=" * 60)
            download_mp3s(book_dir)
        else:
            print("[skip] Step 4 — Download MP3s")

    print("\nDone.")


if __name__ == "__main__":
    main()
