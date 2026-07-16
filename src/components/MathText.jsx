import React, { useMemo } from 'react';
import katex from 'katex';

// ── Unicode fallbacks for common LaTeX commands ──────────────────────────
const UNICODE_MAP = {
  '\\times':       '×',
  '\\cdot':        '·',
  '\\div':         '÷',
  '\\pm':          '±',
  '\\mp':          '∓',
  '\\approx':      '≈',
  '\\equiv':       '≡',
  '\\neq':         '≠',
  '\\leq':         '≤',
  '\\geq':         '≥',
  '\\ll':          '≪',
  '\\gg':          '≫',
  '\\sim':         '∼',
  '\\propto':      '∝',
  '\\infty':       '∞',
  '\\partial':     '∂',
  '\\nabla':       '∇',
  '\\alpha':       'α',
  '\\beta':        'β',
  '\\gamma':       'γ',
  '\\delta':       'δ',
  '\\epsilon':     'ε',
  '\\varepsilon':  'ε',
  '\\theta':       'θ',
  '\\lambda':      'λ',
  '\\mu':          'μ',
  '\\pi':          'π',
  '\\sigma':       'σ',
  '\\omega':       'ω',
  '\\phi':         'φ',
  '\\rho':         'ρ',
  '\\Delta':       'Δ',
  '\\Gamma':       'Γ',
  '\\Theta':       'Θ',
  '\\Lambda':      'Λ',
  '\\Pi':          'Π',
  '\\Sigma':       'Σ',
  '\\Omega':       'Ω',
  '\\rightarrow':  '→',
  '\\to':          '→',
  '\\leftarrow':   '←',
  '\\Rightarrow':  '⇒',
  '\\Leftarrow':   '⇐',
  '\\leftrightarrow': '↔',
  '\\uparrow':     '↑',
  '\\downarrow':   '↓',
  '\\textdegree':  '°',
  '\\degree':      '°',
  '\\textcelsius': '°C',
  '\\textCelcius': '°C',
};

/** Commands that require KaTeX rendering (no simple Unicode equivalent). */
const COMPLEX_COMMANDS = [
  '\\\\frac', '\\\\sqrt', '\\\\text', '\\\\mathbf', '\\\\mathit',
  '\\\\mathrm', '\\\\mathcal', '\\\\mathbb', '\\\\boldsymbol',
  '\\\\dfrac', '\\\\tfrac', '\\\\binom', '\\\\over', '\\\\choose',
  '\\\\sum', '\\\\prod', '\\\\int', '\\\\iint', '\\\\iiint', '\\\\oint',
  '\\\\lim', '\\\\log', '\\\\ln', '\\\\sin', '\\\\cos', '\\\\tan',
  '\\\\left', '\\\\right', '\\\\big', '\\\\Big', '\\\\bigg', '\\\\Bigg',
  '\\\\begin', '\\\\end', '\\\\displaystyle', '\\\\textstyle',
  '\\\\stackrel', '\\\\underset', '\\\\overset',
];

const SIMPLE_CMD_RE = new RegExp(
  Object.keys(UNICODE_MAP)
    .sort((a, b) => b.length - a.length)
    .map(c => c.replace(/\\/g, '\\\\'))
    .join('|'),
  'g'
);

const COMPLEX_CMD_RE = new RegExp(
  '(' + COMPLEX_COMMANDS.join('|') + ')',
  'g'
);

// ── Helpers ───────────────────────────────────────────────────────────────

function replaceSimpleCommands(text) {
  return text.replace(SIMPLE_CMD_RE, (match) => UNICODE_MAP[match] || match);
}

