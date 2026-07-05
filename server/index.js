import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3001;

const DATA_PATH = process.env.DATA_PATH || path.resolve(__dirname, '../data');
const DEFAULT_BOOK = process.env.DEFAULT_BOOK || 'biology-oup';
const ETT_MAX_IMAGE_DIM = 1536;   // max px on longest side for images sent to ETT/vLLM
const DSE_AUTH_CONFIG_PATH = process.env.DSE_AUTH_CONFIG_PATH || path.resolve(__dirname, '../../../dse-auth-config.php');

/** Return an ISO-8601 timestamp in Hong Kong time (UTC+8) */
function hkNow() {
  const now = Date.now() + 8 * 60 * 60 * 1000; // UTC + 8h = HKT
  const d = new Date(now);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
}

/** Resolve the data root for a given book ID */
function getDataRoot(book) {
  const safeBook = String(book || DEFAULT_BOOK).replace(/\.\./g, '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_PATH, safeBook || DEFAULT_BOOK);
}

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pdf-reader';
let mongoClient;
let aiGenerations;
let userActions;
let userSelects;
let annotationsCollection;

function normalizeStringId(value, fallback = '') {
  return String(value != null ? value : fallback).trim();
}

function normalizeNumberId(value) {
  return Number(value);
}

function normalizeAnnotationLangId(value) {
  return String(value || '').trim().toLowerCase() === 'tc' ? 'tc' : 'en';
}

async function listAnnotationRemarks(query) {
  const docs = await annotationsCollection.find(query).toArray();
  return docs
    .flatMap((doc) => (Array.isArray(doc.remarks) ? doc.remarks : []))
    .sort((left, right) => String(left?.createdAt || '').localeCompare(String(right?.createdAt || '')));
}

function buildAiIdentity({ subjectId, bookId, sectionId, pageId }) {
  const identity = {
    subjectId: normalizeStringId(subjectId, DEFAULT_BOOK),
    bookId: normalizeStringId(bookId),
    sectionId: normalizeNumberId(sectionId),
  };
  if (pageId != null) {
    identity.pageId = normalizeNumberId(pageId);
  }
  return identity;
}

function buildLegacyAiIdentity({ bookId, sectionId, pageId }) {
  const identity = {
    subjectId: { $exists: false },
    bookId: normalizeStringId(bookId),
    sectionId: normalizeNumberId(sectionId),
  };
  if (pageId != null) {
    identity.pageId = normalizeNumberId(pageId);
  }
  return identity;
}

function parseAiRequestIdentity(source, { includePage = true } = {}) {
  const subjectId = source?.subjectId ?? source?.subject ?? source?.book ?? DEFAULT_BOOK;
  const bookId = source?.bookId ?? source?.chapter;
  const sectionId = source?.sectionId ?? source?.section;
  const pageId = includePage ? (source?.pageId ?? source?.page) : undefined;
  return buildAiIdentity({ subjectId, bookId, sectionId, pageId });
}

async function buildBookSubjectIndex() {
  const index = new Map();
  const subjectEntries = await fs.readdir(DATA_PATH, { withFileTypes: true });
  for (const subjectEntry of subjectEntries) {
    if (!subjectEntry.isDirectory()) continue;
    const subjectId = subjectEntry.name;
    const subjectDir = path.join(DATA_PATH, subjectId);
    let bookEntries = [];
    try {
      bookEntries = await fs.readdir(subjectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const bookEntry of bookEntries) {
      if (!bookEntry.isDirectory()) continue;
      const bucket = index.get(bookEntry.name) || new Set();
      bucket.add(subjectId);
      index.set(bookEntry.name, bucket);
    }
  }
  return index;
}

async function migrateAiGenerationSubjectIds() {
  if (!aiGenerations) return;
  const bookSubjectIndex = await buildBookSubjectIndex();
  const docs = await aiGenerations.find({ subjectId: { $exists: false }, bookId: { $type: 'string' } }).toArray();
  let migrated = 0;
  let unresolved = 0;
  for (const doc of docs) {
    const matches = [...(bookSubjectIndex.get(String(doc.bookId || '')) || [])];
    if (matches.length !== 1) {
      unresolved += 1;
      continue;
    }
    await aiGenerations.updateOne({ _id: doc._id }, { $set: { subjectId: matches[0] } });
    migrated += 1;
  }
  if (migrated || unresolved) {
    console.log(`[mongo] ai-generations subjectId migration: migrated=${migrated} unresolved=${unresolved}`);
  }
}

async function findAiGenerationDocument(identity) {
  if (!aiGenerations) return null;
  let doc = await aiGenerations.findOne(identity, { sort: { updatedAt: -1 } });
  if (doc) return doc;
  const legacyQuery = buildLegacyAiIdentity(identity);
  doc = await aiGenerations.findOne(legacyQuery, { sort: { updatedAt: -1 } });
  if (doc) {
    await aiGenerations.updateOne({ _id: doc._id }, { $set: { subjectId: identity.subjectId } });
    doc.subjectId = identity.subjectId;
  }
  return doc;
}

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db('pdf-reader');
    aiGenerations = db.collection('ai-generations');
    userActions = db.collection('user-actions');
    userSelects = db.collection('user-selects');
    annotationsCollection = db.collection('annotations');
    await migrateAiGenerationSubjectIds();
    await aiGenerations.createIndex(
      { subjectId: 1, bookId: 1, sectionId: 1, pageId: 1 },
      { unique: true, name: 'ai_generations_identity_unique' }
    );
    await aiGenerations.createIndex(
      { subjectId: 1, bookId: 1, sectionId: 1, updatedAt: -1 },
      { name: 'ai_generations_lookup' }
    );
    await userSelects.createIndex(
      { userId: 1 },
      { unique: true, name: 'user_selects_user_unique' }
    );
    try {
      await annotationsCollection.dropIndex('annotations_identity_unique');
    } catch {}
    await annotationsCollection.createIndex(
      { userId: 1, subjectId: 1, bookId: 1, sectionId: 1, pageId: 1, langId: 1 },
      { unique: true, name: 'annotations_identity_lang_unique' }
    );
    await annotationsCollection.createIndex(
      { userId: 1, subjectId: 1, bookId: 1, sectionId: 1, pageId: 1 },
      { name: 'annotations_page_lookup' }
    );
    console.log('[mongo] connected to', MONGO_URI.replace(/\/\/.*@/, '//<credentials>@'));
  } catch (err) {
    console.warn('[mongo] connection failed, AI content persistence disabled:', err.message);
  }
}

console.log('[server] DATA_PATH:', DATA_PATH);
console.log('[server] DEFAULT_BOOK:', DEFAULT_BOOK);

app.use(express.json({ limit: '2mb' }));

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

