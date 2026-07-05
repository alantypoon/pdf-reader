#!/usr/bin/env python3
"""
generate-study-materials.py — Batch-generate AI study materials for Book reader.

For each page, the script:
  1. Extracts English text from page images via the AI Gateway (ett-vllm, multipart)
  2. Generates English flashcards & MCQs (vllm text generation)
  4. Translates the English materials into Traditional Chinese
  5. Saves the bilingual result to MongoDB (pdf-reader.ai-generations)

Usage:
  python generate-study-materials.py                          # all subjects
  python generate-study-materials.py biology-oup              # one subject
  python generate-study-materials.py biology-oup/1a           # one book
  python generate-study-materials.py biology-oup/1a/1         # all pages under section 1
  python generate-study-materials.py biology-oup/1a/1/5       # page 5 only under section 1
  python generate-study-materials.py --force                  # regenerate existing
  python generate-study-materials.py -f                       # same as --force
  python generate-study-materials.py --force-to-regenerate    # same as --force
  python generate-study-materials.py --dry-run                # list what would be done
  python generate-study-materials.py --pages-per-section 3    # generate up to 3 sub-pages per section
"""

import os
import io
import sys
import json
import re
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

# Maximum dimension for images sent to the ETT pipeline.
# InternVL models have a limited context window; large images
# produce too many tokens and fail with 'prompt longer than
# maximum model length'.
ETT_MAX_IMAGE_DIM = 1536

# ── Paths ──────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = Path(os.environ.get('DATA_PATH', str(PROJECT_DIR / 'data')))
ENV_FILE = PROJECT_DIR / '.env'

# ── Load .env (always prefer .env values for our config keys) ──
_CONFIG_KEYS = {'DATA_PATH', 'MONGODB_URI', 'AIGATEWAY_API_URL',
                'AIGATEWAY_PROVIDER', 'AIGATEWAY_MODEL', 'AIGATEWAY_APIKEY'}
