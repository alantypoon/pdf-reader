#!/bin/bash
#
# copy-TN-files-from-all-to-data-orig.sh
#
# Copy _TN (teacher's notes) PDF files from ./all/ to ./data-orig/,
# parsing the filename to extract bookId and sectionId.
# Language is detected from the source path (all/en/ -> en, all/tc/ -> tc).
# Legacy files directly under all/ default to en.
#
# Source patterns:
#   all/en/DSEPHY_TE_1_TN/DSEPHY_TE_101_TN.pdf    -> data-orig/1/en/contents/1.pdf
#   all/tc/DSEPHY_TE_1_TN/DSEPHY_TE_101_TN.pdf    -> data-orig/1/tc/contents/1.pdf
#   all/en/DSEPHY_TE_E1_TN/DSEPHY_TE_E101_TN.pdf   -> data-orig/e1/en/contents/1.pdf
#   all/en/DSEPHY_TE_1_TN/DSEPHY_TE_1_end_TN.pdf   -> data-orig/1/en/contents/end.pdf
#   all/en/DSEPHY_TE_E101_TN.pdf                   -> data-orig/e1/en/contents/1.pdf
#
# Usage:
#   ./copy-TN-files-from-all-to-data-orig.sh [-f]
#
#   -f    Force overwrite of existing target files (default: skip existing)

set -euo pipefail
shopt -s extglob

FORCE=false
while getopts "f" opt; do
    case "$opt" in
        f) FORCE=true ;;
        *) echo "Usage: $0 [-f]" >&2; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/all"
TGT_DIR="$SCRIPT_DIR/data-orig"

# Known book IDs — longest first so "3A" matches before "3", "E1" before "E".
BOOK_IDS=("3A" "3B" "E1" "E2" "E3" "E4" "1" "2" "4" "5")

echo "=== Copying _TN PDF files from all/ to data-orig/ ==="
if $FORCE; then
    echo "  (force overwrite enabled)"
else
    echo "  (skipping existing files; use -f to force overwrite)"
fi
echo ""

copied=0
skipped=0

# Find all _TN.pdf and _TN_ce.pdf files recursively under all/
find "$SRC_DIR" \( -name "*_TN.pdf" -o -name "*_TN_ce.pdf" \) -type f -print0 | while IFS= read -r -d '' src_file; do
    fname=$(basename "$src_file")

    # Detect language from source path: first component relative to all/
    rel="${src_file#$SRC_DIR/}"
    lang="${rel%%/*}"
    if [[ "$lang" != "en" && "$lang" != "tc" ]]; then
        lang="en"  # default for legacy files directly under all/
    fi

    # Strip "DSEPHY_TE_" prefix and "_TN.pdf" / "_TN_ce.pdf" suffix to isolate the code
    code="${fname#DSEPHY_TE_}"
    code="${code%_TN_ce.pdf}"
    code="${code%_TN.pdf}"

    # Parse bookId and sectionId
    book_id=""
    section_id=""

    for bid in "${BOOK_IDS[@]}"; do
        if [[ "$code" == "$bid"* ]]; then
            book_id="$bid"
            section_id="${code#$bid}"
            break
        fi
    done

    if [[ -z "$book_id" ]]; then
        echo "WARNING: Could not parse bookId from: $fname (code=$code) — skipping"
        ((skipped++)) || true
        continue
    fi

    # Strip leading underscore from section_id (e.g. "_end" -> "end")
    section_id="${section_id#_}"
    # Strip leading zeros (e.g. "01" -> "1", "10" -> "10"; "end" unaffected)
    section_id="${section_id##+(0)}"
    [[ -z "$section_id" ]] && section_id="0"

    if [[ -z "$section_id" ]]; then
        echo "WARNING: Empty sectionId from: $fname (code=$code, bookId=$book_id) — skipping"
        ((skipped++)) || true
        continue
    fi

    # Convert bookId to lowercase for target path
    book_id_lower=$(echo "$book_id" | tr '[:upper:]' '[:lower:]')

    # Build target path: data-orig/<bookId>/<lang>/contents/<sectionId>.pdf
    tgt_path="$TGT_DIR/$book_id_lower/$lang/contents/${section_id}.pdf"

    # Create target directory if needed
    mkdir -p "$(dirname "$tgt_path")"

    # Skip if target exists and not forcing overwrite
    if [[ -f "$tgt_path" ]] && ! $FORCE; then
        echo "  SKIP: $fname (target exists: data-orig/$book_id_lower/$lang/contents/${section_id}.pdf)"
        ((skipped++)) || true
        continue
    fi

    # Copy the file
    cp "$src_file" "$tgt_path"
    echo "  $fname  ->  data-orig/$book_id_lower/$lang/contents/${section_id}.pdf"
    ((copied++)) || true
done

echo ""
echo "Done.  Copied: $copied, Skipped: $skipped"