async function readJSON(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

let dseAuthConfigCache;

function loadDseAuthConfig() {
  if (dseAuthConfigCache !== undefined) {
    return dseAuthConfigCache;
  }

  try {
    const text = readFileSync(DSE_AUTH_CONFIG_PATH, 'utf8');
    const cookieNameMatch = text.match(/'cookie_name'\s*=>\s*'([^']+)'/);
    const cookieSecretMatch = text.match(/'cookie_secret'\s*=>\s*'([^']+)'/);
    dseAuthConfigCache = {
      cookieName: cookieNameMatch?.[1] || 'dse_auth',
      cookieSecret: cookieSecretMatch?.[1] || '',
    };
  } catch {
    dseAuthConfigCache = { cookieName: 'dse_auth', cookieSecret: '' };
  }

  return dseAuthConfigCache;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) {
    return cookies;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    const rawValue = rawValueParts.join('=').trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }

  return cookies;
}

function decodeDseAuthUserId(request) {
  const { cookieName, cookieSecret } = loadDseAuthConfig();
  if (!cookieSecret) {
    return '';
  }

  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[cookieName];
  if (!token) {
    return '';
  }

  try {
    const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) {
      return '';
    }
    const [username, expires, signature] = parts;
    if (!username || !/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) {
      return '';
    }
    const payload = `${username}|${expires}`;
    const expectedSignature = crypto.createHmac('sha256', cookieSecret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return '';
    }
    return username;
  } catch {
    return '';
  }
}

function getAuthenticatedUserId(request) {
  const cookieUserId = decodeDseAuthUserId(request);
  if (cookieUserId) {
    return cookieUserId;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Basic\s+(.+)$/i);
    if (match) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const username = decoded.split(':', 1)[0]?.trim();
        if (username) {
          return username;
        }
      } catch {
        // Ignore malformed Authorization headers and keep falling back.
      }
    }
  }

  const candidates = [
    request.headers['x-remote-user'],
    request.headers['remote-user'],
    request.headers['x-forwarded-user'],
    request.headers['x-authenticated-user'],
    request.headers.remote_user,
    process.env.REMOTE_USER,
  ];
  const resolved = candidates.find((value) => typeof value === 'string' && value.trim());
  return resolved ? resolved.trim() : '';
}

async function logUserAction(action) {
  if (!userActions || !action || typeof action !== 'object') {
    return false;
  }

  const payload = {
    ...action,
    createdAt: hkNow(),
  };

  if (!payload.userId || typeof payload.userId !== 'string') {
    return false;
  }

  await userActions.insertOne(payload);
  return true;
}

function formatBookLabel(bookId, bookName) {
  const normalizedId = String(bookId || '').trim();
  const upperId = normalizedId.toUpperCase();
  const normalizedName = typeof bookName === 'string' ? bookName.trim() : '';

  if (!upperId) {
    return normalizedName;
  }

  return normalizedName ? `${upperId} - ${normalizedName}` : upperId;
}

function getBookNamesFromContents(contents = {}) {
  const nameEn = typeof contents.nameEn === 'string' && contents.nameEn.trim()
    ? contents.nameEn.trim()
    : (typeof contents.name === 'string' ? contents.name.trim() : '');
  const nameZh = typeof contents.nameZh === 'string' ? contents.nameZh.trim() : '';
  return { nameEn, nameZh };
}

function compareNaturalIds(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  const pattern = /^(\d+)([a-z]*)$/i;
  const matchA = a.match(pattern);
  const matchB = b.match(pattern);

  if (matchA && matchB) {
    const numDiff = Number(matchA[1]) - Number(matchB[1]);
    if (numDiff !== 0) return numDiff;
    return matchA[2].localeCompare(matchB[2], undefined, { sensitivity: 'base' });
  }
  if (matchA) return -1;
  if (matchB) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

app.get('/api/session-user', (request, response) => {
  response.json({ userId: getAuthenticatedUserId(request) });
});

app.get('/api/user-selects', asyncRoute(async (request, response) => {
  const authenticatedUserId = getAuthenticatedUserId(request);
  const userId = String(request.query.userId || authenticatedUserId || '').trim();
  if (!userId) {
    response.status(400).json({ error: 'userId is required' });
    return;
  }
  if (!userSelects) {
    response.json({ userId, lastSubjectId: '', selections: {} });
    return;
  }
  const doc = await userSelects.findOne({ userId });
  response.json({
    userId,
    lastSubjectId: typeof doc?.lastSubjectId === 'string' ? doc.lastSubjectId : '',
    selections: doc?.selections && typeof doc.selections === 'object' ? doc.selections : {},
    updatedAt: doc?.updatedAt || null,
  });
}));

app.post('/api/user-selects', asyncRoute(async (request, response) => {
  const authenticatedUserId = getAuthenticatedUserId(request);
  const body = request.body || {};
  const userId = String(body.userId || authenticatedUserId || '').trim();
  const subjectId = String(body.subjectId || body.lastSubjectId || '').trim();
  if (!userId || !subjectId) {
    response.status(400).json({ error: 'userId and subjectId are required' });
    return;
  }
  if (!userSelects) {
    response.status(500).json({ error: 'MongoDB not connected' });
    return;
  }
  const now = hkNow();
  const selection = {
    bookId: body.bookId != null ? String(body.bookId) : '',
    sectionId: body.sectionId != null ? Number(body.sectionId) : 1,
    pageId: body.pageId != null ? Number(body.pageId) : 1,
    physicsChapterId: body.physicsChapterId != null ? String(body.physicsChapterId) : '',
  };
  await userSelects.updateOne(
    { userId },
    {
      $set: {
        lastSubjectId: String(body.lastSubjectId || subjectId),
        [`selections.${subjectId}`]: selection,
        updatedAt: now,
      },
      $setOnInsert: {
        userId,
        createdAt: now,
      },
    },
    { upsert: true }
  );
  response.json({ ok: true });
}));

app.post('/api/user-actions', asyncRoute(async (request, response) => {
  const authenticatedUserId = getAuthenticatedUserId(request);
  const body = request.body || {};
  const userId = String(body.userId || authenticatedUserId || '').trim();
  if (!userId) {
    response.status(400).json({ error: 'userId is required' });
    return;
  }

  const actionType = String(body.actionType || '').trim();
  if (!actionType) {
    response.status(400).json({ error: 'actionType is required' });
    return;
  }

  await logUserAction({
    userId,
    actionType,
    chapter: body.chapter != null ? String(body.chapter) : undefined,
    section: body.section != null ? String(body.section) : undefined,
    page: body.page != null ? Number(body.page) : undefined,
    language: body.language != null ? String(body.language) : undefined,
    durationMs: body.durationMs != null ? Number(body.durationMs) : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    source: 'pdf-reader-frontend',
  });

  response.json({ ok: true });
}));

app.post('/api/user-actions/logout', asyncRoute(async (request, response) => {
  const userId = String(getAuthenticatedUserId(request) || request.body?.userId || '').trim();
  if (!userId) {
    response.status(400).json({ error: 'userId is required' });
    return;
  }

  await logUserAction({
    userId,
    actionType: 'logout',
    source: 'pdf-reader-backend',
    metadata: request.body?.metadata && typeof request.body.metadata === 'object' ? request.body.metadata : undefined,
  });

  response.json({ ok: true });
}));

app.get('/api/catalog', asyncRoute(async (request, response) => {
  const requestedBook = request.query.book || DEFAULT_BOOK;
  const dataRoot = getDataRoot(requestedBook);
  console.log('[catalog] dataRoot:', dataRoot);
  if (!existsSync(dataRoot)) {
    response.status(500).json({ error: `Data root not found: ${dataRoot}` });
    return;
  }
  const activeBookId = path.basename(dataRoot);
  const dataFolders = await fs.readdir(DATA_PATH, { withFileTypes: true });
  const books = dataFolders
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareNaturalIds);
  const folders = (await fs.readdir(dataRoot, { withFileTypes: true }))
    .sort((a, b) => compareNaturalIds(a.name, b.name));
  console.log('[catalog] folders found:', folders.map(f => f.name));
  const chapters = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const contentsPath = path.join(dataRoot, entry.name, 'contents.json');
        console.log('[catalog] reading:', contentsPath);
        const contents = await readJSON(contentsPath, { contents: [] });
        const sections = (contents.contents || []).length;
        console.log(`[catalog]   ${entry.name}: ${sections} sections`);
        const { nameEn, nameZh } = getBookNamesFromContents(contents);
        return {
          id: entry.name,
          name: formatBookLabel(entry.name, nameEn || nameZh),
          nameEn,
          nameZh,
          contents: contents.contents || []
        };
      })
  );
  console.log('[catalog] returning', chapters.length, 'chapters');
  response.json({ chapters, books, activeBookId });
}));

