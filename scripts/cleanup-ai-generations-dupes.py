#!/usr/bin/env python3
"""
Clean up duplicate documents in the ai-generations MongoDB collection.

For each (subjectId, bookId, sectionId, pageId) tuple, keep only the
most recently updated document and remove all older duplicates.

Usage:
    python3 scripts/cleanup-ai-generations-dupes.py           # dry-run (show what would be removed)
    python3 scripts/cleanup-ai-generations-dupes.py --execute  # actually remove duplicates
"""

import sys
import os
from pymongo import MongoClient

# ── MongoDB connection ──────────────────────────────────────
MONGO_URI = os.environ.get(
    "MONGODB_URI",
    "mongodb://root:Generic0626Skills@127.0.0.1:2700/?authSource=admin",
)
DB_NAME = "dse_reader"
COLL_NAME = "ai-generations"

# ── Main ────────────────────────────────────────────────────

def main():
    dry_run = "--execute" not in sys.argv
    mode = "DRY RUN" if dry_run else "EXECUTE"
    print(f"=== ai-generations dedup ({mode}) ===")

    client = MongoClient(MONGO_URI)
    db = client[DB_NAME]
    coll = db[COLL_NAME]

    # Find all groups with >1 document for the same identity
    pipeline = [
        {
            "$group": {
                "_id": {
                    "subjectId": "$subjectId",
                    "bookId": "$bookId",
                    "sectionId": "$sectionId",
                    "pageId": "$pageId",
                },
                "count": {"$sum": 1},
                "docs": {
                    "$push": {
                        "_id": "$_id",
                        "updatedAt": "$updatedAt",
                        "createdAt": "$createdAt",
                    }
                },
            }
        },
        {"$match": {"count": {"$gt": 1}}},
        {"$sort": {"count": -1}},
    ]

    dup_groups = list(coll.aggregate(pipeline))

    if not dup_groups:
        print("No duplicate groups found. Collection is clean.")
        return

    total_removed = 0
    for group in dup_groups:
        identity = group["_id"]
        docs = group["docs"]

        # Sort by updatedAt descending, then by _id (ObjectId is monotonic)
        # Keep the newest, remove the rest
        docs_sorted = sorted(
            docs,
            key=lambda d: (
                d.get("updatedAt") or d.get("createdAt") or "",
                str(d["_id"]),
            ),
            reverse=True,
        )

        keep = docs_sorted[0]
        remove = docs_sorted[1:]
        total_removed += len(remove)

        print(
            f"\n  {identity['subjectId']}/{identity['bookId']}/"
            f"s{identity['sectionId']}/p{identity['pageId']}: "
            f"{len(docs)} docs → keeping {keep['_id']} "
            f"(updatedAt={keep.get('updatedAt', 'N/A')})"
        )
        for r in remove:
            print(f"    REMOVE {r['_id']} (updatedAt={r.get('updatedAt', 'N/A')})")

        if not dry_run:
            remove_ids = [r["_id"] for r in remove]
            result = coll.delete_many({"_id": {"$in": remove_ids}})
            print(f"    → deleted {result.deleted_count}")

    print(f"\n=== {'Would remove' if dry_run else 'Removed'} {total_removed} duplicate documents ===")
    if dry_run:
        print("Run with --execute to actually delete duplicates.")


if __name__ == "__main__":
    main()
