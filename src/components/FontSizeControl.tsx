// @ts-nocheck
import React from 'react';
import { t } from '../i18n';

/**
 * Reusable font-size control: − / value / + buttons.
 *
 * Props:
 *  value    – current font size (px)
 *  onChange – callback receiving the new font size
 *  min      – minimum allowed size (default 10)
 *  max      – maximum allowed size (default 28)
 *  lang     – 'en' | 'tc' for aria-label translation
 */
export default function FontSizeControl({ value, onChange, min = 10, max = 28, lang = 'en' }) {
  const _ = (key) => t(key, lang);

  return (
    <div className="ai-font-size-control">
      <button
        className="ai-font-btn"
        onClick={() => onChange(Math.max(min, value - 1))}
        title={_('decreaseFontSize')}
        aria-label={_('decreaseFontSize')}
      >−</button>
      <span className="ai-font-size-value">{value}</span>
      <button
        className="ai-font-btn"
        onClick={() => onChange(Math.min(max, value + 1))}
        title={_('increaseFontSize')}
        aria-label={_('increaseFontSize')}
      >+</button>
    </div>
  );
}