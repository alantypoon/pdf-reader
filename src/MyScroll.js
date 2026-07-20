/**
 * MyScroll — centralised programmatic scroll control.
 *
 * Every scrollTop / scrollLeft assignment and scrollTo / scrollBy call in the
 * app MUST go through these functions so that debugging is a one-line flag
 * change.  Set DEBUG_FLAG = DEBUG_MYSCROLL (995) in debug.js to enable
 * verbose logging of every programmatic scroll operation.
 */
import { isDebugMyScroll } from './debug.js';

const DEBUG = isDebugMyScroll;

function _elLabel(el) {
  if (!el) return 'null';
  const c = el.className;
  const cls = typeof c === 'string'
    ? c.split(' ').filter(Boolean).slice(0, 2).join('.')
    : (c?.baseVal || '');
  const id = el.id ? `#${el.id}` : '';
  return `${el.tagName || '?'}${id}${cls ? '.' + cls : ''}`;
}

/**
 * Set scrollTop on an element.
 * @param {HTMLElement} el
 * @param {number} value
 */
export function mySetScrollTop(el, value) {
  if (DEBUG()) {
    console.log(
      `[MyScroll] scrollTop  ${_elLabel(el)}  ${Math.round(el.scrollTop)} → ${Math.round(value)}`
    );
  }
  el.scrollTop = value;
}

/**
 * Set scrollLeft on an element.
 * @param {HTMLElement} el
 * @param {number} value
 */
export function mySetScrollLeft(el, value) {
  if (DEBUG()) {
    console.log(
      `[MyScroll] scrollLeft  ${_elLabel(el)}  ${Math.round(el.scrollLeft)} → ${Math.round(value)}`
    );
  }
  el.scrollLeft = value;
}

/**
 * Call scrollTo on an element.
 * @param {HTMLElement} el
 * @param {...any} args - same as Element.scrollTo()
 */
export function myScrollTo(el, ...args) {
  if (DEBUG()) {
    const opts = args[0];
    const top = typeof opts === 'object' ? opts.top : opts;
    const left = typeof opts === 'object' ? opts.left : undefined;
    const behavior = typeof opts === 'object' ? opts.behavior : (args[1] || '');
    console.log(
      `[MyScroll] scrollTo  ${_elLabel(el)}  top=${Math.round(top)}` +
      (left !== undefined ? `  left=${Math.round(left)}` : '') +
      (behavior ? `  behavior=${behavior}` : '')
    );
  }
  el.scrollTo(...args);
}

/**
 * Read the current scroll position of an element.
 * @param {HTMLElement} el
 * @returns {{ scrollTop: number, scrollLeft: number }}
 */
export function getScrollPos(el) {
  const pos = { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
  if (DEBUG()) {
    console.log(
      `[MyScroll] getScrollPos  ${_elLabel(el)}  scrollTop=${Math.round(pos.scrollTop)}  scrollLeft=${Math.round(pos.scrollLeft)}`
    );
  }
  return pos;
}

/**
 * Call scrollBy on an element.
 * @param {HTMLElement} el
 * @param {...any} args - same as Element.scrollBy()
 */
export function myScrollBy(el, ...args) {
  if (DEBUG()) {
    const opts = args[0];
    const left = typeof opts === 'object' ? opts.left : opts;
    const top = typeof opts === 'object' ? opts.top : undefined;
    console.log(
      `[MyScroll] scrollBy  ${_elLabel(el)}  dx=${typeof left === 'number' ? left.toFixed(2) : left}` +
      (top !== undefined ? `  dy=${typeof top === 'number' ? top.toFixed(2) : top}` : '')
    );
  }
  el.scrollBy(...args);
}
