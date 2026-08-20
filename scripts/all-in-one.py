#!/var/www/html/pdf-reader/.venv/bin/python3
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

            <subject>/<book>/contents.json e.g. data/biology-oup/1a/contents.json

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


     4. Extracts each English section name from the first page image of that
         section, then translates it to Traditional Chinese and fills
         contents[].en.name and contents[].tc.name in contents.json.

            data/biology-oup/1a/en/contents/pages/1-1.png
            data/math-oup/4a/en/contents/pages/01-1.png

        The script uses the AI Gateway ETT flow, following the same
        request pattern as /var/www/html/aigateway/scripts/test-ett.py.


    5. Adds root-level names for elective books.

        For elective books, a new top-level "name" field is added under
        "chapter", for example:

            {
                "chapter": "e1",
                "name": "Microbes and Disease",
                ...
            }

        Elective book names:
            e1 → Microbes and Disease
            e2 → Human Physiology: Regulation and Control
            e3 → Applied Ecology
            e4 → Biotechnology


    6. Downloads MP3 resources and rewrites the URLs to local paths.

    7. Downloads HTML resources and rewrites the URLs to local paths.
       Also downloads all files referenced within each HTML (images, CSS,
       JS, etc.) and rewrites those URLs to local paths too.


"""

import argparse
import glob
import json
import mimetypes
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.request import urlretrieve

import fitz  # PyMuPDF
import requests
from PIL import Image


BIOLOGY_ELECTIVE_BOOK_NAMES = {
    "e1": ("Human Physiology", "人類生理學"),
    "e2": ("Applied Ecology", "應用生態學"),
    "e3": ("Microorganisms and Humans", "微生物與人類"),
    "e4": ("Biotechnology", "生物科技"),
}

CHEMISTRY_BOOK_NAMES = {
    "1": ("Planet Earth", "地球"),
    "2": ("Microscopic World I", "微觀世界 I"),
    "3": ("Metals", "金屬"),
    "4": ("Acids and Bases", "酸和鹽基"),
    "5": ("Fossil Fuels and Carbon Compounds", "化石燃料和碳化合物"),
    "6": ("Microscopic World II", "微觀世界 II"),
    "7": ("Redox Reactions, Chemical Cells and Electrolysis", "氧化還原反應、化學電池和電解"),
    "8": ("Chemical Reactions and Energy", "化學反應和能量"),
    "9": ("Rate of Reaction", "反應速率"),
    "10": ("Chemical Equilibrium", "化學平衡"),
    "11": ("Chemistry of Carbon Compounds", "碳化合物的化學"),
    "12": ("Patterns in the Chemical World", "化學世界中的規律"),
    "13": ("Industrial Chemistry", "工業化學"),
    "14": ("Materials Chemistry", "物料化學"),
    "15": ("Analytical Chemistry", "分析化學"),
}

PHYSICS_BOOK_NAMES = {
    "1": ("Heat and Gases", "熱和氣體"),
    "2": ("Force and Motion", "力和運動"),
    "3a": ("Wave Motion I", "波動 I"),
    "3b": ("Wave Motion II", "波動 II"),
    "4": ("Electricity and Magnetism", "電和磁"),
    "5": ("Radioactivity and Nuclear Energy", "放射現象和核能"),
    "e1": ("Astronomy and Space Science", "天文學和航天科學"),
    "e2": ("Atomic World", "原子世界"),
    "e3": ("Energy and Use of Energy", "能量和能源的使用"),
    "e4": ("Medical Physics", "醫學物理學"),
}

MATH_ROOT_BOOK_NAME = ("Math", "數學")


def _natural_id_sort_key(value):
    text = str(value).strip()
    try:
        return (0, float(text), text)
    except ValueError:
        return (1, 0, text)


def _discover_book_dirs(scope_dir):
    """Return book directory names under a subject dir, or [None] if scope_dir is already a book."""
    subdirs = sorted(
        (
            d for d in os.listdir(scope_dir)
            if os.path.isdir(os.path.join(scope_dir, d))
            and os.path.isdir(os.path.join(scope_dir, d, "en"))
        ),
        key=_natural_id_sort_key,
    )
    return subdirs if subdirs else [None]


def _process_scope(scope_dir, scope_label, args, base_dir):
    """Process either a subject directory containing multiple books or one concrete book directory."""
    books = _discover_book_dirs(scope_dir)

    for i, book in enumerate(books):
        if book is not None:
            book_dir = os.path.join(scope_dir, book)
            label = f"{scope_label}/{book}"
        else:
            book_dir = scope_dir
            label = scope_label

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

        # ── Step 4: Extract section names ──────────────────────────
        if not args.skip_section_names:
            print("\n" + "=" * 60)
            print("  Step 4 — Extracting English section names from first section pages")
            print("=" * 60)
            fill_section_names_from_first_pages(book_dir, base_dir)
        else:
            print("[skip] Step 4 — Extract section names")

        # ── Step 5: Add root book/topic names ─────────────────────
        if not args.skip_book_names:
            print("\n" + "=" * 60)
            print("  Step 5 — Adding root book/topic names")
            print("=" * 60)
            add_root_book_name(book_dir)
        else:
            print("[skip] Step 5 — Add root book/topic names")

        # ── Step 6: Download MP3s ─────────────────────────────────
        if not args.skip_mp3s:
            print("\n" + "=" * 60)
            print("  Step 6 — Downloading MP3 resources")
            print("=" * 60)
            download_mp3s(book_dir)
        else:
            print("[skip] Step 6 — Download MP3s")

        # ── Step 7: Download HTMLs ─────────────────────────────────
        if not args.skip_htmls:
            print("\n" + "=" * 60)
            print("  Step 7 — Downloading HTML resources")
            print("=" * 60)
            download_htmls(book_dir, force=args.force)
        else:
            print("[skip] Step 7 — Download HTMLs")

        # ── Step 8: Capture book title ───────────────────────────
        if args.capture_title and args.capture_title > 0:
            print("\n" + "=" * 60)
            print(f"  Step 8 — Capturing book title from first {args.capture_title} page(s)")
            print("=" * 60)
            capture_book_title(book_dir, args.capture_title, base_dir)
        elif args.capture_title is not None and args.capture_title > 0:
            pass  # handled above
        else:
            # --capture-title not given or 0 — skip
            pass


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 1 — PDF splitting
# ═══════════════════════════════════════════════════════════════════════════════

def _split_one_pdf_dir(pdf_dir, pages_dir, args):
    """Split all PDFs in *pdf_dir* into individual images under *pages_dir*."""
    if not os.path.isdir(pdf_dir):
        return

    os.makedirs(pages_dir, exist_ok=True)

    # Collect ALL PDFs. Derive section name from filename stem:
    #   "1.pdf" → "1"
    #   "1.1-sba-157.pdf" → "1.1"
    #   "appendix.pdf" → "appendix"
    #   "cover.pdf" → "cover"  (fallback: whole stem)
    pdf_entries = []
    for f in sorted(os.listdir(pdf_dir)):
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
        return

    # Sort by section (try numeric first, then string)
    def _sort_key(entry):
        sec = entry[0]
        try:
            return (0, float(sec), "")
        except ValueError:
            return (1, 0, sec)

    pdf_entries.sort(key=_sort_key)

    rel = os.path.relpath(pdf_dir, os.path.join(os.path.dirname(pdf_dir), ".."))
    print(f"\n{'='*60}")
    print(f"  {rel}/")
    print(f"{'='*60}")

    for section_num, pdf_name in pdf_entries:
        pdf_path = os.path.join(pdf_dir, pdf_name)

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


def split_pdfs(TEXTBOOKS_DIR, args):
    """Split multi-page PDFs into individual PNG (or JPG) images.

    Processes both {lang}/contents/ (main textbook) and
    {lang}/contents.tn/ (teacher's notes) directories.
    """
    langs_available = [lang for lang in ("en", "tc")
                       if os.path.isdir(os.path.join(TEXTBOOKS_DIR, lang))]
    if not langs_available:
        print(f"  [skip] No language directories (en/, tc/) found in {TEXTBOOKS_DIR}")
        return

    for language in langs_available:
        lang_dir = os.path.join(TEXTBOOKS_DIR, language)

        # Process both "contents" and "contents.tn" if they exist
        for subdir_name in ("contents", "contents.tn"):
            pdf_dir = os.path.join(lang_dir, subdir_name)
            pages_dir = os.path.join(pdf_dir, "pages")
            _split_one_pdf_dir(pdf_dir, pages_dir, args)


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 2 — Fill resources into contents.json
# ═══════════════════════════════════════════════════════════════════════════════

def _create_skeleton_from_pdfs(TEXTBOOKS_DIR):
    """Create a skeleton contents.json from PDF files found in
    {en,tc}/contents/ directories."""
    sections = set()
    for lang in ("en", "tc"):
        contents_dir = os.path.join(TEXTBOOKS_DIR, lang, "contents")
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

    chapter_name = os.path.basename(TEXTBOOKS_DIR)
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


def fill_resources(TEXTBOOKS_DIR):
    """Read resource-*.json files and merge them into contents.json."""
    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    book_section_id = os.path.basename(os.path.normpath(TEXTBOOKS_DIR))

    if os.path.exists(contents_path):
        try:
            with open(contents_path, "r", encoding="utf-8") as f:
                contents = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"  [warn] Failed to read {contents_path}: {e}")
            print(f"  [warn] Recreating skeleton from PDFs…")
            contents = None
    else:
        contents = None

    if contents is None:
        # Create skeleton from PDF files so we have sections to fill into
        contents = _create_skeleton_from_pdfs(TEXTBOOKS_DIR)
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
        sec = item.get("section")
        if not sec:
            print(f"  [warn] Skipping contents entry with missing 'section': {item}")
            continue
        sec = str(sec)
        section_map[sec] = {
            "en": list(item.get("en", {}).get("resources", [])),
            "tc": list(item.get("tc", {}).get("resources", [])),
        }

    # Merge in any newly discovered sections from PDFs that aren't in
    # contents.json yet (e.g. "1.1" alongside existing "1").
    skeleton = _create_skeleton_from_pdfs(TEXTBOOKS_DIR)
    if skeleton:
        for item in skeleton.get("contents", []):
            sec = item.get("section")
            if not sec:
                continue
            sec = str(sec)
            if sec not in section_map:
                section_map[sec] = {"en": [], "tc": []}
                contents["contents"].append(item)
                print(f"  Added new section {sec} from PDFs")

    # Read resource files from {TEXTBOOKS_DIR}/{lang}/resources/resource*.json
    any_resources_found = False
    for lang in ("en", "tc"):
        resources_dir = os.path.join(TEXTBOOKS_DIR, lang, "resources")
        if not os.path.isdir(resources_dir):
            # Not an error — many books simply have no resource folder yet
            continue

        pattern = os.path.join(resources_dir, "resource*.json")
        resource_files = sorted(glob.glob(pattern))

        if not resource_files:
            continue

        any_resources_found = True
        print(f"\n  Reading {len(resource_files)} resource file(s) from {resources_dir}/")

        for filepath in resource_files:
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                print(f"  [warn] Failed to read {filepath}: {e}")
                continue

            for content_item in data.get("contents", []):
                # Process both en and tc from each file (some files have both)
                for res_lang in ("en", "tc"):
                    resources = content_item.get(res_lang, {}).get("resources", [])
                    for res in resources:
                        page = res.get("page", "")
                        if not page:
                            continue

                        page_str = str(page).strip()
                        if not page_str:
                            continue

                        # If page has no hyphen (e.g. "1"), treat it as a
                        # whole-book resource and assign it to the book section id.
                        # Example: physics-oup/1 -> section "1".
                        if "-" in page_str:
                            section_num = page_str.split("-")[0].strip()
                        else:
                            section_num = book_section_id

                        if not section_num:
                            continue
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
        sec = item.get("section")
        if not sec:
            continue
        sec = str(sec)
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

    if not any_resources_found and total_en == 0 and total_tc == 0:
        print(f"  [info] No resource files found for this book.")
        print(f"  [info] To add resources, place resource*.json files in:")
        print(f"  [info]   {os.path.join(TEXTBOOKS_DIR, 'en', 'resources')}/")
        print(f"  [info]   {os.path.join(TEXTBOOKS_DIR, 'tc', 'resources')}/")


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


def fix_urls(TEXTBOOKS_DIR):
    """Fix resource URLs in contents.json that are missing /isolution-web/."""
    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    total = 0
    for section in data.get("contents", []):
        sec = section.get("section")
        if not sec:
            continue
        for lang in ("en", "tc"):
            resources = section.get(lang, {}).get("resources", [])
            n = fix_urls_in_resources(resources)
            if n:
                print(f"    section {sec} {lang}: fixed {n} URL(s)")
            total += n

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"\n  Fixed {total} URL(s) in {contents_path}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 4 — Extract section names from first section page images
# ═══════════════════════════════════════════════════════════════════════════════

def load_env_file(env_path):
    """Parse .env file supporting single-line key=value and multi-line quoted values.

    Multi-line quoted values like::

        VLLM_APIKEY="
        key1
        key2
        "

    are collected into one value (the first non-empty line, or all lines joined).
    """
    values = {}
    if not os.path.isfile(env_path):
        return values

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n\r")
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" not in stripped:
                continue
            key, _, remainder = stripped.partition("=")
            key = key.strip()

            # Single-line value: trim surrounding quotes and spaces
            val = remainder.strip()
            if len(val) >= 2 and ((val.startswith('"') and val.endswith('"')) or
                                  (val.startswith("'") and val.endswith("'"))):
                val = val[1:-1]
            elif val.startswith('"') or val.startswith("'"):
                # Multi-line quoted value — read until the matching closing quote
                quote_char = val[0]
                inner = val[1:]  # after opening quote
                closing_found = False
                while not closing_found:
                    idx = inner.find(quote_char)
                    if idx >= 0:
                        inner = inner[:idx]
                        closing_found = True
                        break
                    # Read next line
                    next_line = f.readline()
                    if not next_line:
                        break
                    inner += "\n" + next_line.rstrip("\n\r")
                val = inner.strip()
            else:
                val = val.strip().strip('"').strip("'")

            values[key] = val
    return values


def get_ai_gateway_config(base_dir):
    env_values = load_env_file(os.path.join(base_dir, ".env"))
    return {
        "url": os.environ.get("VLLM_API_URL") or env_values.get("VLLM_API_URL") or "https://aigateway.aied.hku.hk/api/generate",
        "model": os.environ.get("VLLM_MODEL") or env_values.get("VLLM_MODEL") or "OpenGVLab/InternVL3_5-38B",
        "api_key": os.environ.get("VLLM_APIKEY") or env_values.get("VLLM_APIKEY") or "",
        "provider": os.environ.get("VLLM_PROVIDER") or env_values.get("VLLM_PROVIDER") or "ett-vllm",
    }


def get_text_generation_config(base_dir):
    env_values = load_env_file(os.path.join(base_dir, ".env"))
    return {
        "url": os.environ.get("VLLM_API_URL") or env_values.get("VLLM_API_URL") or "https://aigateway.aied.hku.hk/api/generate",
        "model": os.environ.get("OLLAMA_MODEL") or env_values.get("OLLAMA_MODEL") or "gpt-oss:120b",
        "api_key": os.environ.get("OLLAMA_APIKEY") or env_values.get("OLLAMA_APIKEY") or "",
        "provider": os.environ.get("OLLAMA_PROVIDER") or env_values.get("OLLAMA_PROVIDER") or "ollama",
    }


def send_ett_request(url, api_key, model, file_path, prompt, provider="ett-vllm", extra_fields=None):
    """Send a single image + prompt to the AI gateway using requests (same as
    the proven test-aigateway-long-request-prompt.py pattern)."""
    mime_type, _ = mimetypes.guess_type(str(file_path))
    if mime_type is None:
        mime_type = "application/octet-stream"

    form_fields = {
        "provider": (None, provider),
        "apiKey": (None, api_key),
        "model": (None, model),
        "prompt": (None, prompt),
        "files": (Path(file_path).name, open(file_path, "rb"), mime_type),
    }
    for key, value in (extra_fields or {}).items():
        form_fields[key] = (None, str(value))

    try:
        resp = requests.post(
            url,
            files=form_fields,
            headers={"Accept": "application/json"},
            timeout=120,
        )
        if resp.status_code != 200:
            return {"error": True, "status": resp.status_code, "body": resp.text[:500]}
        return resp.json()
    except requests.Timeout:
        return {"error": True, "reason": "timeout after 120s"}
    except requests.ConnectionError as err:
        return {"error": True, "reason": str(err)}
    except requests.RequestException as err:
        return {"error": True, "reason": str(err)}


def send_text_generation_request(url, api_key, model, prompt, provider="ollama"):
    """Send a text-only generation request to the AI gateway."""
    form_fields = [
        ("provider", (None, provider)),
        ("apiKey", (None, api_key)),
        ("model", (None, model)),
        ("prompt", (None, prompt)),
    ]

    try:
        resp = requests.post(
            url,
            files=form_fields,
            headers={"Accept": "text/event-stream"},
            timeout=180,
        )
        if resp.status_code != 200:
            return "", f"HTTP {resp.status_code}: {resp.text[:500]}"
        return resp.text, None
    except requests.Timeout:
        return "", "timeout after 180s"
    except requests.ConnectionError as err:
        return "", str(err)
    except requests.RequestException as err:
        return "", str(err)


def extract_text_from_ett_result(result):
    if not isinstance(result, dict) or result.get("error"):
        return ""

    text = result.get("response", "") or result.get("text", "") or result.get("output", "") or ""

    if not text:
        parts = []
        for file_info in result.get("files", []) or []:
            file_text = file_info.get("text", "") or file_info.get("response", "") or file_info.get("output", "") or ""
            if isinstance(file_text, str) and file_text.strip():
                parts.append(file_text.strip())
        text = "\n\n".join(parts)

    generation = result.get("generation", "")
    if not text and isinstance(generation, str) and generation.strip():
        text = generation
    elif not text and isinstance(generation, dict):
        text = generation.get("text", "") or generation.get("response", "") or ""

    if not text:
        content = result.get("content", "")
        if isinstance(content, str) and content.strip():
            text = content

    return text.strip() if isinstance(text, str) else ""


def extract_text_from_generation_result(raw_text):
    """Extract plain text from a text-generation gateway response."""
    if not isinstance(raw_text, str):
        return ""

    try:
        parsed = json.loads(raw_text)
    except (json.JSONDecodeError, TypeError):
        parsed = None

    if isinstance(parsed, dict):
        text = parsed.get("response", "") or parsed.get("text", "") or parsed.get("output", "") or ""
        if not text:
            generation = parsed.get("generation", "")
            if isinstance(generation, str) and generation.strip():
                text = generation
            elif isinstance(generation, dict):
                text = generation.get("text", "") or generation.get("response", "") or ""
        if not text:
            content = parsed.get("content", "")
            if isinstance(content, str) and content.strip():
                text = content
        if isinstance(text, str) and text.strip():
            return text.strip()

    collected = ""
    for line in raw_text.splitlines():
        if not line.startswith("data: "):
            continue
        chunk = line[6:].strip()
        if not chunk or chunk == "[DONE]":
            continue
        try:
            parsed_chunk = json.loads(chunk)
        except json.JSONDecodeError:
            collected += chunk
            continue
        choices = parsed_chunk.get("choices")
        if isinstance(choices, list) and choices:
            collected += choices[0].get("delta", {}).get("content", "")
        elif isinstance(parsed_chunk.get("content"), str):
            collected += parsed_chunk["content"]

    return collected.strip() or raw_text.strip()


def _clean_translated_section_title(raw_text):
    """Normalize a translated section title to one plain Traditional Chinese line."""
    if not raw_text:
        return ""

    lines = [" ".join(line.strip().split()) for line in str(raw_text).splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""

    title = lines[0]
    title = re.sub(r"^```(?:text)?\s*", "", title, flags=re.IGNORECASE).strip()
    title = re.sub(r"\s*```$", "", title).strip()
    title = re.sub(r"^[#>*\-•\s]+", "", title).strip()
    title = re.sub(r"^[\"'“”‘’«»]+|[\"'“”‘’«»]+$", "", title).strip()
    title = title.strip("*_` ")
    title = re.sub(r"^(?:translation|translated title|traditional chinese|title)\s*[:：]\s*", "", title, flags=re.IGNORECASE).strip()
    return title


def translate_section_title_to_tc(title_en, text_config):
    """Translate an English section title to Traditional Chinese."""
    prompt = (
        "Translate this mathematics textbook section title into Traditional Chinese (繁體中文). "
        "Return ONLY the translated title. Do NOT add explanation, punctuation, bullets, quotes, or extra text.\n\n"
        f"{title_en}"
    )
    raw_text, error = send_text_generation_request(
        text_config["url"],
        text_config["api_key"],
        text_config["model"],
        prompt,
        provider=text_config["provider"],
    )
    if error:
        raise RuntimeError(error)

    title_tc = _clean_translated_section_title(extract_text_from_generation_result(raw_text))
    if not title_tc:
        raise RuntimeError("empty translation result")
    return title_tc




def parse_contents_entries(text):
    entries = {}
    for raw_line in text.splitlines():
        line = " ".join(raw_line.strip().split())
        if not line:
            continue
        if line.lower().startswith("new senior secondary mastering biology"):
            continue

        match = re.match(r"^(\d+(?:\.\d+)?)\s+(.+?)$", line)
        if match:
            section = match.group(1)
            title = match.group(2).strip()
            entries[section] = title
            continue

        if re.fullmatch(r"appendix", line, re.IGNORECASE):
            entries["appendix"] = "Appendix"
            continue

        if re.fullmatch(r"end", line, re.IGNORECASE):
            entries["end"] = "End"
            continue

    return entries


def _normalize_section_id(value):
    text = str(value).strip()
    try:
        num = float(text)
        if num.is_integer():
            return str(int(num))
        return str(num)
    except ValueError:
        return text.lower()


def _section_sort_key(value):
    text = str(value).strip()
    try:
        return (0, float(text), "")
    except ValueError:
        return (1, 0, text)


def _find_first_section_page_image(TEXTBOOKS_DIR, section):
    """Find the first English page image for *section*.

    Accepts exact section IDs (``1-1.png``), zero-padded IDs
    (``01-1.png``), and generated image formats supported by the reader.
    """
    pages_dir = os.path.join(TEXTBOOKS_DIR, "en", "contents", "pages")
    if not os.path.isdir(pages_dir):
        return None

    section_text = str(section).strip()
    normalized_section = _normalize_section_id(section_text)
    image_pattern = re.compile(r"^(.+)-(\d+)\.(png|jpg|jpeg|webp)$", re.IGNORECASE)
    candidates = []

    for fname in os.listdir(pages_dir):
        match = image_pattern.match(fname)
        if not match:
            continue
        file_section, page_num = match.group(1), int(match.group(2))
        if page_num != 1:
            continue
        if file_section == section_text or _normalize_section_id(file_section) == normalized_section:
            candidates.append(os.path.join(pages_dir, fname))

    if not candidates:
        return None

    candidates.sort(key=lambda path: (len(Path(path).stem.split("-", 1)[0]), Path(path).name))
    return candidates[0]


def _create_section_title_crop(image_path):
    """Crop the upper title band from a section opener page for more reliable OCR."""
    with Image.open(image_path) as image:
        width, height = image.size
        crop_box = (
            int(width * 0.24),
            int(height * 0.06),
            int(width * 0.80),
            int(height * 0.19),
        )
        cropped = image.crop(crop_box)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_file:
        cropped.save(temp_file.name, format="PNG")
        return temp_file.name


def _clean_extracted_section_title(raw_text, section):
    """Normalize an ETT response to one plain English section title."""
    if not raw_text:
        return ""

    lines = [" ".join(line.strip().split()) for line in raw_text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""

    section_text = str(section).strip()
    normalized_section = _normalize_section_id(section_text)
    section_prefixes = []
    for value in (section_text, normalized_section):
        if value and value not in section_prefixes:
            section_prefixes.append(value)
    numeric_section = normalized_section
    if re.fullmatch(r"\d+(?:\.0+)?", normalized_section):
        numeric_section = str(int(float(normalized_section)))
        if numeric_section not in section_prefixes:
            section_prefixes.append(numeric_section)

    def _normalize_title_candidate(value):
        title = value
        title = re.sub(r"^```(?:text)?\s*", "", title, flags=re.IGNORECASE).strip()
        title = re.sub(r"\s*```$", "", title).strip()
        title = re.sub(r"^[#>*\-•\s]+", "", title).strip()
        title = re.sub(r"^[\"'“”‘’«»]+|[\"'“”‘’«»]+$", "", title).strip()
        title = title.strip("*_` ")
        title = re.sub(r"^(?:section|chapter|unit)\s+", "", title, flags=re.IGNORECASE).strip()
        title = re.sub(r"^(?:title|section\s+title|section\s+name)\s*[:：]\s*", "", title, flags=re.IGNORECASE).strip()
        title = re.sub(rf"^{re.escape(section_text)}(?:(?:\.(?!\d)|[-–—:：])\s*|\s+)", "", title).strip()
        if normalized_section != section_text:
            title = re.sub(rf"^{re.escape(normalized_section)}(?:(?:\.(?!\d)|[-–—:：])\s*|\s+)", "", title).strip()
        return title

    def _is_bad_title(value):
        if not value:
            return True
        lowered = value.lower()
        if lowered in {"unknown", "n/a", "na", "none"}:
            return True
        if lowered in {"number and algebra", "measures, shape and space"}:
            return True
        if re.search(r"\(\s*(?:p\.|page)\s*\d", value, re.IGNORECASE):
            return True
        bad_prefixes = (
            "the content",
            "the section",
            "the problem",
            "the page",
            "this page",
            "the text",
            "text extracted",
            "extracted text",
            "the image",
            "here is",
            "in this",
        )
        if any(lowered.startswith(prefix) for prefix in bad_prefixes):
            return True
        bad_fragments = (
            "includes the following",
            "includes:",
            "focused on",
            "discusses",
            "involves",
            "summary",
            "is titled",
            "shown is",
            "reads:",
        )
        if any(fragment in lowered for fragment in bad_fragments):
            return True
        if lowered in {"review", "text extracted"}:
            return True
        if len(value.split()) > 12:
            return True
        return False

    def _cleanup_pattern_candidate(value):
        candidate = _normalize_title_candidate(value)
        candidate = re.sub(r"[\s.,:;!?]+$", "", candidate).strip()
        return "" if _is_bad_title(candidate) else candidate

    def _looks_like_section_prefix(line):
        for prefix in section_prefixes:
            if re.match(rf"^{re.escape(prefix)}(?:(?:\.(?!\d)|[-–—:：])\s*|\s+)", line):
                return True
        return False

    def _combine_with_next(index):
        candidate = _normalize_title_candidate(lines[index])
        if _is_bad_title(candidate):
            return ""
        if index + 1 >= len(lines):
            return candidate
        next_candidate = _normalize_title_candidate(lines[index + 1])
        if _is_bad_title(next_candidate):
            return candidate
        if _looks_like_section_prefix(lines[index + 1]) or re.search(r"\(\s*(?:p\.|page)\s*\d", next_candidate, re.IGNORECASE):
            return candidate
        combined = f"{candidate} {next_candidate}".strip()
        return combined if not _is_bad_title(combined) else candidate

    early_text = raw_text[:1200]
    for prefix in section_prefixes:
        pattern = re.compile(rf"\*{{1,3}}\s*{re.escape(prefix)}(?:(?:\.(?!\d)|[-–—:：])\s*|\s+)([^*\n]+?)\s*\*{{1,3}}", re.IGNORECASE)
        match = pattern.search(early_text)
        if match:
            candidate = _cleanup_pattern_candidate(match.group(1))
            if candidate:
                return candidate

    chapter_match = re.search(r"chapter\s+\d+(?:\.\d+)?\s*:\s*([^\n*]+)", early_text, re.IGNORECASE)
    if chapter_match:
        candidate = _cleanup_pattern_candidate(chapter_match.group(1))
        if candidate:
            return candidate

    quoted_block_match = re.search(r"[\"“]([^\"”]+)[\"”]", early_text, re.DOTALL)
    if quoted_block_match:
        quoted_lines = [" ".join(line.strip().split()) for line in quoted_block_match.group(1).splitlines()]
        for quoted_line in quoted_lines:
            if not quoted_line:
                continue
            candidate = _cleanup_pattern_candidate(quoted_line)
            if candidate:
                return candidate

    titled_match = re.search(r"titled\s+[\"“]([^\"”]+)[\"”]", early_text, re.IGNORECASE)
    if titled_match:
        candidate = _cleanup_pattern_candidate(titled_match.group(1))
        if candidate:
            return candidate

    for match in re.finditer(r"(?:topic|discussing|about)\s+[\"“]([^\"”]+)[\"”]", early_text, re.IGNORECASE):
        candidate = _cleanup_pattern_candidate(match.group(1))
        if candidate:
            return candidate

    about_match = re.search(r"about\s+([a-z][a-z\s]+?)(?:\.|,|\s+with|\s+that|\s+which|\s+it\b)", early_text, re.IGNORECASE)
    if about_match:
        candidate = _cleanup_pattern_candidate(about_match.group(1))
        if candidate and candidate == candidate.lower():
            candidate = candidate.title()
        if candidate:
            return candidate

    section_markers = {section_text, normalized_section}
    for index, line in enumerate(lines):
        if line.strip() in section_markers:
            for next_index in range(index + 1, min(index + 4, len(lines))):
                candidate = _combine_with_next(next_index)
                if candidate:
                    return candidate

        candidate = _combine_with_next(index)
        raw_stripped = line.strip()
        if _looks_like_section_prefix(raw_stripped):
            if candidate:
                return candidate

    for index, _line in enumerate(lines):
        candidate = _combine_with_next(index)
        if candidate:
            return candidate

    return ""


def fill_section_names_from_first_pages(TEXTBOOKS_DIR, base_dir):
    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            contents = json.load(f)
    else:
        contents = _create_skeleton_from_pdfs(TEXTBOOKS_DIR)
        if not contents:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    config = get_ai_gateway_config(base_dir)
    if not config["api_key"]:
        print("  [skip] VLLM_APIKEY not configured; cannot extract section names")
        return
    text_config = get_text_generation_config(base_dir)

    print(f"  Gateway: {config['url']}")
    print(f"  Provider: {config['provider']}  |  Model: {config['model']}")
    print(f"  API key: {config['api_key'][:8]}...{config['api_key'][-4:]} ({len(config['api_key'])} chars)")
    if text_config["api_key"]:
        print(f"  Translation: {text_config['provider']}  |  Model: {text_config['model']}")
    else:
        print("  Translation: disabled (OLLAMA_APIKEY not configured)")
    updates = 0
    missing = []
    failed = []
    extracted = {}
    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue

        image_path = _find_first_section_page_image(TEXTBOOKS_DIR, section)
        if not image_path:
            missing.append(section)
            continue

        prompt = (
            "OCR TASK ONLY. This cropped image contains the heading area of one textbook section opener page. "
            "Return ONLY the main section title shown in the largest heading. "
            "If the title spans multiple lines, join them with spaces. "
            "Do NOT describe the page. Do NOT summarize the page. Do NOT explain the page. "
            "Do NOT return subsection titles such as 1.1, 2.1, or review labels. "
            "Do NOT include the large section number, book title, strand header, page numbers, or Markdown. "
            "Output only the main section title text, or UNKNOWN if you cannot find one."
        )
        crop_path = None
        try:
            crop_path = _create_section_title_crop(image_path)
            result = send_ett_request(
                config["url"],
                config["api_key"],
                config["model"],
                crop_path,
                prompt,
                provider=config["provider"],
                extra_fields={"extractOnly": "true", "stream": "false", "wordCount": "400"},
            )
            raw_text = extract_text_from_ett_result(result)
            title = _clean_extracted_section_title(raw_text, section)
            if not title:
                result = send_ett_request(
                    config["url"],
                    config["api_key"],
                    config["model"],
                    image_path,
                    prompt,
                    provider=config["provider"],
                    extra_fields={"extractOnly": "true", "stream": "false", "wordCount": "400"},
                )
                raw_text = extract_text_from_ett_result(result)
                title = _clean_extracted_section_title(raw_text, section)
        finally:
            if crop_path and os.path.exists(crop_path):
                os.unlink(crop_path)
        # Surface gateway errors instead of silently treating them as empty titles
        if isinstance(result, dict) and result.get("error"):
            error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
            print(f"    ⚠  Section {section}: gateway error — {str(error_detail)[:200]}")
        if not title:
            failed.append(section)
            continue

        item.setdefault("en", {})
        item.setdefault("tc", {})
        title_tc = ""
        if text_config["api_key"]:
            try:
                title_tc = translate_section_title_to_tc(title, text_config)
            except Exception as err:
                print(f"    ⚠  Section {section}: tc translation failed — {err}")

        changed = False
        old_value = item["en"].get("name", "")
        if old_value != title:
            item["en"]["name"] = title
            changed = True
        old_value_tc = item["tc"].get("name", "")
        if title_tc and old_value_tc != title_tc:
            item["tc"]["name"] = title_tc
            changed = True
        if changed:
            updates += 1
        extracted[section] = {"en": title, "tc": title_tc}
        if title_tc:
            print(f"  Section {section}: {Path(image_path).name} → {title} / {title_tc}")
        else:
            print(f"  Section {section}: {Path(image_path).name} → {title}")

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    print(f"\n  Updated bilingual section names in {contents_path}")
    for section in sorted(extracted.keys(), key=_section_sort_key):
        entry = extracted[section]
        if entry["tc"]:
            print(f"    Section {section}: {entry['en']} / {entry['tc']}")
        else:
            print(f"    Section {section}: {entry['en']}")
    print(f"    Changed: {updates}")
    if missing:
        print(f"    Missing first-page images: {', '.join(missing)}")
    if failed:
        print(f"    No title extracted: {', '.join(failed)}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 5 — Add root-level book/topic names
# ═══════════════════════════════════════════════════════════════════════════════

def _resolve_root_book_names(TEXTBOOKS_DIR):
    subject_id = os.path.basename(os.path.dirname(os.path.normpath(TEXTBOOKS_DIR))).lower()
    book_id = os.path.basename(os.path.normpath(TEXTBOOKS_DIR)).lower()

    if subject_id == "math-oup":
        return MATH_ROOT_BOOK_NAME
    if subject_id == "chemistry-winter":
        return CHEMISTRY_BOOK_NAMES.get(book_id)
    if subject_id == "physics-oup":
        return PHYSICS_BOOK_NAMES.get(book_id)
    if subject_id == "biology-oup":
        return BIOLOGY_ELECTIVE_BOOK_NAMES.get(book_id)
    return None


def add_root_book_name(TEXTBOOKS_DIR):
    """Add root-level English/Chinese book names when known."""
    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    chapter_code = os.path.basename(os.path.normpath(TEXTBOOKS_DIR)).lower()
    resolved = _resolve_root_book_names(TEXTBOOKS_DIR)

    if not resolved:
        print(f"  [skip] {chapter_code} — no configured root book/topic name")
        return

    name_en, name_zh = resolved

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = _create_skeleton_from_pdfs(TEXTBOOKS_DIR)
        if not data:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    old_name = data.get("name")
    old_name_en = data.get("nameEn")
    old_name_zh = data.get("nameZh")
    data["name"] = name_en
    data["nameEn"] = name_en
    data["nameZh"] = name_zh

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    if old_name == name_en and old_name_en == name_en and old_name_zh == name_zh:
        print(f"  {contents_path} already has root name: {name_en} / {name_zh}")
    else:
        print(f"  Set root book/topic name in {contents_path}")
        print(f"    chapter: {data.get('chapter')}")
        print(f"    nameEn:  {name_en}")
        print(f"    nameZh:  {name_zh}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 8 — Capture book title from first N page images
# ═══════════════════════════════════════════════════════════════════════════════

def _collect_first_page_images(pages_dir, count):
    """Return up to *count* image paths from the pages directory, sorted by
    (section_number, page_number).  Only PNG/JPG files that match the
    ``section-page.ext`` naming convention are included."""
    if not os.path.isdir(pages_dir):
        return []

    pattern = re.compile(r"^(\d+(?:\.\d+)?)-(\d+)\.(png|jpg|jpeg|webp)$", re.IGNORECASE)
    candidates = []
    for fname in os.listdir(pages_dir):
        m = pattern.match(fname)
        if not m:
            continue
        section = float(m.group(1))
        page = int(m.group(2))
        candidates.append((section, page, os.path.join(pages_dir, fname)))

    if not candidates:
        return []

    candidates.sort(key=lambda item: (item[0], item[1]))
    return [path for _, _, path in candidates[:count]]


def _send_ett_with_images(url, api_key, model, image_paths, prompt, provider="ett-vllm"):
    """Send one or more page images to ETT/vLLM and return the parsed JSON
    response, or {'error': True, ...} on failure.

    Uses requests (same proven pattern as test-aigateway-long-request-prompt.py).
    """
    files: list = [
        ("provider", (None, provider)),
        ("apiKey", (None, api_key)),
        ("model", (None, model)),
        ("prompt", (None, prompt)),
    ]
    for img_path in image_paths:
        mime_type, _ = mimetypes.guess_type(str(img_path))
        if mime_type is None:
            mime_type = "application/octet-stream"
        files.append(("files", (Path(img_path).name, open(img_path, "rb"), mime_type)))

    try:
        resp = requests.post(
            url,
            files=files,
            headers={"Accept": "application/json"},
            timeout=180,
        )
        if resp.status_code != 200:
            return {"error": True, "status": resp.status_code, "body": resp.text[:500]}
        return resp.json()
    except requests.Timeout:
        return {"error": True, "reason": "timeout after 180s"}
    except requests.ConnectionError as err:
        return {"error": True, "reason": str(err)}
    except requests.RequestException as err:
        return {"error": True, "reason": str(err)}


def capture_book_title(TEXTBOOKS_DIR, page_count, base_dir):
    """Use ETT/vLLM to extract the book title from the first *page_count*
    page images and write it as ``nameEn`` in contents.json."""

    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    pages_dir = os.path.join(TEXTBOOKS_DIR, "en", "contents", "pages")

    images = _collect_first_page_images(pages_dir, page_count)
    if not images:
        print(f"  [skip] No page images found in {pages_dir}")
        return

    print(f"  Using page images:")
    for img in images:
        print(f"    {Path(img).name}")

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = _create_skeleton_from_pdfs(TEXTBOOKS_DIR)
        if not data:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    existing_name = data.get("nameEn") or data.get("name") or ""
    resolved_names = _resolve_root_book_names(TEXTBOOKS_DIR)

    prompt = (
        "Look at these textbook page images and tell me the full book title. "
        "Return ONLY the book title as a plain text string — nothing else. "
        "Do not include section numbers, chapter names, or page numbers. "
        "If you cannot determine the title, return 'UNKNOWN'."
    )

    config = get_ai_gateway_config(base_dir)
    if not config["api_key"]:
        print("  [skip] VLLM_APIKEY not configured")
        return

    print(f"  Gateway: {config['url']}")
    print(f"  Provider: {config['provider']}  |  Model: {config['model']}")
    result = _send_ett_with_images(config["url"], config["api_key"], config["model"], images, prompt, provider=config["provider"])
    raw_text = extract_text_from_ett_result(result)

    if not raw_text or raw_text.upper() == "UNKNOWN":
        if resolved_names:
            name_en, name_zh = resolved_names
            data["name"] = name_en
            data["nameEn"] = name_en
            data["nameZh"] = name_zh
            with open(contents_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"  [fallback] Using configured root name: {name_en} / {name_zh}")
            return
        print("  [skip] ETT/vLLM could not determine a title")
        if existing_name:
            print(f"  Keeping existing nameEn: {existing_name}")
        return

    # Clean up the response — take the first meaningful line
    title = raw_text.strip().split("\n")[0].strip()
    title = re.sub(r'^["\'«‹„]|["\'»›”]$', '', title).strip()
    # Remove common prefixes like "Title: " or "Book Title: "
    title = re.sub(r'^(book\s+)?title\s*[:：]\s*', '', title, flags=re.IGNORECASE).strip()

    lowered = title.lower()
    bad_prefixes = (
        "the text",
        "the text on the image",
        "the text in the image",
        "the text extracted",
        "the extracted text",
        "the image",
        "this image",
        "the page",
        "this page",
        "the textbook page",
        "here is",
    )
    if any(lowered.startswith(prefix) for prefix in bad_prefixes):
        if resolved_names:
            name_en, name_zh = resolved_names
            data["name"] = name_en
            data["nameEn"] = name_en
            data["nameZh"] = name_zh
            with open(contents_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"  [fallback] Using configured root name: {name_en} / {name_zh}")
            return
        print("  [skip] Extracted title looked like page-description boilerplate")
        if existing_name:
            print(f"  Keeping existing nameEn: {existing_name}")
        return

    if not title or len(title) < 2:
        if resolved_names:
            name_en, name_zh = resolved_names
            data["name"] = name_en
            data["nameEn"] = name_en
            data["nameZh"] = name_zh
            with open(contents_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
            print(f"  [fallback] Using configured root name: {name_en} / {name_zh}")
            return
        print("  [skip] Extracted title too short")
        return

    data["nameEn"] = title
    # Also set 'name' as fallback if not already set
    if not data.get("name"):
        data["name"] = title

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"  Captured title → nameEn: {title}")
    if existing_name and existing_name != title:
        print(f"    (replaced: {existing_name})")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 6 — Download MP3 resources
# ═══════════════════════════════════════════════════════════════════════════════

def download_mp3s(TEXTBOOKS_DIR):
    """Download all MP3 resources referenced in contents.json to local mp3s/
    folders and rewrite URLs to local paths."""

    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    book = data.get("chapter", os.path.basename(TEXTBOOKS_DIR))
    total_downloaded = 0
    total_skipped = 0
    total_errors = 0

    for section in data.get("contents", []):
        sec = section.get("section")
        if not sec:
            continue
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
                mp3_dir = os.path.join(TEXTBOOKS_DIR, lang, "mp3s")
                os.makedirs(mp3_dir, exist_ok=True)
                local_path = os.path.join(mp3_dir, filename)

                if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
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
                # TEXTBOOKS_DIR is e.g. .../data/biology-oup/1a
                # Build relative path: biology-oup/1a
                parts = os.path.normpath(TEXTBOOKS_DIR).split(os.sep)
                rel_book = os.sep.join(parts[-2:])  # e.g. "biology-oup/1a"
                local_url = f"/pdf-reader/data/textbooks/{rel_book}/{lang}/mp3s/{filename}"
                res["url"] = local_url

    if total_downloaded or total_skipped or total_errors:
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"\n  MP3s: {total_downloaded} downloaded, {total_skipped} skipped, "
          f"{total_errors} errors  → {contents_path}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 7 — Download HTML resources and rewrite URLs to local paths
# ═══════════════════════════════════════════════════════════════════════════════

# HTML tags/attributes that reference external resources
_HTML_RESOURCE_ATTRS = [
    # (tag, attr) — order matters for matching
    ("img", "src"),
    ("script", "src"),
    ("link", "href"),
    ("source", "src"),
    ("video", "src"),
    ("video", "poster"),
    ("audio", "src"),
    ("object", "data"),
    ("embed", "src"),
    ("iframe", "src"),
    ("track", "src"),
]

_CSS_URL_RE = re.compile(r'url\(["\']?([^)"\']+)["\']?\)', re.IGNORECASE)


def _extract_resource_urls(html_text, base_url):
    """Parse HTML and extract all external resource URLs (absolute & relative).
    Returns a set of resolved absolute URLs."""
    urls = set()

    # 1. Tag attributes
    for tag, attr in _HTML_RESOURCE_ATTRS:
        # Match <tag ... attr="..." ...>  or  <tag ... attr='...' ...>
        pattern = re.compile(
            r'<' + re.escape(tag) + r'\b[^>]*?\b' + re.escape(attr)
            + r'\s*=\s*["\']([^"\']+)["\']',
            re.IGNORECASE | re.DOTALL,
        )
        for m in pattern.finditer(html_text):
            urls.add(m.group(1).strip())

    # 2. srcset attributes (comma-separated URLs)
    for m in re.finditer(r'srcset\s*=\s*["\']([^"\']+)["\']', html_text, re.IGNORECASE):
        for part in m.group(1).split(","):
            part = part.strip().split()[0]  # strip descriptor like "2x" or "600w"
            if part:
                urls.add(part)

    # 3. CSS url() references in <style> blocks and inline style attributes
    for m in re.finditer(r'<style[^>]*>(.*?)</style>', html_text, re.IGNORECASE | re.DOTALL):
        for css_match in _CSS_URL_RE.finditer(m.group(1)):
            urls.add(css_match.group(1).strip())
    for m in re.finditer(r'style\s*=\s*["\']([^"\']+)["\']', html_text, re.IGNORECASE):
        for css_match in _CSS_URL_RE.finditer(m.group(1)):
            urls.add(css_match.group(1).strip())

    # Resolve relative URLs to absolute, filter out data: URIs and anchors
    from urllib.parse import urljoin, urlparse as uparse
    resolved = set()
    for u in urls:
        u = u.strip()
        if not u or u.startswith("data:") or u.startswith("#") or u.startswith("javascript:"):
            continue
        if u.startswith("http://") or u.startswith("https://"):
            resolved.add(u)
        elif u.startswith("//"):
            resolved.add("https:" + u)
        else:
            resolved.add(urljoin(base_url, u))

    return resolved


def _path_safe_filename(url):
    """Derive a safe local filename from a URL path."""
    from urllib.parse import urlparse as uparse
    path = uparse(url).path
    filename = os.path.basename(path)
    if not filename or "." not in filename:
        # Fallback: hash-based name with extension guess from URL
        ext = os.path.splitext(path)[1] or ".dat"
        filename = f"{abs(hash(url)):x}{ext}"
    return filename


def _download_file(url, dest_path, timeout=30):
    """Download a single file to dest_path. Returns True on success."""
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        return True  # already downloaded
    try:
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=timeout) as resp:
            with open(dest_path, "wb") as f:
                f.write(resp.read())
        return True
    except Exception as e:
        print(f"      ⚠ failed: {url} → {e}")
        return False


def download_htmls(TEXTBOOKS_DIR, force=False):
    """Download all HTML resources referenced in contents.json to local htmls/
    folders. Also download all files referenced within each HTML (images, CSS,
    JS, etc.) and rewrite URLs to local paths.

    If *force* is False, HTML files that already exist on disk are skipped
    entirely (no download and no sub-resource processing)."""

    contents_path = os.path.join(TEXTBOOKS_DIR, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    book = data.get("chapter", os.path.basename(TEXTBOOKS_DIR))
    total_html = 0
    total_assets = 0
    total_skipped = 0
    total_errors = 0
    modified = False

    for section in data.get("contents", []):
        sec = section.get("section")
        if not sec:
            continue
        for lang in ("en", "tc"):
            resources = section.get(lang, {}).get("resources", [])
            for res in resources:
                url = res.get("url", "")
                if not url or not re.search(r'\.html(\?|$|#)', url, re.IGNORECASE):
                    continue

                # Derive a unique local name for the HTML
                parsed = urlparse(url)
                html_basename = os.path.basename(parsed.path)
                if not html_basename or not html_basename.endswith(".html"):
                    html_basename = f"{abs(hash(url)):x}.html"

                # Local directory: data/{book}/{lang}/htmls/
                html_dir = os.path.join(TEXTBOOKS_DIR, lang, "htmls")
                os.makedirs(html_dir, exist_ok=True)

                # If name collision, add the section prefix
                local_html_path = os.path.join(html_dir, html_basename)
                if os.path.exists(local_html_path) and not html_basename.startswith(f"{sec}-"):
                    html_basename = f"{sec}-{html_basename}"
                    local_html_path = os.path.join(html_dir, html_basename)

                # Also make a subdirectory for supporting files
                assets_dir_name = html_basename.replace(".html", "_files")
                assets_dir = os.path.join(html_dir, assets_dir_name)

                # Download the HTML
                html_content = None
                if os.path.exists(local_html_path) and os.path.getsize(local_html_path) > 0:
                    if not force:
                        total_skipped += 1
                        print(f"    [skip] {html_basename}")
                        continue  # skip entirely — no sub-resource processing
                    # force mode: re-read existing HTML and re-process sub-resources
                    with open(local_html_path, "r", encoding="utf-8") as f:
                        html_content = f.read()
                    total_skipped += 1
                    print(f"    [reprocess] {html_basename}")
                else:
                    print(f"    downloading {html_basename} ...", end=" ", flush=True)
                    try:
                        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
                        with urlopen(req, timeout=30) as resp:
                            raw = resp.read()
                        # Try to decode; fall back to utf-8 with replacement
                        try:
                            html_content = raw.decode("utf-8")
                        except UnicodeDecodeError:
                            html_content = raw.decode("utf-8", errors="replace")
                        with open(local_html_path, "w", encoding="utf-8") as f:
                            f.write(html_content)
                        print("ok")
                        total_html += 1
                    except Exception as e:
                        print(f"FAILED ({e})")
                        total_errors += 1
                        continue

                if html_content is None:
                    continue

                # Check if this HTML is just a meta-refresh redirect to an MP3.
                # Example: <meta http-equiv="refresh" content="0;url=...mp3">
                mp3_redirect_match = re.search(
                    r'<meta\s+http-equiv\s*=\s*["\']refresh["\']\s+content\s*=\s*["\']\d+\s*;\s*url\s*=\s*([^"\']+\.mp3)["\']',
                    html_content, re.IGNORECASE,
                )
                if mp3_redirect_match:
                    mp3_url = mp3_redirect_match.group(1)
                    print(f"    → meta redirect to MP3: {mp3_url}")
                    # Download the MP3 to the mp3s/ folder
                    mp3_filename = os.path.basename(urlparse(mp3_url).path)
                    if not mp3_filename:
                        mp3_filename = f"audio_{abs(hash(mp3_url))}.mp3"
                    mp3_dir = os.path.join(TEXTBOOKS_DIR, lang, "mp3s")
                    os.makedirs(mp3_dir, exist_ok=True)
                    mp3_local_path = os.path.join(mp3_dir, mp3_filename)

                    if not (os.path.exists(mp3_local_path) and os.path.getsize(mp3_local_path) > 0):
                        print(f"      downloading {mp3_filename} ...", end=" ", flush=True)
                        try:
                            urlretrieve(mp3_url, mp3_local_path)
                            print("ok")
                        except Exception as e:
                            print(f"FAILED ({e})")
                            total_errors += 1
                            continue

                    # Rewrite the resource URL to local MP3 path (not HTML)
                    parts = os.path.normpath(TEXTBOOKS_DIR).split(os.sep)
                    rel_book = os.sep.join(parts[-2:])
                    local_url = f"/pdf-reader/data/textbooks/{rel_book}/{lang}/mp3s/{mp3_filename}"
                    if res.get("url") != local_url:
                        res["url"] = local_url
                        modified = True
                    # Remove the downloaded HTML stub since this isn't really an HTML resource
                    if os.path.exists(local_html_path):
                        os.remove(local_html_path)
                    continue

                # Extract all resource URLs from the HTML
                resource_urls = _extract_resource_urls(html_content, url)
                if not resource_urls:
                    # No sub-resources to download — just rewrite the main URL
                    parts = os.path.normpath(TEXTBOOKS_DIR).split(os.sep)
                    rel_book = os.sep.join(parts[-2:])
                    local_url = f"/pdf-reader/data/textbooks/{rel_book}/{lang}/htmls/{html_basename}"
                    if res.get("url") != local_url:
                        res["url"] = local_url
                        modified = True
                    continue

                # Download each sub-resource
                rewritten = False
                url_map = {}  # absolute_url → local_relative_path (from HTML's dir)

                for asset_url in sorted(resource_urls):
                    asset_name = _path_safe_filename(asset_url)
                    asset_dest = os.path.join(assets_dir, asset_name)

                    # Avoid filename collisions
                    counter = 1
                    base, ext = os.path.splitext(asset_name)
                    while os.path.exists(asset_dest):
                        if os.path.getsize(asset_dest) > 0:
                            break  # already exists with content
                        asset_name = f"{base}_{counter}{ext}"
                        asset_dest = os.path.join(assets_dir, asset_name)
                        counter += 1

                    if _download_file(asset_url, asset_dest):
                        # Map absolute URL to local relative path
                        local_rel = f"{assets_dir_name}/{asset_name}"
                        url_map[asset_url] = local_rel
                        total_assets += 1

                # Rewrite URLs in the HTML content
                if url_map:
                    # Replace absolute URLs with local relative paths
                    for abs_url, local_rel in url_map.items():
                        # Also handle protocol-relative variants
                        html_content = html_content.replace(abs_url, local_rel)
                        # Handle // prefix variant
                        if abs_url.startswith("https://"):
                            html_content = html_content.replace(
                                abs_url.replace("https://", "http://", 1), local_rel)
                        if abs_url.startswith("http://"):
                            html_content = html_content.replace(
                                abs_url.replace("http://", "https://", 1), local_rel)

                    with open(local_html_path, "w", encoding="utf-8") as f:
                        f.write(html_content)
                    rewritten = True

                # Rewrite the resource URL in contents.json
                parts = os.path.normpath(TEXTBOOKS_DIR).split(os.sep)
                rel_book = os.sep.join(parts[-2:])
                local_url = f"/pdf-reader/data/textbooks/{rel_book}/{lang}/htmls/{html_basename}"
                if res.get("url") != local_url:
                    res["url"] = local_url
                    modified = True

    if modified:
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

    print(f"\n  HTMLs: {total_html} downloaded, {total_skipped} skipped, "
          f"{total_assets} sub-resources, {total_errors} errors  → {contents_path}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="All-in-one: split PDFs, fill resources, fix URLs, extract section names, add elective names, and download MP3s"
    )
    parser.add_argument(
        "chapter_path",
        nargs="?",
        help="Optional relative subject/book path under data/, e.g. biology-oup/1a. Omit to process all subjects under ./data.",
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
        "--skip-section-names",
        action="store_true",
        help="Skip step 4 (extract section names from first section page images)",
    )
    parser.add_argument(
        "--skip-book-names",
        action="store_true",
        help="Skip step 5 (add root book/topic names)",
    )
    parser.add_argument(
        "--skip-mp3s",
        action="store_true",
        help="Skip step 6 (download MP3s)",
    )
    parser.add_argument(
        "--skip-htmls",
        action="store_true",
        help="Skip step 7 (download HTMLs and their sub-resources)",
    )
    parser.add_argument(
        "-f", "--force",
        action="store_true",
        help="Force re-download and re-process HTML files even if they already exist",
    )
    parser.add_argument(
        "--capture-title",
        type=int,
        default=0,
        metavar="N",
        help="Capture book title from first N page images via ETT/vLLM (step 8). 0 = disabled.",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_root = os.path.join(base_dir, "data")

    if args.chapter_path:
        TEXTBOOKS_DIR = os.path.join(data_root, args.chapter_path)
        if not os.path.isdir(TEXTBOOKS_DIR):
            print(f"ERROR: directory not found: {TEXTBOOKS_DIR}", file=sys.stderr)
            sys.exit(1)
        _process_scope(TEXTBOOKS_DIR, args.chapter_path, args, base_dir)
        print("\nDone.")
        return

    subject_dirs = sorted(
        (
            entry.name for entry in os.scandir(data_root)
            if entry.is_dir()
        ),
        key=_natural_id_sort_key,
    )

    if not subject_dirs:
        print(f"ERROR: no subject directories found under: {data_root}", file=sys.stderr)
        sys.exit(1)

    for index, subject_id in enumerate(subject_dirs):
        if index > 0:
            print("\n\n")
        subject_dir = os.path.join(data_root, subject_id)
        print("@" * 60)
        print(f"  Subject: {subject_id}")
        print("@" * 60)
        _process_scope(subject_dir, subject_id, args, base_dir)

    print("\nDone.")


if __name__ == "__main__":
    main()
