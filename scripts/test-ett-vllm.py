#!/usr/bin/env python3
"""
test-ett-vllm.py — Test ETT with the vLLM InternVL model.

Reads AIGATEWAY_MODEL_VLLM and AIGATEWAY_APIKEY_VLLM from ../.env

Usage:
    python3 scripts/test-ett-vllm.py [--file FILE] [-v]
"""
import sys
from pathlib import Path

script_dir = Path(__file__).resolve().parent
test_ett = script_dir / "test-ett.py"

# Run test-ett.py with --preset vllm
sys.argv = [str(test_ett), "--preset", "vllm"] + sys.argv[1:]
exec(test_ett.read_text())
