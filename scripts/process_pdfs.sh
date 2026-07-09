#!/bin/bash

# Script to find all PDFs in subfolders and process them:
# Step 1: Unlock (remove restrictions)
# Step 2: Clean (keep text, remove images)
#
# Usage: ./process_pdfs.sh [directory]
# Default directory is the current directory.

set -euo pipefail

SEARCH_DIR="${1:-.}"

echo "Searching for PDF files in: $SEARCH_DIR"

# Use process substitution to avoid subshell issues with set -e
while IFS= read -r -d '' pdf; do
    echo "============================================="
    echo "Processing: $pdf"

    dir="$(dirname "$pdf")"
    base="$(basename "$pdf" .pdf)"

    unlocked="${dir}/${base}_unlocked.pdf"
    cleaned="${dir}/${base}_cleaned.pdf"

    # Step 1: Unlock the PDF
    echo "  [1/2] Unlocking..."
    if gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile="$unlocked" "$pdf"; then
        echo "  -> Created: $unlocked"
    else
        echo "  ERROR: Failed to unlock $pdf" >&2
        continue
    fi

    # Step 2: Clean the unlocked PDF (remove images, keep text)
    echo "  [2/2] Cleaning (removing images)..."
    if gs -o "$cleaned" -sDEVICE=pdfwrite -dFILTERIMAGE -dFILTERTEXT=false "$unlocked"; then
        echo "  -> Created: $cleaned"
    else
        echo "  ERROR: Failed to clean $unlocked" >&2
        continue
    fi

    # Optional: remove intermediate unlocked file
    rm -f "$unlocked"
    echo "  Done. Final output: $cleaned"

done < <(find "$SEARCH_DIR" -type f -name '*.pdf' -print0)

echo "============================================="
echo "All done."
