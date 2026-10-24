import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { classifyOtherLearningResource, getOtherLearningResources } from '../server/otherLearningResources.js';

test('resource columns remain present while the catalog is loading or unavailable', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const panes = vm.runInNewContext(
    source.slice(source.indexOf('  const otherResourcePanes = useMemo'), source.indexOf('  // Auto-fallback to English'))
    + '\notherResourcePanes;',
    {
      useMemo: (callback) => callback(),
      isWinterMaterial: true,
      otherResourceCatalog: null,
      otherResourceSelections: {},
      RESOURCE_VIEW_IDS: ['questions', 'answers', 'misc'],
    },
  );
  assert.deepEqual(Array.from(panes, (pane) => pane.viewId), ['questions', 'answers', 'misc']);
});

test('In-depth and Intensive resource views stay selectable before content loads', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const selectedBook of ['chemistry-winter', 'chemistry-winter2']) {
    const options = vm.runInNewContext(
      source.slice(source.indexOf('const MATERIAL_TEXTBOOK ='), source.indexOf('function getLegacyLanguageRoleFromViews'))
      + source.slice(source.indexOf('  const viewToggleOptions ='), source.indexOf('  const selectedViewCount ='))
      + '\nviewToggleOptions;',
      {
        isWinterMaterial: ['chemistry-winter', 'chemistry-winter2'].includes(selectedBook),
        materialMode: 'textbook',
        selectedViews: ['en-student'],
        otherResourcePanes: [],
        ppRelatedTopics: [],
        effectivePageSources: {},
        isTextViewAvailable: () => true,
        hasRenderableSource: () => false,
      },
    );
    assert.deepEqual(
      Array.from(options.filter((option) => ['questions', 'answers', 'misc'].includes(option.viewId)),
        ({ viewId, disabled }) => ({ viewId, disabled })),
      [
        { viewId: 'questions', disabled: false },
        { viewId: 'answers', disabled: false },
        { viewId: 'misc', disabled: false },
      ],
      selectedBook,
    );
  }
});

test('classifies numbered questions, singular/plural answers and only the four Misc files', () => {
  assert.deepEqual([
    '02 CC Microscopic World I.pdf',
    '03 CC Metals Answer.pdf',
    '03 CC Metals Answers.pdf',
    'List of Definition.pdf',
    'Paragraph Length Question.pdf',
    'Summary of Diagrams.pdf',
    'Ultimate Intensive Note.pdf',
    'Chemical Test for Cations and Anions.pdf',
    '123 Invalid.pdf',
    '03 CC Metals.png',
  ].map(classifyOtherLearningResource), [
    'questions', 'answers', 'answers', 'misc', 'misc', 'misc', 'misc', null, null, null,
  ]);
});

test('catalog sorts pages numerically, avoids duplicate formats and falls back to source PDFs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-reader-resources-'));
  try {
    const resourceRoot = path.join(root, 'other-learning-resources');
    const pages = path.join(resourceRoot, 'pages', '03 CC Metals');
    await mkdir(pages, { recursive: true });
    for (const file of ['03 CC Metals.pdf', '03 CC Metals Answer.pdf', 'List of Definition.pdf']) {
      await writeFile(path.join(resourceRoot, file), '');
    }
    for (const file of ['page-10.png', 'page-2.jpg', 'page-2.png', 'page-1.png', 'unrelated.png']) {
      await writeFile(path.join(pages, file), '');
    }
    const catalog = await getOtherLearningResources(root);
    assert.deepEqual(catalog, {
      questions: [{
        id: '03 CC Metals', name: '03 CC Metals', chapter: '3',
        source: [1, 2, 10].map((page) => `/pdf-reader/data/other-learning-resources/pages/03%20CC%20Metals/page-${page}.png`),
      }],
      answers: [{
        id: '03 CC Metals Answer', name: '03 CC Metals Answer', chapter: '3',
        source: '/pdf-reader/data/other-learning-resources/03%20CC%20Metals%20Answer.pdf',
      }],
      misc: [{
        id: 'List of Definition', name: 'List of Definition', chapter: '',
        source: '/pdf-reader/data/other-learning-resources/List%20of%20Definition.pdf',
      }],
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test('user selections persist years without replacing other subject fields', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  const routes = new Map();
  const document = { userId: 'test', selections: { chemistry: { untouched: true, pastPaperYear: '2020' } } };
  vm.runInNewContext(source.slice(
    source.indexOf("app.get('/api/user-selects'"),
    source.indexOf("app.post('/api/user-actions'"),
  ), {
    app: {
      get: (url, middleware, handler) => routes.set(`GET ${url}`, handler),
      post: (url, middleware, handler) => routes.set(`POST ${url}`, handler),
    },
    requireValidUserId: () => null,
    asyncRoute: (handler) => handler,
    hkNow: () => 'now',
    userSelects: {
      findOne: async () => document,
      updateOne: async (query, update) => {
        for (const [key, value] of Object.entries(update.$set)) {
          if (key.startsWith('selections.chemistry.')) document.selections.chemistry[key.split('.')[2]] = value;
          else document[key] = value;
        }
      },
    },
  });
  let result;
  const response = { json: (value) => { result = value; } };
  await routes.get('POST /api/user-selects')({
    validatedUserId: 'test',
    body: { subjectId: 'chemistry', bookId: '3', pastPaperYear: '2025', pastPaperLanguage: 'tc', pastPaperYearType: 'p1b' },
  }, response);
  // Older clients saving only textbook position must not erase the saved year.
  await routes.get('POST /api/user-selects')({
    validatedUserId: 'test', body: { subjectId: 'chemistry', bookId: '4' },
  }, response);
  await routes.get('GET /api/user-selects')({ validatedUserId: 'test' }, response);
  assert.deepEqual({ ...result.selections.chemistry }, {
    untouched: true, bookId: '4', sectionId: 1, pageId: 1, physicsChapterId: '',
    pastPaperYear: '2025', pastPaperLanguage: 'tc', pastPaperYearType: 'p1b',
  });
});

test('resource downloads include selected PDFs and reject paths outside the resource directory', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  let handler;
  let archivedNames;
  let result;
  vm.runInNewContext(source.slice(
    source.indexOf("app.get('/api/section-pdfs.zip'"),
    source.indexOf("app.get('/api/remarks'"),
  ), {
    app: { get: (url, callback) => { handler = callback; } },
    asyncRoute: (callback) => callback,
    DEFAULT_BOOK: 'chemistry-winter2',
    PATH_DATA: '/fixtures',
    getDataRoot: () => '/fixtures/textbooks',
    classifyOtherLearningResource,
    path,
    fs: { readFile: async (file) => Buffer.from(file) },
    console: { log: () => {} },
    buildStoredZip: (files) => {
      archivedNames = Array.from(files, (file) => file.name);
      return Buffer.from('zip');
    },
  });
  const response = {
    status: (code) => { result = code; return response; },
    json: (data) => { result = data; },
    setHeader: () => {},
    send: (data) => { result = data; },
  };
  await handler({ query: { resource: ['03 CC Metals', 'List of Definition'] } }, response);
  assert.deepEqual(archivedNames, ['03 CC Metals.pdf', 'List of Definition.pdf']);
  await handler({ query: { resource: '03/../../outside' } }, response);
  assert.equal(result.error, 'Invalid other learning resource');
});
