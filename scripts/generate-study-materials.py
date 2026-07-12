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


# Images are sent as-is; the AI Gateway's ett-vllm handler normalises
# every uploaded image to a model-compatible canvas automatically.
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB sanity cap

# ── Paths ──────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = Path(os.environ.get('DATA_PATH', str(PROJECT_DIR / 'data')))
ENV_FILE = PROJECT_DIR / '.env'

# ── Load .env (always prefer .env values for our config keys) ──
_CONFIG_KEYS = {'DATA_PATH', 'MONGODB_URI',
                'VLLM_API_URL', 'VLLM_PROVIDER', 'VLLM_MODEL', 'VLLM_APIKEY',
                'OLLAMA_PROVIDER', 'OLLAMA_MODEL', 'OLLAMA_APIKEY',
                'AVAILABLE_MODELS_PATH'}
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

# ── VLLM / ett-vllm config (image → text extraction only) ──
VLLM_URL = os.environ.get('VLLM_API_URL', 'https://aigateway.aied.hku.hk/api/generate')
VLLM_DEBUG_URL = VLLM_URL + ('&' if '?' in VLLM_URL else '?') + 'debug_log=1'
VLLM_PROVIDER = os.environ.get('VLLM_PROVIDER', 'ett-vllm')
VLLM_MODEL = os.environ.get('VLLM_MODEL', 'OpenGVLab/InternVL3_5-38B')
VLLM_APIKEY = os.environ.get('VLLM_APIKEY', '')

# ── Ollama config (text → study-material generation & translation) ──
OLLAMA_PROVIDER = os.environ.get('OLLAMA_PROVIDER', 'ollama')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'gpt-oss:120b')
OLLAMA_APIKEY = os.environ.get('OLLAMA_APIKEY', '')

# ── Model catalog (for looking up max_completion_tokens) ──
AVAILABLE_MODELS_PATH = Path(os.environ.get('AVAILABLE_MODELS_PATH'))

# Default max_tokens fallback — the gateway defaults to only 512 when omitted,
# which is far too small for a complete study-materials JSON.
_DEFAULT_MAX_TOKENS = 0


def _load_ollama_max_tokens() -> int:
    """Look up max_completion_tokens for the configured Ollama model from the catalog.

    Returns the model's ``max_completion_tokens`` if found, otherwise falls back
    to ``_DEFAULT_MAX_TOKENS``.
    """
    try:
        if not AVAILABLE_MODELS_PATH.is_file():
            return _DEFAULT_MAX_TOKENS
        with open(AVAILABLE_MODELS_PATH, encoding='utf-8') as fh:
            catalog = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return _DEFAULT_MAX_TOKENS

    ollama_models = catalog.get('ollama')
    if not isinstance(ollama_models, list):
        return _DEFAULT_MAX_TOKENS

    target = OLLAMA_MODEL
    if '|' in target:
        target = target.split('|', 1)[-1]

    for entry in ollama_models:
        if not isinstance(entry, dict):
            continue
        if entry.get('id') == target:
            value = entry.get('max_completion_tokens')
            if value is not None:
                value = int(value)
                # Safety cap: values >32K often come from context_window,
                # not actual max output. Sending num_predict=131072 to
                # Ollama causes OOM crashes → "Error reading from remote server".
                return value if value <= 32768 else _DEFAULT_MAX_TOKENS
            return _DEFAULT_MAX_TOKENS

    # Model not in catalog — try fuzzy match on the name part
    target_clean = target.split(':', 1)[0].lower()
    for entry in ollama_models:
        if not isinstance(entry, dict):
            continue
        eid = str(entry.get('id', '')).lower()
        if eid.startswith(target_clean):
            value = entry.get('max_completion_tokens')
            if value is not None:
                value = int(value)
                return value if value <= 32768 else _DEFAULT_MAX_TOKENS

    return _DEFAULT_MAX_TOKENS


def _get_max_tokens() -> int:
    """Return the max_tokens value to use for generation/translation requests.

    Reads from the model catalog once per process; uses a cached value after
    the first call to avoid repeated file I/O.
    """
    global _DEFAULT_MAX_TOKENS
    cached = getattr(_get_max_tokens, '_cached', None)
    if cached is not None:
        return cached
    value = _load_ollama_max_tokens()
    _get_max_tokens._cached = value
    return value

DB_NAME = 'pdf-reader'
COLLECTION_NAME = 'ai-generations'
ALIGNMENT_VERSION = 1
DEFAULT_USER = 'alan'
REQUEST_TIMEOUT = 120
DELAY_BETWEEN_PAGES = 3   # seconds between pages (be gentle to the gateway)
DEBUG = False    # set by --debug flag; prints request payloads + raw responses
VERBOSE = False  # set by -v/--verbose; prints request summary + full response

