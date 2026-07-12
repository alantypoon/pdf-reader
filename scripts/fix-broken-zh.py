#!/usr/bin/env python3
"""
Find ai-generations documents where the zh field contains an error
(upstream provider HTTP 400, typically from max_tokens overflow),
and optionally clean them so they regenerate.
"""

import json
import sys
from pymongo import MongoClient

MONGO_URI = 'mongodb://root:Generic0626Skills@127.0.0.1:2700/?authSource=admin'
DB_NAME = 'pdf-reader'
COLLECTION = 'ai-generations'

def main():
    client = MongoClient(MONGO_URI)
    db = client[DB_NAME]
    col = db[COLLECTION]

    # Find documents where zh.error exists (indicates a failed generation)
    broken = list(col.find(
        {'zh.error': {'$exists': True}},
        {'subjectId': 1, 'bookId': 1, 'sectionId': 1, 'pageId': 1,
         'zh.error': 1, 'zh.details': 1, 'zh.upstream_status': 1,
         'en': 1, 'updatedAt': 1}
    ))

    # Also find documents where zh is an object that looks like an error envelope
    # (has 'success', 'provider', 'error' keys — typical gateway error response)
    broken2 = list(col.find({
        '$and': [
            {'zh.success': {'$exists': True}},
            {'zh.error': {'$exists': True}},
            {'zh.provider': {'$exists': True}},
        ]
    }, {'subjectId': 1, 'bookId': 1, 'sectionId': 1, 'pageId': 1,
        'zh.error': 1, 'zh.details': 1, 'zh.upstream_status': 1,
        'en': 1, 'updatedAt': 1}))

    # Merge both sets, deduplicate by _id
    all_broken = {}
    for doc in broken + broken2:
        all_broken[str(doc['_id'])] = doc

    if not all_broken:
        print('✓ No broken zh documents found.')
        client.close()
        return

    print(f'Found {len(all_broken)} document(s) with broken zh field:\n')
    for i, doc in enumerate(all_broken.values(), 1):
        sid = doc.get('subjectId', '?')
        bid = doc.get('bookId', '?')
        sec = doc.get('sectionId', '?')
        pid = doc.get('pageId', '?')
        zh = doc.get('zh', {})
        error = zh.get('error', '?') if isinstance(zh, dict) else str(zh)[:200]
        has_en = bool(doc.get('en'))
        print(f'{i:3d}. subject={sid} book={bid} section={sec} page={pid}')
        print(f'     zh error: {error}')
        print(f'     has en:   {has_en}')
        en_status = 'OK' if has_en else 'MISSING'
        print(f'     zh status: BROKEN | en status: {en_status}')
        print()

    print('─' * 60)
    print('Options:')
    print('  1. Delete entire documents → full regeneration on next visit')
    print('  2. Clear only zh field → en content kept, zh regenerates on force-regenerate')
    print('  3. Do nothing (report only)')
    print('  q. Quit')
    choice = input('\nChoose (1/2/3/q): ').strip().lower()

    ids = [doc['_id'] for doc in all_broken.values()]

    if choice == '1':
        result = col.delete_many({'_id': {'$in': ids}})
        print(f'\n✓ Deleted {result.deleted_count} document(s). They will regenerate on next visit.')
    elif choice == '2':
        result = col.update_many(
            {'_id': {'$in': ids}},
            {'$unset': {'zh': '', 'zhUpdatedAt': ''}}
        )
        # Also update updatedAt to trigger re-check
        from datetime import datetime, timezone, timedelta
        now = datetime.now(timezone(timedelta(hours=8))).isoformat()
        col.update_many(
            {'_id': {'$in': ids}},
            {'$set': {'updatedAt': now}}
        )
        print(f'\n✓ Cleared zh field on {result.modified_count} document(s).')
        print('  en content preserved. Use force-regenerate to recreate zh.')
    elif choice == '3' or choice == 'q':
        print('\nNo changes made.')
    else:
        print(f'\nUnknown option: {choice}')

    client.close()

if __name__ == '__main__':
    main()
