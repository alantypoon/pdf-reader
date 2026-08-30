#!/usr/bin/env python3
"""
convert-contents-to-tn.py — Move <subject>/<book>/<lang>/contents → contents.tn.

Moves every ``{en,tc,zh}/contents`` folder under chemistry-aristo and
physics-oup (configurable) to a sibling ``contents.tn`` folder, so Teacher
views serve that content (Student views are left without data).

MOVE semantics:
- If contents.tn does not exist, the whole contents folder is simply renamed.
- If contents.tn already exists (e.g. from a previous copy run), files are
  moved one by one.  When the target already holds an identical-size file, the
  source is removed as a duplicate.  Otherwise the source is left in place
  (never clobbered) unless ``--force`` is given.
- Empty leftover directories under contents are removed afterwards, including
  the contents folder itself once it is empty.

Usage:
  python convert-contents-to-tn.py                       # all default subjects
  python convert-contents-to-tn.py --dry-run             # list planned actions only
  python convert-contents-to-tn.py chemistry-aristo      # one subject
  python convert-contents-to-tn.py chemistry-aristo/1a   # one book
  python convert-contents-to-tn.py chemistry-aristo 1b --force
"""

import argparse
import os
import shutil
import sys

DEFAULT_SUBJECTS = ['chemistry-aristo', 'physics-oup']
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTBOOKS_DIR = os.path.join(BASE_DIR, 'data', 'textbooks')

# Language folders that are moved (anything else under a book is skipped).
LANG_DIRS = ('en', 'tc', 'zh')


def parse_targets(args):
    """Return list of (subject, book) tuples; book may be None = all books."""
    targets = []
    for arg in args:
        parts = arg.split('/')
        subject = parts[0]
        book = parts[1] if len(parts) > 1 else None
        targets.append((subject, book))
    if not targets:
        targets = [(subject, None) for subject in DEFAULT_SUBJECTS]
    return targets


def count_files(directory):
    return sum(len(files) for _root, _dirs, files in os.walk(directory))


def remove_empty_dirs_under(root):
    """Remove empty directories below (and including) root, bottom-up."""
    removed = 0
    for dirpath, dirnames, _files in os.walk(root, topdown=False):
        try:
            os.rmdir(dirpath)
            removed += 1
        except OSError:
            pass  # not empty or already gone
    return removed


