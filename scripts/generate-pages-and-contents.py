#!/var/www/html/pdf-reader/.venv/bin/python3
"""
all-in-one.py

Usage:
    python3 scripts/all-in-one.py biology-oup/1a

Output:
    1. Splits each multi-page PDF into individual PNG images.

        This reads every PDF in:
            data/textbooks/biology-oup/1a/en/contents/*.pdf
            data/textbooks/biology-oup/1a/tc/contents/*.pdf

        and writes numbered PNGs into:
            data/textbooks/biology-oup/1a/en/contents/pages/1-1.png   (section 1, page 1)
            data/textbooks/biology-oup/1a/en/contents/pages/1-2.png   (section 1, page 2)
            ...
            data/textbooks/biology-oup/1a/tc/contents/pages/1-1.png
            
    2. Reads all resource files and updates <book>/contents.json by filling resources into the correct section.

            <subject>/<book>/contents.json e.g. data/biology-oup/1a/contents.json

            data/textbooks/biology-oup/1a/en/resources/resource-*.json
            data/textbooks/biology-oup/1a/tc/resources/resource-*.json

        The section number is extracted from the part before the hyphen in the
        "page" field of each resource (e.g., "6" from "6-5").
        

    3. Fixes resource URLs in contents.json that are missing the /isolution-web/
        path segment.

        Before:
            https://isolution.oupchina.com.hk/.iSolution/ebook_user_content/...

        After:
            https://isolution.oupchina.com.hk/isolution-web/.iSolution/ebook_user_content/...


     4. Extracts each English section name from the first page image of that
         section and fills contents[].en.name in contents.json.

                data/textbooks/biology-oup/1a/en/contents/pages/1-1.png
                data/textbooks/math-oup/4a/en/contents/pages/01-1.png

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
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.request import urlretrieve

import fitz  # PyMuPDF
import requests
import urllib3
# Suppress SSL verification warnings (internal CA / self-signed certs)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


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


# ── Past-paper by-topic section title mappings ─────────────────────────────
# Extracted from https://passpaper-unstoppable.github.io/dse.life/ppindex/
# These replace the ETT/vLLM extraction for by-topics section titles.
PAST_PAPER_BY_TOPIC_TITLES = {
    "math": {
        "p1": {
            "en": {
                "1":  "Estimation",
                "2":  "Percentages",
                "3":  "Indices and Logarithms",
                "4":  "Polynomials",
                "5":  "Formulas",
                "6":  "Identities, Equations and the Number System",
                "7":  "Functions and Graphs",
                "8":  "Rate, Ratio and Variation",
                "9":  "Arithmetic and Geometric Sequences",
                "10": "Inequalities and Linear Programming",
                "11": "Geometry of Rectilinear Figure",
                "12": "Geometry of Circles",
                "13": "Basic Trigonometry",
                "14": "Applications of Trigonometry",
                "15": "Mensuration",
                "16": "Coordinate Geometry",
                "17": "Counting Principles and Probability",
                "18": "Statistics",
                "bk1": "Book 1 Topic 1-18",
            },
            "tc": {},
        },
        "p2": {
            "en": {
                "0":  "Number System",
                "1":  "Percentages",
                "2":  "Functions and Graphs",
                "3":  "Exponential and Logarithmic Functions",
                "4":  "More about Polynomials",
                "5":  "More about Equations",
                "6":  "Rate, Ratio and Variations",
                "7":  "Sequences",
                "8":  "Inequalities and Linear Programming",
                "9":  "Mensuration",
                "10": "Plane Geometry",
                "11": "Locus",
                "12": "Coordinates Geometry",
                "13": "Trigonometry",
                "14": "Permutation and Combination",
                "15": "More about Probability",
                "16": "Measures of Dispersion",
                "bk1": "Book 1 Topic 0-16",
            },
            "tc": {},
        },
    },
    "biology": {
        "p1": {
            "en": {
                "1":  "Cell and membrane transport",
                "2":  "Enzymes",
                "3":  "Nutrition in humans",
                "4":  "Gas exchange in humans",
                "5":  "Transport in humans",
                "6":  "Nutrition and gas exchange in plants",
                "7":  "Transpiration, transport and support in plants",
                "8":  "Cell division and reproduction",
                "9":  "Growth and development",
                "10": "Growth responses of plants",
                "11": "Coordination in humans",
                "12": "Movement in humans",
                "13": "Homeostasis",
                "14": "Biodiversity",
                "15": "Ecosystems",
                "16": "Photosynthesis",
                "17": "Respiration",
                "18": "Health and diseases",
                "19": "Basic genetics, Molecular and applied genetics",
                "20": "Evolution",
                "all": "All Topic 1-20",
            },
            "tc": {},
        },
        "p2": {
            "en": {
                "1":  "Body defence",
                "2":  "Cell activities",
                "3":  "Cell division",
                "4":  "Diversity of organisms and classifications",
                "5":  "Detection of environmental conditions in mammals",
                "6":  "Ecosystems",
                "7":  "Evolution",
                "8":  "Excretion and osmoregulation",
                "9":  "Food and humans",
                "10": "Gaseous exchange in humans",
                "11": "Genetic engineering",
                "12": "Genetics",
                "13": "Growth and development",
                "14": "Growth response of plant",
                "15": "Hormonal co-ordination",
                "16": "Man and microorganisms",
                "17": "Man's effect on his environment",
                "18": "Nervous co-ordination",
                "19": "Nutrition and gaseous exchange in plants",
                "20": "Nutrition in mammals",
                "21": "Photosynthesis",
                "22": "Reproduction",
                "23": "Respiration",
                "24": "Support and movement",
                "25": "Temperature regulation in mammals",
                "26": "Transport in human",
                "27": "Water and organisms",
                "28": "Elective — Human Physiology",
                "29": "Elective — Applied Ecology",
                "30": "Elective — Biotechnology",
                "all": "All (excluding electives)",
            },
            "tc": {},
        },
    },
    "chemistry": {
        "flat": {
            "en": {
                "1":  "Laboratory Safety and Precautions",
                "2":  "Planet Earth",
                "3":  "Microscopic World",
                "4":  "Metals",
                "5":  "Acid and Bases",
                "6":  "Fossil fuels and Carbon Compounds",
                "7":  "Microscopic World II",
                "8":  "Redox Reactions, Chemical Cells and Electrolysis",
                "9":  "Chemical Reactions and Energy",
                "10": "Rate of Reaction",
                "11": "Chemical Equilibrium",
                "12": "Chemistry of Carbon Compounds",
                "13": "Patterns in the Chemical World",
                "14": "Industrial Chemistry (E1)",
                "15": "Analytical Chemistry (E2)",
                "bk1": "Book 1 Topic 1-6",
                "bk2": "Book 2 Topic 7-13",
                "bk3": "Book 3 E1+E2",
            },
            "tc": {
                "1":  "地球",
                "2":  "微觀世界 I",
                "3":  "金屬",
                "4":  "酸和鹽",
                "5":  "化石燃料和碳化合物",
                "6":  "微觀世界 II",
                "7":  "化學電池",
                "8":  "化學反應與能量",
                "9":  "氧化還原反應",
                "10": "電解",
                "11": "反應速率",
                "12": "氣體的摩爾數",
                "13": "平衡常數",
                "14": "同系列和同分異構",
                "15": "碳化合物的化學",
                "16": "重要有機物質",
                "17": "化學世界中的規律",
                "18": "MC Answers",
                "19": "CE LQ Answers",
                "20": "DSE LQ Answers",
                "21": "E1 工業化學",
                "22": "E2 分析化學",
                "all": "All (excluding E1, E2)",
            },
        },
    },
    "physics": {
        "flat": {
            "en": {
                "1":  "Temperature, Heat and Internal energy",
                "2":  "Transfer Processes",
                "3":  "Change of State",
                "4":  "General Gas Law",
                "5":  "Kinetic Theory",
                "6":  "Position and Movement",
                "7":  "Newton's Laws",
                "8":  "Moment of Force",
                "9":  "Work, Energy and Power",
                "10": "Momentum",
                "11": "Projectile Motion",
                "12": "Circular Motion",
                "13": "Gravitation",
                "14": "Wave Propagation",
                "15": "Wave Phenomena",
                "16": "Reflection and Refraction of Light",
                "17": "Lenses",
                "18": "Wave Nature of Light",
                "19": "Sound",
                "20": "Electrostatics",
                "21": "Electric Circuits",
                "22": "Domestic Electricity",
                "23": "Magnetic Field",
                "24": "Electromagnetic Induction",
                "25": "Alternating Current",
                "26": "Radiation and Radioactivity",
                "27": "Atomic Model",
                "28": "Nuclear Energy",
                "e1": "Astronomy and Space Science",
                "e2": "Atomic World",
                "e3": "Energy and Use of Energy",
                "bk1": "Book 1 Topic 1-5",
                "bk2": "Book 2 Topic 6-13",
                "bk3": "Book 3 Topic 14-19",
                "bk4": "Book 4 Topic 20-25",
                "bk5": "Book 5 Topic 26-28",
            },
            "tc": {
                "1":  "熱和氣體",
                "2":  "力和運動",
                "3":  "波動",
                "4":  "電和磁",
                "5":  "放射現象和核能",
                "6":  "天文學和航天科學",
                "7":  "原子世界",
                "8":  "能量和能源的使用",
                "9":  "醫學物理學",
                "10": "MC Answers",
                "11": "CE LQ Answers",
                "12": "DSE Answers",
                "13": "2018-2021 By Topic",
                "14": "2018-2021 Answer",
                "bk1": "Book 1 Topic 1-5",
                "bk2": "Book 2 Topic 6-9",
            },
        },
    },
}


def _lookup_section_title(subject_id, section, paper, lang):
    """Look up a by-topics section title from the static reference mapping.

    Returns the title string, or empty string if not found.
    """
    subject_map = PAST_PAPER_BY_TOPIC_TITLES.get(subject_id)
    if not subject_map:
        return ""
    paper_key = f"p{paper}" if paper else "flat"
    paper_map = subject_map.get(paper_key)
    if not paper_map:
        return ""
    lang_map = paper_map.get(lang)
    if not lang_map:
        return ""
    return lang_map.get(section, "")


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


def split_pdfs(data_dir, args):
    """Split multi-page PDFs into individual PNG (or JPG) images.

    Processes both {lang}/contents/ (main textbook) and
    {lang}/contents.tn/ (teacher's notes) directories.
    """
    langs_available = [lang for lang in ("en", "tc")
                       if os.path.isdir(os.path.join(data_dir, lang))]
    if not langs_available:
        print(f"  [skip] No language directories (en/, tc/) found in {data_dir}")
        return

    for language in langs_available:
        lang_dir = os.path.join(data_dir, language)

        # Process both "contents" and "contents.tn" if they exist
        for subdir_name in ("contents", "contents.tn"):
            pdf_dir = os.path.join(lang_dir, subdir_name)
            pages_dir = os.path.join(pdf_dir, "pages")
            _split_one_pdf_dir(pdf_dir, pages_dir, args)


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
        "url": os.environ.get("VLLM_API_URL") or env_values.get("VLLM_API_URL") or "https://gentle.aied.hku.hk/api/generate",
        "model": os.environ.get("VLLM_MODEL") or env_values.get("VLLM_MODEL") or "OpenGVLab/InternVL3_5-38B",
        "api_key": os.environ.get("VLLM_APIKEY") or env_values.get("VLLM_APIKEY") or "",
        "provider": os.environ.get("VLLM_PROVIDER") or env_values.get("VLLM_PROVIDER") or "ett-vllm",
    }


def send_ett_request(url, api_key, model, file_path, prompt, provider="ett-vllm"):
    """Send a single image + prompt to the AI gateway using requests (same as
    the proven test-aigateway-long-request-prompt.py pattern)."""
    mime_type, _ = mimetypes.guess_type(str(file_path))
    if mime_type is None:
        mime_type = "application/octet-stream"

    try:
        resp = requests.post(
            url,
            files={
                "provider": (None, provider),
                "apiKey": (None, api_key),
                "model": (None, model),
                "prompt": (None, prompt),
                "files": (Path(file_path).name, open(file_path, "rb"), mime_type),
            },
            headers={"Accept": "application/json"},
            timeout=120,
            verify=False,
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


def _find_first_section_page_image(data_dir, section):
    """Find the first English page image for *section*.

    Accepts exact section IDs (``1-1.png``), zero-padded IDs
    (``01-1.png``), and generated image formats supported by the reader.
    """
    pages_dir = os.path.join(data_dir, "en", "contents", "pages")
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


def _clean_extracted_section_title(raw_text, section):
    """Normalize an ETT response to one plain English section title."""
    if not raw_text:
        return ""

    lines = [" ".join(line.strip().split()) for line in raw_text.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""

    title = lines[0]
    title = re.sub(r"^```(?:text)?\s*", "", title, flags=re.IGNORECASE).strip()
    title = re.sub(r"\s*```$", "", title).strip()
    title = re.sub(r"^[\"'“”‘’«»]+|[\"'“”‘’«»]+$", "", title).strip()
    title = re.sub(r"^(?:section|chapter|unit)\s+", "", title, flags=re.IGNORECASE).strip()
    title = re.sub(r"^(?:title|section\s+title|section\s+name)\s*[:：]\s*", "", title, flags=re.IGNORECASE).strip()

    section_text = str(section).strip()
    escaped_section = re.escape(section_text)
    title = re.sub(rf"^{escaped_section}\s*[-–—.:：]?\s*", "", title).strip()
    normalized_section = _normalize_section_id(section_text)
    if normalized_section != section_text:
        title = re.sub(rf"^{re.escape(normalized_section)}\s*[-–—.:：]?\s*", "", title).strip()

    if title.upper() in {"UNKNOWN", "N/A", "NA", "NONE"}:
        return ""
    return title


def fill_section_names_from_first_pages(data_dir, base_dir):
    contents_path = os.path.join(data_dir, "contents.json")

    if os.path.exists(contents_path):
        with open(contents_path, "r", encoding="utf-8") as f:
            contents = json.load(f)
    else:
        contents = _create_skeleton_from_pdfs(data_dir)
        if not contents:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    config = get_ai_gateway_config(base_dir)
    if not config["api_key"]:
        print("  [skip] VLLM_APIKEY not configured; cannot extract section names")
        return

    print(f"  Gateway: {config['url']}")
    print(f"  Provider: {config['provider']}  |  Model: {config['model']}")
    print(f"  API key: {config['api_key'][:8]}...{config['api_key'][-4:]} ({len(config['api_key'])} chars)")
    updates = 0
    missing = []
    failed = []
    extracted = {}
    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue

        image_path = _find_first_section_page_image(data_dir, section)
        if not image_path:
            missing.append(section)
            continue

        prompt = (
            "This image is the first page of one textbook section. "
            "Extract the English section title/name for this section only. "
            "Return ONLY the section title as plain text. "
            "Do not include the section number, book title, page number, labels, explanations, or Markdown. "
            "If no English section title is visible, return UNKNOWN."
        )
        result = send_ett_request(config["url"], config["api_key"], config["model"], image_path, prompt, provider=config["provider"])
        raw_text = extract_text_from_ett_result(result)
        # Surface gateway errors instead of silently treating them as empty titles
        if isinstance(result, dict) and result.get("error"):
            error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
            print(f"    ⚠  Section {section}: gateway error — {str(error_detail)[:200]}")
        title = _clean_extracted_section_title(raw_text, section)
        if not title:
            failed.append(section)
            continue

        item.setdefault("en", {})
        old_value = item["en"].get("name", "")
        if old_value != title:
            item["en"]["name"] = title
            updates += 1
        extracted[section] = title
        print(f"  Section {section}: {Path(image_path).name} → {title}")

    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    print(f"\n  Updated English section names in {contents_path}")
    for section in sorted(extracted.keys(), key=_section_sort_key):
        print(f"    Section {section}: {extracted[section]}")
    print(f"    Changed: {updates}")
    if missing:
        print(f"    Missing first-page images: {', '.join(missing)}")
    if failed:
        print(f"    No title extracted: {', '.join(failed)}")


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
            verify=False,
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


def capture_book_title(data_dir, page_count, base_dir):
    """Use ETT/vLLM to extract the book title from the first *page_count*
    page images and write it as ``nameEn`` in contents.json."""

    contents_path = os.path.join(data_dir, "contents.json")
    pages_dir = os.path.join(data_dir, "en", "contents", "pages")

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
        data = _create_skeleton_from_pdfs(data_dir)
        if not data:
            print(f"  [skip] No PDFs found to create {contents_path}")
            return

    existing_name = data.get("nameEn") or data.get("name") or ""

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
        print("  [skip] ETT/vLLM could not determine a title")
        if existing_name:
            print(f"  Keeping existing nameEn: {existing_name}")
        return

    # Clean up the response — take the first meaningful line
    title = raw_text.strip().split("\n")[0].strip()
    title = re.sub(r'^["\'«‹„]|["\'»›”]$', '', title).strip()
    # Remove common prefixes like "Title: " or "Book Title: "
    title = re.sub(r'^(?i)(book\s+)?title\s*[:：]\s*', '', title).strip()

    if not title or len(title) < 2:
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


def download_htmls(data_dir, force=False):
    """Download all HTML resources referenced in contents.json to local htmls/
    folders. Also download all files referenced within each HTML (images, CSS,
    JS, etc.) and rewrite URLs to local paths.

    If *force* is False, HTML files that already exist on disk are skipped
    entirely (no download and no sub-resource processing)."""

    contents_path = os.path.join(data_dir, "contents.json")
    if not os.path.exists(contents_path):
        print(f"  [skip] {contents_path} — not found")
        return

    with open(contents_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    book = data.get("chapter", os.path.basename(data_dir))
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
                html_dir = os.path.join(data_dir, lang, "htmls")
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
                    mp3_dir = os.path.join(data_dir, lang, "mp3s")
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
                    parts = os.path.normpath(data_dir).split(os.sep)
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
                    parts = os.path.normpath(data_dir).split(os.sep)
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
                parts = os.path.normpath(data_dir).split(os.sep)
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
#  Past Papers Processing
# ═══════════════════════════════════════════════════════════════════════════════

def _split_pdf_to_pages(pdf_path, pages_dir, prefix, dpi=200, fmt="png"):
    """Split a single multi-page PDF into individual images.
    Returns a list of (page_number, output_filename) tuples."""
    os.makedirs(pages_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    results = []
    for page_idx in range(doc.page_count):
        page_num = page_idx + 1
        out_name = f"{prefix}-{page_num}.{fmt}"
        out_path = os.path.join(pages_dir, out_name)
        if not os.path.exists(out_path):
            page = doc[page_idx]
            mat = fitz.Matrix(dpi / 72, dpi / 72)
            pix = page.get_pixmap(matrix=mat)
            if fmt == "jpg":
                pix.pil_save(out_path, optimize=True, quality=85)
            else:
                pix.save(out_path)
        results.append((page_num, out_name))
    doc.close()
    return results


def _split_pdf_to_single_page_pdfs(pdf_path, pages_dir, prefix):
    """Split a multi-page PDF into individual single-page PDFs.
    Returns a list of (page_number, output_filename) tuples."""
    os.makedirs(pages_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    results = []
    for page_idx in range(doc.page_count):
        page_num = page_idx + 1
        out_name = f"{prefix}-{page_num}.pdf"
        out_path = os.path.join(pages_dir, out_name)
        if not os.path.exists(out_path):
            new_doc = fitz.open()
            new_doc.insert_pdf(doc, from_page=page_idx, to_page=page_idx)
            new_doc.save(out_path)
            new_doc.close()
        results.append((page_num, out_name))
    doc.close()
    return results


def _normalize_past_paper_stem(stem):
    """Normalize malformed paper stems like 'p1 ' to 'p1'."""
    normalized = re.sub(r"\s+", "", str(stem or "").strip())
    return normalized


def _cleanup_generated_year_page_outputs(pages_dir, prefix, image_format):
    """Remove stale generated split-page outputs for one by-years paper type.

    Deletes only generated page files in pages/, not the source PDFs in the year root.
    """
    if not os.path.isdir(pages_dir):
        return

    normalized_prefix = _normalize_past_paper_stem(prefix)
    image_exts = {"png", "jpg", "jpeg", "webp"}

    for fname in os.listdir(pages_dir):
        stem, ext = os.path.splitext(fname)
        ext = ext.lstrip('.').lower()
        if not ext:
            continue
        compact_stem = re.sub(r"\s+", "", stem)
        if not compact_stem.startswith(f"{normalized_prefix}-"):
            continue
        if ext == 'pdf' or ext in image_exts:
            try:
                os.remove(os.path.join(pages_dir, fname))
            except OSError:
                pass


def _create_contents_skeleton(papers_dir, paper_id):
    """Create a minimal contents.json for a past-paper directory."""
    chapter = paper_id if paper_id else os.path.basename(papers_dir)
    skeleton = {
        "chapter": chapter,
        "contents": []
    }
    if os.path.isdir(papers_dir):
        for f in sorted(os.listdir(papers_dir)):
            if not f.endswith(".pdf"):
                continue
            stem = f[:-4]
            # Derive section: part before first "-" if any, else whole stem
            if "-" in stem:
                sec = stem.split("-")[0]
            else:
                sec = stem
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


def _extract_title_from_pdf_first_page(pdf_path, section, base_dir):
    """Render the first page of a PDF to a temp PNG and extract its title via ETT.

    Returns the cleaned title string, or empty string on failure.
    """
    config = get_ai_gateway_config(base_dir)
    if not config["api_key"]:
        print("    [skip] VLLM_APIKEY not configured; cannot extract titles")
        return ""

    # Render first page to temp image
    temp_dir = os.path.join(base_dir, "_tmp_tpage")
    os.makedirs(temp_dir, exist_ok=True)
    temp_img = os.path.join(temp_dir, f"_ett_{os.path.basename(pdf_path)}_{section}_page1.png")

    try:
        doc = fitz.open(pdf_path)
        if doc.page_count == 0:
            doc.close()
            return ""
        page = doc[0]
        mat = fitz.Matrix(150 / 72, 150 / 72)  # 150 DPI for extraction
        pix = page.get_pixmap(matrix=mat)
        pix.save(temp_img)
        doc.close()
    except Exception as e:
        print(f"    ⚠  {Path(pdf_path).name}: error rendering first page — {e}")
        return ""

    prompt = (
        "This image is the first page of one past-paper section/topic. "
        "Extract the English topic title/name for this section only. "
        "Return ONLY the topic title as plain text. "
        "Do not include the section number, book title, page number, labels, explanations, or Markdown. "
        "If no English title is visible, return UNKNOWN."
    )
    result = send_ett_request(
        config["url"], config["api_key"], config["model"],
        temp_img, prompt, provider=config["provider"],
    )
    raw_text = extract_text_from_ett_result(result)
    if isinstance(result, dict) and result.get("error"):
        error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
        print(f"    ⚠  Section {section}: gateway error — {str(error_detail)[:200]}")
    else:
        print(f"    Raw ETT response: {raw_text[:100]}")
    title = _clean_extracted_section_title(raw_text, section)

    # Clean up temp image
    try:
        os.remove(temp_img)
    except OSError:
        pass

    return title


def _extract_past_paper_titles_via_ett(contents, pages_dir, base_dir):
    """Use ETT/vLLM to extract section titles from the first page image of each
    past paper section/PDF.  Updates contents entries in-place."""
    config = get_ai_gateway_config(base_dir)
    if not config["api_key"]:
        print("    [skip] VLLM_APIKEY not configured; cannot extract titles")
        return

    print(f"    Gateway: {config['url']}")
    print(f"    Provider: {config['provider']}  |  Model: {config['model']}")

    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue

        # Find the first page image for this section
        image_path = None
        if os.path.isdir(pages_dir):
            for fname in os.listdir(pages_dir):
                match = re.match(rf"^{re.escape(section)}-1\.(png|jpg|jpeg|webp)$", fname, re.IGNORECASE)
                if match:
                    image_path = os.path.join(pages_dir, fname)
                    break

        if not image_path:
            print(f"    ⚠  Section {section}: no first-page image found")
            continue

        prompt = (
            "This image is the first page of one past-paper section/topic. "
            "Extract the English topic title/name for this section only. "
            "Return ONLY the topic title as plain text. "
            "Do not include the section number, book title, page number, labels, explanations, or Markdown. "
            "If no English title is visible, return UNKNOWN."
        )
        result = send_ett_request(
            config["url"], config["api_key"], config["model"],
            image_path, prompt, provider=config["provider"],
        )
        raw_text = extract_text_from_ett_result(result)
        if isinstance(result, dict) and result.get("error"):
            error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
            print(f"    ⚠  Section {section}: gateway error — {str(error_detail)[:200]}")
        title = _clean_extracted_section_title(raw_text, section)
        if title:
            item.setdefault("en", {})
            item["en"]["name"] = title
            print(f"    Section {section}: {Path(image_path).name} → {title}")
        else:
            print(f"    Section {section}: {Path(image_path).name} → (no title extracted)")


def _process_past_papers(data_root, args, base_dir):
    """Main orchestrator for processing past-papers."""
    past_papers_root = os.path.join(data_root, "past-papers")
    if not os.path.isdir(past_papers_root):
        print(f"ERROR: past-papers directory not found: {past_papers_root}", file=sys.stderr)
        sys.exit(1)

    subjects = sorted(
        (entry.name for entry in os.scandir(past_papers_root) if entry.is_dir()),
        key=_natural_id_sort_key,
    )

    for subject_idx, subject_id in enumerate(subjects):
        if subject_idx > 0:
            print("\n\n")
        print("=" * 70)
        print(f"  Subject: {subject_id}")
        print("=" * 70)

        subject_dir = os.path.join(past_papers_root, subject_id)

        # ── Process by-topics ─────────────────────────────────────
        by_topics_dir = os.path.join(subject_dir, "by-topics")
        if os.path.isdir(by_topics_dir):
            print("\n" + "-" * 60)
            print("  by-topics")
            print("-" * 60)
            if args.contents_json_only:
                _process_by_topics_contents_json_only(by_topics_dir, args, base_dir, subject_id)
            else:
                _process_by_topics(by_topics_dir, args, base_dir, subject_id)

        # ── Process by-years ──────────────────────────────────────
        by_years_dir = os.path.join(subject_dir, "by-years")
        if os.path.isdir(by_years_dir):
            print("\n" + "-" * 60)
            print("  by-years")
            print("-" * 60)
            if args.contents_json_only:
                _process_by_years_contents_json_only(by_years_dir, args, base_dir)
            else:
                _process_by_years(by_years_dir, args, base_dir)

    print("\nDone.")


def _process_by_topics(by_topics_dir, args, base_dir, subject_id):
    """Process by-topics directory.  Handles both structures:
    Case 1 — with paper-1/ and paper-2/ subdirectories
    Case 2 — flat (PDFs directly in <lang>/)
    """
    langs = sorted(
        (entry.name for entry in os.scandir(by_topics_dir) if entry.is_dir()),
    )

    for lang_idx, lang in enumerate(langs):
        if lang_idx > 0:
            print()
        lang_dir = os.path.join(by_topics_dir, lang)
        print(f"  Language: {lang}")

        # Detect structure: check for paper-1/, paper-2/ subdirs
        has_paper_dirs = (
            os.path.isdir(os.path.join(lang_dir, "paper-1"))
            or os.path.isdir(os.path.join(lang_dir, "paper-2"))
        )

        if has_paper_dirs:
            _process_by_topics_with_papers(lang_dir, lang, args, base_dir, subject_id)
        else:
            _process_by_topics_flat(lang_dir, lang, args, base_dir, subject_id)


def _process_by_topics_with_papers(lang_dir, lang, args, base_dir, subject_id):
    """Case 1: by-topics with paper-1 and paper-2 subdirectories.
    
    For each PDF in paper-1/ and paper-2/:
      - Extract pages to <paper>/<paper-id>/pages/*.png
      - Generate <paper>/<paper-id>/contents.json
      - Extract title from static reference mapping
    """
    for paper_dir_name in ("paper-1", "paper-2"):
        paper_dir = os.path.join(lang_dir, paper_dir_name)
        if not os.path.isdir(paper_dir):
            continue

        print(f"    {paper_dir_name}/")
        paper_num = paper_dir_name.split("-")[-1]

        # Collect PDFs in this paper directory
        pdf_files = sorted(
            f for f in os.listdir(paper_dir) if f.endswith(".pdf")
        )
        if not pdf_files:
            print(f"      (no PDFs)")
            continue

        for pdf_name in pdf_files:
            pdf_path = os.path.join(paper_dir, pdf_name)
            paper_id = pdf_name[:-4]  # Remove ".pdf" extension

            # Directory for this paper-id
            paper_id_dir = os.path.join(paper_dir, paper_id)
            pages_dir = os.path.join(paper_id_dir, "pages")
            contents_path = os.path.join(paper_id_dir, "contents.json")

            print(f"      {pdf_name} → {paper_id}/")

            # Extract pages
            if not args.skip_pdfs:
                results = _split_pdf_to_pages(
                    pdf_path, pages_dir, paper_id,
                    dpi=args.dpi, fmt=args.format,
                )
                print(f"        → {len(results)} pages to {pages_dir}/")
            else:
                print(f"        [skip] PDF splitting")

            # Ensure paper_id_dir exists
            os.makedirs(paper_id_dir, exist_ok=True)

            # Look up title from static mapping
            title = ""
            if not args.skip_section_names:
                title = _lookup_section_title(subject_id, paper_id, paper_num, lang)

            # Generate contents.json — single entry from the PDF itself
            if not os.path.exists(contents_path):
                try:
                    page_num = int(paper_id)
                except ValueError:
                    try:
                        page_num = float(paper_id)
                    except ValueError:
                        page_num = paper_id
                contents = {
                    "chapter": paper_id,
                    "contents": [{
                        "section": paper_id,
                        "page": page_num,
                        "en": {"name": title if lang == "en" else "", "resources": []},
                        "tc": {"name": title if lang == "tc" else "", "resources": []},
                    }],
                }
                # Also set the other language name if available
                other_lang = "tc" if lang == "en" else "en"
                other_title = _lookup_section_title(subject_id, paper_id, paper_num, other_lang)
                if other_title:
                    contents["contents"][0][other_lang]["name"] = other_title
                with open(contents_path, "w", encoding="utf-8") as f:
                    json.dump(contents, f, ensure_ascii=False, indent=4)
                print(f"        Created {contents_path}  ({title or 'no title'})")
            else:
                # Update existing contents.json with title
                with open(contents_path, "r", encoding="utf-8") as f:
                    contents = json.load(f)
                if contents["contents"]:
                    contents["contents"][0][lang]["name"] = title
                    other_lang = "tc" if lang == "en" else "en"
                    other_title = _lookup_section_title(subject_id, paper_id, paper_num, other_lang)
                    if other_title:
                        contents["contents"][0][other_lang]["name"] = other_title
                with open(contents_path, "w", encoding="utf-8") as f:
                    json.dump(contents, f, ensure_ascii=False, indent=4)
                print(f"        Updated {contents_path}  ({title or 'no title'})")


def _process_by_topics_flat(lang_dir, lang, args, base_dir, subject_id):
    """Case 2: by-topics without paper-1/paper-2 — PDFs directly in <lang>/.
    
      - Extract pages to <lang>/pages/*.png
      - Generate <lang>/contents.json
      - Extract title from static reference mapping
    """
    pages_dir = os.path.join(lang_dir, "pages")
    contents_path = os.path.join(lang_dir, "contents.json")

    # Collect PDFs
    pdf_files = sorted(f for f in os.listdir(lang_dir) if f.endswith(".pdf"))
    if not pdf_files:
        print(f"      (no PDFs)")
        return

    # Extract pages from each PDF into shared pages/ directory
    if not args.skip_pdfs:
        for pdf_name in pdf_files:
            pdf_path = os.path.join(lang_dir, pdf_name)
            stem = pdf_name[:-4]
            print(f"      {pdf_name}")
            results = _split_pdf_to_pages(
                pdf_path, pages_dir, stem,
                dpi=args.dpi, fmt=args.format,
            )
            print(f"        → {len(results)} pages to {pages_dir}/")
    else:
        print(f"      [skip] PDF splitting")

    # Generate contents.json skeleton from PDFs
    if not os.path.exists(contents_path) or args.force:
        contents = _create_contents_skeleton(lang_dir, None)
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(contents, f, ensure_ascii=False, indent=4)
        print(f"      Created {contents_path}")
    else:
        with open(contents_path, "r", encoding="utf-8") as f:
            contents = json.load(f)

    # Fill titles from static mapping
    if not args.skip_section_names:
        for item in contents.get("contents", []):
            section = str(item.get("section", ""))
            title = _lookup_section_title(subject_id, section, "", lang)
            if title:
                item[lang]["name"] = title
                # Also fill other language if available
                other_lang = "tc" if lang == "en" else "en"
                other_title = _lookup_section_title(subject_id, section, "", other_lang)
                if other_title:
                    item[other_lang]["name"] = other_title
                print(f"        Section {section}: {title}")
        with open(contents_path, "w", encoding="utf-8") as f:
            json.dump(contents, f, ensure_ascii=False, indent=4)


def _process_by_years(by_years_dir, args, base_dir):
    """Case 3: by-years processing.
    
    From /by-years/<lang>/<year>/<paper-id>*.pdf
    Extract pages to /by-years/<lang>/<year>/pages/*.<format>
    """
    langs = sorted(
        (entry.name for entry in os.scandir(by_years_dir) if entry.is_dir()),
    )

    for lang in langs:
        lang_dir = os.path.join(by_years_dir, lang)
        print(f"  Language: {lang}")

        year_dirs = sorted(
            (entry.name for entry in os.scandir(lang_dir) if entry.is_dir()),
            key=_natural_id_sort_key,
        )

        for year in year_dirs:
            year_dir = os.path.join(lang_dir, year)
            pages_dir = os.path.join(year_dir, "pages")

            pdf_files = sorted(f for f in os.listdir(year_dir) if f.endswith(".pdf"))
            if not pdf_files:
                continue

            if not args.skip_pdfs:
                total_pages = 0
                for pdf_name in pdf_files:
                    pdf_path = os.path.join(year_dir, pdf_name)
                    stem = _normalize_past_paper_stem(pdf_name[:-4])
                    _cleanup_generated_year_page_outputs(pages_dir, stem, args.format)
                    results = _split_pdf_to_pages(
                        pdf_path,
                        pages_dir,
                        stem,
                        dpi=args.dpi,
                        fmt=args.format,
                    )
                    total_pages += len(results)
                print(f"    {year}: {len(pdf_files)} PDFs → {total_pages} page images in {pages_dir}/")
            else:
                print(f"    {year}: [skip] PDF splitting")


def _process_by_topics_contents_json_only(by_topics_dir, args, base_dir, subject_id):
    """Generate a single unified contents.json for the whole by-topics directory.

    Scans all languages, both paper-1/paper-2 subdirectories (if present),
    and flat PDF directories.  Produces one contents.json at:
        <by_topics_dir>/contents.json

    Each entry in contents[] corresponds to one PDF with:
      - section: the PDF's stem (e.g. "1", "p1a")
      - paper: "1" or "2" (if under paper-*/ subdirs), else ""
      - lang: the language code (e.g. "en", "tc")
      - en.name / tc.name: title from static reference mapping
    """
    contents_entries = []
    langs = sorted(
        (entry.name for entry in os.scandir(by_topics_dir) if entry.is_dir()),
    )

    for lang in langs:
        lang_dir = os.path.join(by_topics_dir, lang)
        has_paper_dirs = (
            os.path.isdir(os.path.join(lang_dir, "paper-1"))
            or os.path.isdir(os.path.join(lang_dir, "paper-2"))
        )

        if has_paper_dirs:
            for paper_dir_name in ("paper-1", "paper-2"):
                paper_dir = os.path.join(lang_dir, paper_dir_name)
                if not os.path.isdir(paper_dir):
                    continue
                paper_num = paper_dir_name.split("-")[-1]  # "1" or "2"
                pdf_files = sorted(f for f in os.listdir(paper_dir) if f.endswith(".pdf"))
                for pdf_name in pdf_files:
                    stem = pdf_name[:-4]
                    title = ""
                    if not args.skip_section_names:
                        title = _lookup_section_title(subject_id, stem, paper_num, lang)
                    entry = {
                        "section": stem,
                        "paper": paper_num,
                        "lang": lang,
                        "page": _parse_numeric(stem),
                        "en": {"name": title if lang == "en" else "", "resources": []},
                        "tc": {"name": title if lang == "tc" else "", "resources": []},
                    }
                    # Also set the name for the other language if available
                    other_lang = "tc" if lang == "en" else "en"
                    other_title = _lookup_section_title(subject_id, stem, paper_num, other_lang)
                    if other_title:
                        entry[other_lang]["name"] = other_title
                    contents_entries.append(entry)
                    print(f"      [{lang}/{paper_dir_name}] {pdf_name} → {title or '(no title)'}")
        else:
            # Flat: PDFs directly in lang_dir
            pdf_files = sorted(f for f in os.listdir(lang_dir) if f.endswith(".pdf"))
            for pdf_name in pdf_files:
                stem = pdf_name[:-4]
                title = ""
                if not args.skip_section_names:
                    title = _lookup_section_title(subject_id, stem, "", lang)
                entry = {
                    "section": stem,
                    "paper": "",
                    "lang": lang,
                    "page": _parse_numeric(stem),
                    "en": {"name": title if lang == "en" else "", "resources": []},
                    "tc": {"name": title if lang == "tc" else "", "resources": []},
                }
                # Also set the name for the other language if available
                other_lang = "tc" if lang == "en" else "en"
                other_title = _lookup_section_title(subject_id, stem, "", other_lang)
                if other_title:
                    entry[other_lang]["name"] = other_title
                contents_entries.append(entry)
                print(f"      [{lang}] {pdf_name} → {title or '(no title)'}")

    # Sort: by paper ("" < "1" < "2"), then by section numerically, then by lang
    def _sort_key(e):
        p = e.get("paper", "")
        sec = e.get("section", "")
        try:
            sec_key = (0, float(sec))
        except ValueError:
            sec_key = (1, sec)
        return (0 if not p else 1, p if p else "", sec_key, e.get("lang", ""))

    contents_entries.sort(key=_sort_key)

    contents = {
        "chapter": os.path.basename(by_topics_dir),
        "contents": contents_entries,
    }
    contents_path = os.path.join(by_topics_dir, "contents.json")
    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)
    print(f"    Wrote {contents_path}")


def _process_by_years_contents_json_only(by_years_dir, args, base_dir):
    """Generate a single unified contents.json for the whole by-years directory.

    Produces one contents.json at:
        <by_years_dir>/contents.json

    Each entry in contents[] corresponds to one PDF with:
      - section: the PDF's stem (e.g. "p1a", "p1")
      - year: the year directory name (e.g. "2012")
      - lang: the language code (e.g. "en", "tc")
    """
    contents_entries = []
    langs = sorted(
        (entry.name for entry in os.scandir(by_years_dir) if entry.is_dir()),
    )

    for lang in langs:
        lang_dir = os.path.join(by_years_dir, lang)
        year_dirs = sorted(
            (entry.name for entry in os.scandir(lang_dir) if entry.is_dir()),
            key=_natural_id_sort_key,
        )

        for year in year_dirs:
            year_dir = os.path.join(lang_dir, year)
            pdf_files = sorted(f for f in os.listdir(year_dir) if f.endswith(".pdf"))
            for pdf_name in pdf_files:
                stem = pdf_name[:-4]
                entry = {
                    "section": stem,
                    "year": year,
                    "lang": lang,
                    "page": _parse_numeric(stem),
                    "en": {"name": "", "resources": []},
                    "tc": {"name": "", "resources": []},
                }
                contents_entries.append(entry)
                print(f"      [{lang}/{year}] {pdf_name}")

    # Sort by year, then by lang, then by section
    def _sort_key(e):
        yr = e.get("year", "")
        sec = e.get("section", "")
        try:
            sec_key = (0, float(sec))
        except ValueError:
            sec_key = (1, sec)
        return (yr, e.get("lang", ""), sec_key)

    contents_entries.sort(key=_sort_key)

    contents = {
        "chapter": os.path.basename(by_years_dir),
        "contents": contents_entries,
    }
    contents_path = os.path.join(by_years_dir, "contents.json")
    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)
    print(f"    Wrote {contents_path}")


def _parse_numeric(value):
    """Try to convert a string to numeric (int or float), return as-is on failure."""
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


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
    parser.add_argument(
        "--past-papers",
        action="store_true",
        help="Process past-papers in data/past-papers/ instead of textbooks in data/",
    )
    parser.add_argument(
        "--contents-json-only",
        action="store_true",
        help="[past-papers only] Generate only contents.json with ETT-extracted titles from the first page of each PDF. Does NOT extract page images.",
    )
    args = parser.parse_args()

    # --contents-json-only implies --skip-pdfs (no page extraction needed)
    if args.contents_json_only:
        args.skip_pdfs = True

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_root = os.path.join(base_dir, "data")

    if args.past_papers:
        _process_past_papers(data_root, args, base_dir)
        return

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
