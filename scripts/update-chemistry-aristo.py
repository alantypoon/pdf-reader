#!/usr/bin/env python3
"""
Update chemistry-aristo contents.json files with book names and section
names from chemistry-aristo.json.

Updates:
  - Top-level: name, nameEn, nameZh  (from book_title)
  - Per-section: en.name, tc.name    (from chapter english/chinese)
"""

import json
import os
import sys

DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHEM_DIR = os.path.join(DATA_DIR, "data", "chemistry-aristo")
REF_FILE = os.path.join(CHEM_DIR, "chemistry-aristo.json")


def book_key_to_dir(book_key: str) -> str:
    """Convert a book key like '1A' or '2 / 2A' to directory name like '1a' or '2a'."""
    # If there's a '/', take the part after it; otherwise use the whole key
    if "/" in book_key:
        key = book_key.split("/")[-1].strip()
    else:
        key = book_key.strip()
    return key.lower()


def load_reference():
    with open(REF_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def build_lookup(ref_data):
    """
    Build lookup dictionaries from the reference JSON.

    Returns:
        book_info: { dir_name: { "nameEn": ..., "nameZh": ..., "name": ... } }
        chapter_info: { dir_name: { chapter_number: { "en": ..., "tc": ... } } }
    """
    book_info = {}
    chapter_info = {}

    for book in ref_data.get("books", []):
        dir_name = book_key_to_dir(book["book"])
        title = book.get("book_title", {})

        book_info[dir_name] = {
            "name": title.get("english", ""),
            "nameEn": title.get("english", ""),
            "nameZh": title.get("chinese", ""),
        }

        chap_map = {}
        for ch in book.get("chapters", []):
            chap_map[ch["chapter_number"]] = {
                "en": ch.get("english", ""),
                "tc": ch.get("chinese", ""),
            }
        chapter_info[dir_name] = chap_map

    return book_info, chapter_info


def update_contents_json(contents_path, book_info, chapter_info, dir_name):
    """Update a single contents.json file."""
    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    modified = False

    # ── Update book-level names ──
    if dir_name in book_info:
        bi = book_info[dir_name]
        for key in ("name", "nameEn", "nameZh"):
            if data.get(key) != bi[key]:
                data[key] = bi[key]
                modified = True

    # ── Update section-level names ──
    chap_map = chapter_info.get(dir_name, {})
    for section in data.get("contents", []):
        raw_section = section.get("section", "")
        # Extract the integer part of the section (e.g., "1", "1.1", "19.1" → 1, 1, 19)
        try:
            section_int = int(str(raw_section).split(".")[0])
        except (ValueError, TypeError):
            continue

        if section_int in chap_map:
            names = chap_map[section_int]
            en_section = section.get("en", {})
            tc_section = section.get("tc", {})

            if isinstance(en_section, dict) and en_section.get("name") != names["en"]:
                en_section["name"] = names["en"]
                modified = True
            elif isinstance(en_section, str):
                # Handle case where en/tc is a string instead of dict
                section["en"] = {"name": names["en"], "resources": []}
                modified = True

            if isinstance(tc_section, dict) and tc_section.get("name") != names["tc"]:
                tc_section["name"] = names["tc"]
                modified = True
            elif isinstance(tc_section, str):
                section["tc"] = {"name": names["tc"], "resources": []}
                modified = True

    if modified:
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        print(f"  ✓ Updated: {contents_path}")
        return True
    else:
        print(f"  - No changes: {contents_path}")
        return False


def main():
    ref_data = load_reference()
    book_info, chapter_info = build_lookup(ref_data)

    print(f"Loaded reference: {len(book_info)} books, {sum(len(c) for c in chapter_info.values())} chapters")
    print()

    updated_count = 0
    skipped_count = 0

    for dir_name in sorted(os.listdir(CHEM_DIR)):
        dir_path = os.path.join(CHEM_DIR, dir_name)
        if not os.path.isdir(dir_path):
            continue

        contents_path = os.path.join(dir_path, "contents.json")
        if not os.path.exists(contents_path):
            continue

        print(f"Processing: {dir_name}/contents.json")
        if dir_name not in book_info:
            print(f"  ⚠ No reference found for '{dir_name}', skipping")
            skipped_count += 1
            continue

        if update_contents_json(contents_path, book_info, chapter_info, dir_name):
            updated_count += 1
        else:
            skipped_count += 1

    print()
    print(f"Done: {updated_count} updated, {skipped_count} unchanged/skipped")


if __name__ == "__main__":
    main()