def move_contents_to_tn(subject, book=None, dry_run=False, force=False):
    """Move contents → contents.tn for one subject (optionally one book)."""
    subject_dir = os.path.join(TEXTBOOKS_DIR, subject)
    if not os.path.isdir(subject_dir):
        print(f'ERROR: subject directory not found: {subject_dir}', file=sys.stderr)
        return 0, 0, 0, 1

    books = [book] if book else sorted(os.listdir(subject_dir))
    total_moved = 0
    total_deduped = 0
    total_skipped = 0
    total_errors = 0

    for book_id in books:
        book_dir = os.path.join(subject_dir, book_id)
        if not os.path.isdir(book_dir) or book_id.startswith('.'):
            continue

        for lang in LANG_DIRS:
            contents_dir = os.path.join(book_dir, lang, 'contents')
            if not os.path.isdir(contents_dir):
                continue
            tn_dir = os.path.join(book_dir, lang, 'contents.tn')

            if not os.path.exists(tn_dir):
                # Fast path: nothing to merge into — rename the whole folder.
                nfiles = count_files(contents_dir)
                if dry_run:
                    print(f'  [rename] {contents_dir} → {tn_dir}  ({nfiles} file(s))')
                else:
                    try:
                        os.rename(contents_dir, tn_dir)
                        print(f'  [rename] {contents_dir} → {tn_dir}  ({nfiles} file(s))')
                    except OSError as exc:
                        print(f'  [error] rename {contents_dir}: {exc}', file=sys.stderr)
                        total_errors += 1
                        continue
                total_moved += nfiles
                continue

            # Merge path: move file by file, then prune empty dirs.
            for root, _dirs, files in os.walk(contents_dir):
                rel_root = os.path.relpath(root, contents_dir)
                target_root = tn_dir if rel_root == '.' else os.path.join(tn_dir, rel_root)

                for fname in sorted(files):
                    src = os.path.join(root, fname)
                    dst = os.path.join(target_root, fname)

                    if os.path.exists(dst):
                        if force:
                            if dry_run:
                                print(f'  [move:overwrite] {src} → {dst}')
                            else:
                                try:
                                    shutil.move(src, dst)
                                except OSError as exc:
                                    print(f'  [error] {src}: {exc}', file=sys.stderr)
                                    total_errors += 1
                                    continue
                            total_moved += 1
                        else:
                            # Target exists — only drop the source when it is a
                            # same-size duplicate (previous copy run); otherwise
                            # keep both to avoid data loss.
                            try:
                                same_size = os.path.getsize(src) == os.path.getsize(dst)
                            except OSError:
                                same_size = False
                            if same_size:
                                if dry_run:
                                    print(f'  [dedupe] remove {src} (identical size as target)')
                                else:
                                    try:
                                        os.remove(src)
                                        print(f'  [dedupe] removed {src}')
                                    except OSError as exc:
                                        print(f'  [error] {src}: {exc}', file=sys.stderr)
                                        total_errors += 1
                                        continue
                                total_deduped += 1
                            else:
                                total_skipped += 1
                                print(f'  [skip] {src} → {dst} exists with different size')
                        continue

                    if dry_run:
                        print(f'  [move] {src} → {dst}')
                    else:
                        try:
                            os.makedirs(target_root, exist_ok=True)
                            shutil.move(src, dst)
                        except OSError as exc:
                            print(f'  [error] {src}: {exc}', file=sys.stderr)
                            total_errors += 1
                            continue
                    total_moved += 1

            # Prune now-empty directories left behind by the merge move.
            if not dry_run and os.path.isdir(contents_dir):
                remove_empty_dirs_under(contents_dir)

    return total_moved, total_deduped, total_skipped, total_errors


def main():
    parser = argparse.ArgumentParser(
        description='Move contents folders to contents.tn for teacher views.'
    )
    parser.add_argument(
        'targets', nargs='*', default=None,
        help='Subject or subject/book to move (default: %s)' % ', '.join(DEFAULT_SUBJECTS),
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='List planned actions without changing anything',
    )
    parser.add_argument(
        '-f', '--force', action='store_true',
        help='Overwrite target files that already exist in contents.tn',
    )
    args = parser.parse_args()

    targets = parse_targets(args.targets)
    target_labels = ['%s/%s' % (s, b if b else '*') for s, b in targets]
    print(f'Base dir   : {TEXTBOOKS_DIR}')
    print(f'Targets    : {", ".join(target_labels)}')
    print(f'Dry-run    : {args.dry_run}')
    print(f'Force      : {args.force}')
    print('=' * 60)

    grand_moved = 0
    grand_deduped = 0
    grand_skipped = 0
    grand_errors = 0

    for subject, book in targets:
        print(f'\nSubject: {subject}' + (f'  (book {book})' if book else '  (all books)'))
        moved, deduped, skipped, errors = move_contents_to_tn(
            subject, book=book, dry_run=args.dry_run, force=args.force,
        )
        grand_moved += moved
        grand_deduped += deduped
        grand_skipped += skipped
        grand_errors += errors

    print('\n' + '=' * 60)
    print(
        f'Done.  {grand_moved} moved  |  {grand_deduped} duplicates removed  |  '
        f'{grand_skipped} skipped (different-size conflict)  |  {grand_errors} error(s)'
    )
    if args.dry_run:
        print('(Dry run — nothing was changed)')

    sys.exit(1 if grand_errors else 0)


if __name__ == '__main__':
    main()
