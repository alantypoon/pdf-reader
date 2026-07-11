#!/usr/bin/env python3
"""
Test the aigateway's handling of long prompts through the web4 Apache proxy.

Sends two Ollama generation requests through https://aigateway.aied.hku.hk:
  1. a SHORT prompt (should always succeed)
  2. a LONG prompt (~7KB, similar to a translation request)

If the Apache proxy on web4 has default buffer limits, the long prompt will
return a 502 "Proxy Error" HTML page.  After the Apache config fix (Timeout +
LimitRequestBody), both requests should return 200 with valid JSON.

Usage:
    python test-aigateway-long-request-prompt.py
"""

import os
import sys
import json
import time
import requests

# ── Config ─────────────────────────────────────────────────
GATEWAY_URL = os.environ.get(
    "VLLM_API_URL", "https://aigateway.aied.hku.hk/api/generate"
)

# Read API key from .env or environment
API_KEY = os.environ.get("OLLAMA_APIKEY", "")
if not API_KEY:
    env_file = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_file):
        with open(env_file) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("OLLAMA_APIKEY="):
                    API_KEY = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

if not API_KEY:
    print("ERROR: OLLAMA_APIKEY not set in environment or .env")
    sys.exit(1)

PROVIDER = "ollama"
MODEL = "gpt-oss:120b"
TIMEOUT = 120  # seconds for gateway
OLLAMA_DIRECT_URL = os.environ.get(
    "OLLAMA_DIRECT_URL", "http://aiserver3:11434/api/generate"
)
OLLAMA_DIRECT_TIMEOUT = 300  # seconds — direct Ollama can be slow for large prompts

# ── Test prompts ───────────────────────────────────────────

SHORT_PROMPT = (
    "Say hello in exactly three words. Output ONLY those three words."
)

# A realistic ~7KB translation prompt — matches what pdf-reader sends for TC translation
_EN_SOURCE = json.dumps({
    "summary": [
        "The page introduces using the scientific method to solve everyday problems.",
        "A scenario is presented where Kelly wonders if rice speeds up the ripening of an unripe papaya.",
        "The central question is: Does the presence of rice speed up the ripening of papayas?",
        "Students are tasked with designing and carrying out an investigation.",
        "The investigation should compare papayas ripening with rice versus without rice.",
        "The goal is to determine whether rice influences the speed of papaya ripening.",
    ],
    "flashcards": [
        {"question": "What is the central question Kelly is investigating?", "answer": "Does the presence of rice speed up the ripening of papayas?"},
        {"question": "What everyday situation is used to illustrate a scientific investigation?", "answer": "Kelly's mother puts an unripe papaya in a container of rice and suggests the rice may speed up ripening."},
        {"question": "What method should Kelly use to find the answer to her question?", "answer": "She should design and carry out an investigation using the scientific method."},
        {"question": "What are the two conditions Kelly should compare in her experiment?", "answer": "Papayas ripening with rice present versus papayas ripening without rice."},
        {"question": "What is the broader purpose of the task described in the text?", "answer": "To demonstrate how the scientific method can solve a problem in daily life."},
        {"question": "What is the independent variable in Kelly's experiment?", "answer": "The presence or absence of rice."},
        {"question": "What is the dependent variable in Kelly's experiment?", "answer": "The speed of papaya ripening."},
        {"question": "Why is it important to have a control group in an experiment?", "answer": "A control group provides a baseline for comparison to determine if the independent variable has an effect."},
    ],
    "mcq": [
        {
            "question": "In the scenario, what does Kelly's mother claim about the rice?",
            "options": ["A. It can speed up the ripening of the papaya.", "B. It makes the papaya taste sweeter.", "C. It prevents the papaya from ripening.", "D. It changes the color of the papaya."],
            "correct": "A",
            "explanation": "The text states that Kelly's mother explained the presence of rice could speed up the ripening of the papaya."
        },
        {
            "question": "What is the first step Kelly should take to answer her question?",
            "options": ["A. Design an investigation using the scientific method.", "B. Eat the papaya immediately.", "C. Store the papaya in the freezer.", "D. Add sugar to the papaya."],
            "correct": "A",
            "explanation": "The task directs Kelly to design and carry out an investigation, which is the initial step in the scientific method."
        },
        {
            "question": "Which of the following best describes the type of problem Kelly is investigating?",
            "options": ["A. A daily-life problem that can be solved with a scientific investigation.", "B. A mathematical equation about fruit growth.", "C. A historical question about papaya cultivation.", "D. A literary analysis of fruit symbolism."],
            "correct": "A",
            "explanation": "The text explicitly says the investigation is to solve a problem in daily life using the scientific method."
        },
        {
            "question": "What is the purpose of having a control setup in Kelly's experiment?",
            "options": ["A. To provide a baseline for comparison.", "B. To make the experiment more complicated.", "C. To use more papayas.", "D. To test multiple variables at once."],
            "correct": "A",
            "explanation": "A control setup allows Kelly to compare results and determine whether rice actually affects ripening speed."
        },
        {
            "question": "Which variable is deliberately changed in Kelly's experiment?",
            "options": ["A. The type of fruit used.", "B. The presence or absence of rice.", "C. The temperature of the room.", "D. The size of the container."],
            "correct": "B",
            "explanation": "The independent variable is what Kelly changes — in this case, whether rice is present or not."
        },
    ],
})