app.get('/api/page', asyncRoute(async (request, response) => {
  const requestedBook = request.query.book || DEFAULT_BOOK;
  const dataRoot = getDataRoot(requestedBook);
  const { chapter, language, page } = request.query;
  console.log(`[page] request: book=${requestedBook} chapter=${chapter} language=${language} page=${page}`);
  const langDir = path.join(dataRoot, String(chapter), String(language));
  const pagesDir = path.join(langDir, 'contents', 'pages');
  console.log(`[page] langDir=${langDir} pagesDir=${pagesDir}`);

  // ── Try split page images first ───────────────────────────
  try {
    const files = await fs.readdir(pagesDir);
    const prefix = `${String(page)}-`;
    console.log(`[page] ${files.length} files in pages/, looking for prefix "${prefix}"`);
    const images = files
      .filter((f) => f.startsWith(prefix) && /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort((a, b) => {
        const an = parseInt(a.slice(prefix.length).split('.')[0], 10) || 0;
        const bn = parseInt(b.slice(prefix.length).split('.')[0], 10) || 0;
        return an - bn;
      })
      .map((f) => `/pdf-reader/data/${requestedBook}/${chapter}/${language}/contents/pages/${f}`);

    if (images.length > 0) {
      console.log(`[page] → returning ${images.length} images (first: ${images[0]})`);
      response.json({ images });
      return;
    }
    console.log(`[page] no images matched prefix "${prefix}"`);
  } catch (err) {
    console.log(`[page] pages/ dir error: ${err.message}`);
  }

  // ── Fallback: single PDF ──────────────────────────────────
  // Try exact match first, then prefix match (e.g. "1.1" matches "1.1-sba-157.pdf")
  const contentsDir = path.join(langDir, 'contents');
  let pdfUrl = '';
  try {
    const dirFiles = await fs.readdir(contentsDir);
    const exactMatch = `${String(page)}.pdf`;
    if (dirFiles.includes(exactMatch)) {
      pdfUrl = `/pdf-reader/data/${requestedBook}/${chapter}/${language}/contents/${exactMatch}`;
    } else {
      const prefixMatch = dirFiles.find(
        (f) => f.startsWith(`${String(page)}-`) && f.endsWith('.pdf')
      );
      if (prefixMatch) {
        pdfUrl = `/pdf-reader/data/${requestedBook}/${chapter}/${language}/contents/${prefixMatch}`;
      }
    }
  } catch { /* ignore */ }

  if (pdfUrl) {
    console.log(`[page] → returning PDF: ${pdfUrl}`);
    response.json({ url: pdfUrl });
  } else {
    console.log('[page] PDF not found for page:', page);
    response.json({ url: '' });
  }
}));

app.get('/api/remarks', asyncRoute(async (request, response) => {
  const userId = String(request.query.userId || '').trim();
  if (!annotationsCollection || !userId) {
    response.json({ remarks: [] });
    return;
  }
  const query = { userId };
  if (request.query.subjectId != null) query.subjectId = String(request.query.subjectId);
  if (request.query.bookId != null) query.bookId = String(request.query.bookId);
  if (request.query.sectionId != null) query.sectionId = Number(request.query.sectionId);
  if (request.query.pageId != null) query.pageId = Number(request.query.pageId);
  if (request.query.langId != null) query.langId = normalizeAnnotationLangId(request.query.langId);
  response.json({ remarks: await listAnnotationRemarks(query) });
}));

app.post('/api/remarks', asyncRoute(async (request, response) => {
  try {
    const { userId, subjectId, bookId, sectionId, pageId, langId, ...remark } = request.body || {};
    if (!annotationsCollection) {
      response.status(500).json({ error: 'MongoDB not connected', remarks: [] });
      return;
    }
    const identity = {
      userId: String(userId || '').trim(),
      subjectId: String(subjectId || '').trim(),
      bookId: String(bookId || '').trim(),
      sectionId: Number(sectionId),
      pageId: Number(pageId),
      langId: normalizeAnnotationLangId(langId),
    };
    const current = await annotationsCollection.findOne(identity);
    const remarks = [...(current?.remarks || []), { ...remark, langId: identity.langId }];
    await annotationsCollection.updateOne(
      identity,
      {
        $set: { remarks, updatedAt: hkNow() },
        $setOnInsert: { ...identity, createdAt: hkNow() },
      },
      { upsert: true }
    );
    response.json({ remarks: await listAnnotationRemarks({
      userId: identity.userId,
      subjectId: identity.subjectId,
      bookId: identity.bookId,
      sectionId: identity.sectionId,
      pageId: identity.pageId,
    }) });
  } catch (err) {
    console.error('[remarks] POST error:', err.message);
    response.status(500).json({ error: 'Failed to save remark', remarks: [] });
  }
}));

app.delete('/api/remarks', asyncRoute(async (request, response) => {
  try {
    if (!annotationsCollection) {
      response.status(500).json({ error: 'MongoDB not connected', remarks: [] });
      return;
    }
    const { userId, subjectId, bookId, sectionId, pageId, createdAt, langId } = request.query;
    const identity = {
      userId: String(userId || '').trim(),
      subjectId: String(subjectId || '').trim(),
      bookId: String(bookId || '').trim(),
      sectionId: Number(sectionId),
    };
    const resolvedLangId = langId != null ? normalizeAnnotationLangId(langId) : null;
    if (createdAt != null) {
      const pageIdentity = {
        ...identity,
        pageId: Number(pageId),
      };
      const pageQueries = resolvedLangId != null
        ? [{ ...pageIdentity, langId: resolvedLangId }]
        : await annotationsCollection.find(pageIdentity, { projection: { langId: 1 } }).toArray();
      for (const query of pageQueries) {
        const scopedIdentity = resolvedLangId != null ? query : { ...pageIdentity, langId: query.langId };
        const current = await annotationsCollection.findOne(scopedIdentity);
        const remarks = (current?.remarks || []).filter((remark) => String(remark.createdAt || '') !== String(createdAt));
        if ((current?.remarks || []).length === remarks.length) {
          continue;
        }
        if (remarks.length > 0) {
          await annotationsCollection.updateOne(scopedIdentity, {
            $set: { remarks, updatedAt: hkNow() },
          });
        } else {
          await annotationsCollection.deleteOne(scopedIdentity);
        }
      }
      response.json({ remarks: await listAnnotationRemarks(pageIdentity) });
      return;
    }
    if (pageId != null) {
      identity.pageId = Number(pageId);
      if (resolvedLangId != null) {
        identity.langId = resolvedLangId;
        await annotationsCollection.deleteOne(identity);
        response.json({ remarks: await listAnnotationRemarks({
          userId: identity.userId,
          subjectId: identity.subjectId,
          bookId: identity.bookId,
          sectionId: identity.sectionId,
          pageId: identity.pageId,
        }) });
        return;
      }
      await annotationsCollection.deleteMany(identity);
      response.json({ remarks: [] });
      return;
    }
    await annotationsCollection.deleteMany(identity);
    response.json({ remarks: [] });
  } catch (err) {
    console.error('[remarks] DELETE error:', err);
    response.status(500).json({ error: 'Failed to erase remarks' });
  }
}));

// ── Proxy for OUP resources (bypasses X-Frame-Options) ──────
const ALLOWED_PROXY_HOSTS = [
  'eresources.oupchina.com.hk',
  'isolution.oupchina.com.hk',
];

app.get('/api/proxy', async (request, response) => {
  try {
    const targetUrl = request.query.url;
    if (!targetUrl) {
      return response.status(400).send('Missing ?url=');
    }

    const parsed = new URL(targetUrl);
    if (!ALLOWED_PROXY_HOSTS.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return response.status(403).send('Host not allowed');
    }

    const upstream = await fetch(targetUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Book reader Proxy/1.0' },
    });

    const contentType = upstream.headers.get('content-type') || '';

    response.status(upstream.status);

    // Forward content-type and CORS-friendly headers
    if (contentType) {
      response.setHeader('Content-Type', contentType);
    }
    response.setHeader('X-Frame-Options', 'SAMEORIGIN'); // allow iframe on our domain

    if (contentType.includes('text/html')) {
      let html = await upstream.text();
      // Inject <base> so relative CSS/JS/images still load from original host
      const baseTag = `<base href="${parsed.origin}/">`;
      html = html.replace(/<head[^>]*>/i, (match) => match + baseTag);
      // Prepend stub at very start so it runs before ANY OUP script
      const stub = `<script>window.ispring=window.ispring||{presenter:{player:{play:function(){}},navigator:{}}};</script>`;
      html = stub + html;
      response.send(html);
    } else {
      // Stream binary/image/CSS/JS directly
      const buf = await upstream.arrayBuffer();
      response.send(Buffer.from(buf));
    }
  } catch (err) {
    console.error('[proxy] error:', err.message);
    response.status(502).send('Proxy error');
  }
});

