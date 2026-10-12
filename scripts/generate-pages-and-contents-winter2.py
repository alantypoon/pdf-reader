#!/var/www/html/pdf-reader/.venv/bin/python3
"""
generate-pages-and-contents-winter2.py

Usage:
    python3 scripts/generate-pages-and-contents-winter2.py            # all topics
    python3 scripts/generate-pages-and-contents-winter2.py 2 5        # only chapters 2 and 5
    python3 scripts/generate-pages-and-contents-winter2.py --force    # re-copy PDFs and re-render pages

Builds data/textbooks/chemistry-winter2 (the page images of the video-tutor
"Winter Intensive Course" notes) the same way data/textbooks/chemistry-winter
is laid out, using the winter2 video-tutor folder as the source:

    Source:
        /var/www/html/video-tutor/subjects/chemistry/winter2/CONSTANTS-20261001.js
            TOPICS[].name           → topic folder under winter2/videos/
            TOPICS[].notes          → notes PDF in that topic folder
            TOPICS[].notes_chapter  → chapter id in the textbook

        winter2/videos/<topic name>/<notes>.pdf
            (falls back to any PDF in the topic folder starting with the chapter
             number, e.g. "02 Intensive Microscopic World I.pdf")

    Output:
        data/textbooks/chemistry-winter2/<chapter>/en/contents/<chapter>.pdf
        data/textbooks/chemistry-winter2/<chapter>/en/contents/pages/<chapter>-<page>.png
        data/textbooks/chemistry-winter2/<chapter>/contents.json

    Steps per chapter:
        1. Copy the notes PDF into <chapter>/en/contents/<chapter>.pdf
           (skipped when the copy is already up to date).
        2. Split the PDF into page images with split_pdfs() of
           generate-pages-and-contents.py (existing images are kept unless --force).
        3. Write contents.json with the root book name (nameEn / nameZh) taken
           from CHEMISTRY_BOOK_NAMES of generate-pages-and-contents.py.

    The video-tutor notes drawer reads the pages through the symlink
        winter2/textbook -> /var/www/html/pdf-reader/data/textbooks/chemistry-winter2
"""

import argparse
import glob
import importlib.util
import json
import os
import re
import shutil
import sys


WINTER2_DIR = "/var/www/html/video-tutor/subjects/chemistry/winter2"
DEFAULT_CONSTANTS = os.path.join(WINTER2_DIR, "CONSTANTS-20261001.js")
SUBJECT_ID = "chemistry-winter2"


