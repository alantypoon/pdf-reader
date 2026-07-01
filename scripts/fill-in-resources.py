#!/usr/bin/env python3
"""
fill-in-resources.py

Reads all resources/resources_*.json files and updates resources/contents.json
by filling resources into the correct section.

The section number is extracted from the part before the hyphen in the
"page" field of each resource (e.g., "6" from "6-5").
Resources are deduplicated by URL.
"""

import json
import glob
import os
import sys


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    resources_dir = os.path.join(base_dir, "resources")

    # ── 1. Load contents.json ──────────────────────────────────────────
    contents_path = os.path.join(resources_dir, "contents.json")
    if not os.path.exists(contents_path):
        print(f"ERROR: {contents_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(contents_path, "r", encoding="utf-8") as f:
        contents = json.load(f)

    # Build lookup: section (str) -> {"en": [...], "tc": [...]}
    # Preserve any resources already present in contents.json.
    section_map = {}
    for item in contents["contents"]:
        sec = item["section"]
        section_map[sec] = {
            "en": list(item["en"]["resources"]),
            "tc": list(item["tc"]["resources"]),
        }

    # ── 2. Read all resources_*.json files ─────────────────────────────
    pattern = os.path.join(resources_dir, "resources_*.json")
    resource_files = sorted(glob.glob(pattern))

    if not resource_files:
        print("WARNING: No resources_*.json files found", file=sys.stderr)

    for filepath in resource_files:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        for content_item in data.get("contents", []):
            for lang in ("en", "tc"):
                resources = content_item.get(lang, {}).get("resources", [])
                for res in resources:
                    page = res.get("page", "")
                    if not page or "-" not in str(page):
                        continue

                    section_num = str(page).split("-")[0]
                    if section_num not in section_map:
                        continue

                    # Deduplicate by URL
                    existing_urls = {
                        r.get("url", "") for r in section_map[section_num][lang]
                    }
                    if res.get("url", "") not in existing_urls:
                        section_map[section_num][lang].append(res)

    # ── 3. Write back to contents.json ─────────────────────────────────
    for item in contents["contents"]:
        sec = item["section"]
        if sec in section_map:
            item["en"]["resources"] = section_map[sec]["en"]
            item["tc"]["resources"] = section_map[sec]["tc"]

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    # ── 4. Summary ─────────────────────────────────────────────────────
    print(f"Updated {contents_path}")
    total_en = 0
    total_tc = 0
    for sec in sorted(section_map.keys(), key=lambda s: int(s) if s.isdigit() else s):
        en_n = len(section_map[sec]["en"])
        tc_n = len(section_map[sec]["tc"])
        total_en += en_n
        total_tc += tc_n
        print(f"  Section {sec}: {en_n:3d} EN, {tc_n:3d} TC")

    print(f"  Total:       {total_en:3d} EN, {total_tc:3d} TC")


if __name__ == "__main__":
    main()
