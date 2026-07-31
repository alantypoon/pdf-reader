#!/var/www/html/pdf-reader/.venv/bin/python3
"""
add-section-names.py

Usage:
    python3 scripts/add-section-names.py math-oup        # loops all books in math-oup/
    python3 scripts/add-section-names.py biology-oup/1a
    python3 scripts/add-section-names.py math-oup/4a
    python3 scripts/add-section-names.py math-oup/4a/1   # only book 4a, section 1

Given a subject directory (e.g. math-oup), loops over every book subdirectory
that contains an en/ folder.  Given a specific book path (e.g. math-oup/4a),
processes just that one book.  Given a book path with a trailing section
number (e.g. math-oup/4a/1), processes only that section within that book.

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
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image


# Set by -v/--verbose — prints full request payload + response (pretty JSON)
VERBOSE = False


def _log_request(url, form_fields, tag='VERBOSE'):
    """Print the outgoing multipart form request in a readable, pretty-printed way.

    *form_fields* is the dict passed as `files=` to requests.post — file tuples
    are summarized (name/mime/size) rather than dumping raw bytes.
    """
    print(f'\n{"─"*50}')
    print(f'[{tag}] POST {url}')
    print(f'[{tag}] Form fields:')
    display = {}
    for key, value in form_fields.items():
        if key == 'apiKey':
            display[key] = '<redacted>'
            continue
        # requests-style tuple: (filename, fh_or_bytes, mime) or (None, value)
        if isinstance(value, tuple):
            if len(value) >= 3 and value[0] is not None:
                filename, fh, mime = value[0], value[1], value[2]
                try:
                    pos = fh.tell()
                    fh.seek(0, 2)
                    size = fh.tell()
                    fh.seek(pos)
                except Exception:
                    size = '?'
                display[key] = f'<file: {filename}, {mime}, {size} bytes>'
            else:
                val = value[1] if len(value) > 1 else value[0]
                if isinstance(val, str) and len(val) > 500:
                    display[key] = val[:500] + f'… ({len(val)} chars)'
                else:
                    display[key] = val
        else:
            display[key] = value
    print(json.dumps(display, indent=2, ensure_ascii=False))
    print(f'{"─"*50}')


def _log_response(status, text, tag='VERBOSE'):
    """Print the API response, pretty-printed as JSON when possible."""
    print(f'[{tag}] HTTP {status}  ({len(text)} bytes)')
    try:
        parsed = json.loads(text)
        print(f'[{tag}] Response (pretty-printed):')
        print(json.dumps(parsed, indent=2, ensure_ascii=False))
    except (json.JSONDecodeError, TypeError):
        print(f'[{tag}] Response body (raw):\n{text}')
    print(f'{"─"*50}\n')


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
        "ollama_extract_model": "gpt-oss:120b",
        "ollama_api_key": os.environ.get("OLLAMA_APIKEY") or env_values.get("OLLAMA_APIKEY") or "",
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  ETT image-to-text request
# ═══════════════════════════════════════════════════════════════════════════════

def crop_image_to_bytes(file_path, top=140, bottom=600):
    """Crop the image at *file_path* to (0, top) → (max_width, bottom) and return
    PNG bytes in memory. The file is never written to disk."""
    img = Image.open(file_path)
    w, h = img.size
    crop_top = max(0, top)
    crop_bottom = min(h, bottom)
    cropped = img.crop((0, crop_top, w, crop_bottom))
    buf = BytesIO()
    cropped.save(buf, format='PNG')
    buf.seek(0)
    return buf


def send_ett_request(url, api_key, model, file_path, prompt, provider="ett-vllm", image_bytes=None):
    """Send a single image + prompt to the AI gateway.

    If *image_bytes* is given (BytesIO), it is sent as the file payload instead
    of reading *file_path* from disk.
    """
    if image_bytes is not None:
        file_payload = (Path(file_path).name, image_bytes, 'image/png')
    else:
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if mime_type is None:
            mime_type = "application/octet-stream"
        file_payload = (Path(file_path).name, open(file_path, "rb"), mime_type)

    form_fields = {
        "provider": (None, provider),
        "apiKey": (None, api_key),
        "model": (None, model),
        "prompt": (None, prompt),
        "responseFormat": (None, "json"),
        "files": file_payload,
    }

    if VERBOSE:
        _log_request(url, form_fields)

    try:
        resp = requests.post(
            url,
            files=form_fields,
            headers={"Accept": "application/json"},
            timeout=120,
        )
        if VERBOSE:
            _log_response(resp.status_code, resp.text)
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


def extract_title_from_text(config, raw_text, section):
    """Use gpt-oss:120b via ollama to extract the section title from ETT raw text."""
    if not raw_text:
        return ""

    prompt = (
        "From the following text extracted from a textbook page image, "
        "extract the English section title. The section title is the main heading "
        "that appears in the largest font, typically next to section number "
        f"{section}. Return ONLY the section title as plain text in a JSON object "
        "with key \"title\". Example: {\"title\": \"Number Systems\"}.\n\n"
        f"Extracted text:\n{raw_text}"
    )

    form_fields = {
        "provider": (None, config["ollama_provider"]),
        "apiKey": (None, config["ollama_api_key"]),
        "model": (None, config["ollama_extract_model"]),
        "prompt": (None, prompt),
        "responseFormat": (None, "json"),
    }

    if VERBOSE:
        _log_request(config["url"], form_fields, tag='EXTRACT')

    try:
        resp = requests.post(
            config["url"],
            files=form_fields,
            headers={"Accept": "application/json"},
            timeout=120,
        )
        if VERBOSE:
            _log_response(resp.status_code, resp.text, tag='EXTRACT')
        if resp.status_code != 200:
            print(f"[extract] HTTP {resp.status_code}", end=" ")
            return ""

        data = resp.json()
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

        # Try to parse the title from JSON response
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and "title" in parsed:
                return parsed["title"].strip()
        except (json.JSONDecodeError, TypeError):
            pass

        # Fallback: return the text as-is
        return text.strip() if isinstance(text, str) else ""

    except requests.Timeout:
        print("[extract] timeout", end=" ")
        return ""
    except requests.RequestException as err:
        print(f"[extract] {err}", end=" ")
        return ""


# ═══════════════════════════════════════════════════════════════════════════════
#  Translation via ollama provider
# ═══════════════════════════════════════════════════════════════════════════════

def translate_to_chinese(config, english_names):
    """Translate a dict of {section: english_name} to Chinese using gpt-oss:120b.

    Returns dict of {section: chinese_name}.
    """
    if not english_names:
        return {}

    # Build a simple translation prompt
    names_list = "\n".join(f"{sec}: {name}" for sec, name in sorted(english_names.items(), key=lambda x: _section_sort_key(x[0])))
    prompt = (
        "Translate the following English textbook section names to Traditional Chinese (繁體中文). "
        "Return the result as a JSON object where keys are section numbers and values are the Chinese translations. "
        "Example: {\"1\": \"數系\", \"2\": \"代數\"}.\n\n"
        f"{names_list}"
    )

    try:
        form_fields = {
            "provider": (None, config["ollama_provider"]),
            "apiKey": (None, config["ollama_api_key"]),
            "model": (None, config["ollama_extract_model"]),
            "prompt": (None, prompt),
            "responseFormat": (None, "json"),
        }
        if VERBOSE:
            _log_request(config["url"], form_fields)

        resp = requests.post(
            config["url"],
            files=form_fields,
            headers={"Accept": "application/json"},
            timeout=120,
        )
        if VERBOSE:
            _log_response(resp.status_code, resp.text)
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

        # Try to parse the inner text as a JSON object of translations
        translations = {}
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                for sec, zh_name in parsed.items():
                    if isinstance(zh_name, str) and zh_name.strip():
                        translations[sec] = zh_name.strip()
                if translations:
                    return translations
        except (json.JSONDecodeError, TypeError):
            pass

        # Fallback: parse "section: Chinese name" per line
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
    """Sort key that handles mixed alphanumeric book IDs like 4a, 4b, 5a, 6."""
    text = str(value).strip()
    # Split into leading numeric part and trailing alpha part
    match = re.match(r"^(\d+)(.*)", text)
    if match:
        return (0, int(match.group(1)), match.group(2))
    try:
        return (0, int(text), "")
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

def add_section_names(data_dir, base_dir, section_filter=None):
    """Extract English section names from first page images and translate to Chinese.

    If *section_filter* is given, only that section (matched against the
    contents.json "section" field, normalized) is processed.
    """
    contents_path = os.path.join(data_dir, "contents.json")

    if not os.path.exists(contents_path):
        print(f"  [error] {contents_path} not found")
        sys.exit(1)

    with open(contents_path, "r", encoding="utf-8") as f:
        contents = json.load(f)

    normalized_filter = _normalize_section_id(section_filter) if section_filter is not None else None

    config = get_config(base_dir)
    if not config["api_key"]:
        print("  [error] VLLM_APIKEY not configured; cannot extract section names")
        sys.exit(1)

    print(f"  Gateway: {config['url']}")
    print(f"  ETT Provider: {config['provider']}  |  Model: {config['model']}")
    print(f"  Extraction/Translation Provider: {config['ollama_provider']}  |  Model: {config['ollama_extract_model']}")
    print(f"  API key: {config['api_key'][:8]}...{config['api_key'][-4:]} ({len(config['api_key'])} chars)")
    print()

    extracted = {}
    missing = []
    failed = []

    for item in contents.get("contents", []):
        section = str(item.get("section", "")).strip()
        if not section:
            continue
        if normalized_filter is not None and _normalize_section_id(section) != normalized_filter:
            continue

        # Strip leading zeros from numeric section numbers (e.g. "01" → "1")
        section_display = section
        try:
            section_display = str(int(section))
        except ValueError:
            pass

        prompt = (
            "Extract the english title from this textbook page. "
            "The section title has these characteristics: "
            "1) it is in the largest font on the page, "
            f"2) it appears on the right side of the large font-sized chapter/section number {section_display}, "
            "3) This occupys one to two lines of text. "
            "4) ignore the small text, footnotes, page numbers, and other text on the page. They are irrelevant. "
            "Return the result as JSON with key \"title\". e.g. {\"title\": \"Number Systems\"}."
        )

        image_path = _find_first_section_page_image(data_dir, section)
        if not image_path:
            missing.append(section)
            continue

        rel_path = os.path.relpath(image_path, data_dir)
        print(f"  Section {section}: {rel_path} ...", end=" ", flush=True)

        if VERBOSE:
            print()
            print(f"    [VERBOSE] Image path: {os.path.abspath(image_path)}")
            print(f"    [VERBOSE] Extraction prompt: {prompt}")

        # Crop the top portion of the page (title area) in memory before sending
        cropped_bytes = crop_image_to_bytes(image_path, top=140, bottom=600)

        result = send_ett_request(
            config["url"], config["api_key"], config["model"],
            image_path, prompt, provider=config["provider"],
            image_bytes=cropped_bytes,
        )

        if isinstance(result, dict) and result.get("error"):
            error_detail = result.get("body", "") or result.get("reason", "") or json.dumps(result)
            print(f"ERROR ({str(error_detail)[:100]})")
            failed.append(section)
            continue

        raw_text = extract_text_from_ett_result(result)

        if VERBOSE:
            print(f"    [VERBOSE] Generation response text: {raw_text!r}")

        # Use gpt-oss:120b to extract the title from the raw OCR text
        title = extract_title_from_text(config, raw_text, section)

        if VERBOSE:
            print(f"    [VERBOSE] gpt-oss:120b extracted title: {title!r}")

        # Fallback to regex-based cleaning if LLM extraction failed
        if not title:
            title = _clean_extracted_section_title(raw_text, section)

        if not title:
            print("no title extracted")
            failed.append(section)
            continue

        extracted[section] = title
        item.setdefault("en", {})
        item["en"]["name"] = title
        print(f"→ {title}")

    if normalized_filter is not None and not extracted and not missing and not failed:
        print(f"  [warn] No section matching '{section_filter}' found in {contents_path}")

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


def _split_chapter_path(data_root, chapter_path):
    """Resolve *chapter_path* to (scope_path, section_filter).

    If the full path exists as a directory under data/, it's used as-is
    (subject or book scope, section_filter=None). Otherwise, the last path
    segment is treated as a section/chapter number filter and the parent
    path (which must be a book directory) is used as the scope.
    """
    full_dir = os.path.join(data_root, chapter_path)
    if os.path.isdir(full_dir):
        return chapter_path, None

    parent_path, sep, last_seg = chapter_path.rpartition("/")
    if not sep:
        return chapter_path, None

    parent_dir = os.path.join(data_root, parent_path)
    if os.path.isdir(parent_dir):
        return parent_path, last_seg

    return chapter_path, None


def main():
    global VERBOSE

    parser = argparse.ArgumentParser(
        description="Extract English section names from first page images and translate to Chinese"
    )
    parser.add_argument(
        "chapter_path",
        help="Relative path under data/, e.g. 'math-oup' (all books), 'math-oup/4a' (one book), "
             "or 'math-oup/4a/1' (one book, one section)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Log the full request payload and response (pretty-printed JSON) for every API call",
    )
    args = parser.parse_args()

    VERBOSE = args.verbose

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    data_root = os.path.join(base_dir, "data")

    scope_path, section_filter = _split_chapter_path(data_root, args.chapter_path)
    scope_dir = os.path.join(data_root, scope_path)
    if not os.path.isdir(scope_dir):
        print(f"ERROR: directory not found: {scope_dir}", file=sys.stderr)
        sys.exit(1)

    books = _discover_book_dirs(scope_dir)

    for i, book in enumerate(books):
        if book is not None:
            book_dir = os.path.join(scope_dir, book)
            label = f"{scope_path}/{book}"
        else:
            book_dir = scope_dir
            label = scope_path

        if section_filter is not None:
            label = f"{label}  (section {section_filter} only)"

        if i > 0:
            print("\n\n")

        print("#" * 60)
        print(f"  Book: {label}")
        print(f"  Data: {book_dir}")
        print("#" * 60)
        print()

        add_section_names(book_dir, base_dir, section_filter=section_filter)
        print()

    print("\nDone.")


if __name__ == "__main__":
    main()