LONG_PROMPT = f"""You are an expert bilingual Biology educator. Translate the study materials below while preserving the meaning EXACTLY.

The content is from:
- Chapter: 1a
- Section: Introducing Biology
- Page: 9

Translate everything into Traditional Chinese (繁體中文, NOT Simplified Chinese 简体中文).

IMPORTANT REQUIREMENTS:
- The translated English and Chinese versions must match in meaning item-by-item.
- Keep the SAME number of summary bullet points, flashcards, and MCQ questions.
- Preserve the SAME ordering for all arrays.
- summary[i] in the output must match summary[i] in the source by meaning.
- flashcards[i] in the output must match flashcards[i] in the source by meaning.
- mcq[i] in the output must match mcq[i] in the source by meaning.
- Keep exactly 4 options for each MCQ, labeled A-D.
- Keep the SAME correct answer letter as the source.
- Use textbook terminology from the reference text when available.
- Output ONLY valid JSON, no markdown.

--- REFERENCE TEXTBOOK TEXT ---
B 進行科學探究 現在讓我們運用科學方法來解決日常生活的問題！以下例子及問題，可以幫助我們了解如何進行科學探究。情境 嘉熙的媽媽買了一個西瓜，但西瓜還未熟，不適合進食。於是她把西瓜放進米缸，希望西瓜能快些變熟。嘉熙對此十分好奇，很想知道米是否能令西瓜更快變熟。任務 設計並進行一個探究，以解答嘉熙的疑問。
--- END REFERENCE TEXT ---

--- SOURCE STUDY MATERIALS JSON ---
{_EN_SOURCE}
--- END SOURCE ---

Output ONLY the translated JSON."""


# ── Main ───────────────────────────────────────────────────

def test(name, prompt):
    """Send a prompt through the gateway and report the result."""
    print(f"\n{'=' * 60}")
    print(f"Test: {name}")
    print(f"Prompt size: {len(prompt)} chars ({len(prompt.encode('utf-8'))} bytes)")
    print(f"{'=' * 60}")

    t0 = time.time()
    try:
        resp = requests.post(
            GATEWAY_URL,
            files={
                "provider": (None, PROVIDER),
                "apiKey": (None, API_KEY),
                "model": (None, MODEL),
                "prompt": (None, prompt),
            },
            headers={"Accept": "text/event-stream"},
            timeout=TIMEOUT,
        )
    except requests.Timeout:
        print(f"❌ TIMEOUT — request took longer than {TIMEOUT}s")
        return False
    except requests.ConnectionError as e:
        print(f"❌ CONNECTION ERROR — {e}")
        return False

    elapsed = time.time() - t0
    print(f"HTTP {resp.status_code}  ({len(resp.content)} bytes)  took {elapsed:.1f}s")

    if resp.status_code == 502:
        body = resp.text[:500]
        if "<title>502 Proxy Error</title>" in body or "Proxy Error" in body:
            print("❌ APACHE 502 PROXY ERROR — web4 buffer limit likely the cause")
            print(f"   Body preview: {body[:200]}")
            return False
        else:
            print("❌ 502 (non-Apache)")
            print(f"   Body preview: {body[:200]}")
            return False

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        print(f"   Body preview: {resp.text[:300]}")
        return False

    try:
        data = resp.json()
    except json.JSONDecodeError:
        print("❌ Response is not valid JSON")
        print(f"   Body preview: {resp.text[:300]}")
        return False

    if data.get("success"):
        resp_text = data.get("response", "")
        print(f"✅ SUCCESS — {len(resp_text)} chars in {elapsed:.1f}s")
        return True
    elif data.get("error"):
        print(f"⚠️  API error: {data['error'][:200]}")
        return False
    else:
        print("⚠️  Unexpected response format")
        print(json.dumps(data, indent=2, ensure_ascii=False)[:500])
        return False


