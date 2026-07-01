#!/usr/bin/env python3
"""
fix-isolution-urls.py

Fixes resource URLs in contents.json that are missing the /isolution-web/
path segment.

Before:
    https://isolution.oupchina.com.hk/.iSolution/ebook_user_content/...

After:
    https://isolution.oupchina.com.hk/isolution-web/.iSolution/ebook_user_content/...

Usage:
    python3 scripts/fix-isolution-urls.py [path/to/contents.json]
"""

import json
import os
import sys


def fix_url(url):
    """Insert /isolution-web/ after the host for isolution.oupchina.com.hk URLs
    that are missing it."""
    if not isinstance(url, str):
        return url

    prefix = 'https://isolution.oupchina.com.hk/.iSolution/'
    if prefix in url:
        # Already has /isolution-web/ ?
        if '/isolution-web/.iSolution/' in url:
            return url
        return url.replace(
            'https://isolution.oupchina.com.hk/.iSolution/',
            'https://isolution.oupchina.com.hk/isolution-web/.iSolution/'
        )
    return url


def fix_resources(resources):
    """Fix all resource URLs in a resources list."""
    count = 0
    for res in resources:
        old = res.get('url', '')
        new = fix_url(old)
        if new != old:
            res['url'] = new
            count += 1
    return count


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)

    default_path = os.path.join(
        base_dir, 'data', 'biology-oup', '1a', 'contents.json'
    )

    target = sys.argv[1] if len(sys.argv) > 1 else default_path

    if not os.path.exists(target):
        print(f'ERROR: file not found: {target}', file=sys.stderr)
        sys.exit(1)

    with open(target, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total = 0
    for section in data.get('contents', []):
        for lang in ('en', 'tc'):
            resources = section.get(lang, {}).get('resources', [])
            n = fix_resources(resources)
            if n:
                print(f'  section {section["section"]} {lang}: fixed {n} URLs')
            total += n

    with open(target, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    print(f'\nDone. Fixed {total} URLs in {target}')


if __name__ == '__main__':
    main()
