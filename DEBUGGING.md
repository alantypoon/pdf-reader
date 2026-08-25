# Debugging: Page Scrolling Issues

## Enable Scroll Logging

The debug system uses constants to enable/disable verbose logging. To debug scroll issues:

### Option 1: Edit src/debug.js (Recommended)

Edit `/var/www/html/pdf-reader/src/debug.js` and change line 21:

```javascript
// From:
export const DEBUG_FLAG = 0;

// To:
export const DEBUG_FLAG = DEBUG_SCROLLING_PERSISTENCE;
```

Then rebuild/reload the app.

### Option 2: Temporary Browser DevTools Override

In browser console:
```javascript
// This may not work as the debug.js import is evaluated at build time
// Better to edit debug.js and rebuild
```

## Available Debug Flags

From `src/debug.js`:

- `DEBUG_ANNO_STROKES = 993` - Pointer events for stroke drawing
- `DEBUG_LOADING_PAGE_IMAGES = 994` - Image loading and page preloading
- `DEBUG_MYSCROLL = 995` - All programmatic scroll operations
- `DEBUG_MYLOCALSTORAGE = 996` - Scroll position save/restore
- `DEBUG_SCROLLING_MOMENTUM = 997` - 2-finger touch momentum scrolling
- `DEBUG_ZOOMING = 998` - Zoom level changes
- `DEBUG_SCROLLING_PERSISTENCE = 999` - Scroll persistence and page detection

## For This Issue: Use DEBUG_SCROLLING_PERSISTENCE (999)

Set `DEBUG_FLAG = DEBUG_SCROLLING_PERSISTENCE` to see:
- Scroll events being received
- Page detection from scroll position
- Page change notifications
- Scroll position save/restore

```
[init] scroll listener attached to mount (isImageMode=true)
[img-load] INIT  currentPage=1  total=7  isBilingual=false  scrollH=1080
[img-load] RANGE  center=1  range=[1..7]  loaded=0/7
[img-load] START  page=1  concurrent=1  url=1.png
[img-load] REPLACE  page=1  placeholder→img
[img-load] OK    page=1  natural=1024×1448  displayed=768×1087  concurrent=0  isInit=true  restoreInProgress=false  wasFirst=true
[doScrollWork] scrollTop=0 maxTop=1487 scrollH=7896 clientH=800 isInit=true disposed=false
```

## Key Log Messages

### Scroll Events
- `[onScrollWithSave] scroll event received, scheduling RAF` - User scrolled
- `[onScrollWithSave] SKIPPED: syncingFromRemote=...` - Scroll event ignored
- `[doScrollWork] scrollTop=X maxTop=Y` - Scroll position detected
- `[doScrollWork] findContainingPage returned page=N` - Which page is visible
- `[doScrollWork] loadVisibleRange X → Y` - Loading pages around current page

### Image Loading
- `[img-load] SKIP page=N reason=...` - Why a page wasn't loaded
  - `concurrency-cap` - Too many images loading simultaneously
  - `already-loaded` - Already in loadedSet
  - `no-data-src` - Missing data-src attribute
  - `already-has-src` - Image already has src set
- `[img-load] START page=N` - Page started loading
- `[img-load] OK page=N` - Page loaded successfully
- `[img-load] ERROR page=N` - Image load failed
- `[img-load] RANGE center=N range=[A..B] loaded=X/Y` - Preload window

## Common Issues

### Pages 2+ not loading:
1. Check if `[onScrollWithSave] scroll event received` appears when you scroll
   - If NOT: scroll events aren't firing (likely `overflow: hidden` issue)
   - If YES: but pages don't load, check `[img-load] START` messages

2. Check `[doScrollWork] findContainingPage returned page=N`
   - If showing page=1 always: placeholders have no height, can't detect scroll position

3. Check `[img-load] SKIP page=N reason=...`
   - If `concurrency-cap`: too many images loading, try reducing PRELOAD_WINDOW
   - If `no-data-src`: image elements missing src URLs

### Scroll events not detected:
- Check console for `[onScrollWithSave]` messages
- If nothing: scroll listener may not be attached or scroll events not firing
- Check: `mount.addEventListener('scroll', onScrollWithSave, { passive: true })`

### Loading very slow:
- Check `[img-load] OK` delays
- Image server may be slow or files too large
- Check browser Network tab for slow requests