// Serve built frontend (production) — disable cache for HTML
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.use('/data', express.static(path.resolve(__dirname, '../data')));
app.use('/pdf-reader/data', express.static(path.resolve(__dirname, '../data')));

// ── AI Generation ─────────────────────────────────────────

const AIGATEWAY_URL = process.env.AIGATEWAY_API_URL || 'https://aigateway.aied.hku.hk/api/generate';
const AIGATEWAY_PROVIDER = process.env.AIGATEWAY_PROVIDER || 'ett';
const AIGATEWAY_MODEL = process.env.AIGATEWAY_MODEL || 'vllm|OpenGVLab/InternVL3_5-38B';
const AIGATEWAY_APIKEY = process.env.AIGATEWAY_APIKEY || '';
const BILINGUAL_ALIGNMENT_VERSION = 1;

/** Resize an image to fit within ETT_MAX_IMAGE_DIM on the longest side.
 *  Returns { buffer, contentType }.  Keeps originals intact — only resizes
 *  the copy sent to the gateway. */
async function resizeForEtt(imagePath) {
  const metadata = await sharp(imagePath).metadata();
  const longest = Math.max(metadata.width, metadata.height);
  if (longest <= ETT_MAX_IMAGE_DIM) {
    const buf = await sharp(imagePath).jpeg({ quality: 85 }).toBuffer();
    return { buffer: buf, contentType: 'image/jpeg' };
  }
  const ratio = ETT_MAX_IMAGE_DIM / longest;
  const newWidth = Math.round(metadata.width * ratio);
  const newHeight = Math.round(metadata.height * ratio);
  console.log(`[resize] ${path.basename(imagePath)}: ${metadata.width}x${metadata.height} → ${newWidth}x${newHeight}`);
  const buf = await sharp(imagePath)
    .resize(newWidth, newHeight, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { buffer: buf, contentType: 'image/jpeg' };
}

/** Find split page image files for a given section within a chapter/language */
async function findPageImages(dataRoot, chapter, language, section) {
  const langDir = path.join(dataRoot, String(chapter), String(language));
  const pagesDir = path.join(langDir, 'contents', 'pages');
  const results = [];

  // Try split page images first
  try {
    const files = await fs.readdir(pagesDir);
    const prefix = `${String(section)}-`;
    const images = files
      .filter((f) => f.startsWith(prefix) && /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort((a, b) => {
        const an = parseInt(a.slice(prefix.length).split('.')[0], 10) || 0;
        const bn = parseInt(b.slice(prefix.length).split('.')[0], 10) || 0;
        return an - bn;
      })
      .map((f) => path.join(pagesDir, f));
    results.push(...images);
  } catch { /* no split images */ }

  // Fallback: single image with exact page name
  if (results.length === 0) {
    const imgDir = path.join(langDir, 'contents');
    const candidates = ['png', 'jpg', 'jpeg', 'webp'];
    for (const ext of candidates) {
      const imgPath = path.join(imgDir, `${String(section)}.${ext}`);
      if (existsSync(imgPath)) {
        results.push(imgPath);
        break;
      }
    }
  }

  console.log(`[ai-generate] findPageImages: chapter=${chapter} lang=${language} section=${section} → ${results.length} image(s)`);
  if (results.length > 0) {
    console.log(`[ai-generate]   ${results.join(', ')}`);
  }
  return results;
}

/** Build the AI prompt for flash card and MCQ generation */
function buildGenerationPrompt(chapter, sectionName, pageNum, language, extractedText) {
  const langInstruction = language === 'tc'
    ? '所有內容必須使用繁體中文（Traditional Chinese, NOT Simplified Chinese）。問題和答案都要用繁體中文書寫。'
    : 'All content must be in English.';

  return `You are an expert biology educator. Using ONLY the textbook content provided below (do NOT use any outside knowledge), generate learning materials to help a student study this specific page.

The content is from:
- Chapter: ${chapter}
- Section: ${sectionName}
- Page: ${pageNum}

${langInstruction}

--- TEXTBOOK CONTENT (use ONLY this) ---
${extractedText.slice(0, 3000)}
--- END CONTENT ---

IMPORTANT: Base every question and answer STRICTLY on the provided content. Do not introduce concepts, facts, or terminology not found in the content above.

Generate in JSON:
1. A bullet-point summary of the key concepts on this page (3-6 bullet points as an array of strings)
2. 4-6 flashcards (each with "question" and "answer")
3. 3-5 MCQ questions (each with "question", 4 "options" labeled A-D, "correct" letter, and "explanation")

Output ONLY the JSON object, no markdown:
{
  "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
  "flashcards": [{"question":"...","answer":"..."}],
  "mcq": [{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A","explanation":"..."}]
}`;
}

function buildTranslationPrompt(chapter, sectionName, pageNum, targetLanguage, sourceContent, referenceText) {
  const langInstruction = targetLanguage === 'tc'
    ? 'Translate everything into Traditional Chinese (繁體中文, NOT Simplified Chinese 简体中文).'
    : 'Translate everything into English.';

  return `You are an expert bilingual biology educator. Translate the study materials below while preserving the meaning EXACTLY.

The content is from:
- Chapter: ${chapter}
- Section: ${sectionName}
- Page: ${pageNum}

${langInstruction}

IMPORTANT REQUIREMENTS:
- The translated English and Chinese versions must match in meaning item-by-item.
- Keep the SAME number of summary bullet points, flashcards, and MCQ questions.
- Preserve the SAME ordering for all arrays.
- summary[i] in the output must match summary[i] in the source by meaning.
- flashcards[i] in the output must match flashcards[i] in the source by meaning.
- mcq[i] in the output must match mcq[i] in the source by meaning.
- Keep exactly 4 options for each MCQ, labeled A-D.
- Keep the SAME correct answer letter as the source.
- Use textbook terminology from the reference text when available.
- Output ONLY valid JSON, no markdown.

--- REFERENCE TEXTBOOK TEXT ---
${(referenceText || '').slice(0, 3000)}
--- END REFERENCE TEXTBOOK TEXT ---

--- SOURCE STUDY MATERIALS JSON ---
${JSON.stringify(sourceContent)}
--- END SOURCE STUDY MATERIALS JSON ---

Output ONLY the translated JSON object in this schema:
{
  "summary": ["translated bullet point 1", "translated bullet point 2"],
  "flashcards": [{"question":"...","answer":"..."}],
  "mcq": [{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A","explanation":"..."}]
}`;
}

class AiGenerationError extends Error {
  constructor(message, debug = {}) {
    super(message);
    this.name = 'AiGenerationError';
    this.debug = debug;
  }
}

function extractTextFromGatewayResponse(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    const parts = [];
    if (Array.isArray(parsed.files)) {
      parts.push(...parsed.files.map((file) => file?.text || '').filter(Boolean));
    }
    if (typeof parsed.text === 'string') parts.push(parsed.text);
    if (typeof parsed.content === 'string') parts.push(parsed.content);
    if (typeof parsed.response === 'string') parts.push(parsed.response);
    if (typeof parsed.masterSummary === 'string') parts.push(parsed.masterSummary);
    return parts.join('\n\n').trim();
  } catch {
    return rawText.trim();
  }
}

function formatLanguageDebug(debugMap) {
  return Object.entries(debugMap)
    .map(([language, value]) => `=== ${language} ===\n${value || '[empty]'}`)
    .join('\n\n');
}

function parseGeneratedContent(genText) {
  try {
    const parsed = JSON.parse(genText);

    if (parsed.response && typeof parsed.response === 'string') {
      const cleaned = parsed.response.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          const fixed = jsonMatch[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          try {
            return JSON.parse(fixed);
          } catch {
            return { raw: cleaned };
          }
        }
      }
      return { raw: cleaned };
    }

    if (parsed.details) {
      try {
        const details = typeof parsed.details === 'string' ? JSON.parse(parsed.details) : parsed.details;
        if (details.error?.message) throw new Error(details.error.message);
      } catch (e) {
        if (e.message && !e.message.startsWith('AI Gateway')) throw e;
      }
      return { raw: genText };
    }

    if (parsed.choices?.[0]?.message?.content) {
      const content = parsed.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: content };
    }

    if (parsed.flashcards || parsed.mcq) {
      return parsed;
    }

    if (parsed.files && Array.isArray(parsed.files)) {
      const genContent = parsed.files.map((f) => f.text || '').join('\n\n');
      const jsonMatch = genContent.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: genContent };
    }

    if (typeof parsed.text === 'string') {
      const jsonMatch = parsed.text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: parsed.text };
    }

    if (typeof parsed.content === 'string') {
      const jsonMatch = parsed.content.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: parsed.content };
    }

    return { raw: genText };
  } catch {
    let collected = '';
    for (const line of genText.split('\n')) {
      if (line.startsWith('data: ')) {
        const chunk = line.slice(6).trim();
        if (chunk && chunk !== '[DONE]') {
          try {
            const parsedChunk = JSON.parse(chunk);
            if (parsedChunk.choices?.[0]?.delta?.content) collected += parsedChunk.choices[0].delta.content;
            else if (parsedChunk.choices?.[0]?.message?.content) collected += parsedChunk.choices[0].message.content;
            else if (typeof parsedChunk.content === 'string') collected += parsedChunk.content;
          } catch {
            // ignore malformed SSE chunk
          }
        }
      }
    }
    if (collected) {
      const jsonMatch = collected.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: collected };
    }
    const jsonMatch = genText.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: genText };
  }
}

