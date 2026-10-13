#!/usr/bin/env python3
"""
add-section-for-winter.py

Scan the generated textbook page images for chemistry-winter and
chemistry-winter2, cache image-to-text output, then write page sections based
on the video titles in video-tutor CONSTANTS chapters[].videos[].

Default input roots:
	data/textbooks/chemistry-winter
	data/textbooks/chemistry-winter2

For a page image like:
	data/textbooks/chemistry-winter/1/en/contents/pages/1-1.png

Outputs:
	data/textbooks/chemistry-winter/1/en/image-to-text/1-1.txt
	data/textbooks/chemistry-winter/1/en/sections/1-1.txt
	data/textbooks/chemistry-winter/1/contents.json updated with page-num

Configuration is read from environment variables first, then .env in the
project root:
	VLLM_API_URL=https://gentle.aied.hku.hk/api/generate
	VLLM_PROVIDER=ett-vllm
	VLLM_MODEL=OpenGVLab/InternVL3_5-38B
	VLLM_APIKEY=<secret>

Usage:
	python3 scripts/add-section-for-winter.py
	python3 scripts/add-section-for-winter.py chemistry-winter/1
	python3 scripts/add-section-for-winter.py chemistry-winter2/1 --force
	python3 scripts/add-section-for-winter.py --books 1 2 --pages 1-1 1-2
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests


DEFAULT_SUBJECTS = ("chemistry-winter", "chemistry-winter2")
DEFAULT_API_URL = "https://gentle.aied.hku.hk/api/generate"
DEFAULT_PROVIDER = "ett-vllm"
DEFAULT_MODEL = "OpenGVLab/InternVL3_5-38B"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
CONSTANTS_FILES = {
	"chemistry-winter": Path("/private/var/www/html/video-tutor/subjects/chemistry/winter/CONSTANTS-20260930.js"),
	"chemistry-winter2": Path("/private/var/www/html/video-tutor/subjects/chemistry/winter2/CONSTANTS-20261001.js"),
}
VIDEOS_DIRS = {
	"chemistry-winter": Path("/private/var/www/html/video-tutor/subjects/chemistry/winter/videos"),
	"chemistry-winter2": Path("/private/var/www/html/video-tutor/subjects/chemistry/winter2/videos"),
}

VERBOSE = False


def load_env_file(env_path: Path) -> dict[str, str]:
	"""Parse a simple .env file with KEY=value lines."""
	values: dict[str, str] = {}
	if not env_path.is_file():
		return values

	with env_path.open("r", encoding="utf-8") as f:
		for raw_line in f:
			line = raw_line.strip()
			if not line or line.startswith("#") or "=" not in line:
				continue
			key, value = line.split("=", 1)
			key = key.strip()
			value = value.strip()
			if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
				value = value[1:-1]
			values[key] = value
	return values


def get_config(base_dir: Path) -> dict[str, str]:
	env = load_env_file(base_dir / ".env")
	return {
		"url": os.environ.get("VLLM_API_URL") or env.get("VLLM_API_URL") or DEFAULT_API_URL,
		"provider": os.environ.get("VLLM_PROVIDER") or env.get("VLLM_PROVIDER") or DEFAULT_PROVIDER,
		"model": os.environ.get("VLLM_MODEL") or env.get("VLLM_MODEL") or DEFAULT_MODEL,
		"api_key": os.environ.get("VLLM_APIKEY") or env.get("VLLM_APIKEY") or "",
	}


def natural_sort_key(value: str | Path) -> tuple[int, int, str, str]:
	text = Path(value).stem if isinstance(value, Path) else str(value)
	match = re.match(r"^(\d+)(?:-(\d+))?(.*)$", text)
	if match:
		return (0, int(match.group(1)), int(match.group(2) or 0), match.group(3))
	return (1, 0, 0, text)


def strip_js_comments(text: str) -> str:
	out: list[str] = []
	i = 0
	in_string = False
	quote = ""
	escaped = False
	while i < len(text):
		ch = text[i]
		next_ch = text[i + 1] if i + 1 < len(text) else ""
		if in_string:
			out.append(ch)
			if escaped:
				escaped = False
			elif ch == "\\":
				escaped = True
			elif ch == quote:
				in_string = False
			i += 1
			continue
		if ch in {'"', "'"}:
			in_string = True
			quote = ch
			out.append(ch)
			i += 1
			continue
		if ch == "/" and next_ch == "/":
			while i < len(text) and text[i] not in "\r\n":
				i += 1
			continue
		if ch == "/" and next_ch == "*":
			i += 2
			while i + 1 < len(text) and not (text[i] == "*" and text[i + 1] == "/"):
				i += 1
			i += 2
			continue
		out.append(ch)
		i += 1
	return "".join(out)


def find_matching_bracket(text: str, open_index: int, open_char: str = "[", close_char: str = "]") -> int:
	depth = 0
	in_string = False
	quote = ""
	escaped = False
	for i in range(open_index, len(text)):
		ch = text[i]
		if in_string:
			if escaped:
				escaped = False
			elif ch == "\\":
				escaped = True
			elif ch == quote:
				in_string = False
			continue
		if ch in {'"', "'"}:
			in_string = True
			quote = ch
			continue
		if ch == open_char:
			depth += 1
		elif ch == close_char:
			depth -= 1
			if depth == 0:
				return i
	return -1


def find_object_blocks(array_text: str) -> list[str]:
	blocks = []
	i = 0
	while i < len(array_text):
		if array_text[i] == "{":
			end = find_matching_bracket(array_text, i, "{", "}")
			if end >= 0:
				blocks.append(array_text[i:end + 1])
				i = end + 1
				continue
		i += 1
	return blocks


def extract_js_array(block: str, key: str) -> str:
	match = re.search(rf"\b{re.escape(key)}\s*:\s*\[", block)
	if not match:
		return ""
	open_index = match.end() - 1
	close_index = find_matching_bracket(block, open_index, "[", "]")
	if close_index < 0:
		return ""
	return block[open_index + 1:close_index]


def extract_js_string_value(block: str, key: str) -> str:
	match = re.search(rf"\b{re.escape(key)}\s*:\s*(['\"])(.*?)\1", block, flags=re.S)
	return match.group(2).strip() if match else ""


def extract_js_number_value(block: str, key: str) -> str:
	match = re.search(rf"\b{re.escape(key)}\s*:\s*(\d+)", block)
	return match.group(1) if match else ""


def parse_js_string_array(array_text: str) -> list[str]:
	return [m.group(2).strip() for m in re.finditer(r"(['\"])(.*?)\1", array_text, flags=re.S)]


def parse_js_number_array(array_text: str) -> list[int]:
	return [int(m.group(1)) for m in re.finditer(r"\b(\d+)\b", array_text)]


def clean_video_title(video: str) -> str:
	title = video.split("|", 1)[0].strip()
	title = title.replace("_", ".")
	title = re.sub(r"\s+", " ", title)
	return title


def sanitize_section_title(title: str) -> str:
	title = title.strip()
	title = re.sub(r"^#+\s*", "", title)
	title = title.strip().strip("-•* ").strip()
	title = title.replace("_", ".")
	title = re.sub(r"\s+", " ", title)
	return title.strip()


def video_title_key(title: str) -> str:
	title = sanitize_section_title(title)
	title = re.sub(r"\.[a-z0-9]{2,5}$", "", title, flags=re.IGNORECASE)
	title = re.sub(r"\s+", " ", title)
	title = re.sub(r"\s+([.,;:])", r"\1", title)
	return title.casefold().strip()


def load_valid_video_titles(videos_root: Path) -> dict[str, str]:
	"""Return normalized video-title key -> canonical filename stem for .mp4 videos."""
	if not videos_root.is_dir():
		return {}

	titles: dict[str, str] = {}
	for path in videos_root.rglob("*.mp4"):
		canonical = sanitize_section_title(path.stem)
		key = video_title_key(canonical)
		if key and key not in titles:
			titles[key] = canonical
	return titles


def load_all_valid_video_titles() -> dict[str, dict[str, str]]:
	return {subject: load_valid_video_titles(path) for subject, path in VIDEOS_DIRS.items()}


def canonical_video_title(title: str, valid_video_titles: dict[str, str]) -> str | None:
	return valid_video_titles.get(video_title_key(title))


def filter_to_existing_video_titles(titles: list[str], valid_video_titles: dict[str, str]) -> list[str]:
	filtered: list[str] = []
	for title in titles:
		canonical = canonical_video_title(title, valid_video_titles)
		if canonical and canonical not in filtered:
			filtered.append(canonical)
	return filtered


def infer_notes_chapter(topic_block: str) -> str:
	chapter = extract_js_number_value(topic_block, "notes_chapter")
	if chapter:
		return chapter
	notes = extract_js_string_value(topic_block, "notes")
	match = re.match(r"0*(\d+)", notes)
	return match.group(1) if match else ""


def load_video_page_index(constants_path: Path) -> dict[str, dict[int, list[str]]]:
	"""Return {book_id: {page_number: [video_title, ...]}} from CONSTANTS."""
	if not constants_path.is_file():
		return {}

	text = strip_js_comments(constants_path.read_text(encoding="utf-8"))
	topics_match = re.search(r"\bTOPICS\s*=\s*\[", text)
	if not topics_match:
		return {}
	topics_open = topics_match.end() - 1
	topics_close = find_matching_bracket(text, topics_open, "[", "]")
	if topics_close < 0:
		return {}

	index: dict[str, dict[int, list[str]]] = {}
	for topic_block in find_object_blocks(text[topics_open + 1:topics_close]):
		book_id = infer_notes_chapter(topic_block)
		if not book_id:
			continue
		chapters_text = extract_js_array(topic_block, "chapters")
		if not chapters_text:
			continue

		book_index = index.setdefault(book_id, {})
		for chapter_block in find_object_blocks(chapters_text):
			videos = [clean_video_title(v) for v in parse_js_string_array(extract_js_array(chapter_block, "videos"))]
			pages = parse_js_number_array(extract_js_array(chapter_block, "pages"))
			for video_title, page_number in zip(videos, pages):
				if not video_title:
					continue
				items = book_index.setdefault(page_number, [])
				if video_title not in items:
					items.append(video_title)
	return index


def load_all_video_page_indexes() -> dict[str, dict[str, dict[int, list[str]]]]:
	return {subject: load_video_page_index(path) for subject, path in CONSTANTS_FILES.items()}


def subject_id_from_book_dir(book_dir: Path) -> str:
	try:
		return book_dir.parent.name
	except IndexError:
		return ""


def page_number_from_image(image_path: Path) -> int | None:
	match = re.match(r"^\d+-(\d+)$", image_path.stem)
	return int(match.group(1)) if match else None


def normalize_for_match(text: str) -> set[str]:
	stop = {"the", "and", "of", "in", "to", "for", "from", "a", "an", "mc", "i", "ii", "iii", "iv", "v"}
	return {
		word for word in re.findall(r"[a-z0-9]+", text.lower())
		if len(word) > 1 and word not in stop
	}


def rank_video_titles_for_page(video_titles: list[str], ocr_text: str) -> list[str]:
	"""Order same-page video titles by OCR overlap while retaining all titles."""
	if len(video_titles) <= 1 or not ocr_text.strip():
		return video_titles

	ocr_tokens = normalize_for_match(ocr_text)
	scored = []
	for order, title in enumerate(video_titles):
		tokens = normalize_for_match(title)
		score = len(tokens & ocr_tokens)
		scored.append((-score, order, title))
	return [title for _, _, title in sorted(scored)]


def section_parts_from_title(title: str, fallback_index: int) -> tuple[str, str]:
	match = re.match(r"^\s*((?:\d+[A-Z]?|[A-Z]\d*)(?:\.\d+)*|MC\s+[A-Z0-9-]+)\s*[.)_:-]?\s+(.+)$", title, flags=re.IGNORECASE)
	if match:
		section_id = re.sub(r"\s+", "", match.group(1).strip()).replace("_", ".")
		return section_id, match.group(2).strip()
	return str(fallback_index), title


def read_sections_for_contents(
	book_dir: Path,
	sections_dir: Path,
	allowed_page_numbers: set[int] | None = None,
	valid_video_titles: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
	if not sections_dir.is_dir():
		return []

	book_page_id = book_dir.name
	entries: list[dict[str, Any]] = []
	seen: set[tuple[str, int, str]] = set()
	for path in sorted(sections_dir.glob("*.txt"), key=natural_sort_key):
		page_number = page_number_from_image(path)
		if page_number is None:
			continue
		if allowed_page_numbers is not None and page_number not in allowed_page_numbers:
			continue
		try:
			lines = [sanitize_section_title(line) for line in path.read_text(encoding="utf-8").splitlines() if sanitize_section_title(line)]
		except OSError:
			continue
		for title in lines:
			if valid_video_titles is not None:
				canonical = canonical_video_title(title, valid_video_titles)
				if not canonical:
					continue
				title = canonical
			section_id, section_name = section_parts_from_title(title, len(entries) + 1)
			key = (section_id, page_number, title)
			if key in seen:
				continue
			seen.add(key)
			entries.append({
				"section": section_id,
				"page": book_page_id,
				"page-num": page_number,
				"en": {"name": section_name, "resources": []},
				"tc": {"name": "", "resources": []},
			})
	return entries


def update_contents_json_from_sections(
	book_dir: Path,
	book_video_index: dict[int, list[str]] | None = None,
	valid_video_titles: dict[str, str] | None = None,
) -> int:
	contents_path = book_dir / "contents.json"
	sections_dir = book_dir / "en" / "sections"
	allowed_page_numbers = set(book_video_index) if book_video_index else None
	entries = read_sections_for_contents(book_dir, sections_dir, allowed_page_numbers, valid_video_titles)
	if not entries:
		return 0

	if contents_path.is_file():
		with contents_path.open("r", encoding="utf-8") as f:
			data = json.load(f)
	else:
		data = {"chapter": book_dir.name, "contents": []}

	old_by_name = {}
	old_by_section = {}
	for item in data.get("contents", []) if isinstance(data.get("contents"), list) else []:
		name = ""
		if isinstance(item.get("en"), dict):
			name = str(item["en"].get("name") or "").strip().lower()
		if name:
			old_by_name[name] = item
		old_by_section[str(item.get("section", "")).strip()] = item

	for entry in entries:
		old = old_by_name.get(entry["en"]["name"].strip().lower()) or old_by_section.get(str(entry["section"])) or {}
		for lang in ("en", "tc"):
			old_lang = old.get(lang)
			if isinstance(old_lang, dict):
				if lang == "tc" and old_lang.get("name"):
					entry[lang]["name"] = old_lang.get("name", "")
				entry[lang]["resources"] = old_lang.get("resources", []) if isinstance(old_lang.get("resources"), list) else []
			elif isinstance(old_lang, str) and old_lang.strip() and lang == "tc":
				entry[lang]["name"] = old_lang.strip()

	data["contents"] = entries
	with contents_path.open("w", encoding="utf-8") as f:
		json.dump(data, f, ensure_ascii=False, indent=4)
		f.write("\n")
	return len(entries)


def extract_response_text(data: Any) -> str:
	"""Extract the model text from common AI Gateway response shapes."""
	if isinstance(data, str):
		return data.strip()
	if not isinstance(data, dict):
		return ""

	for key in ("response", "text", "output", "content", "masterSummary"):
		value = data.get(key)
		if isinstance(value, str) and value.strip():
			return value.strip()
		if isinstance(value, dict):
			nested = extract_response_text(value)
			if nested:
				return nested

	generation = data.get("generation")
	if isinstance(generation, str) and generation.strip():
		return generation.strip()
	if isinstance(generation, dict):
		nested = extract_response_text(generation)
		if nested:
			return nested

	files = data.get("files")
	if isinstance(files, list):
		parts = [extract_response_text(item) for item in files]
		return "\n\n".join(part for part in parts if part).strip()

	return ""


def log_request(url: str, fields: dict[str, Any]) -> None:
	if not VERBOSE:
		return
	printable = {}
	for key, value in fields.items():
		if key == "apiKey":
			printable[key] = "<redacted>"
		elif isinstance(value, tuple) and len(value) >= 3 and value[0] is not None:
			printable[key] = f"<file {value[0]} {value[2]}>"
		elif isinstance(value, tuple):
			printable[key] = value[1] if len(value) > 1 else value[0]
		else:
			printable[key] = value
	print(f"\n[request] POST {url}")
	print(json.dumps(printable, ensure_ascii=False, indent=2))


def post_generate(config: dict[str, str], prompt: str, image_path: Path | None = None, timeout: int = 180) -> str:
	"""Call the configured AI Gateway /api/generate endpoint."""
	fields: dict[str, Any] = {
		"provider": (None, config["provider"]),
		"apiKey": (None, config["api_key"]),
		"model": (None, config["model"]),
		"prompt": (None, prompt),
		"responseFormat": (None, "json"),
	}

	file_handle = None
	try:
		if image_path is not None:
			mime_type, _ = mimetypes.guess_type(str(image_path))
			if not mime_type:
				mime_type = "application/octet-stream"
			file_handle = image_path.open("rb")
			fields["files"] = (image_path.name, file_handle, mime_type)

		log_request(config["url"], fields)
		response = requests.post(
			config["url"],
			files=fields,
			headers={"Accept": "application/json"},
			timeout=timeout,
		)
		if VERBOSE:
			print(f"[response] HTTP {response.status_code}: {response.text[:2000]}")
		if response.status_code >= 400:
			message = response.text.strip()[:1000]
			if message:
				response.reason = f"{response.reason}: {message}"
		response.raise_for_status()

		try:
			return extract_response_text(response.json())
		except json.JSONDecodeError:
			return response.text.strip()
	finally:
		if file_handle is not None:
			file_handle.close()


def ocr_page(config: dict[str, str], image_path: Path) -> str:
	prompt = (
		"You are reading a chemistry textbook page image. Extract all visible text "
		"as accurately as possible. Preserve the natural reading order and useful "
		"line breaks. Include headings, subheadings, labels, equations, captions, "
		"and bullet points. Do not summarize. Return only plain text."
	)
	return post_generate(config, prompt, image_path=image_path)


def extract_sections_from_text(config: dict[str, str], text: str) -> str:
	"""Extract likely section headings from cached OCR text without another API call.

	The ett-vllm provider is image-oriented and returns HTTP 400 for text-only
	generation requests, so section extraction is intentionally local.
	"""
	_ = config
	lines = cleanup_ocr_lines(text)
	if not lines:
		return ""

	headings: list[str] = []
	for i, line in enumerate(lines):
		candidate = normalize_heading_line(line)
		if not candidate:
			continue

		# Join headings split by OCR into "A." then "Elements and compounds".
		if re.fullmatch(r"(?:\d+(?:\.\d+)*|[A-Z])\s*[.)]", candidate) and i + 1 < len(lines):
			next_line = normalize_heading_line(lines[i + 1])
			if next_line and is_plausible_heading_text(next_line):
				candidate = f"{candidate} {next_line}"

		if is_section_heading(candidate) and candidate not in headings:
			headings.append(candidate)

	return "\n".join(headings)


def cleanup_ocr_lines(text: str) -> list[str]:
	text = text.strip()
	text = re.sub(r"^```(?:text|markdown)?\s*", "", text, flags=re.IGNORECASE).strip()
	text = re.sub(r"\s*```$", "", text).strip()
	text = re.sub(r"^The image (?:contains|shows|has) the following text:\s*", "", text, flags=re.IGNORECASE).strip()
	text = text.strip('"')

	lines = []
	for raw in text.splitlines():
		line = re.sub(r"[*_`]+", "", raw).strip()
		line = re.sub(r"\s+", " ", line)
		line = line.strip('"“”')
		if line:
			lines.append(line)
	return lines


def normalize_heading_line(line: str) -> str:
	line = line.strip().strip("-•* ").strip()
	line = line.strip('"“”')
	line = re.sub(r"\s+", " ", line)
	line = re.sub(r"^([A-Z]|\d+(?:\.\d+)*)\s+", r"\1. ", line, count=1) if re.match(r"^(?:[A-Z]|\d+(?:\.\d+)*)\s+[A-Z]", line) else line
	return line.strip()


def is_plausible_heading_text(line: str) -> bool:
	if not line or len(line) > 100:
		return False
	if re.search(r"[.!?]$", line) and len(line.split()) > 4:
		return False
	return bool(re.search(r"[A-Za-z]", line))


def is_section_heading(line: str) -> bool:
	if not is_plausible_heading_text(line):
		return False

	lower = line.lower().strip()
	compact = re.sub(r"[^a-z0-9]", "", lower)
	ignored = {
		"hkdse",
		"h k d s e",
		"chemistry",
		"chemchemday",
		"deep learning series",
		"contents",
		"answers",
	}
	if lower in ignored or compact in {"hkdse", "hksdse", "hkdsechemistry", "hksdsechemistry"} or lower.isdigit():
		return False
	if re.search(r"深度學習系列|頁|第\s*\d+\s*頁", line):
		return False

	# Numbered or lettered chemistry note headings.
	if re.match(r"^(?:\d+(?:\.\d+)*|[A-Z])\s*[.)]\s+\S", line):
		return True

	# Cover/title pages and prominent short headings commonly OCRed as one line.
	words = line.split()
	if 1 <= len(words) <= 7 and re.search(r"[A-Za-z]", line):
		alpha_words = [word for word in words if re.search(r"[A-Za-z]", word)]
		if alpha_words and sum(1 for word in alpha_words if word[:1].isupper()) >= max(1, len(alpha_words) - 1):
			return True

	return False


def normalize_section_output(raw: str) -> str:
	"""Clean JSON/code-fence wrappers while keeping one heading per line."""
	text = raw.strip()
	if not text:
		return ""

	text = re.sub(r"^```(?:json|text)?\s*", "", text, flags=re.IGNORECASE).strip()
	text = re.sub(r"\s*```$", "", text).strip()

	try:
		parsed = json.loads(text)
		if isinstance(parsed, dict):
			for key in ("sections", "headings", "section", "heading"):
				value = parsed.get(key)
				if isinstance(value, list):
					return "\n".join(str(item).strip() for item in value if str(item).strip())
				if isinstance(value, str):
					return value.strip()
		if isinstance(parsed, list):
			return "\n".join(str(item).strip() for item in parsed if str(item).strip())
	except json.JSONDecodeError:
		pass

	lines = []
	for line in text.splitlines():
		line = line.strip().strip("-•* ").strip()
		if line and line.upper() not in {"N/A", "NA", "NONE", "NO SECTION", "NO SECTIONS"}:
			lines.append(line)
	return "\n".join(lines)


def discover_subject_dirs(data_root: Path, scopes: list[str]) -> list[Path]:
	if scopes:
		return [data_root / scope for scope in scopes]
	return [data_root / "textbooks" / subject for subject in DEFAULT_SUBJECTS]


def discover_book_dirs(scope_dir: Path) -> list[Path]:
	if (scope_dir / "en" / "contents" / "pages").is_dir():
		return [scope_dir]
	if not scope_dir.is_dir():
		return []
	return sorted(
		(
			child for child in scope_dir.iterdir()
			if child.is_dir() and (child / "en" / "contents" / "pages").is_dir()
		),
		key=lambda p: natural_sort_key(p.name),
	)


def discover_page_images(book_dir: Path, page_filter: set[str] | None) -> list[Path]:
	pages_dir = book_dir / "en" / "contents" / "pages"
	images = [p for p in pages_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
	if page_filter is not None:
		images = [p for p in images if p.stem in page_filter]
	return sorted(images, key=natural_sort_key)


def process_page(
	config: dict[str, str],
	image_path: Path,
	image_text_dir: Path,
	sections_dir: Path,
	force_ocr: bool,
	force_sections: bool,
	page_video_titles: list[str] | None,
	valid_video_titles: dict[str, str],
) -> tuple[bool, bool]:
	page_id = image_path.stem
	image_text_path = image_text_dir / f"{page_id}.txt"
	section_path = sections_dir / f"{page_id}.txt"

	image_text_dir.mkdir(parents=True, exist_ok=True)
	sections_dir.mkdir(parents=True, exist_ok=True)

	ocr_created = False
	section_created = False

	if image_text_path.exists() and not force_ocr:
		text = image_text_path.read_text(encoding="utf-8")
	else:
		text = ocr_page(config, image_path)
		image_text_path.write_text(text.rstrip() + "\n", encoding="utf-8")
		ocr_created = True

	if section_path.exists() and not force_sections:
		return ocr_created, section_created

	if page_video_titles is not None:
		valid_titles = filter_to_existing_video_titles(rank_video_titles_for_page(page_video_titles, text), valid_video_titles)
	else:
		valid_titles = filter_to_existing_video_titles(normalize_section_output(extract_sections_from_text(config, text)).splitlines(), valid_video_titles)
	section_text = "\n".join(valid_titles)
	section_path.write_text(section_text.rstrip() + ("\n" if section_text else ""), encoding="utf-8")
	section_created = True
	return ocr_created, section_created


def process_book(
	config: dict[str, str],
	book_dir: Path,
	args: argparse.Namespace,
	video_indexes: dict[str, dict[str, dict[int, list[str]]]],
) -> None:
	page_filter = set(args.pages) if args.pages else None
	images = discover_page_images(book_dir, page_filter)
	if not images:
		print(f"  [skip] no page images: {book_dir}")
		return

	image_text_dir = book_dir / "en" / "image-to-text"
	sections_dir = book_dir / "en" / "sections"
	subject_id = subject_id_from_book_dir(book_dir)
	book_video_index = video_indexes.get(subject_id, {}).get(book_dir.name, {})
	valid_video_titles = getattr(args, "valid_video_titles", {}).get(subject_id, {})

	print(f"  Book: {book_dir}")
	print(f"  Pages: {len(images)}")
	if book_video_index:
		print(f"  Video sections: {sum(len(v) for v in book_video_index.values())} title(s) on {len(book_video_index)} page(s)")
	else:
		print("  Video sections: none found; falling back to OCR heading detection")
	print(f"  Valid video files: {len(valid_video_titles)} title(s)")

	for index, image_path in enumerate(images, start=1):
		label = f"{index}/{len(images)} {image_path.name}"
		page_number = page_number_from_image(image_path)
		page_video_titles = book_video_index.get(page_number) if page_number is not None else None
		try:
			ocr_created, section_created = process_page(
				config,
				image_path,
				image_text_dir,
				sections_dir,
				args.force_ocr,
				args.force_sections,
				page_video_titles,
				valid_video_titles,
			)
			actions = []
			actions.append("ocr" if ocr_created else "ocr cached")
			actions.append("sections" if section_created else "sections cached")
			if page_video_titles:
				actions.append(f"matched {len(page_video_titles)} video title(s)")
			print(f"    [{label}] {', '.join(actions)}")
		except requests.RequestException as exc:
			print(f"    [{label}] ERROR: {exc}", file=sys.stderr)
			if not args.continue_on_error:
				raise
		except Exception as exc:
			print(f"    [{label}] ERROR: {exc}", file=sys.stderr)
			if not args.continue_on_error:
				raise

		if args.delay > 0 and index < len(images):
			time.sleep(args.delay)

	updated = update_contents_json_from_sections(book_dir, book_video_index, valid_video_titles)
	if updated:
		print(f"  Updated contents.json with {updated} section(s)")


def main() -> None:
	global VERBOSE

	parser = argparse.ArgumentParser(
		description="OCR chemistry winter textbook pages and extract section headings."
	)
	parser.add_argument(
		"scopes",
		nargs="*",
		help=(
			"Optional paths under data/, e.g. 'textbooks/chemistry-winter', "
			"'textbooks/chemistry-winter/1', or shorthand 'chemistry-winter/1'. "
			"Default: chemistry-winter and chemistry-winter2."
		),
	)
	parser.add_argument("--books", nargs="*", help="Only process these book/chapter ids within each subject root.")
	parser.add_argument("--pages", nargs="*", help="Only process these page ids, e.g. 1-1 1-2.")
	parser.add_argument("--force", dest="force_sections", action="store_true", help="Regenerate existing sections files only.")
	parser.add_argument("--force-ocr", action="store_true", help="Regenerate existing image-to-text files too.")
	parser.add_argument("--continue-on-error", action="store_true", help="Continue with later pages after an API/page error.")
	parser.add_argument("--delay", type=float, default=0.0, help="Seconds to wait between pages.")
	parser.add_argument("-v", "--verbose", action="store_true", help="Print API request/response details.")
	args = parser.parse_args()

	VERBOSE = args.verbose

	script_dir = Path(__file__).resolve().parent
	base_dir = script_dir.parent
	data_root = base_dir / "data"
	config = get_config(base_dir)

	if not config["api_key"]:
		print("ERROR: VLLM_APIKEY is missing from environment or .env", file=sys.stderr)
		sys.exit(1)

	scopes = []
	for scope in args.scopes:
		scope_path = Path(scope)
		if scope_path.is_absolute():
			scopes.append(str(scope_path.relative_to(data_root)) if str(scope_path).startswith(str(data_root)) else str(scope_path))
		elif scope.startswith("textbooks/"):
			scopes.append(scope)
		else:
			scopes.append(f"textbooks/{scope}")

	video_indexes = load_all_video_page_indexes()
	args.valid_video_titles = load_all_valid_video_titles()
	scope_dirs = discover_subject_dirs(data_root, scopes)
	print(f"Gateway: {config['url']}")
	print(f"Provider: {config['provider']} | Model: {config['model']}")
	print("Image-to-text cache: reused unless --force-ocr is set")
	print("Sections source: video-tutor CONSTANTS chapters[].videos[] when available")

	for scope_dir in scope_dirs:
		if not scope_dir.is_dir():
			print(f"[skip] directory not found: {scope_dir}", file=sys.stderr)
			continue

		books = discover_book_dirs(scope_dir)
		if args.books:
			wanted = set(args.books)
			books = [book for book in books if book.name in wanted]

		print("\n" + "#" * 72)
		print(f"Scope: {scope_dir}")
		print("#" * 72)

		if not books:
			print("  [skip] no matching book directories")
			continue

		for book_dir in books:
			process_book(config, book_dir, args, video_indexes)

	print("\nDone.")


if __name__ == "__main__":
	main()
