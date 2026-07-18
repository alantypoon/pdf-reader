/**
 * Debug constants — change DEBUG_FLAG to enable verbose logs for specific subsystems.
 *
 *   DEBUG_SCROLLING_MOMENTUM    = 997   2-finger touch inertia: velocity tracking, deceleration curve
 *   DEBUG_ZOOMING              = 998   zoom level changes & center-anchored scroll
 *   DEBUG_SCROLLING_PERSISTENCE = 999   localStorage scroll/zoom persistence
 */
export const DEBUG_SCROLLING_MOMENTUM = 997;
export const DEBUG_ZOOMING = 998;
export const DEBUG_SCROLLING_PERSISTENCE = 999;
// export const DEBUG_FLAG = DEBUG_SCROLLING_MOMENTUM;
export const DEBUG_FLAG = 0;

export function isDebugScrollingMomentum() {
  return DEBUG_FLAG === DEBUG_SCROLLING_MOMENTUM;
}

export function isDebugZooming() {
  return DEBUG_FLAG === DEBUG_ZOOMING;
}

export function isDebugScrollingPersistence() {
  return DEBUG_FLAG === DEBUG_SCROLLING_PERSISTENCE;
}