async function runGenerationPrompt(prompt) {
  const genModel = AIGATEWAY_MODEL.includes('|') ? AIGATEWAY_MODEL.split('|').slice(1).join('|') : AIGATEWAY_MODEL;
  const genFormData = new FormData();
  genFormData.append('provider', 'vllm');
  genFormData.append('apiKey', AIGATEWAY_APIKEY);
  genFormData.append('model', genModel);
  genFormData.append('prompt', prompt);
  genFormData.append('max_tokens', '500');

  const genController = new AbortController();
  const genTimeoutId = setTimeout(() => genController.abort(), 120000);

  let genResponse;
  try {
    genResponse = await fetch(AIGATEWAY_URL, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: genFormData,
      signal: genController.signal,
    });
  } finally {
    clearTimeout(genTimeoutId);
  }

  if (!genResponse.ok) {
    const errText = await genResponse.text();
    throw new Error(`AI Gateway generation error: ${genResponse.status} — ${errText.slice(0, 300)}`);
  }

  const genText = await genResponse.text();
  return { content: parseGeneratedContent(genText), raw: genText };
}

async function extractPageText(dataRoot, chapter, sectionNum, page, language) {
  const sectionImages = await findPageImages(dataRoot, chapter, language, sectionNum);
  console.log(`[ai-generate] ${language}: found ${sectionImages.length} section images`);

  if (sectionImages.length === 0) {
    throw new AiGenerationError(`No page images found for language=${language}`, {
      extractionRaw: '[no page images found]',
      generationRaw: '[generation not attempted]',
      extractionMethod: 'none',
    });
  }

  const visiblePageIndex = Math.max(1, Number(page) || 1) - 1;
  const selectedImages = sectionImages.length > 1
    ? [sectionImages[Math.min(visiblePageIndex, sectionImages.length - 1)]]
    : sectionImages;
  const debug = {
    extractionRaw: '',
    generationRaw: '[generation not attempted]',
    extractionMethod: 'gateway',
  };

  const extractPrompt = language === 'tc'
    ? '從這些教科書頁面圖像中提取並轉錄所有文字內容。包括所有標題、正文和圖片說明。必須用繁體中文（Traditional Chinese）輸出，不要使用簡體中文（Simplified Chinese）。'
    : 'Extract and transcribe all text content from these textbook page images. Include all headings, body text, and captions.';

  const formData = new FormData();
  formData.append('provider', AIGATEWAY_PROVIDER);
  formData.append('apiKey', AIGATEWAY_APIKEY);
  formData.append('model', AIGATEWAY_MODEL);
  formData.append('wordCount', '3000');
  formData.append('prompt', extractPrompt);

  for (const imgPath of selectedImages) {
    const { buffer, contentType } = await resizeForEtt(imgPath);
    const filename = path.basename(imgPath).replace(/\.(png|jpg|jpeg|webp)$/i, '.jpg');
    formData.append('files', new Blob([buffer], { type: contentType }), filename);
  }

  console.log(`[ai-generate] ${language}: sending ${selectedImages.length} image(s) for extraction`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  let aiResponse;
  try {
    aiResponse = await fetch(AIGATEWAY_URL, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: formData,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!aiResponse.ok) {
    const errText = await aiResponse.text();
    throw new AiGenerationError(`AI Gateway extraction error (${language}): ${aiResponse.status} — ${errText.slice(0, 300)}`, debug);
  }

  const text = await aiResponse.text();
  debug.extractionRaw = text;
  console.log(`[ai-generate] ${language}: extraction response length=${text.length}`);

  let extractedText = extractTextFromGatewayResponse(text);
  console.log(`[ai-generate] ${language}: extracted text length=${extractedText.length}`);

  if (!extractedText.trim()) {
    console.log(`[ai-generate] ${language}: ERROR — no text extracted`);
    console.log(`[ai-generate] ${language}: request payload:`);
    console.log(`[ai-generate] ${language}: ${JSON.stringify({ provider: AIGATEWAY_PROVIDER, model: AIGATEWAY_MODEL, prompt: extractPrompt.slice(0, 200), wordCount: '3000', images: selectedImages }, null, 2)}`);
    console.log(`[ai-generate] ${language}: raw response (${text.length} bytes):`);
    console.log(`[ai-generate] ${language}: ${text.slice(0, 2000)}`);
    throw new AiGenerationError(`No text could be extracted for language=${language}`, debug);
  }

  return { extractedText, debug, selectedImages };
}

/** Generate flashcards & MCQs for a single language. Returns the parsed content object. */
async function generateForLanguage(dataRoot, chapter, sectionNum, page, language, sectionName) {
  const extraction = await extractPageText(dataRoot, chapter, sectionNum, page, language);
  const genPrompt = buildGenerationPrompt(chapter, sectionName || '', page || 1, language, extraction.extractedText);
  console.log(`[ai-generate] ${language}: calling generation...`);
  const generated = await runGenerationPrompt(genPrompt);
  console.log(`[ai-generate] ${language}: gen response length=${generated.raw.length}`);
  return {
    content: generated.content,
    debug: {
      ...extraction.debug,
      generationRaw: generated.raw,
    },
  };
}

async function translateGeneratedContent(chapter, sectionName, page, targetLanguage, sourceContent, referenceText, debug = {}) {
  console.log(`[ai-generate] ${targetLanguage}: translating generated content to aligned ${targetLanguage} version...`);
  const prompt = buildTranslationPrompt(chapter, sectionName || '', page || 1, targetLanguage, sourceContent, referenceText || '');
  const generated = await runGenerationPrompt(prompt);
  return {
    content: generated.content,
    debug: {
      extractionRaw: debug.extractionRaw || '[no reference text used]',
      extractionMethod: debug.extractionMethod || 'not-used',
      generationRaw: generated.raw,
    },
  };
}

/** Save generated content for a language into the shared ai-generations document */
async function saveAiContent(subjectId, bookId, sectionNum, page, language, content, userId) {
  if (!aiGenerations) return;
  const langField = language === 'tc' ? 'zh' : 'en';
  const now = hkNow();
  const identity = buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page });
  await aiGenerations.updateOne(
    identity,
    {
      $set: {
        [langField]: content,
        [`${langField}UpdatedAt`]: now,
        updatedAt: now,
        ...(userId ? { user: String(userId) } : {}),
      },
      $setOnInsert: { createdAt: now, ...identity },
    },
    { upsert: true }
  );
  console.log(`[ai-generate] ${language}: saved to ai-generations (field=${langField})`);
}