if ENV_FILE.exists():
    with open(ENV_FILE, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key in _CONFIG_KEYS and value:
                    os.environ[key] = value

MONGO_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017/pdf-reader')
AIGATEWAY_URL = os.environ.get('AIGATEWAY_API_URL', 'https://aigateway.aied.hku.hk/api/generate')
# Add ?debug_log=1 for diagnostic output from the gateway
AIGATEWAY_DEBUG_URL = AIGATEWAY_URL + ('&' if '?' in AIGATEWAY_URL else '?') + 'debug_log=1'
AIGATEWAY_PROVIDER = os.environ.get('AIGATEWAY_PROVIDER', 'ett-vllm')
AIGATEWAY_MODEL = os.environ.get('AIGATEWAY_MODEL', 'vllm|OpenGVLab/InternVL3_5-38B')
AIGATEWAY_APIKEY = os.environ.get('AIGATEWAY_APIKEY', '')

# The vllm provider (text-only) needs the model name WITHOUT the 'vllm|' prefix
_VLLM_MODEL = AIGATEWAY_MODEL.split('|', 1)[1] if '|' in AIGATEWAY_MODEL else AIGATEWAY_MODEL
_VLLM_PROVIDER = 'vllm'

DB_NAME = 'pdf-reader'
COLLECTION_NAME = 'ai-generations'
ALIGNMENT_VERSION = 1
DEFAULT_USER = 'alan'
REQUEST_TIMEOUT = 120
DELAY_BETWEEN_PAGES = 3   # seconds between pages (be gentle to the gateway)
DEBUG = False  # set by --debug flag; when True, prints full request payloads

# ── MongoDB ────────────────────────────────────────────────
import pymongo

_mongo_client = None
_ai_generations = None


def _get_collection():
    global _mongo_client, _ai_generations
    if _ai_generations is None:
        _mongo_client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
        _mongo_client.admin.command('ping')  # verify connection
        _ai_generations = _mongo_client[DB_NAME][COLLECTION_NAME]
        print(f'[mongo] connected to {DB_NAME}.{COLLECTION_NAME}')
    return _ai_generations


def _to_section_id(raw):
    """Convert a section number to the same numeric type the Node server uses.

    The server does `Number(sectionNum)`: integer sections become Int32,
    dotted sections (e.g. '1.1') become Double.  Non-numeric strings raise
    ValueError so the caller can skip them.
    """
    try:
        return int(raw)
    except (ValueError, TypeError):
        pass
    try:
        return float(raw)
    except (ValueError, TypeError):
        pass
    raise ValueError(f'Cannot convert section ID to number: {raw!r}')


def _build_ai_identity(subject_id, book_id, section_id, page_id):
    return {
        'subjectId': str(subject_id),
        'bookId': str(book_id),
        'sectionId': _to_section_id(section_id),
        'pageId': int(page_id),
    }


def _build_legacy_ai_identity(book_id, section_id, page_id):
    return {
        'subjectId': {'$exists': False},
        'bookId': str(book_id),
        'sectionId': _to_section_id(section_id),
        'pageId': int(page_id),
    }


def _find_ai_doc(subject_id, book_id, section_id, page_id):
    coll = _get_collection()
    identity = _build_ai_identity(subject_id, book_id, section_id, page_id)
    doc = coll.find_one(identity)
    if doc:
        return doc
    legacy = coll.find_one(_build_legacy_ai_identity(book_id, section_id, page_id))
    if legacy:
        coll.update_one({'_id': legacy['_id']}, {'$set': {'subjectId': str(subject_id)}})
        legacy['subjectId'] = str(subject_id)
    return legacy


def content_exists(subject_id, book_id, section_id, page_id):
    """Return True if a complete bilingual document already exists for this page.

    A complete record must have en+zh with summary+flashcards+mcq in both languages.
    If any part is missing, the document is treated as incomplete and will be regenerated.
    """
    doc = _find_ai_doc(subject_id, book_id, section_id, page_id)
    if not doc:
        return False

    def _is_complete(lang_content):
        if not isinstance(lang_content, dict):
            return False
        # Skip error envelopes (failed gateway calls)
        if lang_content.get('error') and (lang_content.get('success') is not None or lang_content.get('provider')):
            return False
        has_summary = isinstance(lang_content.get('summary'), list) and len(lang_content.get('summary', [])) > 0
        has_flashcards = isinstance(lang_content.get('flashcards'), list) and len(lang_content.get('flashcards', [])) > 0
        has_mcq = isinstance(lang_content.get('mcq'), list) and len(lang_content.get('mcq', [])) > 0
        return has_summary and has_flashcards and has_mcq

    en = doc.get('en') or {}
    zh = doc.get('zh') or {}
    en_ok = _is_complete(en)
    zh_ok = _is_complete(zh)

    if not en_ok or not zh_ok:
        missing = []
        if not en_ok:
            missing.append('en')
        if not zh_ok:
            missing.append('zh')
        print(f'    [incomplete] missing {", ".join(missing)} — will regenerate')
    return bool(en_ok and zh_ok)


def en_exists_zh_missing(subject_id, book_id, section_id, page_id):
    """Return (en_content, True) if en is complete but zh is missing/broken, else (None, False)."""
    doc = _find_ai_doc(subject_id, book_id, section_id, page_id)
    if not doc:
        return None, False

    def _is_complete(lang_content):
        if not isinstance(lang_content, dict):
            return False
        if lang_content.get('error') and (lang_content.get('success') is not None or lang_content.get('provider')):
            return False
        has_summary = isinstance(lang_content.get('summary'), list) and len(lang_content.get('summary', [])) > 0
        has_flashcards = isinstance(lang_content.get('flashcards'), list) and len(lang_content.get('flashcards', [])) > 0
        has_mcq = isinstance(lang_content.get('mcq'), list) and len(lang_content.get('mcq', [])) > 0
        return has_summary and has_flashcards and has_mcq

    en = doc.get('en') or {}
    zh = doc.get('zh') or {}
    en_ok = _is_complete(en)
    zh_ok = _is_complete(zh)

    if en_ok and not zh_ok:
        return en, True
    return None, False


def _normalize_generated_content(content):
    """Normalize generated content shape for DB/UI compatibility.

    Handles the {raw: "..."} fallback wrapper and filters invalid entries.
    """
    if not isinstance(content, dict):
        return content

    normalized = dict(content)

    # ── Recover from {raw: "{...valid json...}"} wrapper ──
    raw_val = normalized.pop('raw', None)
    if isinstance(raw_val, str) and raw_val.strip():
        inner = raw_val.strip()
        # Strip markdown fences
        inner = re.sub(r'^```(?:json)?\s*\n?', '', inner, flags=re.IGNORECASE)
        inner = re.sub(r'\n?```\s*$', '', inner)
        inner = inner.strip()
        if inner.startswith('{'):
            m = re.search(r'\{[\s\S]*\}', inner)
            json_str = m.group(0) if m else inner
            try:
                parsed_inner = json.loads(json_str)
            except json.JSONDecodeError:
                fixed = re.sub(r',\s*}', '}', json_str)
                fixed = re.sub(r',\s*]', ']', fixed)
                try:
                    parsed_inner = json.loads(fixed)
                except json.JSONDecodeError:
                    normalized['raw'] = inner
                    return normalized
            if isinstance(parsed_inner, dict):
                for k, v in parsed_inner.items():
                    if k not in normalized or not normalized[k]:
                        normalized[k] = v
        else:
            normalized['raw'] = inner

    # ── Filter invalid entries ──
    if isinstance(normalized.get('flashcards'), list):
        normalized['flashcards'] = [
            item for item in normalized['flashcards'] if isinstance(item, dict)
        ]
    if isinstance(normalized.get('mcq'), list):
        normalized['mcq'] = [
            item for item in normalized['mcq'] if isinstance(item, dict)
        ]

    return normalized


def save_content(subject_id, book_id, section_id, page_id, en_content, zh_content, user=DEFAULT_USER):
    """Upsert bilingual content into MongoDB matching the exact schema."""
    coll = _get_collection()
    now = datetime.now(timezone.utc).isoformat()
    identity = _build_ai_identity(subject_id, book_id, section_id, page_id)
    coll.delete_many({'$or': [identity, _build_legacy_ai_identity(book_id, section_id, page_id)]})
    coll.insert_one({
        **identity,
        'en': _normalize_generated_content(en_content),
        'zh': _normalize_generated_content(zh_content),
        'enUpdatedAt': now,
        'zhUpdatedAt': now,
        'updatedAt': now,
        'alignmentVersion': ALIGNMENT_VERSION,
        'user': str(user),
        'createdAt': now,
    })


# ── AI Gateway helpers ─────────────────────────────────────
import requests


def _call_ett_vllm(payload, files=None, timeout=REQUEST_TIMEOUT):
    """Call the ett-vllm provider.

    Always uses multipart/form-data — the ett-vllm provider does not accept
    JSON.  When ``files`` is provided, image files are attached for extraction;
    otherwise only form fields are sent for text-only generation/translation.
    """
    url = AIGATEWAY_DEBUG_URL
    headers = {'Accept': 'text/event-stream'}
    form = []
    for key, value in payload.items():
        form.append((key, (None, str(value) if not isinstance(value, str) else value)))
    if files:
        form.extend(files)

    if DEBUG:
        _log_request(url, payload, files)

    resp = requests.post(url, files=form, headers=headers, timeout=timeout)
    resp.raise_for_status()
    raw = resp.text

    if DEBUG:
        _log_response(resp.status_code, raw)

    return raw


def _log_request(url, payload, files):
    print(f'\n{"─"*50}')
    print(f'[DEBUG] POST {url}')
    print(f'[DEBUG] Form fields:')
    for k, v in payload.items():
        if k == 'apiKey':
            print(f'  {k}: <redacted>')
        elif isinstance(v, str) and len(v) > 200:
            print(f'  {k}: {v[:200]}... ({len(v)} chars)')
        else:
            print(f'  {k}: {v}')
    if files:
        print(f'[DEBUG] Files ({len(files)}):')
        for field_name, (filename, fh, mime) in files:
            try:
                pos = fh.tell()
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(pos)
            except Exception:
                size = '?'
            print(f'  {field_name}: {filename} ({mime}, {size} bytes)')
    else:
        print(f'[DEBUG] Files: (none — text-only request)')
    print(f'{"─"*50}')


def _log_response(status, text):
    print(f'[DEBUG] HTTP {status}  ({len(text)} bytes)')
    print(f'[DEBUG] Response body:\n{text}')
    print(f'{"─"*50}\n')


def _build_text_payload(prompt):
    """Return form-field dict for text-only generation/translation via the vllm provider."""
    return {
        'provider': _VLLM_PROVIDER,
        'model': _VLLM_MODEL,
        'apiKey': AIGATEWAY_APIKEY,
        'prompt': prompt,
        'max_tokens': '1000',
    }


def _extract_text(raw_text):
    """Pull plain text content from the gateway's JSON / SSE response."""
    try:
        parsed = json.loads(raw_text)
        parts = []
        if isinstance(parsed.get('files'), list):
            for f in parsed['files']:
                if isinstance(f, dict) and f.get('text'):
                    parts.append(f['text'])
        for key in ('text', 'content', 'response', 'masterSummary'):
            val = parsed.get(key)
            if isinstance(val, str) and val.strip():
                parts.append(val)
        combined = '\n\n'.join(p.strip() for p in parts if p.strip())
        if combined:
            return combined
    except (json.JSONDecodeError, TypeError):
        pass
    return raw_text.strip()


def _parse_generated_json(raw_text):
    """Parse the JSON output from the generation/translation step.

    Handles various gateway response wrappers: vllm {response: ...}, OpenAI
    {choices: [...]}, raw JSON objects, SSE streams, etc.
    """
    # Try direct JSON parse first
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        # ── vllm / ett-vllm wrapper: { "response": "```json\\n{...}\\n```" } ──
        # Matches server's parseGeneratedContent logic exactly
        if isinstance(parsed.get('response'), str) and parsed['response'].strip():
            inner = parsed['response']
            # Strip markdown fences
            inner = re.sub(r'^```(?:json)?\s*\n?', '', inner, flags=re.IGNORECASE)
            inner = re.sub(r'\n?```\s*$', '', inner)
            # Find JSON object
            m = re.search(r'\{[\s\S]*\}', inner)
            if m:
                try:
                    return json.loads(m.group(0))
                except json.JSONDecodeError:
                    # Try fixing trailing commas
                    fixed = re.sub(r',\s*}', '}', m.group(0))
                    fixed = re.sub(r',\s*]', ']', fixed)
                    try:
                        return json.loads(fixed)
                    except json.JSONDecodeError:
                        return {'raw': inner}
            return {'raw': inner}

        # ── OpenAI-compatible: { choices: [{ message: { content: "..." } }] } ──
        choices = parsed.get('choices')
        if isinstance(choices, list) and choices:
            content = choices[0].get('message', {}).get('content', '')
            m = re.search(r'\{[\s\S]*\}', content)
            if m:
                try:
                    return json.loads(m.group(0))
                except json.JSONDecodeError:
                    pass

        # ── Direct summary / flashcards / mcq present ──
        if 'summary' in parsed or 'flashcards' in parsed or 'mcq' in parsed:
            return parsed

        # ── Gateway error { "details": "...", "error": "..." } ──
        if parsed.get('error') and not parsed.get('response'):
            return {'error': str(parsed['error']), 'raw': raw_text}

        # ── files[].text concatenation ──
        if isinstance(parsed.get('files'), list):
            combined = '\n\n'.join(
                f.get('text', '') for f in parsed['files'] if isinstance(f, dict)
            )
            m = re.search(r'\{[\s\S]*\}', combined)
            if m:
                try:
                    return json.loads(m.group(0))
                except json.JSONDecodeError:
                    pass

        # ── text / content field ──
        for key in ('text', 'content'):
            val = parsed.get(key)
            if isinstance(val, str):
                m = re.search(r'\{[\s\S]*\}', val)
                if m:
                    try:
                        return json.loads(m.group(0))
                    except json.JSONDecodeError:
                        pass

    # Try SSE stream aggregation
    collected = ''
    for line in raw_text.split('\n'):
        if line.startswith('data: '):
            chunk = line[6:].strip()
            if chunk and chunk != '[DONE]':
                try:
                    c = json.loads(chunk)
                    choices = c.get('choices')
                    if choices:
                        collected += choices[0].get('delta', {}).get('content', '')
                    elif isinstance(c.get('content'), str):
                        collected += c['content']
                except json.JSONDecodeError:
                    pass
    if collected:
        m = re.search(r'\{[\s\S]*\}', collected)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass

    # Last resort — any JSON object in the raw text
    m = re.search(r'\{[\s\S]*\}', raw_text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    # Give up and return raw wrapper
    return {'raw': raw_text}


# ── Page text extraction ───────────────────────────────────



def _resize_for_ett(image_path):
    """Resize image to fit within ETT_MAX_IMAGE_DIM on the longest side.
    Returns (bytes, content_type)."""
    img = Image.open(image_path).convert('RGB')
    w, h = img.size
    longest = max(w, h)
    if longest <= ETT_MAX_IMAGE_DIM:
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=85)
        return buf.getvalue(), 'image/jpeg'

    ratio = ETT_MAX_IMAGE_DIM / longest
    new_size = (int(w * ratio), int(h * ratio))
    img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85)
    orig_kb = (w * h * 3) / 1024
    new_kb = buf.tell() / 1024
    print(f'  [resize] {Path(image_path).name}: {w}x{h} → {new_size[0]}x{new_size[1]} ({orig_kb:.0f}KB → {new_kb:.0f}KB)')
    return buf.getvalue(), 'image/jpeg'


