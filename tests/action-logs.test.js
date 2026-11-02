import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { parseActionLogQuery, readActionLogPage } from '../server/actionLogs.js';

test('log query defaults, limits and invalid parameters', () => {
  assert.deepEqual(parseActionLogQuery({}), {
    sort: 'datetime', direction: 'desc', search: '', limit: 50, cursor: null,
  });
  assert.equal(parseActionLogQuery({ search: ' cells ', limit: '100' }).search, 'cells');
  for (const query of [
    { sort: '$where' }, { direction: 'up' }, { search: ['a'] },
    { search: 'a'.repeat(201) }, { limit: '101' }, { limit: '0' }, { limit: '2.5' },
    { cursor: '{}' }, { cursor: ['bad'] },
  ]) {
    assert.throws(() => parseActionLogQuery(query), RangeError);
  }
});

test('cursor is bound to the search and sorting settings', () => {
  const value = { value: 'Cells', id: new ObjectId().toString(), sort: 'bookName', direction: 'asc', search: 'cell' };
  const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.deepEqual(parseActionLogQuery({ ...value, cursor }).cursor, value);
  for (const change of [{ search: 'other' }, { direction: 'desc' }, { sort: 'datetime' }]) {
    assert.throws(() => parseActionLogQuery({ ...value, ...change, cursor }), RangeError);
  }
});

test('GET logs requires authenticated identity and never enables userId fallback', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  let handler;
  let fallback;
  vm.runInNewContext(source.slice(
    source.indexOf("app.get(['/api/user-actions'"),
    source.indexOf("app.post('/api/user-actions'"),
  ), {
    app: { get: (route, middleware, callback) => { handler = callback; } },
    requireValidUserId: (...args) => { fallback = args; },
    asyncRoute: (callback) => callback,
    parseActionLogQuery,
    readActionLogPage: async (collection, userId) => ({ userId, items: [], nextCursor: null }),
    userActions: {},
    isValidUserId: (userId) => ['signed-in', 'alan', 'raymond'].includes(userId),
    console: { warn() {} },
    PATH_TEXTBOOKS: '/unused',
    RangeError,
  });
  assert.deepEqual(fallback, []);
  const response = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.data = value; },
  };
  await handler({ validatedUserId: 'signed-in', params: {}, query: { userId: 'other' } }, response);
  assert.equal(response.data.userId, 'signed-in');
  await handler({ validatedUserId: 'signed-in', params: {}, query: { sort: 'invalid' } }, response);
  assert.equal(response.statusCode, 400);
  await handler({ validatedUserId: 'alan', params: { userId: 'raymond' }, query: {} }, response);
  assert.equal(response.data.userId, 'raymond');
  await handler({ validatedUserId: 'signed-in', params: { userId: 'raymond' }, query: {} }, response);
  assert.equal(response.statusCode, 403);
  await handler({ validatedUserId: 'raymond', params: { userId: 'raymond' }, query: {} }, response);
  assert.equal(response.data.userId, 'raymond');
  await handler({ validatedUserId: 'alan', params: { userId: 'missing' }, query: {} }, response);
  assert.equal(response.statusCode, 404);
});