def _load_reference_module(script_dir):
    """Import generate-pages-and-contents.py (hyphenated name, so not importable directly)."""
    path = os.path.join(script_dir, "generate-pages-and-contents.py")
    spec = importlib.util.spec_from_file_location("generate_pages_and_contents", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_topics(constants_path):
    """Return [(topic name, notes file, chapter)] from the TOPICS of a CONSTANTS file."""
    with open(constants_path, "r", encoding="utf-8") as f:
        text = f.read()
    topics = []
    for m in re.finditer(r"\{\s*name:\s*'(Topic [^']+)'(.*?)chapters:", text, re.S):
        name, body = m.group(1), m.group(2)
        notes = re.search(r"notes:\s*'([^']+)'", body)
        chapter = re.search(r"notes_chapter:\s*(\d+)", body)
        notes = notes.group(1) if notes else ""
        if chapter:
            chapter = chapter.group(1)
        else:
            lead = re.match(r"0*(\d+)", notes)
            chapter = lead.group(1) if lead else ""
        if chapter:
            topics.append((name, notes, chapter))
    return topics


def find_notes_pdf(topic_dir, notes, chapter):
    """Locate the notes PDF of a topic: the CONSTANTS notes file, else a PDF named "<chapter>...".pdf."""
    if notes:
        path = os.path.join(topic_dir, notes)
        if os.path.isfile(path):
            return os.path.realpath(path)
    candidates = sorted(
        p for p in glob.glob(os.path.join(topic_dir, "*.pdf"))
        if re.match(r"0*%s\D" % re.escape(chapter), os.path.basename(p))
        and not os.path.islink(p)
    )
    return candidates[0] if candidates else None


def copy_pdf(src, dest, force):
    if (not force and os.path.isfile(dest)
            and os.path.getsize(dest) == os.path.getsize(src)
            and os.path.getmtime(dest) >= os.path.getmtime(src)):
        print(f"  [up to date] {dest}")
        return False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(src, dest)
    print(f"  Copied {os.path.basename(src)} → {dest}")
    return True


def clear_pages(pages_dir, chapter, image_format):
    removed = 0
    for path in glob.glob(os.path.join(pages_dir, f"{chapter}-*.{image_format}")):
        os.remove(path)
        removed += 1
    if removed:
        print(f"  Removed {removed} old page images")


def write_contents_json(ref, book_dir, chapter, topic_name):
    contents_path = os.path.join(book_dir, "contents.json")
    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = ref._create_skeleton_from_pdfs(book_dir)

    # "Topic II - Microscopic World I" → "Microscopic World I" when the chapter is not in CHEMISTRY_BOOK_NAMES
    fallback_en = topic_name.split(" - ", 1)[-1]
    name_en, name_zh = ref.CHEMISTRY_BOOK_NAMES.get(chapter, (fallback_en, fallback_en))
    data["name"] = name_en
    data["nameEn"] = name_en
    data["nameZh"] = name_zh

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    print(f"  Wrote {contents_path} ({name_en} / {name_zh})")


def main():
    parser = argparse.ArgumentParser(
        description="Generate chemistry-winter2 textbook pages and contents.json from the video-tutor winter2 notes PDFs"
    )
    parser.add_argument("chapters", nargs="*", help="Only process these chapter ids (default: all topics in CONSTANTS)")
    parser.add_argument("--constants", default=DEFAULT_CONSTANTS, help=f"CONSTANTS file (default: {DEFAULT_CONSTANTS})")
    parser.add_argument("--dpi", type=int, default=200, help="Output resolution in DPI (default: 200)")
    parser.add_argument("--format", choices=("png", "jpg"), default="png", help="Output image format (default: png)")
    parser.add_argument("-f", "--force", action="store_true", help="Re-copy the PDFs and re-render all page images")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    subject_dir = os.path.join(base_dir, "data", "textbooks", SUBJECT_ID)
    ref = _load_reference_module(script_dir)

    if not os.path.isfile(args.constants):
        print(f"ERROR: CONSTANTS file not found: {args.constants}", file=sys.stderr)
        sys.exit(1)
    videos_dir = os.path.join(os.path.dirname(args.constants), "videos")

    topics = parse_topics(args.constants)
    if args.chapters:
        topics = [t for t in topics if t[2] in args.chapters]
    if not topics:
        print("ERROR: no matching topics in CONSTANTS", file=sys.stderr)
        sys.exit(1)

    os.makedirs(subject_dir, exist_ok=True)
    done, missing = [], []

    for name, notes, chapter in topics:
        print("\n" + "#" * 60)
        print(f"  Chapter {chapter}: {name}")
        print("#" * 60)

        src = find_notes_pdf(os.path.join(videos_dir, name), notes, chapter)
        if not src:
            print(f"  [skip] no notes PDF in {os.path.join(videos_dir, name)}/")
            missing.append(chapter)
            continue

        book_dir = os.path.join(subject_dir, chapter)
        contents_dir = os.path.join(book_dir, "en", "contents")
        pages_dir = os.path.join(contents_dir, "pages")

        copied = copy_pdf(src, os.path.join(contents_dir, f"{chapter}.pdf"), args.force)
        if copied or args.force:
            clear_pages(pages_dir, chapter, args.format)

        ref.split_pdfs(book_dir, args)
        write_contents_json(ref, book_dir, chapter, name)
        done.append(chapter)

    print("\n" + "=" * 60)
    print(f"  Generated: {', '.join(done) or '-'}")
    if missing:
        print(f"  No notes PDF yet: {', '.join(missing)}")
    print("\nDone.")


if __name__ == "__main__":
    main()