def _find_page_images(subject, book, section_num, page_num, language):
    """Locate the image file(s) for a given page."""
    book_dir = DATA_DIR / subject / book
    pages_dir = book_dir / language / 'contents' / 'pages'
    label = f'{subject}/{book}/{section_num}/{page_num} [{language}]'

    prefix = f'{section_num}-'
    if pages_dir.is_dir():
        images = sorted(
            [p for p in pages_dir.iterdir()
             if p.name.startswith(prefix) and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')],
            key=lambda p: _subpage_sort_key(p.name, prefix),
        )
    else:
        images = []

    if images:
        idx = max(0, int(page_num) - 1)
        selected = images[min(idx, len(images) - 1)]
        print(f'  [{label}] images: {len(images)} found, using {selected}')
        return [selected]

    # Fallback: exact-named image in contents/
    contents_dir = book_dir / language / 'contents'
    for ext in ('.png', '.jpg', '.jpeg', '.webp'):
        cand = contents_dir / f'{page_num}{ext}'
        if cand.is_file():
            print(f'  [{label}] images: fallback single {cand}')
            return [cand]

    raise FileNotFoundError(
        f'No images found for subject={subject} book={book} '
        f'section={section_num} page={page_num} language={language}'
    )


def extract_page_text(subject, book, section_num, page_num, language='en'):
    """Send page images to the AI Gateway (ett-vllm) for OCR-like text extraction.

    Images are sent as multipart/form-data — the ett-vllm provider requires this."""
    selected = _find_page_images(subject, book, section_num, page_num, language)

    prompt = (
        '從這些教科書頁面圖像中提取並轉錄所有文字內容。包括所有標題、正文和圖片說明。必須用繁體中文（Traditional Chinese）輸出，不要使用簡體中文（Simplified Chinese）。'
        if language == 'tc' else
        'Extract and transcribe all text content from these textbook page images. '
        'Include all headings, body text, and captions.'
    )

    payload = {
        'provider': AIGATEWAY_PROVIDER,
        'model': AIGATEWAY_MODEL,
        'apiKey': AIGATEWAY_APIKEY,
        'prompt': prompt,
        'wordCount': '3000',
    }
    files_list = []
    for img_path in selected:
        img_bytes, mime_type = _resize_for_ett(img_path)
        files_list.append(('files', (img_path.name, io.BytesIO(img_bytes), mime_type)))
    raw = _call_ett_vllm(payload, files=files_list)

    text = _extract_text(raw)

    # Detect when _extract_text fell back to returning raw JSON wrapper
    looks_like_json_wrapper = text.strip().startswith('{') and (
        '"success"' in text or '"provider"' in text or '"generation"' in text
    )

    if not text.strip() or looks_like_json_wrapper:
        safe_payload = {k: ('<redacted>' if k == 'apiKey' else v) for k, v in payload.items()}
        safe_payload['files'] = [str(s) for s in selected]
        print(f'  [{language}] ERROR: Gateway returned no usable text')
        print(f'  [{language}] Request payload:')
        print(f'  [{language}] {json.dumps(safe_payload, indent=2, ensure_ascii=False)}')
        print(f'  [{language}] Raw response ({len(raw)} bytes):')
        print(f'  [{language}] {raw[:2000]}')
        raise RuntimeError(
            f'Gateway returned no usable text for subject={subject} book={book} '
            f'section={section_num} page={page_num} language={language}'
        )
    return text


def _subpage_sort_key(filename, prefix):
    """Extract the sub-page number from filename like '3-5.png' → 5."""
    stem = filename[len(prefix):]
    parts = stem.replace('.png', '').replace('.jpg', '').split('-')
    try:
        return int(parts[0])
    except (ValueError, IndexError):
        return 0


# ── Prompt builders ────────────────────────────────────────

def _build_gen_prompt(chapter, section_name, page_num, language, text):
    """Match server's buildGenerationPrompt exactly."""
    lang_instruction = (
        '所有內容必須使用繁體中文（Traditional Chinese, NOT Simplified Chinese）。問題和答案都要用繁體中文書寫。'
        if language == 'tc' else
        'All content must be in English.'
    )
    return (
        f'You are an expert biology educator. Using ONLY the textbook content '
        f'provided below (do NOT use any outside knowledge), generate learning '
        f'materials to help a student study this specific page.\n\n'
        f'The content is from:\n'
        f'- Chapter: {chapter}\n'
        f'- Section: {section_name}\n'
        f'- Page: {page_num}\n\n'
        f'{lang_instruction}\n\n'
        f'--- TEXTBOOK CONTENT (use ONLY this) ---\n'
        f'{text[:3000]}\n'
        f'--- END CONTENT ---\n\n'
        f'IMPORTANT: Base every question and answer STRICTLY on the provided '
        f'content. Do not introduce concepts, facts, or terminology not found '
        f'in the content above.\n\n'
        f'Generate in JSON:\n'
        f'1. A bullet-point summary of the key concepts on this page (3-6 bullet points as an array of strings)\n'
        f'2. 4-6 flashcards (each with "question" and "answer")\n'
        f'3. 3-5 MCQ questions (each with "question", 4 "options" labeled A-D, '
        f'"correct" letter, and "explanation")\n\n'
        f'Output ONLY the JSON object, no markdown:\n'
        f'{{\n  "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],\n'
        f'  "flashcards": [{{"question":"...","answer":"..."}}],\n'
        f'  "mcq": [{{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],'
        f'"correct":"A","explanation":"..."}}]\n}}'
    )


def _build_translation_prompt(chapter, section_name, page_num, target_lang, source, ref_text):
    """Match server's buildTranslationPrompt exactly."""
    lang_instruction = (
        'Translate everything into Traditional Chinese (繁體中文, NOT Simplified Chinese 简体中文).'
        if target_lang == 'tc' else
        'Translate everything into English.'
    )
    return (
        f'You are an expert bilingual biology educator. Translate the study '
        f'materials below while preserving the meaning EXACTLY.\n\n'
        f'The content is from:\n'
        f'- Chapter: {chapter}\n'
        f'- Section: {section_name}\n'
        f'- Page: {page_num}\n\n'
        f'{lang_instruction}\n\n'
        f'IMPORTANT REQUIREMENTS:\n'
        f'- The translated English and Chinese versions must match in meaning item-by-item.\n'
        f'- Keep the SAME number of summary bullet points, flashcards, and MCQ questions.\n'
        f'- Preserve the SAME ordering.\n'
        f'- summary[i] in the output must match summary[i] in the source by meaning.\n'
        f'- flashcards[i] in the output must match flashcards[i] in the source by meaning.\n'
        f'- mcq[i] in the output must match mcq[i] in the source by meaning.\n'
        f'- Keep exactly 4 options for each MCQ, labeled A-D.\n'
        f'- Keep the SAME correct answer letter as the source.\n'
        f'- Use textbook terminology from the reference text when available.\n'
        f'- Output ONLY valid JSON, no markdown.\n\n'
        f'--- REFERENCE TEXTBOOK TEXT ---\n'
        f'{(ref_text or '')[:3000]}\n'
        f'--- END REFERENCE TEXTBOOK TEXT ---\n\n'
        f'--- SOURCE STUDY MATERIALS JSON ---\n'
        f'{json.dumps(source)}\n'
        f'--- END SOURCE STUDY MATERIALS JSON ---\n\n'
        f'Output ONLY the translated JSON object in this schema:\n'
        f'{{\n  "summary": ["translated bullet point 1", "translated bullet point 2"],\n'
        f'  "flashcards": [{{"question":"...","answer":"..."}}],\n'
        f'  "mcq": [{{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],'
        f'"correct":"A","explanation":"..."}}]\n}}'
    )


# ── Core generation ────────────────────────────────────────

def _run_vllm(prompt):
    """Send a text-generation prompt to the ett-vllm provider (multipart, no images)."""
    payload = _build_text_payload(prompt)
    raw = _call_ett_vllm(payload)
    return _normalize_generated_content(_parse_generated_json(raw))


def generate_for_page(subject, book, section_num, page_num, section_name, force=False):
    """
    Generate English + Chinese study materials for one page.
    Steps: extract EN text → generate EN → extract ZH text → translate to ZH → save.
    If EN already exists but ZH is missing/broken, translates directly from EN → ZH.
    """
    label = f'{subject}/{book}/{section_num}/{page_num}'

    if not force and content_exists(subject, book, section_num, page_num):
        return 'skipped'

    # ── Shortcut: en exists, zh missing → translate directly ──
    if not force:
        existing_en, has_en = en_exists_zh_missing(subject, book, section_num, page_num)
        if has_en:
            print(f'  [{label}] English content exists, zh missing — translating directly from en')
            zh_prompt = _build_translation_prompt(book, section_name, page_num, 'tc', existing_en, '')
            zh_result = _run_vllm(zh_prompt)
            if 'raw' in zh_result:
                print(f'  [{label}]   ⚠  Chinese translation returned unparsed raw content')
            # Only save zh, preserve existing en from DB
            save_content(subject, book, section_num, page_num, existing_en, zh_result)
            print(f'  [{label}] ✓  Saved zh translation to MongoDB')
            return 'translated'

    print(f'  [{label}] Extracting English text …')
    en_text = extract_page_text(subject, book, section_num, page_num, 'en')
    print(f'  [{label}]   got {len(en_text)} chars')

    print(f'  [{label}] Generating English study materials …')
    en_prompt = _build_gen_prompt(book, section_name, page_num, 'en', en_text)
    en_result = _run_vllm(en_prompt)
    if 'raw' in en_result:
        print(f'  [{label}]   ⚠  English generation returned unparsed raw content')

    # Extract Chinese reference text
    zh_text = ''
    try:
        print(f'  [{label}] Extracting Chinese reference text …')
        zh_text = extract_page_text(subject, book, section_num, page_num, 'tc')
        print(f'  [{label}]   got {len(zh_text)} chars')
    except Exception as exc:
        print(f'  [{label}]   ⚠  Chinese reference extraction failed: {exc}')
        print(f'  [{label}]   continuing with translation without reference text')

    print(f'  [{label}] Translating to Traditional Chinese …')
    zh_prompt = _build_translation_prompt(book, section_name, page_num, 'tc', en_result, zh_text)
    zh_result = _run_vllm(zh_prompt)
    if 'raw' in zh_result:
        print(f'  [{label}]   ⚠  Chinese translation returned unparsed raw content')

    save_content(subject, book, section_num, page_num, en_result, zh_result)
    print(f'  [{label}] ✓  Saved to MongoDB')
    return 'generated'


# ── Discovery helpers ──────────────────────────────────────

def discover_subjects():
    """Return sorted list of subject directories (those containing book dirs)."""
    subjects = []
    for entry in sorted(DATA_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith('.') or entry.name.startswith('_'):
            continue
        # Must have at least one child directory with a contents.json
        for child in entry.iterdir():
            if child.is_dir() and (child / 'contents.json').exists():
                subjects.append(entry.name)
                break
    return subjects


def discover_books(subject):
    """Return sorted list of book IDs under a subject."""
    subject_dir = DATA_DIR / subject
    books = []
    for entry in sorted(subject_dir.iterdir()):
        if entry.is_dir() and not entry.name.startswith('.'):
            if (entry / 'contents.json').exists():
                books.append(entry.name)
    return books


def discover_sections(subject, book):
    """Return list of {section, en_name, tc_name} from contents.json."""
    contents_file = DATA_DIR / subject / book / 'contents.json'
    with open(contents_file, encoding='utf-8') as fh:
        data = json.load(fh)

    sections = []
    for item in data.get('contents', []):
        sec = str(item.get('section', item.get('page', '')))
        en_name = _extract_name(item, 'en')
        tc_name = _extract_name(item, 'tc')
        sections.append({'section': sec, 'en_name': en_name, 'tc_name': tc_name})
    return sections


def _extract_name(item, lang):
    """Pull the display name for a language from a contents entry."""
    val = item.get(lang)
    if isinstance(val, dict):
        return val.get('name', '')
    if isinstance(val, str):
        return val
    return ''


def discover_pages(subject, book, section_num):
    """Count how many sub-page images exist for a section."""
    pages_dir = DATA_DIR / subject / book / 'en' / 'contents' / 'pages'
    if not pages_dir.is_dir():
        # Check for a single PDF instead
        pdf = DATA_DIR / subject / book / 'en' / 'contents' / f'{section_num}.pdf'
        return 1 if pdf.is_file() else 0

    prefix = f'{section_num}-'
    seen = set()
    for p in pages_dir.iterdir():
        if p.name.startswith(prefix) and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
            num = _subpage_sort_key(p.name, prefix)
            if num > 0:
                seen.add(num)
    return max(seen) if seen else 0


# ── CLI ────────────────────────────────────────────────────

def _parse_target(target):
    """'biology-oup/1a/2/3' → (subject, book, section, page)."""
    parts = target.split('/')
    return (
        parts[0] if len(parts) > 0 else None,
        parts[1] if len(parts) > 1 else None,
        parts[2] if len(parts) > 2 else None,
        parts[3] if len(parts) > 3 else None,
    )


def main():
    parser = argparse.ArgumentParser(
        description='Batch-generate AI study materials for Book reader pages'
    )
    parser.add_argument(
        'target', nargs='?', default=None,
        help='Target scope: subject, subject/book, subject/book/section, or '
             'subject/book/section/page (omit for all subjects)',
    )
    parser.add_argument(
        '-f', '--force', action='store_true',
        help='Regenerate even if bilingual content already exists in MongoDB',
    )
    parser.add_argument(
        '--force-to-regenerate', action='store_true', dest='force',
        help='Same as -f/--force: regenerate even if a document already exists in MongoDB',
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='List pages that would be processed without calling the AI gateway',
    )
    parser.add_argument(
        '--pages-per-section', type=int, default=1,
        help='Maximum sub-pages to generate per section (default: 1 = overview only)',
    )
    parser.add_argument(
        '--delay', type=float, default=DELAY_BETWEEN_PAGES,
        help=f'Seconds to wait between pages (default: {DELAY_BETWEEN_PAGES})',
    )
    parser.add_argument(
        '--debug', action='store_true',
        help='Print full request payloads sent to the AI gateway',
    )
    args = parser.parse_args()

    # ── Validate configuration ─────────────────────────────
    if not AIGATEWAY_APIKEY:
        print('ERROR: AIGATEWAY_APIKEY is not set.  Configure it in your .env file.')
        sys.exit(1)

    if not DATA_DIR.is_dir():
        print(f'ERROR: DATA_DIR does not exist: {DATA_DIR}')
        sys.exit(1)

    # ── Resolve scope ──────────────────────────────────────
    if args.target:
        subject, book, section, page = _parse_target(args.target)
        subjects = [subject] if subject else discover_subjects()
    else:
        subject = book = section = page = None
        subjects = discover_subjects()

    if not subjects:
        print(f'No subjects found under {DATA_DIR}')
        sys.exit(1)

    print(f'Subjects  : {", ".join(subjects)}')
    print(f'Data dir  : {DATA_DIR}')
    print(f'Gateway   : {AIGATEWAY_DEBUG_URL}')
    print(f'Provider  : {AIGATEWAY_PROVIDER}')
    print(f'Model     : {AIGATEWAY_MODEL}')
    print(f'Force     : {args.force}')
    print(f'Dry-run   : {args.dry_run}')
    print(f'Pages/sect: {args.pages_per_section}')
    print(f'Debug     : {args.debug}')
    print('=' * 60)

    if args.debug:
        global DEBUG
        DEBUG = True

    total_pages = 0
    total_generated = 0
    total_skipped = 0
    total_errors = 0

    try:
        for subj in subjects:
            books = [book] if book else discover_books(subj)
            if not books:
                print(f'\n⚠  Subject {subj}: no books found, skipping')
                continue
            print(f'\n📚 Subject: {subj}  ({len(books)} books)')

            for bk in books:
                all_sections = discover_sections(subj, bk)
                # Filter out non-numeric section IDs (e.g. 'appendix')
                numeric_sections = []
                skipped_sections = []
                for s in all_sections:
                    try:
                        _to_section_id(s['section'])
                        numeric_sections.append(s)
                    except ValueError:
                        skipped_sections.append(s['section'])
                if skipped_sections:
                    print(f'  📖 Book: {bk}  ({len(numeric_sections)} sections, skipped non-numeric: {skipped_sections})')
                else:
                    print(f'  📖 Book: {bk}  ({len(numeric_sections)} sections)')

                sec_targets = (
                    [s for s in numeric_sections if s['section'] == section]
                    if section else numeric_sections
                )

                # ── Heuristic: 3-part target where the 3rd part doesn't match
                #    any section → treat as "page N of the first section".
                #    e.g. "chemistry-winter/1/5" → section 1, page 5
                if section and not sec_targets and numeric_sections and page is None:
                    first_sec = numeric_sections[0]
                    print(f'  ⚠  Section "{section}" not found in book {bk} — '
                          f'treating as page {section} of section {first_sec["section"]}')
                    sec_targets = [first_sec]
                    page = section
                    section = None

                for sec in sec_targets:
                    sec_num = sec['section']
                    sec_name = sec['en_name'] or sec['tc_name'] or f'Section {sec_num}'

                    max_pages = discover_pages(subj, bk, sec_num)
                    if max_pages == 0:
                        max_pages = 1

                    # Determine page range:
                    #   4-part target (…/section/page) → start at that page and continue
                    #                                  through the end of the section
                    #   3-part target (…/section)      → ALL pages of that section
                    #   2-part target (…/book)         → limited by --pages-per-section
                    #   1-part target (subject)        → limited by --pages-per-section
                    #   no target                      → ALL pages of every section
                    if page is not None:
                        # Explicit start page → continue through the section
                        page_start = max(1, int(page))
                        page_end = max(page_start, max_pages)
                    elif section is not None:
                        # Explicit section (3-part target) → all pages
                        page_limit = max_pages
                        page_start = 1
                        page_end = page_limit
                    elif args.target is None:
                        # No-argument run → process all pages in the section
                        page_start = 1
                        page_end = max_pages
                    else:
                        # Book or subject level → respect --pages-per-section
                        page_limit = min(max_pages, args.pages_per_section)
                        page_start = 1
                        page_end = page_limit

                    for pg in range(page_start, page_end + 1):
                        total_pages += 1
                        label = f'{subj}/{bk}/{sec_num}/{pg}'

                        if content_exists(subj, bk, sec_num, pg) and not args.force:
                            total_skipped += 1
                            print(f'    [skip] {label}  — {sec_name[:50]} (already in DB)')
                            continue

                        if args.dry_run:
                            print(f'    [GEN]  {label}  — {sec_name[:50]}')
                            continue

                        print(f'\n  📄 {label}  — {sec_name[:60]}')
                        try:
                            result = generate_for_page(subj, bk, sec_num, pg, sec_name, force=args.force)
                            if result == 'generated':
                                total_generated += 1
                            else:
                                total_skipped += 1
                        except Exception as exc:
                            print(f'  ❌ ERROR: {exc}')
                            total_errors += 1
                            time.sleep(2)

                        time.sleep(args.delay)

    except KeyboardInterrupt:
        print('\n\nInterrupted by user.')
        sys.exit(130)

    print('\n' + '=' * 60)
    print(
        f'Done.  {total_pages} page(s) total  |  '
        f'{total_generated} generated  |  '
        f'{total_skipped} skipped  |  '
        f'{total_errors} error(s)'
    )
    if args.dry_run:
        print('(Dry run — no content was generated or saved)')


if __name__ == '__main__':
    main()
