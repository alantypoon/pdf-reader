#!/var/www/html/pdf-reader/.venv/bin/python3
"""
add-section-names.py

Usage:
    python3 scripts/add-section-names.py math-oup        # loops all books in math-oup/
    python3 scripts/add-section-names.py biology-oup/1a
    python3 scripts/add-section-names.py math-oup/4a

Given a subject directory (e.g. math-oup), loops over every book subdirectory
that contains an en/ folder.  Given a specific book path (e.g. math-oup/4a),
processes just that one book.

Extracts each English section name from the first page image of that section
and fills contents[].en.name in contents.json.

Then translates the English section names to Chinese and fills contents[].tc.name.

Image sources:
    data/biology-oup/1a/en/contents/pages/1-1.png
    data/math-oup/4a/en/contents/pages/01-1.png
    ...

Uses the AI Gateway ETT flow for image-to-text extraction (ett-vllm),
and gpt-oss:20b via ollama provider for English→Chinese translation.
"""

import argparse
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path

import requests


# ═══════════════════════════════════════════════════════════════════════════════
#  Config
# ═══════════════════════════════════════════════════════════════════════════════

def load_env_file(env_path):
    """Parse .env file supporting single-line key=value pairs."""
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

            val = remainder.strip()
            if len(val) >= 2 and ((val.startswith('"') and val.endswith('"')) or
                                  (val.startswith("'") and val.endswith("'"))):
                val = val[1:-1]
            elif val.startswith('"') or val.startswith("'"):
                quote_char = val[0]
                inner = val[1:]
                closing_found = False
                while not closing_found:
                    idx = inner.find(quote_char)
                    if idx >= 0:
                        inner = inner[:idx]
                        closing_found = True
                        break
                    next_line = f.readline()
                    if not next_line:
                        break
                    inner += "\n" + next_line.rstrip("\n\r")
                val = inner.strip()
            else:
                val = val.strip().strip('"').strip("'")

            values[key] = val
    return values