test('MongoDB pagination, catalog names, literal search and per-user isolation', {
  skip: !process.env.ACTION_LOGS_TEST_MONGODB_URI,
}, async () => {
  const client = new MongoClient(process.env.ACTION_LOGS_TEST_MONGODB_URI);
  const root = await mkdtemp(path.join(os.tmpdir(), 'pdf-reader-action-logs-'));
  let collection;
  try {
    await client.connect();
    collection = client.db('pdf-reader').collection(`test_action_logs_${new ObjectId()}`);
    await mkdir(path.join(root, 'biology', '1a'), { recursive: true });
    await writeFile(path.join(root, 'biology', '1a', 'contents.json'), JSON.stringify({
      nameEn: 'Cells',
      contents: [
        { page: 1, en: { name: 'Cell structure [A]' } },
        { page: 2, en: { name: 'Molecules' } },
        { page: 3, 'page-num': 1, en: { name: 'Introduction' } },
        { page: 3, 'page-num': 5, en: 'Detailed topic' },
      ],
    }));
    const docs = Array.from({ length: 123 }, (_, i) => ({
      _id: new ObjectId(), userId: 'logs-test', subjectId: 'biology', chapter: '1a',
      section: i % 2 ? '1' : '2', actionType: 'page_view_start',
      createdAt: `2026-11-02T10:${String(i % 60).padStart(2, '0')}:00.000+08:00`,
    }));
    docs.push(
      { _id: new ObjectId(), userId: 'other-user', subjectId: 'biology', createdAt: '2026-11-02T12:00:00+08:00' },
      { _id: new ObjectId(), userId: 'logs-test', subjectId: 'missing', chapter: '7', section: '3', createdAt: '2026-11-02T01:00:00Z' },
      { _id: new ObjectId(), userId: 'logs-test', subjectId: 'biology', createdAt: '2026-11-02T00:00:00Z', metadata: { chapter: '1a', section: '1', page: 9 } },
      { _id: new ObjectId(), userId: 'logs-test', bookName: 'book 10', sectionName: 'topic 10', createdAt: '2026-11-02T00:00:00Z' },
      { _id: new ObjectId(), userId: 'logs-test', bookName: 'book 2', sectionName: 'topic 2', createdAt: '2026-11-02T00:00:00Z' },
      { _id: new ObjectId(), userId: 'logs-test', subjectId: 'biology', chapter: '1a', section: '3', page: 5, createdAt: '2026-11-02T00:00:00Z' },
    );
    await collection.insertMany(docs);
    for (const sort of ['datetime', 'bookName', 'sectionName']) {
      for (const direction of ['asc', 'desc']) {
        const found = [];
        let cursor = null;
        do {
          const result = await readActionLogPage(collection, 'logs-test', root, parseActionLogQuery({
            sort, direction, limit: 17, ...(cursor ? { cursor } : {}),
          }));
          assert.ok(result.items.length <= 17);
          assert.ok(result.items.every((item) => item.userId === 'logs-test'));
          found.push(...result.items);
          cursor = result.nextCursor;
          assert.ok(found.length <= docs.length);
        } while (cursor);
        assert.equal(found.length, docs.length - 1);
        assert.equal(new Set(found.map((row) => row.id)).size, found.length);
        const comparator = new Intl.Collator('en', { sensitivity: 'accent', numeric: true });
        for (let i = 1; i < found.length; i++) {
          const previous = found[i - 1];
          const current = found[i];
          const comparison = sort === 'datetime'
            ? new Date(previous.createdAt) - new Date(current.createdAt)
            : comparator.compare(previous[sort], current[sort]);
          assert.ok(direction === 'asc' ? comparison <= 0 : comparison >= 0, `${sort} ${direction}`);
        }
        assert.equal(found.find((item) => item.subjectId === 'missing').bookName, '7');
        assert.equal(found.find((item) => item.metadata?.page === 9).page, 9);
        assert.equal(found.find((item) => item.page === 5).sectionName, 'Detailed topic');
      }
    }
    for (const search of ['cells', '[A]', 'Molecules', 'no matches', '.*']) {
      const result = await readActionLogPage(collection, 'logs-test', root, parseActionLogQuery({ search, limit: 100 }));
      if (['no matches', '.*'].includes(search)) assert.equal(result.items.length, 0);
      else assert.ok(result.items.length > 0);
      if (search === '[A]') assert.ok(result.items.every((item) => item.sectionName === 'Cell structure [A]'));
      if (search === 'cells') assert.ok(result.items.every((item) => item.bookName === '1A - Cells'));
    }
  } finally {
    if (collection) await collection.drop();
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