async function saveAlignedBilingualAiContent(subjectId, bookId, sectionNum, page, enContent, zhContent, userId) {
  if (!aiGenerations) return;
  const now = hkNow();
  const identity = buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page });
  await aiGenerations.deleteMany({
    $or: [identity, buildLegacyAiIdentity(identity)],
  });
  await aiGenerations.insertOne({
    ...identity,
    en: enContent,
    zh: zhContent,
    enUpdatedAt: now,
    zhUpdatedAt: now,
    updatedAt: now,
    alignmentVersion: BILINGUAL_ALIGNMENT_VERSION,
    ...(userId ? { user: String(userId) } : {}),
    createdAt: now,
  });
  console.log('[ai-generate] saved aligned bilingual content to ai-generations');
}

async function getAiContentDocument(subjectId, bookId, sectionNum, page) {
  return findAiGenerationDocument(buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page }));
}

function hasStoredAiContent(doc) {
  return !!(doc && (doc.en || doc.zh));
}

/** Check if an AI content value is a valid generated content object (not an error envelope) */
function isValidAiContent(value) {
  if (!value || typeof value !== 'object') return false;
  // Error envelopes from the gateway have 'success', 'provider', 'error' keys
  if (value.error && (value.success !== undefined || value.provider)) return false;
  // Must have at least one of the expected content types
  return !!(value.summary || value.flashcards || value.mcq);
}

