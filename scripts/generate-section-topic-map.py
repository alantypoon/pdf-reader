#!/usr/bin/env python3
"""
generate-section-topic-map.py
─────────────────────────────
Produces  data/past-papers/<subject>/section-topic-map.json  for every
subject that has both a textbook and a by-topics past-paper catalog.

Output shape (many-to-many):
{
  "<book-id>": {                   // e.g. "biology-oup"
    "<chapter>": {                 // e.g. "1a"
      "<section-id>": [            // e.g. "3"
        { "topicId": "1", "topicName": "Cell and membrane transport",
          "paper": "1", "score": 0.82 },
        ...
      ],
      ...
    },
    ...
  }
}

And the inverse lookup is also written:
{
  "topics": {
    "<topicId>": ["<book>/<chapter>/<section>", ...]
  }
}

Matching strategy
─────────────────
1. Token-overlap Jaccard similarity between lowercased words.
2. Any pair whose score >= THRESHOLD is recorded.
3. All results per section are sorted by score descending.

Override / manual-edit workflow
────────────────────────────────
Run once, then hand-edit the JSON.  Re-running will not overwrite existing
output unless --force is passed.

Usage
─────
  python3 scripts/generate-section-topic-map.py
  python3 scripts/generate-section-topic-map.py --force
  python3 scripts/generate-section-topic-map.py --subject physics-oup --force
  python3 scripts/generate-section-topic-map.py --threshold 0.15
  python3 scripts/generate-section-topic-map.py --verbose
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────

DATA_ROOT = os.path.join(os.path.dirname(__file__), '..', 'data')

# book-id  ->  past-paper subject folder name
BOOK_TO_SUBJECT = {
    'biology-oup':     'biology',
    'chemistry-aristo': 'chemistry',
    'math-oup':        'math',
    'physics-oup':     'physics',
}

# Words that carry no discriminative weight
STOP_WORDS = {
    'a', 'an', 'the', 'and', 'or', 'of', 'in', 'to', 'for', 'on',
    'with', 'by', 'from', 'at', 'as', 'is', 'are', 'be', 'its', 'their',
    'this', 'that', 'which', 'into', 'between', 'through', 'about',
    'other', 'some', 'more', 'less', 'during', 'using', 'related',
    'i', 'ii', 'iii', 'iv', 'v',
}

DEFAULT_THRESHOLD = 0.12   # lower = cast wider net; raise to tighten


# ── Helpers ───────────────────────────────────────────────────────────────────

def tokenise(text: str) -> set:
    words = re.findall(r'[a-z]+', text.lower())
    return {w for w in words if w not in STOP_WORDS and len(w) > 2}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def read_json(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_json(path: str, data, verbose: bool = False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    if verbose:
        print(f'  wrote {os.path.relpath(path)}')


# ── Core ──────────────────────────────────────────────────────────────────────

def load_past_paper_topics(subject: str) -> list[dict]:
    """Return list of {topicId, topicName, paper} dicts for every unique topic."""
    path = os.path.join(DATA_ROOT, 'past-papers', subject, 'by-topics', 'contents.json')
    if not os.path.exists(path):
        return []
    raw = read_json(path)
    seen = {}
    for entry in raw.get('contents', []):
        tid = str(entry.get('section', '')).strip()
        if not tid or tid in seen:
            continue
        name = (entry.get('en') or {}).get('name', '') or ''
        if not name:
            name = (entry.get('tc') or {}).get('name', '') or ''
        paper = str(entry.get('paper', '')).strip()
        seen[tid] = {'topicId': tid, 'topicName': name.strip(), 'paper': paper}
    return list(seen.values())


def load_textbook_sections(book_id: str) -> dict[str, dict[str, str]]:
    """
    Returns {chapter: {section_id: section_name}}.
    Sections with no name are included with an empty string.
    """
    tb_dir = os.path.join(DATA_ROOT, 'textbooks', book_id)
    if not os.path.isdir(tb_dir):
        return {}
    result: dict[str, dict[str, str]] = {}
    for chapter in sorted(os.listdir(tb_dir)):
        ch_path = os.path.join(tb_dir, chapter)
        if not os.path.isdir(ch_path) or chapter.startswith('.'):
            continue
        cfile = os.path.join(ch_path, 'contents.json')
        if not os.path.exists(cfile):
            continue
        data = read_json(cfile)
        secs: dict[str, str] = {}
        for entry in data.get('contents', []):
            sid = str(entry.get('section', '')).strip()
            if not sid:
                continue
            name = (entry.get('en') or {}).get('name', '') or ''
            if not name:
                name = (entry.get('tc') or {}).get('name', '') or ''
            secs[sid] = name.strip()
        if secs:
            result[chapter] = secs
    return result


def build_mapping(
    book_id: str,
    subject: str,
    threshold: float,
    verbose: bool,
) -> tuple[dict, dict]:
    """
    Returns (forward_map, inverse_map).

    forward_map: {chapter: {section: [{topicId, topicName, paper, score}]}}
    inverse_map: {topicId: ['chapter/section', ...]}
    """
    topics = load_past_paper_topics(subject)
    if not topics:
        print(f'  [skip] no by-topics data for {subject}')
        return {}, {}

    sections_by_chapter = load_textbook_sections(book_id)
    if not sections_by_chapter:
        print(f'  [skip] no textbook data for {book_id}')
        return {}, {}

    # Pre-tokenise topics
    topic_tokens = [(t, tokenise(t['topicName'])) for t in topics]

    forward: dict[str, dict] = {}
    inverse: dict[str, list] = defaultdict(list)

    for chapter, sections in sections_by_chapter.items():
        chapter_map: dict[str, list] = {}
        for sec_id, sec_name in sections.items():
            sec_tokens = tokenise(sec_name)
            matches = []
            for topic, t_tokens in topic_tokens:
                score = jaccard(sec_tokens, t_tokens)
                if score >= threshold:
                    matches.append({
                        'topicId':   topic['topicId'],
                        'topicName': topic['topicName'],
                        'paper':     topic['paper'],
                        'score':     round(score, 4),
                    })
            matches.sort(key=lambda x: x['score'], reverse=True)
            chapter_map[sec_id] = matches
            for m in matches:
                key = f'{chapter}/{sec_id}'
                if key not in inverse[m['topicId']]:
                    inverse[m['topicId']].append(key)

            if verbose and matches:
                print(f'    {chapter}/{sec_id} "{sec_name}"')
                for m in matches[:3]:
                    print(f'      -> {m["topicId"]} "{m["topicName"]}" score={m["score"]}')

        forward[chapter] = chapter_map

    return forward, dict(inverse)


def process_book(
    book_id: str,
    subject: str,
    threshold: float,
    force: bool,
    verbose: bool,
):
    out_dir = os.path.join(DATA_ROOT, 'past-papers', subject)
    out_path = os.path.join(out_dir, 'section-topic-map.json')
    inv_path = os.path.join(out_dir, 'topic-section-map.json')

    if os.path.exists(out_path) and not force:
        print(f'  [skip] {os.path.relpath(out_path)} already exists (use --force to overwrite)')
        return

    print(f'  Building map for {book_id} → {subject} (threshold={threshold}) …')
    fwd, inv = build_mapping(book_id, subject, threshold, verbose)
    if not fwd:
        return

    # Compute summary stats
    total_secs = sum(len(secs) for secs in fwd.values())
    mapped_secs = sum(1 for secs in fwd.values() for matches in secs.values() if matches)
    print(f'    {mapped_secs}/{total_secs} sections matched at least one topic')

    write_json(out_path, fwd, verbose=True)
    write_json(inv_path, {'topics': inv}, verbose=True)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--subject', help='Only process this book ID (e.g. physics-oup)')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD,
                        help=f'Min Jaccard score to include a match (default {DEFAULT_THRESHOLD})')
    parser.add_argument('--force', action='store_true', help='Overwrite existing output files')
    parser.add_argument('--verbose', action='store_true', help='Print per-section match details')
    args = parser.parse_args()

    books = BOOK_TO_SUBJECT
    if args.subject:
        if args.subject not in books:
            print(f'Unknown subject "{args.subject}". Choose from: {", ".join(books)}', file=sys.stderr)
            sys.exit(1)
        books = {args.subject: books[args.subject]}

    for book_id, subject in books.items():
        print(f'\n=== {book_id} ===')
        process_book(book_id, subject, args.threshold, args.force, args.verbose)

    print('\nDone.')


if __name__ == '__main__':
    main()