def get_config(base_dir):
    env_values = load_env_file(os.path.join(base_dir, ".env"))
    return {
        "url": os.environ.get("VLLM_API_URL") or env_values.get("VLLM_API_URL") or "https://aigateway.aied.hku.hk/api/generate",
        "model": os.environ.get("VLLM_MODEL") or env_values.get("VLLM_MODEL") or "OpenGVLab/InternVL3_5-38B",
        "api_key": os.environ.get("VLLM_APIKEY") or env_values.get("VLLM_APIKEY") or "",
        "provider": os.environ.get("VLLM_PROVIDER") or env_values.get("VLLM_PROVIDER") or "ett-vllm",
        "ollama_provider": os.environ.get("OLLAMA_PROVIDER") or env_values.get("OLLAMA_PROVIDER") or "ollama",
        "ollama_model": "gpt-oss:20b",
        "ollama_api_key": os.environ.get("OLLAMA_APIKEY") or env_values.get("OLLAMA_APIKEY") or "",
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  ETT image-to-text request
# ═══════════════════════════════════════════════════════════════════════════════

def send_ett_request(url, api_key, model, file_path, prompt, provider="ett-vllm"):
    """Send a single image + prompt to the AI gateway."""
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
    """Extract text from ETT gateway response."""
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


# ═══════════════════════════════════════════════════════════════════════════════
#  Translation via ollama provider
# ═══════════════════════════════════════════════════════════════════════════════

def translate_to_chinese(config, english_names):
    """Translate a dict of {section: english_name} to Chinese using gpt-oss:20b.

    Returns dict of {section: chinese_name}.
    """
    if not english_names:
        return {}

    # Build a simple translation prompt
    names_list = "\n".join(f"{sec}: {name}" for sec, name in sorted(english_names.items(), key=lambda x: _section_sort_key(x[0])))
    prompt = (
        "Translate the following English textbook section names to Traditional Chinese (繁體中文). "
        "Return ONLY the translations in the exact same format: one per line, \"section_number: Chinese name\". "
        "Do not add explanations or extra text.\n\n"
        f"{names_list}"
    )

    try:
        resp = requests.post(
            config["url"],
            files={
                "provider": (None, config["ollama_provider"]),
                "apiKey": (None, config["ollama_api_key"]),
                "model": (None, config["ollama_model"]),
                "prompt": (None, prompt),
            },
            headers={"Accept": "application/json"},
            timeout=120,
        )
        if resp.status_code != 200:
            print(f"  [warn] Translation request failed: HTTP {resp.status_code}")
            return {}

        raw = resp.text
        # Try to parse as JSON first
        try:
            data = json.loads(raw)
            text = data.get("response", "") or data.get("text", "") or data.get("output", "") or ""
            if not text:
                generation = data.get("generation", "")
                if isinstance(generation, str):
                    text = generation
                elif isinstance(generation, dict):
                    text = generation.get("text", "") or generation.get("response", "") or ""
            if not text:
                master = data.get("masterSummary", "")
                if isinstance(master, str):
                    text = master
                elif isinstance(master, dict):
                    text = master.get("text", "") or master.get("summary", "") or ""
        except (json.JSONDecodeError, TypeError):
            text = raw

        # Parse the response: "section: Chinese name" per line
        translations = {}
        for line in text.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            match = re.match(r"^(\S+)\s*[:：]\s*(.+)$", line)
            if match:
                sec = match.group(1).strip()
                zh_name = match.group(2).strip()
                # Remove surrounding quotes if present
                zh_name = re.sub(r'^["\'""]+|["\'""]+$', '', zh_name).strip()
                translations[sec] = zh_name

        return translations

    except requests.Timeout:
        print("  [warn] Translation request timed out")
        return {}
    except requests.RequestException as err:
        print(f"  [warn] Translation request failed: {err}")
        return {}


# ═══════════════════════════════════════════════════════════════════════════════
#  Section name extraction helpers
# ═══════════════════════════════════════════════════════════════════════════════

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
    """Find the first English page image for *section*."""
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
    title = re.sub(r"^[\"'""''«»]+|[\"'""''«»]+$", "", title).strip()
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


def _natural_id_sort_key(value):
    text = str(value).strip()
    try:
        return (0, float(text), text)
    except ValueError:
        return (1, 0, text)


def _discover_book_dirs(scope_dir):
    """Return book directory names under a subject dir, or None if it's already a single book."""
    if not os.path.isdir(scope_dir):
        return []
    subdirs = sorted(
        (
            d for d in os.listdir(scope_dir)
            if os.path.isdir(os.path.join(scope_dir, d))
            and os.path.isdir(os.path.join(scope_dir, d, "en"))
        ),
        key=_natural_id_sort_key,
    )
    if not subdirs:
        # Maybe this IS a book dir (has en/ directly)
        if os.path.isdir(os.path.join(scope_dir, "en")):
            return [None]
        return []
    return subdirs


# ═══════════════════════════════════════════════════════════════════════════════
#  Main logic
# ═══════════════════════════════════════════════════════════════════════════════

def add_section_names(data_dir, base_dir):
    """Extract English section names from first page images and translate to Chinese."""
    contents_path = os.path.join(data_dir, "contents.json")

    if not os.path.exists(contents_path):
        print(f"  [error] {contents_path} not found")
        sys.exit(1)

    with open(contents_path, "r", encoding="utf-8") as f:
        contents = json.load(f)

    config = get_config(base_dir)
    if not config["api_key"]:
        print("  [error] VLLM_APIKEY not configured; cannot extract section names")
        sys.exit(1)

    print(f"  Gateway: {config['url']}")
    print(f"  ETT Provider: {config['provider']}  |  Model: {config['model']}")
    print(f"  Translation Provider: {config['ollama_provider']}  |  Model: {config['ollama_model']}")
    print(f"  API key: {config['api_key'][:8]}...{config['api_key'][-4:]} ({len(config['api_key'])} chars)")
    print()

    extracted = {}
    missing = []
    failed = []

    prompt = (
        "Extract the English section title from this textbook page. "
        "The section title has these characteristics: "
        "1) it is in the largest font on the page, "
        "2) it appears next to a large chapter/section number, "
        "3) it is located in the upper one fifth area of the page. "
        "Return ONLY the section title as plain text, nothing else."
    )

    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue

        image_path = _find_first_section_page_image(data_dir, section)
        if not image_path:
            missing.append(section)
            continue

        rel_path = os.path.relpath(image_path, data_dir)
        print(f"  Section {section}: {rel_path} ...", end=" ", flush=True)

        result = send_ett_request(
            config["url"], config["api_key"], config["model"],
            image_path, prompt, provider=config["provider"]
        )

        if isinstance(result, dict) and result.get("error"):
            error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
            print(f"ERROR ({str(error_detail)[:100]})")
            failed.append(section)
            continue

        raw_text = extract_text_from_ett_result(result)
        title = _clean_extracted_section_title(raw_text, section)

        if not title:
            print("no title extracted")
            failed.append(section)
            continue

        extracted[section] = title
        item.setdefault("en", {})
        item["en"]["name"] = title
        print(f"→ {title}")

    # ── Translate to Chinese ──
    if extracted:
        print(f"\n  Translating {len(extracted)} section name(s) to Chinese...")
        translations = translate_to_chinese(config, extracted)

        if translations:
            for item in contents.get("contents", []):
                section = str(item.get("section", "")).strip()
                if section in translations:
                    item.setdefault("tc", {})
                    item["tc"]["name"] = translations[section]

            print("  Translations:")
            for sec in sorted(translations.keys(), key=_section_sort_key):
                print(f"    Section {sec}: {translations[sec]}")
        else:
            print("  [warn] No translations returned")

    # ── Save ──
    with open(contents_path, "w", encoding="utf-8") as f:
        json.dump(contents, f, ensure_ascii=False, indent=4)

    # ── Summary ──
    print(f"\n  Summary:")
    print(f"    Updated: {contents_path}")
    print(f"    Extracted: {len(extracted)} section name(s)")
    for sec in sorted(extracted.keys(), key=_section_sort_key):
        print(f"      Section {sec}: {extracted[sec]}")
    if missing:
        print(f"    Missing first-page images: {', '.join(missing)}")
    if failed:
        print(f"    No title extracted: {', '.join(failed)}")


def main():
    parser = argparse.ArgumentParser(
        description="Extract English section names from first page images and translate to Chinese"
    )
    parser.add_argument(
        "chapter_path",
        help="Relative path under data/, e.g. 'math-oup' (loops all books) or 'math-oup/4a' (single book)",
    )
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_root = os.path.join(base_dir, "data")

    scope_dir = os.path.join(data_root, args.chapter_path)
    if not os.path.isdir(scope_dir):
        print(f"ERROR: directory not found: {scope_dir}", file=sys.stderr)
        sys.exit(1)

    books = _discover_book_dirs(scope_dir)

    for i, book in enumerate(books):
        if book is not None:
            book_dir = os.path.join(scope_dir, book)
            label = f"{args.chapter_path}/{book}"
        else:
            book_dir = scope_dir
            label = args.chapter_path

        if i > 0:
            print("\n\n")

        print("#" * 60)
        print(f"  Book: {label}")
        print(f"  Data: {book_dir}")
        print("#" * 60)
        print()

        add_section_names(book_dir, base_dir)
        print()

    print("\nDone.")


if __name__ == "__main__":
    main()
