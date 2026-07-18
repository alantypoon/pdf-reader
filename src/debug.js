/**
 * Debug constants — change DEBUG_FLAG to DEBUG_SCROLLING_PERSISTENCE (=999)
 * to enable verbose localStorage scroll/zoom persistence logs.
 */
export const DEBUG_FLAG = 0;
export const DEBUG_SCROLLING_PERSISTENCE = 999;

export function isDebugScrollingPersistence() {
  return DEBUG_FLAG === DEBUG_SCROLLING_PERSISTENCE;
}