# ── Simplified Chinese Detection ───────────────────────────
# Characters that exist ONLY in Simplified Chinese — i.e. their traditional
# counterpart is a DIFFERENT Unicode codepoint.  Characters that are
# identical in both writing systems (e.g. 了, 人, 大, 合, 建, 除, 快, 最)
# are deliberately EXCLUDED because they are not reliable indicators.
#
# This set is curated from the official Chinese character simplification
# tables (简化字总表).  Each character here has a visually distinct
# traditional form and does NOT appear as-is in standard Traditional Chinese.
_SIMPLIFIED_ONLY_CHARS = frozenset(
    # ── Very high frequency (almost certain to appear in AI-generated text if
    #     the model outputs simplified instead of traditional) ──
    '个们门电话长对东车马鱼鸟风飞'
    '时过会见觉开关学实写买卖万与义乐头发龙'
    '专产业厂广严丽么习从'
    '仪优传伤伦伪伟货质转轮轻轴阵验'
    '证骑惊齿爱书体国'

    # ── High frequency ──
    '贝宾参尝虫达带单当党动荡断队吨夺尔'
    '妇盖刚钢巩沟构购归龟柜'
    '汉号护华画坏欢还击机积极'
    '计记纪际济继夹价坚监检简将'
    '节洁结紧锦尽劲经旧剧据军'
    '壳垦恳库块宽亏扩兰离历'
    '励隶帘联练粮两疗辽邻岭'
    '刘龙楼芦卤陆录驴屡虑仑罗络'
    '满梦灭亩恼脑闹难拟鸟宁农疟欧盘骗'
    '苹凄齐岂弃谦枪墙桥亲庆穷区'
    '权劝确让扰热认荣绒润丧扫杀纱'
    '赏烧绍设审胜圣湿识势适术树'
    '帅双肃岁孙损缩态坛叹讨腾题条铁'
    '厅听图团网为韦卫闻问无'
    '雾牺袭戏细虾吓显县线乡详响项'
    '协胁兴须许悬选压盐严颜'
    '扬阳养样药爷业叶页义艺阴'
    '隐应营拥优犹邮鱼渔与语'
    '誉渊园员远愿跃运酝杂赃凿'
    '责择泽贼赠轧张账这针'
    '镇郑织职纸钟种众轴猪'
    '烛贮驻庄壮状资纵总组钻'

    # ── Medium frequency (still useful for detection) ──
    '肮袄坝罢摆败颁办帮绑宝报鲍备钡狈惫绷笔币毕闭边编贬变标'
    '别滨饼拨驳补财残蚕灿仓苍舱厕侧测层'
    '产铲阐颤尝偿厂畅钞彻尘陈衬称惩诚骋痴迟冲'
    '筹畴础储处触创锤纯绰词赐聪窜错'
    '胆诞弹档导岛捣祷盗邓敌涤递点电垫调钓'
    '钉顶订冬栋冻斗独读赌镀锻堕'
    '恶儿罚阀烦贩饭纺废费纷坟奋'
    '疯枫冯缝凤肤辐抚辅负妇赋缚'
    '该赶秆岗鸽阁给贡沟构购顾刮'
    '观馆贯惯广归龟轨柜贵刽辊'
    '骇沪华划画怀坏欢环还换唤焕涣黄挥辉汇'
    '会绘贿秽荤浑伙获祸货'
    '饥机鸡积极辑级挤剂济继绩'
    '驾歼坚监艰拣茧检减简见'
    '剑渐践鉴键舰将浆讲奖蒋酱胶浇骄娇脚缴绞较'
    '疖'
    '凯刊抠裤块宽矿亏扩阔'
    '腊蜡来莱赖兰拦栏蓝览懒烂滥捞劳唠'
    '类泪厘离礼历厉励丽隶帘联连镰怜练炼恋链'
    '辆谅疗辽邻临灵龄领'
    '铝缕绿乱轮论罗逻锣箩骡络'
    '妈骂吗买卖麦满猫贸么没'
    '梦弥谜绵缅灭蔑'
    '酿浓疟'
    '呕'
    '庞赔喷骗苹凭扑仆谱'
    '启气弃牵铅迁签谦钱枪墙抢桥翘亲轻倾'
    '驱趋权劝确鹊'
    '纫软锐'
    '洒伞涩筛晒闪陕赏烧绍设审肾渗声胜圣绳湿诗'
    '释寿书输属术树数'
    '谁顺说丝饲耸颂苏虽随'
    '锁'
    '颓'
    '袜万网为韦围卫闻纹稳问无'
    '牺习袭戏细虾峡吓鲜纤贤显险县现线宪'
    '谢'
    '续询训'
    '鸭盐严颜艳验扬阳养痒样药爷叶页业仪医遗义艺忆议'
    '银隐应营拥优忧邮犹鱼渔与语誉渊园员圆远愿约阅'
    '枣'
    '闸债盏崭战张涨账折这针贞诊阵镇争郑证织职纸帜质'
    '诸'
    '砖转赚庄壮状锥赘浊'
)


def _collect_zh_text(doc):
    """Extract all Chinese text from a document's zh field for simplified detection.

    Walks summary strings, flashcard question/answer, and MCQ question/options/explanation.
    Returns a single concatenated string of all Chinese text found.
    """
    zh = doc.get('zh') or {}
    if not isinstance(zh, dict):
        return ''

    parts = []

    # Summary (list of strings)
    for item in (zh.get('summary') or []):
        if isinstance(item, str):
            parts.append(item)

    # Flashcards (list of {question, answer})
    for card in (zh.get('flashcards') or []):
        if isinstance(card, dict):
            for key in ('question', 'answer'):
                val = card.get(key, '')
                if isinstance(val, str):
                    parts.append(val)

    # MCQ (list of {question, options[], correct, explanation})
    for q in (zh.get('mcq') or []):
        if isinstance(q, dict):
            for key in ('question', 'explanation'):
                val = q.get(key, '')
                if isinstance(val, str):
                    parts.append(val)
            for opt in (q.get('options') or []):
                if isinstance(opt, str):
                    parts.append(opt)

    return '\n'.join(parts)


def has_simplified_chinese(doc):
    """Return True if the document's zh content contains any simplified-only characters."""
    text = _collect_zh_text(doc)
    if not text:
        return False
    return any(ch in _SIMPLIFIED_ONLY_CHARS for ch in text)

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
                    # JSON is truly broken (likely truncated mid-stream).
                    # DO NOT silently wrap it — mark as a parse error so
                    # the caller can retry or report the failure.
                    normalized['_parse_error'] = True
                    normalized['_raw_truncated'] = inner[:200] + ('…' if len(inner) > 200 else '')
                    return normalized
            if isinstance(parsed_inner, dict):
                for k, v in parsed_inner.items():
                    if k not in normalized or not normalized[k]:
                        normalized[k] = v
        else:
            # Non-JSON raw content — mark as unparseable
            normalized['_parse_error'] = True
            normalized['_raw_truncated'] = inner[:200] + ('…' if len(inner) > 200 else '')
            return normalized

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


# ── Content structure validation ───────────────────────────

_REQUIRED_FIELDS = {
    'summary': (list, 'array of strings'),
    'flashcards': (list, 'array of {question, answer} objects'),
    'mcq': (list, 'array of {question, options[], correct, explanation} objects'),
}

_FLASHCARD_REQUIRED = {'question', 'answer'}
_MCQ_REQUIRED = {'question', 'options', 'correct', 'explanation'}