def test_direct_ollama(name, prompt):
    """Send a prompt directly to aiserver3's Ollama (bypass gateway/web4)."""
    print(f"\n{'=' * 60}")
    print(f"Test: {name}")
    print(f"URL:  {OLLAMA_DIRECT_URL}")
    print(f"Prompt size: {len(prompt)} chars ({len(prompt.encode('utf-8'))} bytes)")
    print(f"{'=' * 60}")

    payload = {
        "model": MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.3},
    }

    t0 = time.time()
    try:
        resp = requests.post(
            OLLAMA_DIRECT_URL,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=OLLAMA_DIRECT_TIMEOUT,
        )
    except requests.Timeout:
        print("❌ TIMEOUT — request took longer than %ds" % OLLAMA_DIRECT_TIMEOUT)
        return False
    except requests.ConnectionError as e:
        print(f"❌ CONNECTION ERROR — {e}")
        return False

    elapsed = time.time() - t0
    print(f"HTTP {resp.status_code}  ({len(resp.content)} bytes)  took {elapsed:.1f}s")

    if resp.status_code != 200:
        print(f"❌ HTTP {resp.status_code}")
        print(f"   Body preview: {resp.text[:300]}")
        return False

    try:
        data = resp.json()
    except json.JSONDecodeError:
        print("❌ Response is not valid JSON")
        print(f"   Body preview: {resp.text[:300]}")
        return False

    resp_text = (data.get("response") or "").strip()
    if resp_text:
        print(f"✅ SUCCESS — {len(resp_text)} chars response in {elapsed:.1f}s")
        # Show first 200 chars of the translation to confirm it's good
        if len(resp_text) > 200:
            print(f"   Preview: {resp_text[:200]}...")
        else:
            print(f"   Content: {resp_text}")
        return True
    else:
        print("❌ Empty response from Ollama")
        return False


def main():
    print("aigateway long-prompt test")
    print(f"URL:      {GATEWAY_URL}")
    print(f"Provider: {PROVIDER}")
    print(f"Model:    {MODEL}")

    if not API_KEY:
        print("ERROR: No API key configured")
        sys.exit(1)

    # Test 1: short prompt via gateway (baseline)
    short_ok = test("SHORT prompt via gateway", SHORT_PROMPT)

    # Test 2: long prompt via gateway (should trigger 502 if Apache not fixed)
    long_ok = test(f"LONG prompt via gateway (~{len(LONG_PROMPT)} chars)", LONG_PROMPT)

    # Test 3: long prompt DIRECT to aiserver3 Ollama (should always work)
    direct_ok = test_direct_ollama(f"LONG prompt direct to aiserver3 (~{len(LONG_PROMPT)} chars)", LONG_PROMPT)

    # ── Summary ──────────────────────────────────────────
    print(f"\n{'=' * 60}")
    print("RESULTS")
    print(f"{'=' * 60}")
    print(f"  1. Short via gateway:       {'✅ PASS' if short_ok else '❌ FAIL'}")
    print(f"  2. Long  via gateway:       {'✅ PASS' if long_ok else '❌ FAIL'}")
    print(f"  3. Long  direct to aiserver3: {'✅ PASS' if direct_ok else '❌ FAIL'}")

    if short_ok and long_ok and direct_ok:
        print("\n✅ All three passed — gateway and direct Ollama both working.")
    elif short_ok and not long_ok and direct_ok:
        print("\n❌ Gateway fails for long prompts but direct Ollama works.")
        print("   The Apache proxy on web4 is the bottleneck.")
        print("   Apply: Timeout 300 + LimitRequestBody 0 in the aigateway VirtualHost.")
    elif short_ok and not long_ok and not direct_ok:
        print("\n❌ Both gateway and direct Ollama fail for long prompts.")
        print("   Check aiserver3 Ollama health and network connectivity.")
    elif not short_ok:
        print("\n❌ Even the short gateway prompt failed — check gateway connectivity.")

    sys.exit(0 if (short_ok and long_ok and direct_ok) else 1)


if __name__ == "__main__":
    main()
