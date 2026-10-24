#!/usr/bin/env python3
"""
DSE Chemistry Past Paper Video Batch Processor
==============================================
Performs the following for each video in the target folder:
  1. Extracts first frame as PNG (if missing)
  2. Extracts audio track as MP3 (if missing)
  3. Runs ASR speech-to-text to produce SRT + JSON (if missing)
  4. Renames mp4 to <year>-<PIA/PIB/PII>-Q<num>.mp4

Uses mediakit-cli (cloud) for audio extraction and ASR,
and ffmpeg (local) for first-frame extraction.

Usage:
  python3 batch_process.py [--folder /path/to/folder] [--limit N] [--dry-run]

Requires:
  - mediakit-cli in PATH (with auth env vars set)
  - ffmpeg in PATH
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DEFAULT_FOLDER = "/private/var/www/html/video-tutor/subjects/chemistry/winter2/pp-videos/2017"

# Pattern for already-renamed files: e.g. 2017-PIB-Q2.mp4, 2018-PIA-Q36.mp4
RENAMED_RE = re.compile(
    r"^(?P<year>20\d{2})-(?P<part>PIA|PIB|PII)-(?P<q>Q\d+|Section[A-C]-Q\d+)$"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run(cmd, check=True, capture=True):
    """Run a shell command, return stdout (stripped). Raise on failure."""
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=capture, text=True)
    if check and result.returncode != 0:
        print(f"  STDERR: {result.stderr[:500]}")
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return result.stdout.strip()


def poll_task(task_id, timeout=600, interval=5):
    """Poll mediakit-cli shared query-task until terminal state."""
    start = time.time()
    while time.time() - start < timeout:
        out = run(["mediakit-cli", "shared", "query-task", "--task-id", task_id])
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            print(f"  [poll] non-JSON: {out[:200]}")
            time.sleep(interval)
            continue

        status = data.get("status", "")
        if status in ("completed", "success"):
            return data
        if status in ("failed", "error", "cancelled"):
            raise RuntimeError(f"Task {task_id} failed: {data}")
        print(f"  [poll] {status}... ({int(time.time()-start)}s)")
        time.sleep(interval)
    raise TimeoutError(f"Task {task_id} timed out after {timeout}s")


def extract_first_frame(video_path: Path, png_path: Path):
    """Extract first frame as PNG using ffmpeg."""
    if png_path.exists():
        print(f"  [skip] PNG exists: {png_path.name}")
        return
    run([
        "ffmpeg", "-y", "-i", str(video_path),
        "-vframes", "1", "-q:v", "2", "-update", "1", str(png_path),
    ])
    print(f"  [ok] PNG saved: {png_path.name}")


def extract_audio(video_path: Path, mp3_path: Path):
    """Submit extract-audio task, wait, download mp3."""
    if mp3_path.exists():
        print(f"  [skip] MP3 exists: {mp3_path.name}")
        return

    out = run([
        "mediakit-cli", "editing", "extract-audio",
        "--video-url", str(video_path),
        "--format", "mp3",
    ])
    data = json.loads(out)
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError(f"No task_id: {data}")

    result = poll_task(task_id)
    audio_url = result.get("result", {}).get("audio_url") or result.get("audio_url")
    if not audio_url:
        raise RuntimeError(f"No audio_url: {result}")

    print(f"  [download] {mp3_path.name}")
    urllib.request.urlretrieve(audio_url, str(mp3_path))
    print(f"  [ok] MP3 saved ({mp3_path.stat().st_size // 1024} KB)")


def asr_transcribe(audio_path: Path, json_path: Path, srt_path: Path):
    """Submit ASR task, wait, save JSON + convert to SRT."""
    if srt_path.exists() and json_path.exists():
        print(f"  [skip] SRT+JSON exist: {srt_path.name}")
        return

    out = run([
        "mediakit-cli", "video", "asr-subtitles",
        "--audio-url", str(audio_path),
    ])
    data = json.loads(out)
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError(f"No task_id in ASR response: {data}")

    result = poll_task(task_id, timeout=900)
    subtitles = result.get("result", {}).get("subtitles") or result.get("subtitles", [])

    payload = {
        "source_audio": audio_path.name,
        "duration_sec": result.get("result", {}).get("duration") or result.get("duration"),
        "subtitles": subtitles,
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  [ok] JSON saved ({len(subtitles)} cues)")

    srt_lines = []
    for i, sub in enumerate(subtitles, 1):
        srt_lines.append(str(i))
        srt_lines.append(f"{fmt_ts(sub['start_time'])} --> {fmt_ts(sub['end_time'])}")
        srt_lines.append(sub["subtitle_text"])
        srt_lines.append("")
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")
    print(f"  [ok] SRT saved")


def fmt_ts(sec: float) -> str:
    """Format seconds as HH:MM:SS,mmm for SRT."""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms == 1000:
        ms = 0
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Batch process DSE Chem past paper videos")
    ap.add_argument("--folder", default=DEFAULT_FOLDER, help="Folder containing videos")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N videos (0=all)")
    ap.add_argument("--dry-run", action="store_true", help="Only list what would be done")
    ap.add_argument("--only", type=str, default="", help="Only process files matching this substring")
    args = ap.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"Folder not found: {folder}", file=sys.stderr)
        sys.exit(1)

    videos = sorted(folder.glob("*.mp4"))
    named = [v for v in videos if RENAMED_RE.match(v.stem)]
    skipped_old = [v for v in videos if not RENAMED_RE.match(v.stem)]

    print(f"Found {len(named)} renamed videos in {folder}")
    if skipped_old:
        print(f"Skipping {len(skipped_old)} non-renamed files:")
        for v in skipped_old:
            print(f"  - {v.name}")

    if args.only:
        named = [v for v in named if args.only in v.name]
        print(f"Filtered to {len(named)} matching '{args.only}'")

    processed = 0
    failed = []

    for video in named:
        stem = video.stem
        print(f"\n=== {stem}.mp4 ===")

        png_path = video.with_suffix(".png")
        mp3_path = video.with_suffix(".mp3")
        json_path = video.with_suffix(".json")
        srt_path = video.with_suffix(".srt")

        if args.dry_run:
            missing = []
            if not png_path.exists():
                missing.append("PNG")
            if not mp3_path.exists():
                missing.append("MP3")
            if not srt_path.exists():
                missing.append("SRT+JSON")
            print(f"  Would process: missing = {missing or 'none (already done)'}")
            continue

        try:
            extract_first_frame(video, png_path)
            extract_audio(video, mp3_path)
            asr_transcribe(mp3_path, json_path, srt_path)
            processed += 1
        except Exception as e:
            print(f"  [FAIL] {e}")
            failed.append((video.name, str(e)))

        if args.limit and processed >= args.limit:
            print(f"\nReached --limit {args.limit}, stopping.")
            break

    print(f"\n{'='*60}")
    print(f"Done. Processed: {processed}, Failed: {len(failed)}")
    if failed:
        print("\nFailed files (re-run to retry):")
        for name, err in failed:
            print(f"  - {name}: {err[:200]}")


if __name__ == "__main__":
    main()