def _validate_content_structure(content, label=''):
    """Validate that generated content has all required fields with correct types.

    Returns (is_valid, list_of_errors).
    """
    errors = []

    if not isinstance(content, dict):
        errors.append(f'{label}content is not a dictionary (got {type(content).__name__})')
        return False, errors

    # ── Hard-fail: parse error from _normalize_generated_content ──
    if content.get('_parse_error'):
        truncated = content.get('_raw_truncated', '')
        errors.append(
            f'{label}JSON is truncated or unparseable. '
            f'First 200 chars: {truncated}'
        )
        return False, errors

    # ── Check for raw-only content (unparsed wrapper) ──
    if 'raw' in content and not any(k in content for k in _REQUIRED_FIELDS):
        raw_preview = str(content.get('raw', ''))[:200]
        errors.append(
            f'{label}content was never parsed — only "raw" field present. '
            f'Raw preview: {raw_preview}'
        )
        return False, errors

    # ── Check required top-level fields ──
    for field, (expected_type, description) in _REQUIRED_FIELDS.items():
        if field not in content:
            errors.append(f'{label}missing required field "{field}" ({description})')
        elif not isinstance(content[field], expected_type):
            errors.append(
                f'{label}"{field}" must be {description}, got {type(content[field]).__name__}'
            )
        elif expected_type is list and len(content[field]) == 0:
            errors.append(f'{label}"{field}" is empty — expected at least one entry')

    if errors:
        return False, errors

    # ── Validate flashcards structure ──
    for i, card in enumerate(content.get('flashcards', [])):
        if not isinstance(card, dict):
            errors.append(f'{label}flashcards[{i}] is not an object')
            continue
        missing = _FLASHCARD_REQUIRED - set(card.keys())
        if missing:
            errors.append(f'{label}flashcards[{i}] missing keys: {missing}')
        for k in _FLASHCARD_REQUIRED:
            if k in card and not isinstance(card[k], str):
                errors.append(f'{label}flashcards[{i}].{k} must be a string')

    # ── Validate MCQ structure ──
    for i, q in enumerate(content.get('mcq', [])):
        if not isinstance(q, dict):
            errors.append(f'{label}mcq[{i}] is not an object')
            continue
        missing = _MCQ_REQUIRED - set(q.keys())
        if missing:
            errors.append(f'{label}mcq[{i}] missing keys: {missing}')
        if 'options' in q:
            if not isinstance(q['options'], list):
                errors.append(f'{label}mcq[{i}].options must be an array')
            elif len(q['options']) != 4:
                errors.append(f'{label}mcq[{i}].options must have exactly 4 entries, got {len(q["options"])}')
            else:
                for j, opt in enumerate(q['options']):
                    if not isinstance(opt, str):
                        errors.append(f'{label}mcq[{i}].options[{j}] must be a string')
        if 'correct' in q and isinstance(q['correct'], str) and q['correct'] not in ('A', 'B', 'C', 'D'):
            errors.append(f'{label}mcq[{i}].correct must be A, B, C, or D, got "{q["correct"]}"')
        if 'explanation' in q and not isinstance(q['explanation'], str):
            errors.append(f'{label}mcq[{i}].explanation must be a string')

    return (len(errors) == 0), errors


