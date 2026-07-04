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


    4. Extracts the English section list from en/contents.png and fills
       contents[].en.name in contents.json.

            data/biology-oup/1a/en/contents.png
            data/biology-oup/1b/en/contents.png

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


"""

import argparse
import glob
import json
import mimetypes
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.request import urlretrieve

import fitz  # PyMuPDF


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
            print("  Step 4 — Extracting English section names from contents.png")
            print("=" * 60)
            fill_section_names_from_contents_png(book_dir, base_dir)
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


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 1 — PDF splitting
# ═══════════════════════════════════════════════════════════════════════════════

def split_pdfs(data_dir, args):
    """Split multi-page PDFs into individual PNG (or JPG) images."""
    langs_available = [lang for lang in ("en", "tc")
                       if os.path.isdir(os.path.join(data_dir, lang))]
    if not langs_available:
        print(f"  [skip] No language directories (en/, tc/) found in {data_dir}")
        return

    for language in langs_available:
        lang_dir = os.path.join(data_dir, language)

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
    book_section_id = os.path.basename(os.path.normpath(data_dir))

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
    skeleton = _create_skeleton_from_pdfs(data_dir)
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

    # Read resource files from {data_dir}/{lang}/resources/resource*.json
    any_resources_found = False
    for lang in ("en", "tc"):
        resources_dir = os.path.join(data_dir, lang, "resources")
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
        print(f"  [info]   {os.path.join(data_dir, 'en', 'resources')}/")
        print(f"  [info]   {os.path.join(data_dir, 'tc', 'resources')}/")


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
#  Step 4 — Extract section names from contents.png
# ═══════════════════════════════════════════════════════════════════════════════

def load_env_file(env_path):
    values = {}
    if not os.path.isfile(env_path):
        return values

    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get_ai_gateway_config(base_dir):
    env_values = load_env_file(os.path.join(base_dir, ".env"))
    return {
        "url": os.environ.get("AIGATEWAY_API_URL") or env_values.get("AIGATEWAY_API_URL") or "https://aigateway.aied.hku.hk/api/generate",
        "model": os.environ.get("AIGATEWAY_MODEL") or env_values.get("AIGATEWAY_MODEL") or "vllm|OpenGVLab/InternVL3_5-38B",
        "api_key": os.environ.get("AIGATEWAY_APIKEY") or env_values.get("AIGATEWAY_APIKEY") or "",
    }


def send_ett_request(url, api_key, model, file_path, prompt):
    boundary = "----PdfReaderContentsEtt"

    def field(name, value):
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n'
            f"\r\n"
            f"{value}\r\n"
        ).encode("utf-8")

    mime_type, _ = mimetypes.guess_type(str(file_path))
    if mime_type is None:
        mime_type = "application/octet-stream"

    with open(file_path, "rb") as fh:
        file_bytes = fh.read()

    parts = [
        field("provider", "ett"),
        field("model", model),
        field("apiKey", api_key),
        field("stream", "false"),
        field("prompt", prompt),
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files"; filename="{Path(file_path).name}"\r\n'
            f"Content-Type: {mime_type}\r\n"
            f"\r\n"
        ).encode("utf-8"),
        file_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]

    body = b"".join(parts)
    req = Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as err:
        return {"error": True, "status": err.code, "body": err.read().decode("utf-8", errors="replace")}
    except URLError as err:
        return {"error": True, "reason": str(err.reason)}


def extract_text_from_ett_result(result):
    if not isinstance(result, dict) or result.get("error"):
        return ""

    text = result.get("response", "") or result.get("text", "") or result.get("output", "") or ""
    master = result.get("masterSummary", "")
    if isinstance(master, str) and master.strip():
        text = master
    elif isinstance(master, dict):
        text = master.get("text", "") or master.get("summary", "") or text

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

    return text.strip() if isinstance(text, str) else ""




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

    return entries


def fill_section_names_from_contents_png(data_dir, base_dir):
    contents_path = os.path.join(data_dir, "contents.json")
    image_path = os.path.join(data_dir, "en", "contents.png")

    if not os.path.exists(image_path):
        print(f"  [skip] {image_path} — not found")
        return

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            contents = json.load(f)
    else:
        contents = _create_skeleton_from_pdfs(data_dir)
        if not contents:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    config = get_ai_gateway_config(base_dir)
    prompt = (
        "Extract the numbered section list from this biology contents image. "
        "Return plain text lines only in the form 'section_number section_title'. "
        "Ignore the book title line. Preserve the exact section titles."
    )

    extracted_text = ""
    if config["api_key"]:
        result = send_ett_request(config["url"], config["api_key"], config["model"], image_path, prompt)
        extracted_text = extract_text_from_ett_result(result)
        if extracted_text:
            print("  ETT extracted section names from contents.png")
        else:
            print("  [skip] ETT returned no usable text for contents.png")
            return
    else:
        print("  [skip] AIGATEWAY_APIKEY not configured; cannot extract section names")
        return

    entries = parse_contents_entries(extracted_text)
    if not entries:
        print(f"  [skip] No section names parsed from {image_path}")
        return

    updates = 0
    missing = []
    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue
        title = entries.get(section)
        if title is None:
            missing.append(section)
            continue

        item.setdefault("en", {})
        old_value = item["en"].get("name", "")
        if old_value != title:
            item["en"]["name"] = title
            updates += 1

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    print(f"\n  Updated English section names in {contents_path}")
    for section in sorted(entries.keys(), key=lambda s: (0, float(s), "") if re.fullmatch(r'\d+(?:\.\d+)?', s) else (1, 0, s)):
        print(f"    Section {section}: {entries[section]}")
    print(f"    Changed: {updates}")
    if missing:
        print(f"    Unmatched sections: {', '.join(missing)}")


# ═══════════════════════════════════════════════════════════════════════════════
#  Step 5 — Add root-level book/topic names
# ═══════════════════════════════════════════════════════════════════════════════

def _resolve_root_book_names(data_dir):
    subject_id = os.path.basename(os.path.dirname(os.path.normpath(data_dir))).lower()
    book_id = os.path.basename(os.path.normpath(data_dir)).lower()

    if subject_id == "chemistry-winter":
        return CHEMISTRY_BOOK_NAMES.get(book_id)
    if subject_id == "physics-oup":
        return PHYSICS_BOOK_NAMES.get(book_id)
    if subject_id == "biology-oup":
        return BIOLOGY_ELECTIVE_BOOK_NAMES.get(book_id)
    return None


def add_root_book_name(data_dir):
    """Add root-level English/Chinese book names when known."""
    contents_path = os.path.join(data_dir, "contents.json")
    chapter_code = os.path.basename(os.path.normpath(data_dir)).lower()
    resolved = _resolve_root_book_names(data_dir)

    if not resolved:
        print(f"  [skip] {chapter_code} — no configured root book/topic name")
        return

    name_en, name_zh = resolved

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = _create_skeleton_from_pdfs(data_dir)
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
#  Step 6 — Download MP3 resources
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
                mp3_dir = os.path.join(data_dir, lang, "mp3s")
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
        help="Skip step 4 (extract section names from contents.png)",
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
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_root = os.path.join(base_dir, "data")

    if args.chapter_path:
        data_dir = os.path.join(data_root, args.chapter_path)
        if not os.path.isdir(data_dir):
            print(f"ERROR: directory not found: {data_dir}", file=sys.stderr)
            sys.exit(1)
        _process_scope(data_dir, args.chapter_path, args, base_dir)
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