/** Check if the document has broken zh content (error envelope instead of real content) */
function hasBrokenZh(doc) {
  if (!doc?.zh) return false;
  return !isValidAiContent(doc.zh);
}

/** Check DB for existing generated content for a language */
async function getCachedAiContent(subjectId, bookId, sectionNum, page, language) {
  const doc = await findAiGenerationDocument(buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page }));
  if (!doc) return null;
  const langField = language === 'tc' ? 'zh' : 'en';
  return doc[langField] || null;
}

app.post('/api/ai-generate', async (request, response) => {
  try {
    const identity = parseAiRequestIdentity(request.body);
    const { subjectId, bookId, sectionId: sectionNum, pageId: page } = identity;
    const sectionName = request.body.sectionName;
    const userId = request.body.userId;
    const dataRoot = getDataRoot(subjectId);
    const isTestMode = request.body.test === true || request.body.test === '1';
    const forceRegenerate = request.body.force === true || request.body.force === '1';
    console.log(`[ai-generate] subject=${subjectId} book=${bookId} section=${sectionNum} page=${page} (both en + tc)`);
    const debugInfo = {
      request: {
        subjectId,
        bookId,
        sectionId: sectionNum,
        pageId: page,
        sectionName,
        userId,
        test: request.body.test,
      },
      workflow: 'generate-en-then-translate-zh',
      extractionRaw: {},
      generationRaw: {},
      extractionMethod: {},
      errors: {},
    };

    if (!AIGATEWAY_APIKEY) {
      return response.status(500).json({ error: 'AIGATEWAY_APIKEY not configured' });
    }

    const results = {};

    const cachedDoc = await getAiContentDocument(subjectId, bookId, sectionNum, page);

    // ── Case 1: Both en and zh are valid → return cached ──
    if (!forceRegenerate && hasStoredAiContent(cachedDoc) && !hasBrokenZh(cachedDoc)) {
      console.log('[ai-generate] using cached ai content from database (both en + zh valid)');
      results.en = cachedDoc.en;
      results.tc = cachedDoc.zh;
      debugInfo.cache = 'existing-document-hit';
    }
    // ── Case 2: en exists but zh is missing or broken → translate en→zh directly ──
    else if (!forceRegenerate && cachedDoc?.en && isValidAiContent(cachedDoc.en) && (!cachedDoc.zh || hasBrokenZh(cachedDoc))) {
      console.log('[ai-generate] en content exists, zh missing/broken — translating directly from en');
      debugInfo.workflow = 'translate-en-to-zh-directly';
      results.en = cachedDoc.en;

      try {
        const chinese = await translateGeneratedContent(
          bookId,
          sectionName,
          page,
          'tc',
          cachedDoc.en,
          '' // no reference text needed, we have the en content
        );
        results.tc = chinese.content;
        debugInfo.generationRaw.tc = chinese.debug?.generationRaw || '';
      } catch (err) {
        console.error('[ai-generate] direct en→zh translation failed —', err.message);
        results.tc = { error: err.message };
        debugInfo.errors.tc = err.message;
      }

      // Save the updated document (en preserved, zh added)
      if (results.tc && !results.tc.error) {
        await saveAiContent(subjectId, bookId, sectionNum, page, 'tc', results.tc, userId);
      }
    }
    // ── Case 3: Nothing cached or force-regenerate → full generation ──
    else {
      try {
        const english = await generateForLanguage(dataRoot, bookId, sectionNum, page, 'en', sectionName);
        results.en = english.content;
        debugInfo.extractionRaw.en = english.debug?.extractionRaw || '';
        debugInfo.generationRaw.en = english.debug?.generationRaw || '';
        debugInfo.extractionMethod.en = english.debug?.extractionMethod || 'gateway';

        let chineseReference = { extractedText: '', debug: { extractionRaw: '[no chinese reference text]', extractionMethod: 'not-used' } };
        try {
          chineseReference = await extractPageText(dataRoot, bookId, sectionNum, page, 'tc');
        } catch (err) {
          console.warn('[ai-generate] tc: reference extraction failed, continuing with translation only');
          chineseReference = {
            extractedText: '',
            debug: {
              extractionRaw: err.debug?.extractionRaw || `[reference extraction failed] ${err.message}`,
              extractionMethod: err.debug?.extractionMethod || 'failed',
            },
          };
          debugInfo.errors.tcReference = err.message;
        }

        const chinese = await translateGeneratedContent(
          bookId,
          sectionName,
          page,
          'tc',
          english.content,
          chineseReference.extractedText,
          chineseReference.debug
        );
        results.tc = chinese.content;
        debugInfo.extractionRaw.tc = chinese.debug?.extractionRaw || '';
        debugInfo.generationRaw.tc = chinese.debug?.generationRaw || '';
        debugInfo.extractionMethod.tc = chinese.debug?.extractionMethod || 'not-used';

        await saveAlignedBilingualAiContent(subjectId, bookId, sectionNum, page, english.content, chinese.content, userId);
      } catch (err) {
        console.error('[ai-generate] aligned generation failed —', err.message);
        results.en = results.en || { error: err.message };
        results.tc = results.tc || { error: err.message };
        debugInfo.extractionRaw.en = debugInfo.extractionRaw.en || err.debug?.extractionRaw || '';
        debugInfo.generationRaw.en = debugInfo.generationRaw.en || err.debug?.generationRaw || '[generation not attempted]';
        debugInfo.errors.en = debugInfo.errors.en || err.message;
        debugInfo.errors.tc = debugInfo.errors.tc || err.message;
      }
    }

    // Normalize keys: 'tc' → 'zh' for consistency with DB schema
    const normalized = {};
    if (results.en) normalized.en = results.en;
    if (results.tc) normalized.zh = results.tc;

    const responsePayload = { content: normalized };
    if (isTestMode) {
      responsePayload._debug = {
        request: debugInfo.request,
        extractionRaw: formatLanguageDebug(debugInfo.extractionRaw),
        generationRaw: formatLanguageDebug(debugInfo.generationRaw),
        extractionMethod: debugInfo.extractionMethod,
        errors: debugInfo.errors,
        subjectId, bookId, sectionId: sectionNum, pageId: page,
        languages: {
          en: !!(results.en && !results.en.error),
          zh: !!(results.tc && !results.tc.error),
        },
      };
    }
    response.json(responsePayload);
  } catch (err) {
    console.error('[ai-generate] error:', err);
    response.status(500).json({ error: err.message });
  }
});

// ── Search (MongoDB ai-generations + annotations) ────────

