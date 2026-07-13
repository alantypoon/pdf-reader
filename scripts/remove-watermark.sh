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
    PY_SCRIPT="${SCRIPT_DIR}/remove_watermark.py"

    if [ ! -f "$PY_SCRIPT" ]; then
        echo "ERROR: Python script not found: $PY_SCRIPT"
        exit 1
    fi
fi

# ── Ensure target directory exists ──────────────────────────────────────────
if [ -f "$INPUT" ] && [[ "$DST_DIR" == *.pdf ]]; then
    # SRC is a single file and DST looks like a PDF path — treat DST as output file
    mkdir -p "$(dirname "$DST_DIR")"
elif [ ! -f "$DST_DIR" ]; then
    mkdir -p "$DST_DIR"
fi

# ── Process a single PDF ────────────────────────────────────────────────────
process_pdf() {
    local src_pdf="$1"
    local dst_pdf

    # If DST_DIR looks like a PDF file path (not an existing directory), use it directly
    if [[ "$DST_DIR" == *.pdf ]] && [ ! -d "$DST_DIR" ]; then
        dst_pdf="$DST_DIR"
    else
        # Determine the output path: mirror directory structure under DST_DIR
        local rel_path="${src_pdf#$SRC_DIR/}"
        # Fallback: if SRC_DIR not a prefix, just use basename
        if [[ "$rel_path" == "$src_pdf" ]]; then
            rel_path="$(basename "$src_pdf")"
        fi
        dst_pdf="${DST_DIR}/${rel_path}"
    fi

    local dst_dir
    dst_dir="$(dirname "$dst_pdf")"
    # Remove any existing regular file at dst_dir so mkdir -p doesn't fail
    [ -f "$dst_dir" ] && rm -f "$dst_dir"
    mkdir -p "$dst_dir"

    # Remove existing output file before writing
    [ -f "$dst_pdf" ] && rm -f "$dst_pdf"

    echo "Processing: $src_pdf"

    local work_pdf="$src_pdf"   # PDF to pass to Ghostscript unlock
    local wm_tmp=""             # temp file from watermark removal (clean up at end)

    if ! $UNLOCK_ONLY; then
        # ── Step 1: Remove watermark from the ORIGINAL PDF ──────────────────
        # Watermark markers (e.g. /Artifact <</Subtype /Watermark) are
        # stripped by Ghostscript, so we must process BEFORE unlocking.
        echo "  [1/2] Removing watermark…"
        wm_tmp="/tmp/wm_output_$$.pdf"

        local wm_arg=()
        if [ -n "${WATERMARK_TEMPLATE:-}" ]; then
            wm_arg=(--watermark "$WATERMARK_TEMPLATE")
        fi

        local wm_ret=0
        if [ ${#wm_arg[@]} -gt 0 ]; then
            "$PYTHON" "$PY_SCRIPT" "$src_pdf" "$wm_tmp" "${wm_arg[@]}" || wm_ret=$?
        else
            "$PYTHON" "$PY_SCRIPT" "$src_pdf" "$wm_tmp" || wm_ret=$?
        fi

        if [ $wm_ret -eq 0 ]; then
            echo "  Watermark removed successfully."
            work_pdf="$wm_tmp"
        elif [ $wm_ret -eq 2 ]; then
            echo -e "\033[1;31m  FATAL: Some pages could not be cleaned! Aborting.\033[0m"
            rm -f "$wm_tmp"
            exit 2
        else
            echo "  (no watermarks found, will unlock original)"
            rm -f "$wm_tmp"
            wm_tmp=""
            work_pdf="$src_pdf"
        fi
    fi

    # ── Step 2: Unlock (remove restrictions) ────────────────────────────────
    local step_label
    if $UNLOCK_ONLY; then
        step_label="[1/1]"
    else
        step_label="[2/2]"
    fi
    echo "  ${step_label} Unlocking…"
    if ! gs -q -dNOPAUSE -dBATCH -dQUIET -sDEVICE=pdfwrite -sOutputFile="$dst_pdf" "$work_pdf" 2>/dev/null; then
        echo "  ERROR: Failed to unlock $work_pdf" >&2
        [ -n "$wm_tmp" ] && rm -f "$wm_tmp"
        return 1
    fi

    echo "  → $dst_pdf"
    [ -n "$wm_tmp" ] && rm -f "$wm_tmp"
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
