# Debugging: Page Scrolling Issues

## Search jumps to the wrong visible page

Fit/zoom refreshes must preserve explicit image heights from the page metadata,
including unloaded images and lazy-load placeholders. Setting unloaded images to
`height: auto` collapses them until they load, shifting page offsets while the
requested page label remains unchanged. Check the visible page itself after a
search jump, not just the page label. Use
https://ai-edu.dedyn.io/pdf-reader/ for browser validation, not a localhost
navigation-test route. After rebuilding, reload the site to load the new bundle.
For example, search for `broken down`, click Chemistry › 1A › §2 › p.25 and
confirm the visible image URL ends in `/2-25.png`, including with slow image
loading and after fit/zoom changes. For Physics, search for `force`, click
Book 1, section 5, p.52 and confirm the visible image URL ends in `/5-52.png`.
The visible page's top should match the scroll container's top, not merely
the requested page label. The regression test is
`node --test tests/search-page-navigation.test.js`.

## Search results refresh after navigation

Search effects depend on the effective request parameters, not the reader's
unscoped location. Clicking a result must preserve the selected search subjects,
loaded results, pagination and scroll position. Current Section searches refresh
only when the section changes; Current Page searches also refresh on page changes.
Changing the query, language or active filters still starts a fresh search.
After successful result navigation, the search drawer closes on narrow portrait
screens (up to 960px wide) so the page is visible. It remains open on wider screens
and in landscape, and reopening it preserves the search.

## In-depth and Intensive resource columns

Questions, Answers and Misc each show a single-row searchable Select2 dropdown above their
own reader in the main area. Selecting a document or scrolling a resource must not
change another column's page or the Notes page. Document dropdowns remain available
when the sidebar is collapsed.
The Download button at the right of each column header saves the selected
document's original PDF, not its generated page images.
Page-card headers are hidden while any resource column is visible so they cannot
cover document selectors. Normal header behaviour returns when none is visible.

If a column shows a catalog error, check `/api/other-learning-resources`.
It must return JSON with `questions`, `answers` and `misc` arrays. An HTML
response usually means the backend has not been restarted since the endpoint
was added. Restart the PDF Reader backend, then use Retry in the column.
Selected columns show loading or error states rather than disappearing.

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