app.get('/api/search', async (request, response) => {
  try {
    const { q, subjectId, bookId, sectionId, pageId, includeAnnotations } = request.query;
    if (!q || !String(q).trim()) {
      return response.json({ results: [] });
    }
    if (!aiGenerations) {
      return response.json({ results: [] });
    }

    const escaped = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = { $regex: escaped, $options: 'i' };

    const scopeFilter = {};
    if (subjectId && String(subjectId).trim()) scopeFilter.subjectId = String(subjectId).trim();
    if (bookId && String(bookId).trim()) scopeFilter.bookId = String(bookId).trim();
    if (sectionId != null) scopeFilter.sectionId = Number(sectionId);
    if (pageId != null) scopeFilter.pageId = Number(pageId);

    // Search ai-generations (summary + raw)
    const aiFilter = { ...scopeFilter, $or: [
      { 'en.summary': regex },
      { 'zh.summary': regex },
      { 'en.raw': regex },
      { 'zh.raw': regex },
    ]};

    const aiDocs = await aiGenerations
      .find(aiFilter)
      .project({
        subjectId: 1, bookId: 1, sectionId: 1, pageId: 1,
        'en.summary': 1, 'zh.summary': 1, updatedAt: 1
      })
      .limit(50)
      .toArray();

    const results = aiDocs.map((doc) => {
      const enText = Array.isArray(doc?.en?.summary) ? doc.en.summary.join(' ') : (typeof doc?.en?.summary === 'string' ? doc.en.summary : '');
      const zhText = Array.isArray(doc?.zh?.summary) ? doc.zh.summary.join(' ') : (typeof doc?.zh?.summary === 'string' ? doc.zh.summary : '');
      const enSnippet = extractSnippet(enText, q);
      const zhSnippet = extractSnippet(zhText, q);
      return {
        _id: doc._id,
        subjectId: doc.subjectId,
        bookId: doc.bookId,
        sectionId: doc.sectionId,
        pageId: doc.pageId,
        snippet: enSnippet || zhSnippet || '',
        source: 'ai',
        updatedAt: doc.updatedAt,
      };
    });

    // Optionally search annotations collection
    if (includeAnnotations === '1' && annotationsCollection) {
      const annoFilter = { ...scopeFilter, 'remarks.text': regex };
      const annoDocs = await annotationsCollection
        .find(annoFilter)
        .project({
          subjectId: 1, bookId: 1, sectionId: 1, pageId: 1, langId: 1,
          remarks: 1
        })
        .limit(50)
        .toArray();

      for (const doc of annoDocs) {
        const matchingRemark = (doc.remarks || []).find(
          (r) => typeof r.text === 'string' && r.text.toLowerCase().includes(String(q).toLowerCase())
        );
        const snippet = matchingRemark?.text
          ? extractSnippet(matchingRemark.text, q)
          : '';
        results.push({
          _id: doc._id,
          subjectId: doc.subjectId,
          bookId: doc.bookId,
          sectionId: doc.sectionId,
          pageId: doc.pageId,
          snippet,
          source: 'annotation',
          langId: doc.langId,
          updatedAt: doc.updatedAt,
        });
      }
    }

    response.json({ results });
  } catch (err) {
    console.error('[search] error:', err);
    response.status(500).json({ error: err.message });
  }
});

/** Extract a short snippet around the first match of query in text */
function extractSnippet(text, query) {
  const safeText = typeof text === 'string' ? text : '';
  const safeQuery = typeof query === 'string' ? query : '';
  if (!safeText || !safeQuery) return '';
  const idx = safeText.toLowerCase().indexOf(safeQuery.toLowerCase());
  if (idx < 0) return '';
  const start = Math.max(0, idx - 40);
  const end = Math.min(safeText.length, idx + safeQuery.length + 80);
  let snippet = safeText.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < safeText.length) snippet = snippet + '…';
  return snippet;
}

// ── AI Content CRUD (MongoDB) ────────────────────────────

app.get('/api/ai-content', async (request, response) => {
  try {
    const identity = parseAiRequestIdentity(request.query, { includePage: request.query.pageId != null || request.query.page != null });
    const { language } = request.query;
    if (!aiGenerations) {
      return response.json({ content: null });
    }
    const doc = await findAiGenerationDocument(identity);
    if (!doc) {
      return response.json({ content: null });
    }
    // Filter out broken zh content (error envelopes from failed gateway calls)
    const validZh = isValidAiContent(doc.zh) ? doc.zh : null;
    // If a specific language is requested, return just that; otherwise return both
    if (language === 'en' || language === 'tc') {
      const langField = language === 'tc' ? 'zh' : 'en';
      const value = langField === 'zh' ? validZh : (doc[langField] || null);
      response.json({ content: value, updatedAt: doc.updatedAt || null });
    } else {
      response.json({ content: { en: doc.en || null, zh: validZh }, updatedAt: doc.updatedAt || null });
    }
  } catch (err) {
    console.error('[ai-content] GET error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.post('/api/ai-content', async (request, response) => {
  try {
    const { userId, language, content } = request.body;
    const identity = parseAiRequestIdentity(request.body);
    if (!aiGenerations) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    const langField = language === 'tc' ? 'zh' : 'en';
    const now = hkNow();
    const existing = await findAiGenerationDocument(identity);
    await aiGenerations.deleteMany({ $or: [identity, buildLegacyAiIdentity(identity)] });
    await aiGenerations.insertOne({
      ...identity,
      en: langField === 'en' ? content : existing?.en || null,
      zh: langField === 'zh' ? content : existing?.zh || null,
      enUpdatedAt: langField === 'en' ? now : existing?.enUpdatedAt || null,
      zhUpdatedAt: langField === 'zh' ? now : existing?.zhUpdatedAt || null,
      updatedAt: now,
      alignmentVersion: existing?.alignmentVersion || null,
      ...(userId ? { user: String(userId) } : {}),
      createdAt: existing?.createdAt || now,
    });
    response.json({ ok: true });
  } catch (err) {
    console.error('[ai-content] POST error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.delete('/api/ai-content', async (request, response) => {
  try {
    const identity = parseAiRequestIdentity(request.query, { includePage: false });
    if (!aiGenerations) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    await aiGenerations.deleteMany({ $or: [identity, buildLegacyAiIdentity(identity)] });
    response.json({ ok: true });
  } catch (err) {
    console.error('[ai-content] DELETE error:', err);
    response.status(500).json({ error: err.message });
  }
});

// SPA fallback — only for navigation routes (no file extension)
app.get('*', (request, response) => {
  if (request.path.includes('.')) {
    return response.status(404).send('Not found');
  }
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.sendFile(path.join(distPath, 'index.html'));
});

app.use((err, request, response, next) => {
  console.error(`[server] ${request.method} ${request.path} failed:`, err);
  if (response.headersSent) {
    next(err);
    return;
  }
  response.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(port, async () => {
  await connectMongo();
  console.log(`Server running on http://localhost:${port}`);
});
