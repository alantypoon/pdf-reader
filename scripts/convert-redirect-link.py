#!/usr/bin/env python3
"""
convert-redirect-link.py

Loop through all contents.json files under data/biology-oup, find resource URLs
ending with .html, curl them, and if they contain a meta refresh redirect tag,
replace the "url" field with the redirect target (renaming the original to "url-orig").

Usage:
  python convert-redirect-link.py              # apply changes
  python convert-redirect-link.py --dry-run    # preview changes only
"""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "data" / "biology-oup"

# Regex to extract URL from <meta http-equiv="refresh" content="0;url=...">
META_REFRESH_RE = re.compile(
    r'<meta\s[^>]*http-equiv\s*=\s*["\']?\s*refresh\s*["\']?[^>]*'
    r'content\s*=\s*["\']?\s*\d+\s*;\s*url\s*=\s*(.+?)["\'\s>]',
    re.IGNORECASE,
)

# Fallback: simpler pattern
META_REFRESH_SIMPLE = re.compile(
    r'url\s*=\s*(.+?)["\'\s>]',
    re.IGNORECASE,
)


def extract_redirect_url(html_text: str) -> str | None:
    """Extract the redirect target from a meta refresh tag in HTML."""
    m = META_REFRESH_RE.search(html_text)
    if m:
        url = m.group(1).strip().strip('"').strip("'")
        return url if url else None

    # Try simpler pattern: find meta refresh then extract URL
    if 'http-equiv="refresh"' in html_text.lower() or "http-equiv='refresh'" in html_text.lower():
        m = META_REFRESH_SIMPLE.search(html_text)
        if m:
            url = m.group(1).strip().strip('"').strip("'")
            return url if url else None

    return None


# Regex to match keyterms mp3 paths like */mp3s/keyterms01_c.mp3 or */mp3s/keyterms02_e.mp3
KEYTERMS_MP3_RE = re.compile(r'/mp3s/(keyterms\d{2}_([ce]))\.mp3$', re.IGNORECASE)


def build_keyterms_orig_url(resource: dict) -> str | None:
    """
    If the resource URL is a local keyterms mp3, return the corresponding
    url-orig value (the OUP link .html that redirects to the mp3).
    Only applies if url-orig does NOT already exist.
    """
    url = resource.get("url", "")
    if not url or not isinstance(url, str):
        return None

    # Skip if already has url-orig
    if "url-orig" in resource:
        return None

    m = KEYTERMS_MP3_RE.search(url)
    if not m:
        return None

    filename = m.group(1)   # e.g. "keyterms01_c"
    # suffix = m.group(2)    # "c" or "e"
    return f"https://eresources.oupchina.com.hk/NSSBIO3E/link/{filename}.html"