def save_content(subject_id, book_id, section_id, page_id, en_content, zh_content,
                 en_text='', zh_text='', user=DEFAULT_USER):
    """Upsert bilingual content into MongoDB matching the exact schema.

    Validates both en and zh content structure before saving.  Raises
    ValueError if either language's content fails validation.

    ``en_text`` and ``zh_text`` are the raw OCR-extracted page texts —
    stored alongside the study materials for reference / debugging.
    """
    en_normalized = _normalize_generated_content(en_content)
    zh_normalized = _normalize_generated_content(zh_content)

    # ── Validate both languages before writing to DB ──
    label = f'{subject_id}/{book_id}/{section_id}/{page_id}'
    for lang, content in [('en', en_normalized), ('zh', zh_normalized)]:
        is_valid, errors = _validate_content_structure(content, f'[{label}] {lang}: ')
        if not is_valid:
            raise ValueError(
                f'Content validation FAILED for {label} ({lang}):\n' +
                '\n'.join(f'  - {e}' for e in errors)
            )

    # ── Strip internal validation markers before persisting ──
    for content in (en_normalized, zh_normalized):
        content.pop('_parse_error', None)
        content.pop('_raw_truncated', None)

    # ── Attach raw extracted text for reference ──
    if en_text:
        en_normalized['extractedText'] = en_text
    if zh_text:
        zh_normalized['extractedText'] = zh_text

    coll = _get_collection()
    now = datetime.now(timezone.utc).isoformat()
    identity = _build_ai_identity(subject_id, book_id, section_id, page_id)
    coll.delete_many({'$or': [identity, _build_legacy_ai_identity(book_id, section_id, page_id)]})
    coll.insert_one({
        **identity,
        'en': en_normalized,
        'zh': zh_normalized,
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
    """Call the AI Gateway (multipart/form-data).

    Used for both image → text extraction (ett-vllm provider) and text-only
    generation (ollama provider).  Only appends ``debug_log=1`` when the
    ``--debug`` flag is active — the gateway's debug mode may return
    metadata without the actual response content.
    """
    # Only use debug_log=1 when --debug is explicitly set.
    # The debug URL may cause the gateway to omit the actual response text.
    url = VLLM_DEBUG_URL if DEBUG else VLLM_URL
    headers = {'Accept': 'text/event-stream'}
    form = []
    for key, value in payload.items():
        form.append((key, (None, str(value) if not isinstance(value, str) else value)))
    if files:
        form.extend(files)

    if DEBUG or VERBOSE:
        tag = 'DEBUG' if DEBUG else 'VERBOSE'
        _log_request(url, payload, files, tag)

    resp = requests.post(url, files=form, headers=headers, timeout=timeout)
    resp.raise_for_status()
    raw = resp.text

    if DEBUG or VERBOSE:
        tag = 'DEBUG' if DEBUG else 'VERBOSE'
        _log_response(resp.status_code, raw, tag)

    return raw


def _log_request(url, payload, files, tag='DEBUG'):
    """Print the API request in a readable format.

    In verbose mode (-v), shows a compact summary.  In debug mode (--debug),
    shows the full pretty-printed request payload.
    """
    print(f'\n{"─"*50}')
    print(f'[{tag}] POST {url}')
    print(f'[{tag}] Form fields:')
    # Build a display-safe copy of the payload
    display = {}
    for k, v in payload.items():
        if k == 'apiKey':
            display[k] = '<redacted>'
        elif isinstance(v, str) and len(v) > 200:
            display[k] = v[:200] + f'… ({len(v)} chars)'
        else:
            display[k] = v
    # Pretty-print the payload as JSON for readability
    print(json.dumps(display, indent=2, ensure_ascii=False))
    if files:
        print(f'[{tag}] Files ({len(files)}):')
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
        print(f'[{tag}] Files: (none — text-only request)')
    print(f'{"─"*50}')


def _log_response(status, text, tag='DEBUG'):
    """Print the API response in a readable format.

    Attempts to pretty-print the response as JSON.  Falls back to raw text
    if the response is not valid JSON.
    """
    print(f'[{tag}] HTTP {status}  ({len(text)} bytes)')
    try:
        parsed = json.loads(text)
        # Remove verbose detail fields for cleaner output unless in debug mode
        if tag != 'DEBUG':
            summary_keys = {'success', 'model', 'provider', 'error', 'response',
                           'text', 'output', 'content', 'generation'}
            filtered = {k: v for k, v in parsed.items() if k in summary_keys}
            # If we filtered out everything useful, fall back to full
            if not filtered or (len(filtered) == 1 and 'success' in filtered):
                filtered = parsed
            print(f'[{tag}] Response (pretty-printed):')
            print(json.dumps(filtered, indent=2, ensure_ascii=False))
        else:
            print(f'[{tag}] Response (pretty-printed):')
            print(json.dumps(parsed, indent=2, ensure_ascii=False))
        # Warn if gateway reports success but response is empty
        if isinstance(parsed, dict) and parsed.get('success') and not parsed.get('response') and not parsed.get('text') and not parsed.get('output'):
            gen = parsed.get('generation', {})
            out_size = gen.get('output_size') if isinstance(gen, dict) else None
            if out_size and out_size > 0:
                print(f'[{tag}] ⚠  WARNING: Gateway reports success (output_size={out_size}) but response field is empty!')
                print(f'[{tag}] ⚠  The debug_log=1 parameter may be stripping the response content.')
                print(f'[{tag}] ⚠  Try running without --debug to get actual model output.')
    except (json.JSONDecodeError, TypeError):
        print(f'[{tag}] Response body (raw):\n{text}')
    print(f'{"─"*50}\n')


def _build_text_payload(prompt, model=None):
    """Return form-field dict for text-only generation/translation via the ollama provider.

    max_tokens is read from the model catalog (available-models.json).
    Omitted when 0 — lets the gateway determine the optimal value.
    """
    fields = {
        'provider': OLLAMA_PROVIDER,
        'model': model if model is not None else OLLAMA_MODEL,
        'apiKey': OLLAMA_APIKEY,
        'prompt': prompt,
    }
    mt = _get_max_tokens()
    if mt > 0:
        fields['max_tokens'] = str(mt)
    return fields


def _extract_text(raw_text):
    """Pull plain text content from the gateway's JSON / SSE response.

    Handles all known gateway response shapes (ett-vllm, vllm, OpenAI-compatible,
    etc.).  Kept in sync with all-in-one.py's extract_text_from_ett_result.

    Returns (text, warning_message).  warning_message is None when everything is ok.
    """
    try:
        parsed = json.loads(raw_text)
    except (json.JSONDecodeError, TypeError):
        return raw_text.strip(), None

    if not isinstance(parsed, dict):
        return raw_text.strip(), None

    # ── Gateway-level error — surface the error message ──
    gateway_error = parsed.get('error')
    if gateway_error and not parsed.get('response') and not parsed.get('files'):
        err_msg = str(gateway_error)
        # Also check for output_size: 0 which indicates model produced nothing
        gen = parsed.get('generation', {})
        if isinstance(gen, dict) and gen.get('output_size') == 0:
            err_msg += ' (model produced zero output tokens — the model may not be loaded or is not responding)'
        return '', err_msg

    # ── Detect zero-output success responses ──
    generation = parsed.get('generation', {})
    if isinstance(generation, dict):
        output_size = generation.get('output_size', None)
        if output_size == 0 and parsed.get('success'):
            # Model returned success but generated zero tokens
            model = parsed.get('model', 'unknown')
            provider = parsed.get('provider', 'unknown')
            return '', (
                f'Gateway returned success but model produced zero output tokens '
                f'(provider={provider}, model={model}). '
                f'The model may not be loaded or may not support the requested task.'
            )
        # ── Detect success with output_size > 0 but empty response field ──
        # This happens when debug_log=1 is used — the gateway returns metadata
        # but omits the actual response text.
        if output_size and output_size > 0 and parsed.get('success') and not parsed.get('response') and not parsed.get('text'):
            model = parsed.get('model', 'unknown')
            provider = parsed.get('provider', 'unknown')
            return '', (
                f'Gateway returned success (output_size={output_size}) but the '
                f'response field is empty. This is likely caused by the '
                f'debug_log=1 query parameter. Rerun without --debug.'
            )

    # ── Collect text from every possible field ──
    text = parsed.get('response', '') or parsed.get('text', '') or parsed.get('output', '') or ''

    # masterSummary may be a string or a dict
    master = parsed.get('masterSummary', '')
    if isinstance(master, str) and master.strip():
        text = master
    elif isinstance(master, dict):
        text = master.get('text', '') or master.get('summary', '') or text

    # Per-file text (multipart image extraction responses)
    parts = []
    for file_info in (parsed.get('files') or []):
        if isinstance(file_info, dict):
            file_text = (
                file_info.get('text', '')
                or file_info.get('response', '')
                or file_info.get('output', '')
                or ''
            )
            if file_text.strip():
                parts.append(file_text.strip())
    if parts:
        if not text.strip():
            text = '\n\n'.join(parts)
        else:
            text = text + '\n\n' + '\n\n'.join(parts)

    # generation field (used by some gateway versions)
    if not text.strip() and isinstance(generation, str) and generation.strip():
        text = generation
    elif not text.strip() and isinstance(generation, dict):
        text = generation.get('text', '') or generation.get('response', '') or ''

    # content field (older wrappers)
    if not text.strip():
        content = parsed.get('content', '')
        if isinstance(content, str) and content.strip():
            text = content

    return text.strip(), None


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



def _read_image_for_ett(image_path):
    """Return (bytes, mime_type) for an image file.

    The AI Gateway's ett-vllm handler normalises every uploaded image
    to a consistent canvas, so no client-side resize is needed.
    """
    img_bytes = image_path.read_bytes()
    if len(img_bytes) > _MAX_IMAGE_BYTES:
        raise ValueError(
            f'Image too large: {image_path.name} ({len(img_bytes)} bytes > '
            f'{_MAX_IMAGE_BYTES} bytes max)'
        )
    suffix = image_path.suffix.lower()
    mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.webp': 'image/webp'}
    mime_type = mime_map.get(suffix, 'application/octet-stream')
    return img_bytes, mime_type


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
        'provider': VLLM_PROVIDER,
        'model': VLLM_MODEL,
        'apiKey': VLLM_APIKEY,
        'prompt': prompt,
        'stream': 'false',
        'wordCount': '3000',
    }
    files_list = []
    for img_path in selected:
        img_bytes, mime_type = _read_image_for_ett(img_path)
        files_list.append(('files', (img_path.name, io.BytesIO(img_bytes), mime_type)))
    raw = _call_ett_vllm(payload, files=files_list)

    text, gateway_warning = _extract_text(raw)
    if gateway_warning:
        print(f'  [{language}] ⚠  Gateway warning: {gateway_warning}')

    # Detect when _extract_text fell back to returning raw JSON wrapper
    looks_like_json_wrapper = text.strip().startswith('{') and (
        '"success"' in text or '"provider"' in text or '"generation"' in text
    )

    if not text.strip() or looks_like_json_wrapper:
        safe_payload = {k: ('<redacted>' if k == 'apiKey' else v) for k, v in payload.items()}
        safe_payload['files'] = [str(s) for s in selected]
        print(f'  [{language}] ERROR: Gateway returned no usable text')
        if gateway_warning:
            print(f'  [{language}] Reason: {gateway_warning}')
        print(f'  [{language}] Request payload:')
        print(f'  [{language}] {json.dumps(safe_payload, indent=2, ensure_ascii=False)}')
        print(f'  [{language}] Raw response ({len(raw)} bytes):')
        print(f'  [{language}] {raw[:2000]}')
        raise RuntimeError(
            f'Gateway returned no usable text for subject={subject} book={book} '
            f'section={section_num} page={page_num} language={language}'
            + (f' — {gateway_warning}' if gateway_warning else '')
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

def _build_gen_prompt(chapter, section_name, page_num, language, text, subject=''):
    """Match server's buildGenerationPrompt exactly."""
    lang_instruction = (
        '所有內容必須使用繁體中文（Traditional Chinese, NOT Simplified Chinese）。'
        '問題、答案、MCQ 選項（options）、解釋（explanation）全部都要用繁體中文書寫，'
        '絕對不可以出現英文。'
        if language == 'tc' else
        'All content must be in English.'
    )
    subject_word = f'{subject} ' if subject else ''
    return (
        f'You are an expert {subject_word}educator. Using ONLY the textbook content '
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
        f'1. A bullet-point summary of the key concepts on this page '
        f'(3-6 bullet points as an array of strings)\n'
        f'2. 4-6 flashcards (each with "question" and "answer")\n'
        f'3. 3-5 MCQ questions (each with "question", 4 "options" labeled A-D, '
        f'"correct" letter, and "explanation")\n\n'
        f'Output ONLY the JSON object, no markdown:\n'
        f'{{\n'
        f'  "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],\n'
        f'  "flashcards": [{{"question":"...","answer":"..."}}],\n'
        f'  "mcq": [{{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],'
        f'"correct":"A","explanation":"..."}}]\n'
        f'}}'
    )


def _build_translation_prompt(chapter, section_name, page_num, target_lang, source, ref_text, subject=''):
    """Match server's buildTranslationPrompt exactly."""
    lang_instruction = (
        'Translate EVERYTHING into Traditional Chinese (繁體中文, NOT Simplified Chinese 简体中文). '
        'This includes all MCQ options — translate every option from English into Traditional Chinese. '
        'Do NOT leave any text untranslated.'
        if target_lang == 'tc' else
        'Translate everything into English.'
    )
    subject_word = f'{subject} ' if subject else ''
    return (
        f'You are an expert bilingual {subject_word}educator. Translate the study '
        f'materials below while preserving the meaning EXACTLY.\n\n'
        f'The content is from:\n'
        f'- Chapter: {chapter}\n'
        f'- Section: {section_name}\n'
        f'- Page: {page_num}\n\n'
        f'{lang_instruction}\n\n'
        f'IMPORTANT REQUIREMENTS:\n'
        f'- The translated English and Chinese versions must match in meaning item-by-item.\n'
        f'- Keep the SAME number of summary bullet points, flashcards, and MCQ questions.\n'
        f'- Preserve the SAME ordering for all arrays.\n'
        f'- summary[i] in the output must match summary[i] in the source by meaning.\n'
        f'- flashcards[i] in the output must match flashcards[i] in the source by meaning.\n'
        f'- mcq[i] in the output must match mcq[i] in the source by meaning.\n'
        f'- CRITICAL: Translate ALL MCQ options (choices A, B, C, D) into Traditional Chinese.\n'
        f'  Keep the same number of options (4), labeled A-D, with the SAME correct answer letter.\n'
        f'  Do NOT leave any option in English — EVERY option must be in Traditional Chinese.\n'
        f'- Use textbook terminology from the reference text when available.\n'
        f'- Output ONLY valid JSON, no markdown.\n\n'
        f'--- REFERENCE TEXTBOOK TEXT ---\n'
        f'{(ref_text or '')[:3000]}\n'
        f'--- END REFERENCE TEXTBOOK TEXT ---\n\n'
        f'--- SOURCE STUDY MATERIALS JSON ---\n'
        f'{json.dumps(source)}\n'
        f'--- END SOURCE STUDY MATERIALS JSON ---\n\n'
        f'Output ONLY the translated JSON object in this schema:\n'
        f'{{\n'
        f'  "summary": ["translated bullet point 1", "translated bullet point 2"],\n'
        f'  "flashcards": [{{"question":"...","answer":"..."}}],\n'
        f'  "mcq": [{{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],'
        f'"correct":"A","explanation":"..."}}]\n'
        f'}}'
    )


# ── Core generation ────────────────────────────────────────

# Strip provider prefix from model name if present (e.g. "ollama|gpt-oss:120b" → "gpt-oss:120b")
def _strip_provider_prefix(model_name):
    return model_name.split('|', 1)[-1] if '|' in model_name else model_name


def _call_generation_via_gateway(prompt, retries=3):
    """Send a text-generation prompt to the AI Gateway with retry on 502/503/504.

    Matches the server's ``runPromptViaGateway`` logic: exponential backoff
    on transient upstream errors, with debug dumps on first failure.

    Unlike ``_call_ett_vllm`` (used for image extraction), this function
    always uses the production URL — the debug_log query parameter can
    strip response content, and generation calls should never use it.
    """
    gen_model = _strip_provider_prefix(OLLAMA_MODEL)
    inner_payload = _build_text_payload(prompt, model=gen_model)
    headers = {'Accept': 'text/event-stream'}
    form = [(k, (None, str(v) if not isinstance(v, str) else v)) for k, v in inner_payload.items()]

    last_error = None
    for attempt in range(retries + 1):
        try:
            if DEBUG or VERBOSE:
                tag = 'DEBUG' if DEBUG else 'VERBOSE'
                _log_request(VLLM_URL, inner_payload, None, tag)
            else:
                # Always show a compact summary for generation calls
                prompt_len = len(inner_payload.get('prompt', ''))
                print(f'  [gateway] POST {VLLM_URL}  model={gen_model}  prompt={prompt_len} chars')
            resp = requests.post(VLLM_URL, files=form, headers=headers, timeout=180)
            resp.raise_for_status()
            raw = resp.text
            if DEBUG or VERBOSE:
                tag = 'DEBUG' if DEBUG else 'VERBOSE'
                _log_response(resp.status_code, raw, tag)
            else:
                print(f'  [gateway] HTTP {resp.status_code}  ({len(raw)} bytes)')
            return raw
        except requests.HTTPError as error:
            status = error.response.status_code if hasattr(error, 'response') and error.response is not None else None
            # Log error response body in verbose/debug modes
            if (DEBUG or VERBOSE) and hasattr(error, 'response') and error.response is not None:
                try:
                    err_body = error.response.text
                except Exception:
                    err_body = '[unable to read response body]'
                tag = 'DEBUG' if DEBUG else 'VERBOSE'
                _log_response(status, err_body, tag)
            last_error = error
            if status in (502, 503, 504):
                if attempt < retries:
                    delay = min(1000 * (2 ** attempt), 10000) / 1000.0  # seconds
                    print(f'  [gateway] gen attempt {attempt + 1} failed ({status}), retrying in {delay:.0f}s …')
                    time.sleep(delay)
                    continue
            else:
                break  # non-retryable error (4xx, etc.) — don't retry
        except requests.RequestException as error:
            last_error = error
            if attempt < retries:
                delay = min(1000 * (2 ** attempt), 10000) / 1000.0
                print(f'  [gateway] gen attempt {attempt + 1} failed ({error}), retrying in {delay:.0f}s …')
                time.sleep(delay)
                continue
    raise last_error


def _run_generation(prompt):
    """Send a text-generation prompt via the AI Gateway."""
    raw = _call_generation_via_gateway(prompt)
    parsed = _parse_generated_json(raw)
    return _normalize_generated_content(parsed)


def _run_vllm(prompt):
    """Send a text-generation prompt (gateway-first, Ollama-fallback).

    Returns the normalized content dict.  If the JSON was truncated/unparseable,
    ``_parse_error`` will be present in the result — callers should validate
    with ``_validate_content_structure`` before saving.
    """
    return _run_generation(prompt)


def generate_for_page(subject, book, section_num, page_num, section_name, force=False):
    """
    Generate English + Chinese study materials for one page.
    Steps: extract EN text → generate EN → extract ZH text → translate to ZH → save.
    If EN already exists but ZH is missing/broken, translates directly from EN → ZH.

    Validates every generated/translated output against the required JSON schema.
    Retries once if the first attempt produces invalid or truncated JSON.
    """
    label = f'{subject}/{book}/{section_num}/{page_num}'
    # Extract readable subject name from folder: "physics-oup" → "Physics"
    _subject_name = subject.split('-')[0].capitalize() if '-' in subject else subject.capitalize()

    if not force and content_exists(subject, book, section_num, page_num):
        return 'skipped'

    # ── Shortcut: en exists, zh missing → translate directly ──
    if not force:
        existing_en, has_en = en_exists_zh_missing(subject, book, section_num, page_num)
        if has_en:
            print(f'  [{label}] English content exists, zh missing — translating directly from en')
            zh_result = _generate_with_retry(
                lambda: _run_vllm(
                    _build_translation_prompt(book, section_name, page_num, 'tc', existing_en, '', _subject_name),
                ),
                label, 'zh-translation',
            )
            # Save zh only, preserving existing en from DB
            save_content(subject, book, section_num, page_num, existing_en, zh_result)
            print(f'  [{label}] ✓  Saved zh translation to MongoDB')
            return 'translated'

    # ── Step 1: Extract English text ──
    print(f'  [{label}] Extracting English text …')
    en_text = extract_page_text(subject, book, section_num, page_num, 'en')
    print(f'  [{label}]   got {len(en_text)} chars')

    # ── Step 2: Generate English study materials (with retry) ──
    print(f'  [{label}] Generating English study materials …')
    en_result = _generate_with_retry(
        lambda: _run_vllm(
            _build_gen_prompt(book, section_name, page_num, 'en', en_text, _subject_name),
        ),
        label, 'en-generation',
    )

    # ── Step 3: Extract Chinese reference text ──
    zh_text = ''
    try:
        print(f'  [{label}] Extracting Chinese reference text …')
        zh_text = extract_page_text(subject, book, section_num, page_num, 'tc')
        print(f'  [{label}]   got {len(zh_text)} chars')
    except Exception as exc:
        print(f'  [{label}]   ⚠  Chinese reference extraction failed: {exc}')
        print(f'  [{label}]   continuing with translation without reference text')

    # ── Step 4: Translate to Traditional Chinese (with retry) ──
    print(f'  [{label}] Translating to Traditional Chinese …')
    zh_result = _generate_with_retry(
        lambda: _run_vllm(
            _build_translation_prompt(book, section_name, page_num, 'tc', en_result, zh_text, _subject_name),
        ),
        label, 'zh-translation',
    )

    # ── Step 5: Final validation before saving ──
    save_content(subject, book, section_num, page_num, en_result, zh_result,
                 en_text=en_text, zh_text=zh_text)
    print(f'  [{label}] ✓  Saved to MongoDB')
    return 'generated'


def _generate_with_retry(generate_fn, label, step_name):
    """Call ``generate_fn()``, validate the result, and retry once if the
    first attempt yields invalid or truncated JSON.

    The AI Gateway uses the model's native maximum output length (max_tokens
    is omitted from the request), so retries are simple re-attempts rather
    than token-budget escalations.

    Raises RuntimeError if both attempts fail validation.
    """
    max_attempts = 2

    for attempt in range(1, max_attempts + 1):
        result = generate_fn()

        # ── Check for parse error (truncated / unparseable JSON) ──
        if result.get('_parse_error'):
            if attempt < max_attempts:
                truncated = result.get('_raw_truncated', '')
                print(f'  [{label}]   ⚠  {step_name} returned truncated/unparseable JSON '
                      f'(attempt {attempt}/{max_attempts}): {truncated}')
                print(f'  [{label}]   retrying …')
                time.sleep(2)
                continue
            else:
                raise RuntimeError(
                    f'{step_name} for {label} returned unparseable content '
                    f'after {max_attempts} attempts. '
                    f'Truncated preview: {result.get("_raw_truncated", "")}'
                )

        # ── Validate structure ──
        is_valid, errors = _validate_content_structure(result, f'[{label}] {step_name}: ')
        if is_valid:
            if attempt > 1:
                print(f'  [{label}]   ✓  {step_name} succeeded on retry '
                      f'(attempt {attempt})')
            # Strip internal markers before returning clean content
            result.pop('_parse_error', None)
            result.pop('_raw_truncated', None)
            return result

        # Invalid — retry or fail
        if attempt < max_attempts:
            print(f'  [{label}]   ⚠  {step_name} validation failed '
                  f'(attempt {attempt}/{max_attempts}):')
            for e in errors:
                print(f'  [{label}]      - {e}')
            print(f'  [{label}]   retrying …')
            time.sleep(2)
            continue
        else:
            raise RuntimeError(
                f'{step_name} for {label} failed validation after '
                f'{max_attempts} attempts:\n' +
                '\n'.join(f'  - {e}' for e in errors)
            )

    # Should never reach here
    raise RuntimeError(f'{step_name} for {label}: unexpected retry loop exit')


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


def _run_simplified_chinese_detection(args):
    """Scan all documents in ai-generations for simplified Chinese in zh content.

    For each document containing simplified-only characters, regenerate it.
    Respects --dry-run (list only) and --delay (pause between regenerations).
    """
    coll = _get_collection()
    all_docs = list(coll.find({}))

    if not all_docs:
        print('No documents found in the ai-generations collection.')
        return

    # ── Filter: documents that HAVE zh content with simplified Chinese ──
    tainted = []
    clean = 0
    no_zh = 0
    for doc in all_docs:
        zh = doc.get('zh')
        if not zh or not isinstance(zh, dict):
            no_zh += 1
            continue
        if has_simplified_chinese(doc):
            tainted.append(doc)
        else:
            clean += 1

    print(f'Collection scan complete:')
    print(f'  Total documents  : {len(all_docs)}')
    print(f'  Clean (zh ok)    : {clean}')
    print(f'  No zh content    : {no_zh}')
    print(f'  Tainted (simpl.) : {len(tainted)}')
    print('=' * 60)

    if not tainted:
        print('✓  No documents contain simplified Chinese. Nothing to do.')
        return

    if args.dry_run:
        print('\nDocuments with simplified Chinese (dry-run — no regeneration):')
        for doc in tainted:
            subject = doc.get('subjectId', '?')
            book = doc.get('bookId', '?')
            section = doc.get('sectionId', '?')
            page = doc.get('pageId', '?')
            # Show which simplified chars were found
            text = _collect_zh_text(doc)
            found = sorted(set(ch for ch in text if ch in _SIMPLIFIED_ONLY_CHARS))
            print(f'  {subject}/{book}/{section}/{page}  —  chars: {" ".join(found[:20])}{" …" if len(found) > 20 else ""}')
        print(f'\n{len(tainted)} document(s) would be regenerated.')
        return

    # ── Regenerate tainted documents ──
    print(f'\nRegenerating {len(tainted)} document(s) with simplified Chinese…\n')
    regenerated = 0
    errors = 0

    for i, doc in enumerate(tainted, 1):
        subject = doc.get('subjectId', '')
        book = doc.get('bookId', '')
        section_num = doc.get('sectionId', 1)
        page_num = doc.get('pageId', 1)
        label = f'{subject}/{book}/{section_num}/{page_num}'

        # Show which simplified chars triggered the detection
        text = _collect_zh_text(doc)
        found = sorted(set(ch for ch in text if ch in _SIMPLIFIED_ONLY_CHARS))
        print(f'\n[{i}/{len(tainted)}] {label}')
        print(f'  Simplified chars detected: {" ".join(found[:20])}{" …" if len(found) > 20 else ""}')

        # Resolve section name from contents.json
        section_name = _resolve_section_name(subject, book, str(section_num))

        try:
            result = generate_for_page(
                subject, book,
                _to_section_id(str(section_num)),
                int(page_num),
                section_name,
                force=True,
            )
            if result in ('generated', 'translated'):
                regenerated += 1
        except Exception as exc:
            print(f'  ❌ ERROR: {exc}')
            errors += 1
            time.sleep(2)

        time.sleep(args.delay)

    print('\n' + '=' * 60)
    print(
        f'Simplified Chinese detection done.  '
        f'{len(tainted)} tainted  |  '
        f'{regenerated} regenerated  |  '
        f'{errors} error(s)'
    )


def _resolve_section_name(subject, book, section_num):
    """Look up the English section name from contents.json. Falls back to a generic label."""
    try:
        contents_file = DATA_DIR / subject / book / 'contents.json'
        if contents_file.is_file():
            with open(contents_file, encoding='utf-8') as fh:
                data = json.load(fh)
            for item in data.get('contents', []):
                if str(item.get('section', '')) == section_num:
                    name = _extract_name(item, 'en') or _extract_name(item, 'tc')
                    if name:
                        return name
        # Also check for contents-*.json files in _out directory (for physics-oup-xxx style)
        out_dir = DATA_DIR.parent / '_out' if (DATA_DIR.parent / '_out').is_dir() else None
    except Exception:
        pass
    return f'Section {section_num}'


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
        '--pages-per-section', type=int, default=0,
        help='Maximum sub-pages to generate per section (default: 0 = all pages)',
    )
    parser.add_argument(
        '--limit', type=int, default=0,
        help='Maximum total pages to process across all sections (default: 0 = unlimited). '
             'Useful for testing: --limit=1 processes only the first page.',
    )
    parser.add_argument(
        '--delay', type=float, default=DELAY_BETWEEN_PAGES,
        help=f'Seconds to wait between pages (default: {DELAY_BETWEEN_PAGES})',
    )
    parser.add_argument(
        '--debug', action='store_true',
        help='Print full request payloads and raw responses sent to the AI gateway',
    )
    parser.add_argument(
        '--simplified-chinese-detection', action='store_true',
        help='Scan ALL documents in the collection for simplified Chinese characters '
             'in the zh (Chinese) content. Any document containing simplified-only '
             'characters (e.g. 爱, 国) will be regenerated to produce proper '
             'Traditional Chinese output.',
    )
    parser.add_argument(
        '-v', '--verbose', action='store_true',
        help='Print the gateway request payload (with redacted API key) and full '
             'response body for every AI call',
    )
    args = parser.parse_args()

    # ── Validate configuration ─────────────────────────────
    if not VLLM_APIKEY:
        print('ERROR: VLLM_APIKEY is not set.  Configure it in your .env file.')
        sys.exit(1)
    if not OLLAMA_APIKEY:
        print('ERROR: OLLAMA_APIKEY is not set.  Configure it in your .env file.')
        sys.exit(1)

    if not DATA_DIR.is_dir():
        print(f'ERROR: DATA_DIR does not exist: {DATA_DIR}')
        sys.exit(1)

    # Apply debug/verbose flags BEFORE anything else so all code paths see them.
    if args.debug:
        global DEBUG
        DEBUG = True
    if args.verbose:
        global VERBOSE
        VERBOSE = True

    # ── Simplified Chinese Detection Mode ──────────────────
    if args.simplified_chinese_detection:
        _run_simplified_chinese_detection(args)
        return

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

    active_url = VLLM_DEBUG_URL if DEBUG else VLLM_URL
    print(f'Subjects  : {", ".join(subjects)}')
    print(f'Data dir  : {DATA_DIR}')
    print(f'VLLM URL  : {active_url}')
    print(f'VLLM prov : {VLLM_PROVIDER}  |  model: {VLLM_MODEL}')
    print(f'Ollama    : {OLLAMA_PROVIDER}  |  model: {OLLAMA_MODEL}')
    print(f'Force     : {args.force}')
    print(f'Dry-run   : {args.dry_run}')
    print(f'Pages/sect: {args.pages_per_section}')
    print(f'Limit     : {args.limit if args.limit else "unlimited"}')
    print(f'Debug     : {args.debug}')
    print(f'Verbose   : {args.verbose}')
    print('=' * 60)

    total_pages = 0
    total_generated = 0
    total_skipped = 0
    total_errors = 0
    limit_reached = False

    try:
        for subj in subjects:
            # Check global limit before processing next subject
            if args.limit > 0 and total_generated + total_skipped >= args.limit:
                print(f'\n⏹  Limit of {args.limit} page(s) reached — stopping.')
                break
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
                    #   4-part target (…/section/page) → ONLY that specific page
                    #   3-part target (…/section)      → ALL pages of that section
                    #   2-part target (…/book)         → limited by --pages-per-section
                    #   1-part target (subject)        → limited by --pages-per-section
                    #   no target                      → ALL pages of every section
                    if page is not None:
                        # Explicit page → only that one page
                        page_start = max(1, int(page))
                        page_end = page_start
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
                        # Book or subject level → respect --pages-per-section (0 = all)
                        page_limit = max_pages if args.pages_per_section == 0 else min(max_pages, args.pages_per_section)
                        page_start = 1
                        page_end = page_limit

                    for pg in range(page_start, page_end + 1):
                        total_pages += 1
                        label = f'{subj}/{bk}/{sec_num}/{pg}'

                        if content_exists(subj, bk, sec_num, pg) and not args.force:
                            total_skipped += 1
                            print(f'    [skip] {label}  — {sec_name[:50]} (already in DB)')
                            if args.limit > 0 and total_skipped >= args.limit:
                                limit_reached = True
                                break
                            continue

                        if args.dry_run:
                            print(f'    [GEN]  {label}  — {sec_name[:50]}')
                            total_generated += 1  # count dry-run pages toward limit
                            if args.limit > 0 and total_generated >= args.limit:
                                limit_reached = True
                                break
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

                        # Check global limit after each page
                        if args.limit > 0 and total_generated + total_skipped >= args.limit:
                            print(f'⏹  Limit of {args.limit} page(s) reached — stopping.')
                            limit_reached = True
                            break

                        time.sleep(args.delay)

                    if limit_reached:
                        break
                if limit_reached:
                    break
            if limit_reached:
                break

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
