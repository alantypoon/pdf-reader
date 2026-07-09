#!/bin/bash
#
# remove-watermark.sh — Remove watermarks from OUP textbook PDFs.
#
# Each PDF is first unlocked (restrictions removed via Ghostscript),
# then watermarks are stripped.  Output files keep the same relative
# path under the target directory.
#
# Usage:
#   ./remove-watermark.sh <src> <dst> [--unlock-only] [--watermark template.pdf]
#
#     <src>          source file or directory
#     <dst>          target directory  (must exist or be creatable)
#     --unlock-only  only unlock (remove restrictions), skip watermark removal
#     --watermark    path to watermark template PDF (e.g. watermark.pdf)
#
# Examples:
#   ./remove-watermark.sh data-orig/e1/en/1.pdf data-target/
#   ./remove-watermark.sh data-orig data-target --watermark watermark.pdf
#   ./remove-watermark.sh data-orig data-target --unlock-only
#
# Requirements: Python 3 (pikepdf auto-installs into local .venv)
#               Ghostscript (gs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Arguments ───────────────────────────────────────────────────────────────
UNLOCK_ONLY=false
WATERMARK_TEMPLATE=""

# Parse flags (can appear anywhere)
POSARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --unlock-only)
            UNLOCK_ONLY=true
            shift
            ;;
        --watermark)
            if [[ $# -lt 2 ]]; then
                echo "ERROR: --watermark requires a path" >&2
                exit 1
            fi
            WATERMARK_TEMPLATE="$2"
            shift 2
            ;;
        *)
            POSARGS+=("$1")
            shift
            ;;
    esac
done

if [ ${#POSARGS[@]} -lt 2 ]; then
    echo "Usage: $0 <src> <dst> [--unlock-only] [--watermark template.pdf]" >&2
    echo "  src  — PDF file or directory of PDFs" >&2
    echo "  dst  — target directory for output PDFs" >&2
    echo "  --unlock-only   only unlock, skip watermark removal" >&2
    echo "  --watermark     path to watermark template PDF" >&2
    exit 1
fi

SRC_DIR="${POSARGS[0]}"
DST_DIR="${POSARGS[1]}"
INPUT="$SRC_DIR"

# ── Ensure Python venv with pikepdf (skip for unlock-only) ──────────────────
VENV_DIR="${SCRIPT_DIR}/.venv"
PYTHON="${VENV_DIR}/bin/python3"

if ! $UNLOCK_ONLY; then
    setup_venv() {
        if [ ! -f "$PYTHON" ]; then
            echo "Setting up Python venv (one-time)…"
            python3 -m venv "$VENV_DIR"
            "$VENV_DIR/bin/pip" install --quiet pikepdf
            echo "venv ready."
        fi
        if ! "$PYTHON" -c "import pikepdf" 2>/dev/null; then
            echo "Installing pikepdf…"
            "$VENV_DIR/bin/pip" install --quiet pikepdf
        fi
    }

    setup_venv

    # ── Python script path ──────────────────────────────────────────────────
    PY_SCRIPT="${SCRIPT_DIR}/tools/remove_watermark.py"

    if [ ! -f "$PY_SCRIPT" ]; then
        echo "ERROR: Python script not found: $PY_SCRIPT"
        exit 1
    fi
fi

# ── Ensure target directory exists ──────────────────────────────────────────
mkdir -p "$DST_DIR"

# ── Process a single PDF ────────────────────────────────────────────────────
process_pdf() {
    local src_pdf="$1"

    # Determine the output path: mirror directory structure under DST_DIR
    local rel_path="${src_pdf#$SRC_DIR/}"
    # Fallback: if SRC_DIR not a prefix, just use basename
    if [[ "$rel_path" == "$src_pdf" ]]; then
        rel_path="$(basename "$src_pdf")"
    fi

    local dst_pdf="${DST_DIR}/${rel_path}"
    local dst_dir
    dst_dir="$(dirname "$dst_pdf")"
    mkdir -p "$dst_dir"

    echo "Processing: $src_pdf"

    # ── Step 1: Unlock (remove restrictions) ────────────────────────────────
    echo "  [1/2] Unlocking…"
    if ! gs -q -dNOPAUSE -dBATCH -dQUIET -sDEVICE=pdfwrite -sOutputFile="$dst_pdf" "$src_pdf" 2>/dev/null; then
        echo "  ERROR: Failed to unlock $src_pdf" >&2
        return 1
    fi

    if $UNLOCK_ONLY; then
        echo "  → $dst_pdf"
        return
    fi

    # ── Step 2: Remove watermark ────────────────────────────────────────────
    echo "  [2/2] Removing watermark…"
    local unlocked="/tmp/wm_unlocked_$$.pdf"
    # Move the just-unlocked file to a temp location for watermark removal
    mv "$dst_pdf" "$unlocked"

    local wm_arg=()
    if [ -n "${WATERMARK_TEMPLATE:-}" ]; then
        wm_arg=(--watermark "$WATERMARK_TEMPLATE")
    fi

    if [ ${#wm_arg[@]} -gt 0 ]; then
        "$PYTHON" "$PY_SCRIPT" "$unlocked" "$dst_pdf" "${wm_arg[@]}"
    else
        "$PYTHON" "$PY_SCRIPT" "$unlocked" "$dst_pdf"
    fi
    local ret=$?

    if [ $ret -eq 0 ]; then
        echo "  → $dst_pdf"
    else
        # No watermarks found — keep the unlocked file as-is
        echo "  (no watermarks found, keeping unlocked file)"
        mv "$unlocked" "$dst_pdf"
        echo "  → $dst_pdf"
    fi
    rm -f "$unlocked"
}

# ── Main dispatch ───────────────────────────────────────────────────────────
if [ -f "$INPUT" ]; then
    process_pdf "$INPUT"
elif [ -d "$INPUT" ]; then
    echo "Searching for PDFs in: $INPUT"
    while IFS= read -r -d '' pdf; do
        process_pdf "$pdf" || true
    done < <(find "$INPUT" -type f -name '*.pdf' -print0)
    echo "All done."
else
    echo "ERROR: $INPUT is neither a file nor a directory"
    exit 1
fi