def fetch_html(url: str) -> str | None:
    """Use curl to fetch the HTML content of a URL. Returns None on failure."""
    try:
        result = subprocess.run(
            ["curl", "-s", "-L", "--max-time", "15", "-A", "PDF-Reader/1.0", url],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            print(f"  [WARN] curl failed for {url}: {result.stderr.strip()}")
            return None
        return result.stdout
    except subprocess.TimeoutExpired:
        print(f"  [WARN] curl timed out for {url}")
        return None
    except Exception as e:
        print(f"  [WARN] curl error for {url}: {e}")
        return None


def extract_mp3_filename(redirect_url: str) -> str | None:
    """If the redirect URL ends with .mp3, extract the filename."""
    if not redirect_url:
        return None
    trimmed = redirect_url.strip().rstrip('/')
    if not trimmed.lower().endswith('.mp3'):
        return None
    # Extract just the filename from the URL
    return Path(trimmed).name or None


def find_local_mp3(contents_json_dir: Path, lang: str, mp3_filename: str) -> str | None:
    """
    Search for an mp3 file matching `mp3_filename` under
    <contents_json_dir>/<lang>/mp3s/ and return its /pdf-reader/... relative path
    if found.
    """
    mp3s_dir = contents_json_dir / lang / "mp3s"
    if not mp3s_dir.is_dir():
        return None

    for f in mp3s_dir.iterdir():
        if f.is_file() and f.name.lower() == mp3_filename.lower():
            # Build path relative to the pdf-reader root
            # contents_json_dir is e.g. .../data/biology-oup/1a
            # We need /pdf-reader/data/biology-oup/1a/<lang>/mp3s/<file>
            try:
                rel = f.relative_to(DATA_ROOT.parent.parent)  # goes up to pdf-reader
                return "/pdf-reader/" + str(rel).replace("\\", "/")
            except ValueError:
                # Fallback: construct from DATA_ROOT structure
                pass

    return None


def process_resource(resource: dict, contents_json_dir: Path, lang: str) -> str | None:
    """
    Check if a resource entry has an http(s) URL ending with .html that redirects.
    Returns the new URL to use, or None.
    
    Two modes:
    1. If the redirect target ends with .mp3 → find the local mp3 file and return its
       /pdf-reader/... path.
    2. Otherwise → return the redirect target URL directly.
    """
    url = resource.get("url", "")
    if not url or not isinstance(url, str):
        return None
    # Only handle http(s) URLs
    if not (url.startswith("http://") or url.startswith("https://")):
        return None
    if not url.lower().endswith(".html"):
        return None

    # Skip already-processed entries
    if "url-orig" in resource:
        return None

    print(f"  Checking: {url}")
    html = fetch_html(url)
    if html is None:
        return None

    redirect = extract_redirect_url(html)
    if not redirect:
        print(f"    -> No redirect found")
        return None

    print(f"    -> Redirect found: {redirect}")

    # ── Mode 1: redirect target ends with .mp3 → find local file ──
    mp3_filename = extract_mp3_filename(redirect)
    if mp3_filename:
        local_path = find_local_mp3(contents_json_dir, lang, mp3_filename)
        if local_path:
            print(f"    -> Mp3 redirect → local: {local_path}")
            return local_path
        else:
            print(f"    -> Mp3 redirect but no local match for: {mp3_filename}")
            return None

    # ── Mode 2: normal redirect → return the redirect URL ──
    return redirect


def process_contents_json(filepath: Path, dry_run: bool = False) -> int:
    """Process a single contents.json file. Returns number of changes made."""
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Processing: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    changes = 0
    contents_json_dir = filepath.parent  # e.g. .../data/biology-oup/1a
    contents = data.get("contents", [])
    for chapter in contents:
        for lang_key in ("en", "tc"):
            lang_data = chapter.get(lang_key, {})
            resources = lang_data.get("resources", [])
            for resource in resources:
                # ── Redirect processing (.html → target URL / local mp3) ──
                redirect = process_resource(resource, contents_json_dir, lang_key)
                if redirect:
                    changes += 1
                    if not dry_run:
                        resource["url-orig"] = resource.pop("url")
                        resource["url"] = redirect
                    else:
                        print(f"    [DRY RUN] Would replace:")
                        print(f"      url:      {resource['url']}")
                        print(f"      url-orig: {resource['url']}")
                        print(f"      new url:  {redirect}")

                # ── Keyterms mp3 reverse-mapping (local mp3 → OUP link) ──
                orig_url = build_keyterms_orig_url(resource)
                if orig_url:
                    changes += 1
                    if not dry_run:
                        resource["url-orig"] = orig_url
                    else:
                        print(f"    [DRY RUN] Would add url-orig:")
                        print(f"      url:      {resource['url']}")
                        print(f"      url-orig: {orig_url}")

    if changes > 0 and not dry_run:
        # Backup with datetime stamp
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = filepath.parent / f"contents-{timestamp}.json"
        shutil.copy2(filepath, backup_path)
        print(f"  Backed up to: {backup_path.name}")

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)
        # Add trailing newline
        with open(filepath, "a", encoding="utf-8") as f:
            f.write("\n")
        print(f"  Saved {changes} changes to {filepath}")

    return changes


def find_contents_json_files(root: Path) -> list[Path]:
    """Recursively find all contents.json files under root."""
    files = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn == "contents.json":
                files.append(Path(dirpath) / fn)
    return sorted(files)


def main():
    dry_run = "--dry-run" in sys.argv

    if not DATA_ROOT.is_dir():
        print(f"Error: data root not found: {DATA_ROOT}")
        sys.exit(1)

    files = find_contents_json_files(DATA_ROOT)
    if not files:
        print(f"No contents.json files found under {DATA_ROOT}")
        sys.exit(0)

    print(f"Found {len(files)} contents.json file(s)")
    total_changes = 0

    for fp in files:
        changes = process_contents_json(fp, dry_run=dry_run)
        total_changes += changes

    print(f"\n{'[DRY RUN] ' if dry_run else ''}Done. {total_changes} total change(s).")
    if dry_run and total_changes > 0:
        print("Run without --dry-run to apply changes.")


if __name__ == "__main__":
    main()