function renderMathSegment(mathStr) {
  try {
    return katex.renderToString(mathStr, {
      throwOnError: false,
      strict: false,
      displayMode: false,
      trust: true,
    });
  } catch (_) {
    return escapeHtml(replaceSimpleCommands(mathStr));
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Walk forward from position `start` in `text` to find the matching
 * closing brace for balanced `{…}` groups.
 */
function skipBracedGroup(text, start) {
  if (start >= text.length || text[start] !== '{') return start;
  let depth = 1;
  let i = start + 1;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return i;
}

// ── Bare _ / ^ script detection ───────────────────────────────────────────

/** Characters that can appear inside a math formula. */
function isMathChar(ch) {
  return /[a-zA-Z0-9+\-*/=<>(){}[\]_^.,|: \\']/.test(ch);
}

/**
 * Find math expression boundaries around a position in text.
 * Walks outward from `pos`, including math-like characters and
 * internal spaces, stopping at sentence boundaries.
 */
function findMathBounds(text, pos) {
  // Walk left
  let left = pos;
  while (left > 0) {
    const ch = text[left - 1];
    if (isMathChar(ch)) { left--; continue; }
    // Allow internal spaces within a formula (e.g. "= 0.5 J")
    if (ch === ' ' && left > 1 && isMathChar(text[left - 2])) { left--; continue; }
    break;
  }
  // Walk right
  let right = pos;
  while (right < text.length) {
    const ch = text[right];
    if (isMathChar(ch)) { right++; continue; }
    if (ch === ' ' && right + 1 < text.length && isMathChar(text[right + 1])) { right++; continue; }
    break;
  }
  return { left, right };
}

/**
 * Merge overlapping or adjacent math regions.
 */
function mergeRegions(regions) {
  if (regions.length === 0) return [];
  const sorted = regions.slice().sort((a, b) => a.left - b.left);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    // Allow a few non-math chars between adjacent regions
    if (curr.left <= prev.right + 3) {
      prev.right = Math.max(prev.right, curr.right);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

/**
 * Preprocess text: find bare  _  /  ^  LaTeX notation (not part of a
 * \\command) and wrap the containing math expression in $…$ delimiters
 * so the rest of the pipeline handles it via KaTeX.
 */
function wrapBareScriptMath(text) {
  // Find _ or ^ preceded by a letter/digit (not by \)
  const scriptRe = /([a-zA-Z0-9])[_^]/g;
  const hits = [];
  let m;
  while ((m = scriptRe.exec(text)) !== null) {
    // Check that this _ or ^ is not preceded by a backslash
    if (m.index > 0 && text[m.index - 1] === '\\') continue;
    hits.push(m.index + 1); // position of the _ or ^
  }

  if (hits.length === 0) return text;

  // Expand each hit to math region boundaries
  const regions = hits.map(pos => {
    const { left, right } = findMathBounds(text, pos);
    return { left, right };
  });

  const merged = mergeRegions(regions);

  // Build output with $…$ wrapped math
  let out = '';
  let cursor = 0;
  for (const r of merged) {
    out += text.slice(cursor, r.left);
    out += '$' + text.slice(r.left, r.right) + '$';
    cursor = r.right;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * For text segments that still contain complex LaTeX commands, extract
 * each command + its arguments and render them with KaTeX, while leaving
 * regular text as-is.
 */
function renderComplexCommandsInText(text) {
  // Reset lastIndex for the global regex
  COMPLEX_CMD_RE.lastIndex = 0;

  const segments = [];
  let cursor = 0;
  let match;

  while ((match = COMPLEX_CMD_RE.exec(text)) !== null) {
    // Plain text before this command
    if (match.index > cursor) {
      segments.push(escapeHtml(text.slice(cursor, match.index)));
    }

    const cmd = match[0]; // e.g. "\\frac"
    let mathExpr = cmd;
    let pos = COMPLEX_CMD_RE.lastIndex; // position after the command name

    // Greedily consume braced arguments (most complex commands take 1-2)
    // Stop when we hit a non-brace character or end of string.
    while (pos < text.length && text[pos] === '{') {
      const afterArg = skipBracedGroup(text, pos);
      mathExpr += text.slice(pos, afterArg);
      pos = afterArg;
      // also consume optional [...] arguments
      if (pos < text.length && text[pos] === '[') {
        const afterOpt = skipBracedGroup(text, pos);
        mathExpr += text.slice(pos, afterOpt);
        pos = afterOpt;
      }
    }

    // Also consume trailing ^ and _ with their braced/non-braced arguments
    while (pos < text.length && (text[pos] === '^' || text[pos] === '_')) {
      mathExpr += text[pos];
      pos++;
      if (pos < text.length && text[pos] === '{') {
        const afterArg = skipBracedGroup(text, pos);
        mathExpr += text.slice(pos, afterArg);
        pos = afterArg;
      } else if (pos < text.length && /[a-zA-Z0-9]/.test(text[pos])) {
        mathExpr += text[pos];
        pos++;
      }
    }

    segments.push(renderMathSegment(mathExpr));
    cursor = pos;
    COMPLEX_CMD_RE.lastIndex = pos;
  }

  // Remaining text
  if (cursor < text.length) {
    segments.push(escapeHtml(text.slice(cursor)));
  }

  return segments.join('');
}

// ── Component ─────────────────────────────────────────────────────────────

/**
 * MathText — renders text that may contain LaTeX math notation.
 *
 * Handles four patterns (in order of precedence):
 * 1. Bare  _  /  ^  script notation (L_T, L_{100}, x^2) → auto-wrapped in $…$
 * 2. Explicit  $...$  /  $$...$$  delimiters → KaTeX-rendered math
 * 3. Complex LaTeX commands (\\frac, \\sqrt, etc.) → KaTeX
 * 4. Simple LaTeX commands (\\times, \\Delta, etc.) → Unicode replacement
 */
export default function MathText({ text, className }) {
  const html = useMemo(() => {
    if (!text) return '';

    // Step 0 — Wrap bare _ / ^ LaTeX notation in $…$ delimiters
    const preprocessed = wrapBareScriptMath(text);

    // Step 1 — Split on explicit $...$ and $$...$$ delimiters
    const parts = splitByMathDelimiters(preprocessed);

    // Step 2 — Process each segment
    return parts.map((seg, i) => {
      if (seg.type === 'math') {
        return renderMathSegment(seg.value);
      }
      // Plain-text segment:
      // a) replace simple LaTeX commands with Unicode
      let processed = replaceSimpleCommands(seg.value);
      // b) render any remaining complex LaTeX commands with KaTeX
      if (COMPLEX_CMD_RE.test(processed)) {
        processed = renderComplexCommandsInText(processed);
      } else {
        processed = escapeHtml(processed);
      }
      return processed;
    }).join('');
  }, [text]);

  if (!text) return null;
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Delimiter-aware splitter ──────────────────────────────────────────────

function splitByMathDelimiters(text) {
  // Match $$...$$ first (display), then $...$ (inline)
  const regex = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    const raw = match[1];
    if (raw.startsWith('$$') && raw.endsWith('$$')) {
      parts.push({ type: 'math', value: raw.slice(2, -2) });
    } else if (raw.startsWith('$') && raw.endsWith('$')) {
      parts.push({ type: 'math', value: raw.slice(1, -1) });
    } else {
      parts.push({ type: 'text', value: raw });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: text }];
}
