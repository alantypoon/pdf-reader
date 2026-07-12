#!/usr/bin/env python3
"""
migrate-physics-oup-ai-generations.py

Migrate AI generation documents from the old continuous-page-numbering
collection (ai-generations-20260712) to the current section-based
collection (ai-generations).

Old schema:  { subjectId, bookId, sectionId=1, pageId }  — pageId runs
             continuously across the entire book (no real sections).

New schema:  { subjectId, bookId, sectionId, pageId }    — pageId is
             relative to the section (1-based within each section).

Usage:
  python migrate-physics-oup-ai-generations.py              # migrate all
  python migrate-physics-oup-ai-generations.py --dry-run    # show matches only
  python migrate-physics-oup-ai-generations.py --force      # overwrite existing
"""

import os
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / '.env'

# ── Load .env ──────────────────────────────────────────────
if ENV_FILE.exists():
    with open(ENV_FILE, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key == 'MONGODB_URI' and value:
                    os.environ['MONGODB_URI'] = value

MONGO_URI = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017/pdf-reader')
OLD_COLLECTION = 'ai-generations-20260712'
NEW_COLLECTION = 'ai-generations'
SUBJECT_ID = 'physics-oup'

# ── Section definitions for each book ──────────────────────
# Format: list of (sectionId, pageCount)
# Pages are numbered continuously (excluding cover & end) in the old
# collection.  Cover and end pages were NOT in the old version.
#
# Cumulative mapping: old page N falls in the section whose cumulative
# range contains N, and the new page within that section is
# N - section_start + 1.

# Cover page (+1 on first section) is INCLUDED — old page 1 → new section page 1.
# End pages are NOT included (old version didn't have them).

BOOK_SECTIONS = {
    '1': [
        ('1', 19),   # 1 cover + 18 content
        ('2', 40),
        ('3', 32),
        ('4', 46),
        ('5', 55),
    ],
    '2': [
        ('1', 35),   # 1 cover + 34 content
        ('2', 58),
        ('3', 60),
        ('4', 42),
        ('5', 34),
        ('6', 48),
        ('7', 52),
        ('8', 40),
        ('9', 44),
        ('10', 38),
    ],
    '3a': [
        ('1', 35),   # 1 cover + 34 content
        ('2', 44),
        ('3', 54),
    ],
    '3b': [
        ('4', 37),   # 1 cover + 36 content
        ('5', 64),
        ('6', 52),
        ('7', 46),
    ],
    '4': [
        ('1', 55),   # 1 cover + 54 content
        ('2', 56),
        ('3', 34),
        ('4', 40),
        ('5', 36),
        ('6', 46),
        ('7', 54),
        ('8', 28),
    ],
    '5': [
        ('1', 43),   # 1 cover + 42 content
        ('2', 48),
        ('3', 30),
    ],
    'e1': [
        ('1', 45),   # 1 cover + 44 content
        ('2', 50),
        ('3', 62),
    ],
    'e2': [
        ('1', 41),   # 1 cover + 40 content
        ('2', 54),
        ('3', 40),
    ],
    'e3': [
        ('1', 45),   # 1 cover + 44 content
        ('2', 40),
        ('3', 46),
        ('4', 56),
    ],
    'e4': [
        ('1', 59),   # 1 cover + 58 content
        ('2', 56),
        ('3', 64),
    ],
}


def build_cumulative_map(book_id):
    """Return a list of (old_page_start, old_page_end, section_id) tuples."""
    sections = BOOK_SECTIONS.get(book_id)
    if not sections:
        return []
    result = []
    offset = 1
    for sec_id, count in sections:
        result.append((offset, offset + count - 1, sec_id))
        offset += count
    return result


def map_old_to_new(book_id, old_page):
    """Map an old continuous page number to (new_section_id, new_page_id).
    Returns (None, None) if the page falls outside all known sections.
    """
    for start, end, sec_id in build_cumulative_map(str(book_id)):
        if start <= old_page <= end:
            return sec_id, old_page - start + 1
    return None, None


def build_new_identity(subject_id, book_id, section_id, page_id):
    """Build the MongoDB identity used by the current ai-generations collection."""
    try:
        sec = int(section_id)
    except (ValueError, TypeError):
        sec = float(section_id)
    return {
        'subjectId': str(subject_id),
        'bookId': str(book_id),
        'sectionId': sec,
        'pageId': int(page_id),
    }


def main():
    parser = argparse.ArgumentParser(
        description='Migrate physics-oup AI generations from old continuous-page '
                    'collection to new section-based collection.'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Show matched documents without writing to the new collection',
    )
    parser.add_argument(
        '--force', action='store_true',
        help='Overwrite existing documents in the new collection',
    )
    args = parser.parse_args()

    # ── Connect ────────────────────────────────────────────
    import pymongo
    client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
    client.admin.command('ping')
    db = client['pdf-reader']
    old_coll = db[OLD_COLLECTION]
    new_coll = db[NEW_COLLECTION]
    print(f'[mongo] connected to {MONGO_URI.replace("//", "//<credentials>@")}')

    # ── Read old documents ─────────────────────────────────
    old_docs = list(old_coll.find({'subjectId': SUBJECT_ID}))
    print(f'[old]   {len(old_docs)} documents in {OLD_COLLECTION}')

    if not old_docs:
        print('No documents to migrate.')
        return

    # ── Match & migrate ────────────────────────────────────
    matched = 0
    skipped_no_match = 0
    skipped_exists = 0
    migrated = 0
    errors = 0

    for doc in old_docs:
        book_id = str(doc.get('bookId', ''))
        old_page = doc.get('pageId', 0)

        # The old collection used sectionId === bookId (flat, no real sections).
        # We ignore the old sectionId and map purely by bookId + old continuous pageId.

        new_section, new_page = map_old_to_new(book_id, old_page)

        if new_section is None:
            skipped_no_match += 1
            continue

        new_identity = build_new_identity(SUBJECT_ID, book_id, new_section, new_page)
        label = f'{SUBJECT_ID}/{book_id}/{new_section}/{new_page}  (old: page {old_page})'

        if args.dry_run:
            print(f'  [MATCH] {label}')
            matched += 1
            continue

        # Check if already exists in new collection
        existing = new_coll.find_one(new_identity)
        if existing and not args.force:
            skipped_exists += 1
            print(f'  [SKIP]  {label} — already exists in {NEW_COLLECTION}')
            continue

        # ── Copy document fields ───────────────────────────
        now = datetime.now(timezone.utc).isoformat()
        new_doc = {
            **new_identity,
            'en': doc.get('en'),
            'zh': doc.get('zh'),
            'enUpdatedAt': doc.get('enUpdatedAt') or doc.get('updatedAt') or now,
            'zhUpdatedAt': doc.get('zhUpdatedAt') or doc.get('updatedAt') or now,
            'updatedAt': now,
            'alignmentVersion': doc.get('alignmentVersion', 1),
            'user': str(doc.get('user', 'migration')),
            'createdAt': doc.get('createdAt') or now,
            '_migratedFrom': str(doc['_id']),
        }

        try:
            # Remove any existing doc with the same identity before inserting
            new_coll.delete_many(new_identity)
            new_coll.insert_one(new_doc)
            migrated += 1
            print(f'  [OK]    {label}')
        except Exception as exc:
            errors += 1
            print(f'  [ERROR] {label} — {exc}')

    # ── Summary ────────────────────────────────────────────
    print()
    print('=' * 60)
    if args.dry_run:
        print(f'DRY RUN — no documents were written.')
    print(f'  Total old docs    : {len(old_docs)}')
    print(f'  Matched           : {matched}')
    print(f'  No match (skipped): {skipped_no_match}')
    print(f'  Already exists    : {skipped_exists}')
    print(f'  Migrated          : {migrated}')
    print(f'  Errors            : {errors}')


if __name__ == '__main__':
    main()
