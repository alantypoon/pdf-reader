import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

for (const { subject, w, h, count, target } of [
  { subject: 'chemistry-aristo', w: 1693, h: 2245, count: 31, target: 25 },
  { subject: 'physics-oup', w: 1709, h: 2237, count: 60, target: 52 },
]) {
  for (const zoom of [0.75, 1, 1.5]) {
    test(`${subject} at zoom ${zoom} reserves full page heights before search destination images load`, async () => {
      const source = await readFile(new URL('../src/PdfPane.jsx', import.meta.url), 'utf8');
      const start = source.indexOf('        const w = baseWidth * zoom;');
      const end = source.indexOf('        // Also update any .my-paper-page', start);
      const images = Array.from({ length: count }, () => ({ w, h }));
      const imgs = images.map(() => ({ style: {}, naturalWidth: 0, naturalHeight: 0 }));
      const placeholders = [1, target, count].map((page) => ({
        dataset: { page: String(page) },
        style: { height: '1061px' },
      }));
      vm.runInNewContext(source.slice(start, end), {
        baseWidth: 600,
        zoom,
        images,
        imgs,
        placeholders,
      });
      const expectedHeight = `${Math.round(h * 600 * zoom / w)}px`;
      assert.deepEqual(
        [...imgs, ...placeholders].map(({ style }) => [style.width, style.height]),
        Array.from({ length: count + placeholders.length }, () => [`${600 * zoom}px`, expectedHeight]),
      );
    });
  }
}

test('resizing preserves each page aspect ratio and uses loaded dimensions for legacy URLs', async () => {
  const source = await readFile(new URL('../src/PdfPane.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('        const w = baseWidth * zoom;');
  const end = source.indexOf('        // Also update any .my-paper-page', start);
  const imgs = [
    { style: {}, naturalWidth: 0, naturalHeight: 0 },
    { style: {}, naturalWidth: 0, naturalHeight: 0 },
    { style: {}, naturalWidth: 800, naturalHeight: 1200 },
  ];
  const placeholders = [3, 1, 2].map((page) => ({
    dataset: { page: String(page) },
    style: { height: '1061px' },
  }));
  vm.runInNewContext(source.slice(start, end), {
    baseWidth: 600,
    zoom: 1,
    images: [{ w: 1200, h: 800 }, { w: 800, h: 1200 }, 'legacy.png'],
    imgs,
    placeholders,
  });
  assert.deepEqual(
    [...imgs, ...placeholders].map(({ style }) => [style.width, style.height]),
    [400, 900, 900, 900, 400, 900].map((height) => ['600px', `${height}px`]),
  );
});

async function getSearchEffectDependencies(overrides = {}) {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const dependencies = [];
  vm.runInNewContext(
    source.slice(source.indexOf('  // ── Debounced search'), source.indexOf('  // ── Load more when')),
    {
      useMemo: (callback) => callback(),
      useEffect: (callback, deps) => dependencies.push(Array.from(deps)),
      URLSearchParams,
      searchQuery: 'force',
      searchScopePage: false,
      searchScopeSection: false,
      selectedBook: 'physics-oup',
      selectedChapter: '1',
      selectedFile: '5',
      selectedPage: 52,
      wholeWord: true,
      searchSubjects: ['physics-oup', 'chemistry-aristo'],
      searchOffset: 50,
      sidebarExcerptLanguage: 'en',
      ...overrides,
    },
  );
  return dependencies;
}

test('unscoped search does not reset or refetch when navigating to a result', async () => {
  assert.deepEqual(
    await getSearchEffectDependencies({
      selectedBook: 'chemistry-aristo', selectedChapter: '1a', selectedFile: '2', selectedPage: 25,
    }),
    await getSearchEffectDependencies(),
  );
});

test('section-scoped search ignores page changes but follows section changes', async () => {
  const baseline = JSON.stringify(await getSearchEffectDependencies({ searchScopeSection: true }));
  assert.deepEqual(
    [
      await getSearchEffectDependencies({ searchScopeSection: true, selectedPage: 25 }),
      await getSearchEffectDependencies({ searchScopeSection: true, selectedFile: '3' }),
    ].map((deps) => JSON.stringify(deps) === baseline),
    [true, false],
  );
});

test('page-scoped search follows page changes and query edits still trigger searches', async () => {
  assert.deepEqual(
    [
      JSON.stringify(await getSearchEffectDependencies({ searchScopePage: true, selectedPage: 25 }))
        !== JSON.stringify(await getSearchEffectDependencies({ searchScopePage: true })),
      JSON.stringify(await getSearchEffectDependencies({ searchQuery: 'energy' }))
        !== JSON.stringify(await getSearchEffectDependencies()),
    ],
    [true, true],
  );
});

test('result navigation preserves search subject filters when switching subjects', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const changes = [];
  vm.runInNewContext(
    source.slice(source.lastIndexOf('  useEffect(() => {', source.indexOf('  const navigateToReaderLocation =')),
      source.indexOf('  const navigateToReaderLocation =')),
    {
      useEffect: (callback) => callback(),
      selectedBook: 'chemistry-aristo',
      navigatingToLocationRef: { current: true },
      setSearchSubjects: () => changes.push('search'),
      setBookmarkSubjects: () => changes.push('bookmarks'),
    },
  );
  assert.deepEqual(changes, ['bookmarks']);
});

test('reopening the search drawer reattaches infinite scrolling to its new sentinel', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const dependencies = [];
  for (const searchDrawerOpen of [false, true]) {
    vm.runInNewContext(
      source.slice(source.indexOf('  // ── Load more when'), source.indexOf('  // Derive modal content type')),
      {
        useRef: () => ({ current: null }),
        useEffect: (callback, deps) => dependencies.push(Array.from(deps)),
        searchHasMore: true,
        searchLoading: false,
        searchLoadingMore: false,
        searchDrawerOpen,
      },
    );
  }
  assert.notDeepEqual(dependencies[0], dependencies[1]);
});

for (const [isNarrowScreen, isPortrait, navigated, closes] of [
  [true, true, true, true],
  [true, false, true, false],
  [false, true, true, false],
  [false, false, true, false],
  [true, true, false, false],
]) {
  test(`result drawer: narrow=${isNarrowScreen}, portrait=${isPortrait}, navigated=${navigated}`, async () => {
    const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
    const start = source.indexOf('                          onClick=', source.indexOf('className="search-result-item"'));
    const handler = source.slice(start + source.slice(start).indexOf('=') + 2, source.indexOf('\n                        >', start)).trim().slice(0, -1);
    const changes = [];
    await vm.runInNewContext(`(${handler})()`, {
      navigateToReaderLocation: async () => navigated,
      result: {},
      isNarrowScreen,
      isPortrait,
      setSearchDrawerOpen: (open) => changes.push(open),
    });
    assert.deepEqual(changes, closes ? [false] : []);
  });
}
