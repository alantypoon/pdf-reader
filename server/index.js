import dotenv from 'dotenv';
dotenv.config({ override: true });  // override any system env vars with .env values
import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';

// ── Timestamped logging ───────────────────────────────────
const _origLog = console.log, _origErr = console.error, _origWarn = console.warn;
const _ts = () => `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}]`;
console.log = (...a) => _origLog(_ts(), ...a);
console.error = (...a) => _origErr(_ts(), ...a);
console.warn = (...a) => _origWarn(_ts(), ...a);

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

// ── Valid user whitelist from htpasswd ─────────────────────
const HTPASSWD_FILE = process.env.HTPASSWD_FILE || '/etc/nginx/.htpasswd_dse';
let validUsersCache;
let validUsersCacheTime = 0;
const VALID_USERS_CACHE_TTL_MS = 60_000; // re-read every 60 seconds

function loadValidUsers() {
  const now = Date.now();
  if (validUsersCache && (now - validUsersCacheTime) < VALID_USERS_CACHE_TTL_MS) {
    return validUsersCache;
  }
  try {
    const text = readFileSync(HTPASSWD_FILE, 'utf8');
    validUsersCache = new Set(
      text.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => line.split(':', 1)[0])
        .filter(Boolean)
    );
    validUsersCacheTime = now;
    console.log(`[auth] loaded ${validUsersCache.size} valid users from ${HTPASSWD_FILE}`);
  } catch (err) {
    console.warn(`[auth] cannot read ${HTPASSWD_FILE}:`, err.message);
    validUsersCache = new Set();
    validUsersCacheTime = now;
  }
  return validUsersCache;
}

/** Returns true if the userId is a valid authenticated username from htpasswd. */
function isValidUserId(userId) {
  if (!userId || typeof userId !== 'string') return false;
  const trimmed = userId.trim();
  if (!trimmed) return false;
  // Reject auto-generated client-side fallback IDs (e.g. "u3miqcow8")
  if (/^u[a-z0-9]{8,}$/.test(trimmed)) return false;
  const validUsers = loadValidUsers();
  return validUsers.has(trimmed);
}

/** Middleware: extract and validate userId, respond 403 if invalid. */
function requireValidUserId(allowQueryFallback = false) {
  return (request, response, next) => {
    const authenticatedUserId = getAuthenticatedUserId(request);
    let userId = authenticatedUserId;

    // Only allow query/body fallback if explicitly permitted AND the value is valid
    if (!userId && allowQueryFallback) {
      const candidate = String(
        request.query.userId || (request.body && request.body.userId) || ''
      ).trim();
      if (candidate && isValidUserId(candidate)) {
        userId = candidate;
      }
    }

    if (!userId || !isValidUserId(userId)) {
      response.status(403).json({ error: 'Access denied: valid authentication required.' });
      return;
    }

    request.validatedUserId = userId;
    next();
  };
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

app.get('/api/user-selects', requireValidUserId(true), asyncRoute(async (request, response) => {
  const userId = request.validatedUserId;
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

app.post('/api/user-selects', requireValidUserId(true), asyncRoute(async (request, response) => {
  const userId = request.validatedUserId;
  const body = request.body || {};
  const subjectId = String(body.subjectId || body.lastSubjectId || '').trim();
  if (!subjectId) {
    response.status(400).json({ error: 'subjectId is required' });
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

app.post('/api/user-actions', requireValidUserId(true), asyncRoute(async (request, response) => {
  const userId = request.validatedUserId;
  const body = request.body || {};

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

app.post('/api/user-actions/logout', requireValidUserId(true), asyncRoute(async (request, response) => {
  const userId = request.validatedUserId;

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

  /** Detect which languages have content for a chapter */
  async function detectLanguages(chapterDir) {
    const langs = [];
    for (const lang of ['en', 'tc']) {
      const pagesDir = path.join(dataRoot, chapterDir, lang, 'contents', 'pages');
      try {
        const stat = await fs.stat(pagesDir);
        if (stat.isDirectory()) langs.push(lang);
      } catch { /* dir doesn't exist */ }
    }
    return langs;
  }

  /** Scan all chapters and return the union of available languages across the book */
  const bookAvailableLanguages = new Set();

  const chapters = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const chapterDir = entry.name;
        const contentsPath = path.join(dataRoot, chapterDir, 'contents.json');
        console.log('[catalog] reading:', contentsPath);
        const contents = await readJSON(contentsPath, { contents: [] });
        const sections = (contents.contents || []).length;
        console.log(`[catalog]   ${chapterDir}: ${sections} sections`);
        const { nameEn, nameZh } = getBookNamesFromContents(contents);
        const availableLanguages = await detectLanguages(chapterDir);
        availableLanguages.forEach((l) => bookAvailableLanguages.add(l));
        return {
          id: chapterDir,
          name: formatBookLabel(chapterDir, nameEn || nameZh),
          nameEn,
          nameZh,
          contents: contents.contents || [],
          availableLanguages,
        };
      })
  );
  console.log('[catalog] returning', chapters.length, 'chapters');
  response.json({
    chapters,
    books,
    activeBookId,
    availableLanguages: [...bookAvailableLanguages].sort(),
  });
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

app.get('/api/remarks', requireValidUserId(true), asyncRoute(async (request, response) => {
  const userId = request.validatedUserId;
  if (!annotationsCollection) {
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

app.post('/api/remarks', requireValidUserId(true), asyncRoute(async (request, response) => {
  try {
    const userId = request.validatedUserId;
    const { subjectId, bookId, sectionId, pageId, langId, ...remark } = request.body || {};
    if (!annotationsCollection) {
      response.status(500).json({ error: 'MongoDB not connected', remarks: [] });
      return;
    }
    const identity = {
      userId,
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

app.delete('/api/remarks', requireValidUserId(true), asyncRoute(async (request, response) => {
  try {
    if (!annotationsCollection) {
      response.status(500).json({ error: 'MongoDB not connected', remarks: [] });
      return;
    }
    const userId = request.validatedUserId;
    const { subjectId, bookId, sectionId, pageId, createdAt, langId } = request.query;
    const identity = {
      userId,
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
// All external hosts are now allowed through the proxy.
// (The whitelist was removed — any URL can be proxied.)
function isAllowedProxyHost(_hostname) {
  return true; // allow all external hosts
}

function rewriteProxyTarget(rawUrl, baseUrl) {
  if (!rawUrl) return rawUrl;
  const trimmed = String(rawUrl).trim();
  if (!trimmed || trimmed.startsWith('#') || /^(data:|javascript:|mailto:|tel:|blob:)/i.test(trimmed)) {
    return rawUrl;
  }

  try {
    const absolute = new URL(trimmed, baseUrl).toString();
    const parsed = new URL(absolute);
    if (isAllowedProxyHost(parsed.hostname)) {
      // The proxy page itself is at /pdf-reader/api/proxy, so a relative
      // "proxy?url=..." resolves to /pdf-reader/api/proxy?url=...
      return `proxy?url=${encodeURIComponent(absolute)}`;
    }
    return absolute;
  } catch {
    return rawUrl;
  }
}

function rewriteSrcset(value, baseUrl) {
  return String(value)
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const parts = trimmed.split(/\s+/);
      parts[0] = rewriteProxyTarget(parts[0], baseUrl);
      return parts.join(' ');
    })
    .join(', ');
}

function rewriteCssUrls(cssText, baseUrl) {
  return String(cssText).replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote, urlValue) => {
    const rewritten = rewriteProxyTarget(urlValue, baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteHtmlForProxy(html, parsedUrl) {
  let baseUrl = parsedUrl.toString();
  // Ensure the base URL ends with "/" so relative URLs resolve against
  // the directory, not the parent.
  if (!baseUrl.endsWith('/') && !/\.\w+$/.test(parsedUrl.pathname)) {
    baseUrl += '/';
  }
  const str = String(html);

  // React / Next.js SPAs: don't modify the HTML — any change breaks hydration.
  // Only rewrite sub-resource URLs and inject the interception script.
  if (/__NEXT_DATA__|_next\/static|react-root|data-reactroot|__REACT_DEVTOOLS/i.test(str)) {
    const pageBase = JSON.stringify(baseUrl);
    const interceptScript = `<script>(function(){var PAGE_BASE=${pageBase},PROXY='/pdf-reader/api/proxy?url=',OUR_HOST=location.hostname;function proxyUrl(raw){if(!raw||typeof raw!=='string')return raw;var t=raw.trim();if(!t||/^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(t))return raw;if(t.indexOf(PROXY)===0)return raw;try{var a=new URL(t,PAGE_BASE).href,u=new URL(a);if(u.hostname===OUR_HOST){var p='/pdf-reader/api/',i=a.indexOf(p);if(i!==-1){var r=a.slice(i+p.length);if(r.indexOf('proxy')!==0){a=new URL(r,PAGE_BASE).href;u=new URL(a)}}}if(u.hostname===OUR_HOST)return a;return PROXY+encodeURIComponent(a)}catch(e){return raw}}var OX=XMLHttpRequest,oo=OX.prototype.open;OX.prototype.open=function(m,u){return oo.apply(this,[m,proxyUrl(u)].concat(Array.prototype.slice.call(arguments,2)))};var of=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=proxyUrl(i);else if(i instanceof Request){try{i=new Request(proxyUrl(i.url),i)}catch(e){}}return of.call(this,i,n)};var os=navigator.sendBeacon;if(os){navigator.sendBeacon=function(u,d){return os.call(navigator,proxyUrl(u),d)}}function pp(pr,pn){var d=Object.getOwnPropertyDescriptor(pr,pn);if(!d||!d.set)return;var os=d.set;Object.defineProperty(pr,pn,{set:function(v){os.call(this,proxyUrl(v))},get:d.get,configurable:true,enumerable:true})}try{pp(HTMLScriptElement.prototype,'src');pp(HTMLImageElement.prototype,'src');pp(HTMLSourceElement.prototype,'src');pp(HTMLEmbedElement.prototype,'src');pp(HTMLVideoElement.prototype,'src');pp(HTMLAudioElement.prototype,'src');pp(HTMLTrackElement.prototype,'src');pp(HTMLIFrameElement.prototype,'src');pp(HTMLLinkElement.prototype,'href')}catch(e){}})();</script>`;
    return interceptScript + str.replace(/\b(href|src|action|poster)=(["'])(.*?)\2/gi, (match, attr, quote, value) => {
      return `${attr}=${quote}${rewriteProxyTarget(value, baseUrl)}${quote}`;
    }).replace(/\bsrcset=(["'])(.*?)\1/gi, (match, quote, value) => {
      return `srcset=${quote}${rewriteSrcset(value, baseUrl)}${quote}`;
    });
  }

  let rewritten = str
    .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']X-Frame-Options["'][^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '');

  rewritten = rewritten.replace(/\b(href|src|action|poster)=(["'])(.*?)\2/gi, (match, attr, quote, value) => {
    return `${attr}=${quote}${rewriteProxyTarget(value, baseUrl)}${quote}`;
  });

  rewritten = rewritten.replace(/\bsrcset=(["'])(.*?)\1/gi, (match, quote, value) => {
    return `srcset=${quote}${rewriteSrcset(value, baseUrl)}${quote}`;
  });

  rewritten = rewritten.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
    return match.replace(css, rewriteCssUrls(css, baseUrl));
  });

  rewritten = rewritten.replace(/style=(["'])(.*?)\1/gi, (match, quote, css) => {
    return `style=${quote}${rewriteCssUrls(css, baseUrl)}${quote}`;
  });

  const pageBase = JSON.stringify(baseUrl);
  const stub = `
<script>
(function(){
  var PAGE_BASE = ${pageBase};
  var PROXY = '/pdf-reader/api/proxy?url=';
  var OUR_HOST = location.hostname;
  function proxyUrl(raw){
    if (!raw || typeof raw !== 'string') return raw;
    var trimmed = raw.trim();
    if (!trimmed || /^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(trimmed)) return raw;
    if (trimmed.indexOf(PROXY) === 0) return raw;
    try {
      var abs = new URL(trimmed, PAGE_BASE).href;
      var u = new URL(abs);
      if (u.hostname === OUR_HOST) {
        // This URL might have been pre-resolved against the proxy page's location.
        // Try to extract the relative path and resolve against the original base.
        var ourPrefix = '/pdf-reader/api/';
        var idx = abs.indexOf(ourPrefix);
        if (idx !== -1) {
          var relPath = abs.slice(idx + ourPrefix.length);
          // Skip if it's already a proxy URL
          if (relPath.indexOf('proxy') !== 0) {
            abs = new URL(relPath, PAGE_BASE).href;
            u = new URL(abs);
          }
        }
      }
      if (u.hostname === OUR_HOST) return abs;
      return PROXY + encodeURIComponent(abs);
    } catch(e) { return raw; }
  }

  // Patch XMLHttpRequest
  var OrigXHR = XMLHttpRequest;
  var origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function(method, url){
    return origOpen.apply(this, [method, proxyUrl(url)].concat(Array.prototype.slice.call(arguments, 2)));
  };

  // Patch fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init){
    if (typeof input === 'string') input = proxyUrl(input);
    else if (input instanceof Request) {
      try { input = new Request(proxyUrl(input.url), input); } catch(e) {}
    }
    return origFetch.call(this, input, init);
  };

  // Patch navigator.sendBeacon
  var origSendBeacon = navigator.sendBeacon;
  if (origSendBeacon) {
    navigator.sendBeacon = function(url, data){
      return origSendBeacon.call(navigator, proxyUrl(url), data);
    };
  }

  // Patch element.src / element.href setters for dynamically created elements
  function patchProp(proto, prop) {
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var origSet = desc.set;
    Object.defineProperty(proto, prop, {
      set: function(val) { origSet.call(this, proxyUrl(val)); },
      get: desc.get,
      configurable: true, enumerable: true
    });
  }
  try {
    patchProp(HTMLScriptElement.prototype, 'src');
    patchProp(HTMLImageElement.prototype, 'src');
    patchProp(HTMLSourceElement.prototype, 'src');
    patchProp(HTMLEmbedElement.prototype, 'src');
    patchProp(HTMLVideoElement.prototype, 'src');
    patchProp(HTMLAudioElement.prototype, 'src');
    patchProp(HTMLTrackElement.prototype, 'src');
    patchProp(HTMLIFrameElement.prototype, 'src');
    patchProp(HTMLLinkElement.prototype, 'href');
  } catch(e) {}
})();
</script>
<script>
window.ispring=window.ispring||{presenter:{player:{play:function(){}},navigator:{}}};
window.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('meta[http-equiv="refresh"]').forEach(function(node){ node.remove(); });
});
</script>`;

  rewritten = rewritten.replace(/<head[^>]*>/i, (match) => match + stub);
  // Neutralise frame-busting code without breaking JS syntax.
  // Replace assignments with a harmless expression (false) instead of
  // deleting them (which would leave syntax errors like `if () {}`).
  rewritten = rewritten.replace(/\btop\.location\s*=\s*self\.location\s*;?/gi, 'false');
  rewritten = rewritten.replace(/\bparent\.location\s*=\s*self\.location\s*;?/gi, 'false');

  return rewritten;
}

app.all('/api/proxy', async (request, response) => {
  try {
    const targetUrl = request.query.url;
    if (!targetUrl) {
      return response.status(400).send('Missing ?url=');
    }

    const parsed = new URL(targetUrl);

    const fetchOpts = {
      method: request.method,
      redirect: 'follow',
      headers: { 'User-Agent': 'Book reader Proxy/1.0' },
    };
    // Forward request body for non-GET/HEAD methods if present
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const ct = request.get('content-type') || '';
      if (ct) fetchOpts.headers['Content-Type'] = ct;
      // Use raw body if available (Express raw body), otherwise parsed body
      if (Buffer.isBuffer(request.body)) {
        fetchOpts.body = request.body;
      } else if (request.body && typeof request.body === 'object') {
        fetchOpts.body = JSON.stringify(request.body);
      } else if (request.body) {
        fetchOpts.body = String(request.body);
      }
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    const contentType = upstream.headers.get('content-type') || '';
    const pathname = parsed.pathname.toLowerCase();

    response.status(upstream.status);

    // Forward content-type and CORS-friendly headers
    if (contentType) {
      response.setHeader('Content-Type', contentType);
    }
    response.setHeader('X-Frame-Options', 'SAMEORIGIN'); // allow iframe on our domain
    response.setHeader('Cache-Control', 'no-store');

    const isCss = contentType.includes('text/css') || pathname.endsWith('.css');
    const isHtml = contentType.includes('text/html') || (!isCss && /\.(html?|php|aspx?|jsp)$/i.test(pathname));

    if (isHtml) {
      const html = await upstream.text();
      response.send(rewriteHtmlForProxy(html, parsed));
    } else if (isCss) {
      const css = await upstream.text();
      response.send(rewriteCssUrls(css, parsed));
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

// ── Cache-busting middleware ────────────────────────────────
// Adding ?cache=0 to any URL disables all caching headers so the
// browser fetches fresh resources on the next load.
app.use((req, res, next) => {
  if (req.query.cache === '0') {
    res.locals.noCache = true;
  }
  next();
});

// Serve built frontend (production)
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath, {
  setHeaders: (res, filePath) => {
    if (res.locals.noCache) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // Hashed assets (JS, CSS, WASM) — cache for 1 year
    if (/\.(js|css|wasm)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
  }
}));

// Serve textbook data (page images, mp3, htmls) with aggressive caching.
// These are static resources that never change — browser can cache indefinitely.
const dataPath = path.resolve(__dirname, '../data');
const dataStatic = express.static(dataPath, {
  setHeaders: (res, filePath) => {
    if (res.locals.noCache) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    // Images, audio, and other static assets — cache for 1 year
    if (/\.(png|jpg|jpeg|gif|webp|svg|mp3|wav|ogg|pdf|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
});
app.use('/data', dataStatic);
app.use('/pdf-reader/data', dataStatic);

// ── AI Generation ─────────────────────────────────────────
//
// Two-stage pipeline:
//   1. Text extraction  (image → text)      via AI Gateway ett-vllm + InternVL
//   2. Content generation (text → study materials)  via Ollama gpt-oss:120b

// ── Stage 1: Text extraction (image → text) ──
const VLLM_URL = process.env.VLLM_API_URL || 'https://aigateway.aied.hku.hk/api/generate';
const VLLM_PROVIDER = process.env.VLLM_PROVIDER || 'ett-vllm';
const VLLM_MODEL = process.env.VLLM_MODEL || 'OpenGVLab/InternVL3_5-38B';
const VLLM_APIKEY = process.env.VLLM_APIKEY || '';

// ── Stage 2: Content generation (text → study materials) ──
const GEN_PROVIDER = process.env.OLLAMA_PROVIDER || 'ollama';
const GEN_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:120b';
const GEN_APIKEY = process.env.OLLAMA_APIKEY || '';

// ── Log loaded configuration at startup ──
console.log('[startup] VLLM_API_URL =', VLLM_URL);
console.log('[startup] VLLM_PROVIDER =', VLLM_PROVIDER, '(env:', process.env.VLLM_PROVIDER || '<unset>', ')');
console.log('[startup] VLLM_MODEL =', VLLM_MODEL);
console.log('[startup] VLLM_APIKEY =', VLLM_APIKEY ? `${VLLM_APIKEY.slice(0, 4)}...${VLLM_APIKEY.slice(-4)}` : '<unset>');
console.log('[startup] GEN_PROVIDER =', GEN_PROVIDER, '(env:', process.env.OLLAMA_PROVIDER || '<unset>', ')');
console.log('[startup] GEN_MODEL =', GEN_MODEL);
console.log('[startup] GEN_APIKEY =', GEN_APIKEY ? `${GEN_APIKEY.slice(0, 4)}...${GEN_APIKEY.slice(-4)}` : '<unset>');
console.log('[startup] CWD =', process.cwd());

// ── Model catalog for looking up max output tokens ────────
// const AVAILABLE_MODELS_PATH = process.env.AVAILABLE_MODELS_PATH
//   || path.resolve(__dirname, '../../../aigateway/available-models.json');
const AVAILABLE_MODELS_PATH = process.env.AVAILABLE_MODELS_PATH;

const DEFAULT_MAX_TOKENS = 0; // never set this


let _cachedGenMaxTokens = null;

/** Return the max_tokens / num_predict value for GEN_MODEL from the catalog. */
function getGenMaxTokens() {
  if (_cachedGenMaxTokens !== null) return _cachedGenMaxTokens;

  try {
    if (!existsSync(AVAILABLE_MODELS_PATH)) {
      _cachedGenMaxTokens = DEFAULT_MAX_TOKENS;
      return _cachedGenMaxTokens;
    }
    const raw = readFileSync(AVAILABLE_MODELS_PATH, 'utf-8');
    const catalog = JSON.parse(raw);
    const ollamaModels = catalog?.ollama;
    if (!Array.isArray(ollamaModels)) {
      _cachedGenMaxTokens = DEFAULT_MAX_TOKENS;
      return _cachedGenMaxTokens;
    }

    // Strip provider prefix if present (e.g. "ollama|gpt-oss:120b" → "gpt-oss:120b")
    const target = GEN_MODEL.includes('|') ? GEN_MODEL.split('|').slice(1).join('|') : GEN_MODEL;

    for (const entry of ollamaModels) {
      if (entry?.id === target && entry.max_completion_tokens != null) {
        _cachedGenMaxTokens = Number(entry.max_completion_tokens);
        console.log(`[ai-generate] max_tokens for ${target}: ${_cachedGenMaxTokens} (from catalog)`);
        return _cachedGenMaxTokens;
      }
    }

    // Fuzzy fallback: match on model family name before the colon
    const targetFamily = target.split(':')[0].toLowerCase();
    for (const entry of ollamaModels) {
      const eid = String(entry?.id || '').toLowerCase();
      if (eid.startsWith(targetFamily) && entry.max_completion_tokens != null) {
        _cachedGenMaxTokens = Number(entry.max_completion_tokens);
        console.log(`[ai-generate] max_tokens for ${target}: ${_cachedGenMaxTokens} (fuzzy match ${entry.id})`);
        return _cachedGenMaxTokens;
      }
    }
  } catch (err) {
    console.warn(`[ai-generate] failed to load model catalog: ${err.message}`);
  }

  _cachedGenMaxTokens = DEFAULT_MAX_TOKENS;
  console.log(`[ai-generate] max_tokens for ${GEN_MODEL}: ${DEFAULT_MAX_TOKENS} (default — model not in catalog)`);
  return _cachedGenMaxTokens;
}

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
  return results;
}

/** Derive a human-readable subject name from a book ID.
 *  "physics-oup" → "Physics", "biology-oup" → "Biology", "chemistry-winter" → "Chemistry" */
function subjectName(bookId) {
  const s = String(bookId || '').toLowerCase();
  if (s.startsWith('physics')) return 'Physics';
  if (s.startsWith('biology')) return 'Biology';
  if (s.startsWith('chemistry')) return 'Chemistry';
  return s.split('-')[0].replace(/^./, (c) => c.toUpperCase());
}

/** Build the AI prompt for flash card and MCQ generation */
function buildGenerationPrompt(chapter, sectionName, pageNum, language, extractedText, subject = '') {
  const langInstruction = language === 'tc'
    ? '所有內容必須使用繁體中文（Traditional Chinese, NOT Simplified Chinese）。問題、答案、MCQ 選項（options）、解釋（explanation）全部都要用繁體中文書寫，絕對不可以出現英文。'
    : 'All content must be in English.';
  const subjectWord = subject ? `${subject} ` : '';

  return `You are an expert ${subjectWord}educator. Using ONLY the textbook content provided below (do NOT use any outside knowledge), generate learning materials to help a student study this specific page.

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

function buildTranslationPrompt(chapter, sectionName, pageNum, targetLanguage, sourceContent, referenceText, subject = '') {
  const langInstruction = targetLanguage === 'tc'
    ? 'Translate EVERYTHING into Traditional Chinese (繁體中文, NOT Simplified Chinese 简体中文). This includes all MCQ options — translate every option from English into Traditional Chinese. Do NOT leave any text untranslated.'
    : 'Translate everything into English.';
  const subjectWord = subject ? `bilingual ${subject} ` : 'bilingual ';

  return `You are an expert ${subjectWord}educator. Translate the study materials below while preserving the meaning EXACTLY.

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
- CRITICAL: Translate ALL MCQ options (choices A, B, C, D) into Traditional Chinese. Keep the same number of options (4), labeled A-D, with the SAME correct answer letter. Do NOT leave any option in English — EVERY option must be in Traditional Chinese.
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
    if (!parsed || typeof parsed !== 'object') return rawText.trim();

    // Collect text from every possible field (matching Python's _extract_text)
    let text = parsed.response || parsed.text || parsed.output || '';

    // masterSummary may be string or dict
    const master = parsed.masterSummary;
    if (typeof master === 'string' && master.trim()) {
      text = master;
    } else if (master && typeof master === 'object') {
      text = master.text || master.summary || text;
    }

    // Per-file text (multipart image extraction responses)
    const parts = [];
    if (Array.isArray(parsed.files)) {
      for (const file of parsed.files) {
        if (file && typeof file === 'object') {
          const ft = file.text || file.response || file.output || '';
          if (ft.trim()) parts.push(ft.trim());
        }
      }
    }
    if (parts.length) {
      text = text ? text + '\n\n' + parts.join('\n\n') : parts.join('\n\n');
    }

    // generation field (used by some gateway versions)
    if (!text.trim()) {
      const gen = parsed.generation;
      if (typeof gen === 'string' && gen.trim()) text = gen;
      else if (gen && typeof gen === 'object') text = gen.text || gen.response || '';
    }

    // content field (older wrappers)
    if (!text.trim() && typeof parsed.content === 'string') {
      text = parsed.content;
    }

    return text.trim();
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
            return { raw: cleaned, _parse_error: true, _raw_truncated: cleaned.slice(0, 200) + '…' };
          }
        }
      }
      return { raw: cleaned, _parse_error: true, _raw_truncated: cleaned.slice(0, 200) + '…' };
    }

    if (parsed.details) {
      try {
        const details = typeof parsed.details === 'string' ? JSON.parse(parsed.details) : parsed.details;
        if (details.error?.message) throw new Error(details.error.message);
      } catch (e) {
        if (e.message && !e.message.startsWith('AI Gateway')) throw e;
      }
      return { raw: genText, _parse_error: true };
    }

    if (parsed.choices?.[0]?.message?.content) {
      const content = parsed.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: content, _parse_error: true };
    }

    if (parsed.flashcards || parsed.mcq) {
      return parsed;
    }

    if (parsed.files && Array.isArray(parsed.files)) {
      const genContent = parsed.files.map((f) => f.text || '').join('\n\n');
      const jsonMatch = genContent.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: genContent, _parse_error: true };
    }

    if (typeof parsed.text === 'string') {
      const jsonMatch = parsed.text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: parsed.text, _parse_error: true };
    }

    if (typeof parsed.content === 'string') {
      const jsonMatch = parsed.content.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: parsed.content, _parse_error: true };
    }

    return { raw: genText, _parse_error: true };
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

async function runGenerationPrompt(prompt, retries = 3) {
  // Strip provider prefix from GEN_MODEL if present (e.g. "ollama|gpt-oss:120b" → "gpt-oss:120b")
  const genModel = GEN_MODEL.includes('|') ? GEN_MODEL.split('|').slice(1).join('|') : GEN_MODEL;

  // Returns { content, raw, genRequest }.
  const doGeneration = async () => {
    return await runPromptViaGateway(prompt, genModel, retries);
  };

  // ── Retry loop: validate parsed content, retry once if invalid ──
  const maxAttempts = 2;
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await doGeneration();
    const content = lastResult.content;

    // Check for parse errors (truncated / unparseable JSON wrappers)
    if (content && content._parse_error) {
      console.log(`[ai-generate] generation returned truncated/unparseable JSON (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) {
        console.log(`[ai-generate] retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Generation returned unparseable content after ${maxAttempts} attempts`);
    }

    // Validate structure — must have at least one meaningful content type
    if (isValidAiContent(content)) {
      if (attempt > 1) console.log(`[ai-generate] generation succeeded on retry (attempt ${attempt})`);
      return lastResult;
    }

    console.log(`[ai-generate] generation returned invalid content (attempt ${attempt}/${maxAttempts}): got keys=${Object.keys(content || {}).join(',') || 'none'}`);
    if (attempt < maxAttempts) {
      console.log(`[ai-generate] retrying...`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
  }

  // All attempts exhausted
  throw new Error(`Generation failed to produce valid study materials after ${maxAttempts} attempts. Last response keys: ${Object.keys(lastResult?.content || {}).join(',') || 'none'}`);
}

async function runPromptViaGateway(prompt, genModel, retries) {
  const mt = getGenMaxTokens();

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Build a fresh FormData for each attempt — FormData streams are
    // single-use in Node.js; reusing a consumed FormData sends an empty body.
    const genFormData = new FormData();
    genFormData.append('provider', GEN_PROVIDER);
    genFormData.append('apiKey', GEN_APIKEY);
    genFormData.append('model', genModel);
    genFormData.append('prompt', prompt);
    if (mt > 0) genFormData.append('max_tokens', String(mt));  // omit when 0 — let gateway decide

    // Use a longer timeout: translation prompts are ~2x larger than
    // generation prompts, and 120B models can take 3-5 minutes.
    const genTimeoutMs = 300000; // 5 min per attempt
    const genController = new AbortController();
    const genTimeoutId = setTimeout(() => genController.abort(), genTimeoutMs);

    let genResponse;
    try {
      genResponse = await fetch(VLLM_URL, {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        body: genFormData,
        signal: genController.signal,
      });
    } catch (fetchErr) {
      // Timeout or network error — retry if attempts remain
      clearTimeout(genTimeoutId);
      lastError = new Error(`AI Gateway generation error: ${fetchErr.message}`);
      if (attempt < retries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 15000);
        console.log(`[ai-generate] gen attempt ${attempt + 1} failed (${fetchErr.message}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw lastError;
    }
    clearTimeout(genTimeoutId);

    if (genResponse.ok) {
      const genText = await genResponse.text();
      // Detect gateway-level error envelope (HTTP 200 + success:false)
      let gatewayError = null;
      try {
        const envelope = JSON.parse(genText);
        if (envelope && envelope.success === false && envelope.error) {
          gatewayError = new Error(`AI Gateway error (${envelope.provider || 'unknown'}): ${envelope.error} — ${(envelope.details || '').slice(0, 200)}`);
        }
      } catch (_) { /* not JSON, not a gateway error */ }
      if (gatewayError) throw gatewayError;

      return {
        content: parseGeneratedContent(genText),
        raw: genText,
        genRequest: {
          endpoint: VLLM_URL,
          provider: GEN_PROVIDER,
          model: genModel,
          max_tokens: mt > 0 ? mt : 'default',
          promptLen: prompt.length,
          promptPreview: prompt.slice(0, 500),
        },
      };
    }

    // 502/503/504 are transient upstream errors — retry
    const status = genResponse.status;
    const errText = await genResponse.text();
    lastError = new Error(`AI Gateway generation error: ${status} — ${errText.slice(0, 300)}`);

    // Debug: dump the failing prompt to disk for diagnosis
    if (attempt === 0) {
      try {
        const fs = await import('fs');
        const debugDir = '/tmp/ai-debug'; await fs.promises.mkdir(debugDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await fs.promises.writeFile(`${debugDir}/gen-fail-${ts}.txt`, JSON.stringify({
          timestamp: ts, attempt, status, model: genModel, provider: GEN_PROVIDER,
          promptLen: prompt.length, promptPreview: prompt.slice(0, 500),
          errBody: errText.slice(0, 2000),
          fullPrompt: prompt,
        }, null, 2));
        console.log(`[ai-generate] debug: dumped failing prompt to /tmp/ai-debug/gen-fail-${ts}.txt`);
      } catch (_) { /* best-effort */ }
    }

    if (status === 502 || status === 503 || status === 504) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // 1s, 2s, 4s, max 10s
        console.log(`[ai-generate] gen attempt ${attempt + 1} failed (${status}), retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    } else {
      break; // non-retryable error (4xx, etc.) — don't retry
    }
  }
  throw lastError;
}

async function extractPageText(dataRoot, chapter, sectionNum, page, language, visionProvider = null) {
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

  const extractPrompt = language === 'tc'
    ? '從這些教科書頁面圖像中提取並轉錄所有文字內容。包括所有標題、正文和圖片說明。必須用繁體中文（Traditional Chinese）輸出，不要使用簡體中文（Simplified Chinese）。'
    : 'Extract and transcribe all text content from these textbook page images. Include all headings, body text, and captions.';

  const provider = visionProvider || VLLM_PROVIDER;

  const debug = {
    extractionRaw: '',
    generationRaw: '[generation not attempted]',
    extractionMethod: 'gateway',
    extractionRequest: {
      endpoint: VLLM_URL,
      provider: provider,
      model: VLLM_MODEL,
      apiKey: VLLM_APIKEY ? `${VLLM_APIKEY.slice(0, 4)}...${VLLM_APIKEY.slice(-4)}` : '<unset>',
      prompt: extractPrompt,
      wordCount: '3000',
      imageCount: selectedImages.length,
    },
  };

  // Build multipart body manually (same approach as Python test-ett.py).
  // Node's fetch + FormData auto Content-Type is unreliable across versions;
  // manual construction guarantees the gateway sees multipart/form-data.
  const boundary = `----AIGatewayBoundary${Date.now()}`;
  const crlf = '\r\n';
  const field = (name, value) =>
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`, 'utf-8');

  const parts = [];
  parts.push(field('provider', provider));
  parts.push(field('apiKey', VLLM_APIKEY));
  parts.push(field('model', VLLM_MODEL));
  parts.push(field('wordCount', '3000'));
  parts.push(field('prompt', extractPrompt));
  parts.push(field('stream', 'false'));

  for (const imgPath of selectedImages) {
    const { buffer, contentType } = await resizeForEtt(imgPath);
    const filename = path.basename(imgPath).replace(/\.(png|jpg|jpeg|webp)$/i, '.jpg');
    const fileHeader = Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="${filename}"${crlf}Content-Type: ${contentType}${crlf}${crlf}`,
      'utf-8'
    );
    parts.push(fileHeader);
    parts.push(buffer);
    parts.push(Buffer.from(crlf, 'utf-8'));
  }
  parts.push(Buffer.from(`--${boundary}--${crlf}`, 'utf-8'));
  const body = Buffer.concat(parts);

  console.log(`[ai-generate] ${language}: sending ${selectedImages.length} image(s) for extraction`);
  console.log(`[ai-generate] ${language}: POST ${VLLM_URL}  Content-Type=multipart/form-data; boundary=${boundary}  bodySize=${body.length}  provider=${provider}  model=${VLLM_MODEL}`);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  let aiResponse;
  try {
    aiResponse = await fetch(VLLM_URL, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (fetchErr) {
    // Wrap AbortError / network errors so the debug payload (extractionRequest) propagates
    throw new AiGenerationError(
      `AI Gateway extraction error (${language}): ${fetchErr.message}`,
      debug
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!aiResponse.ok) {
    const errText = await aiResponse.text();
    throw new AiGenerationError(`AI Gateway extraction error (${language}): ${aiResponse.status} — ${errText.slice(0, 300)}`, debug);
  }

  const text = await aiResponse.text();
  debug.extractionRaw = text;

  // Detect gateway-level error envelope (HTTP 200 + success:false)
  try {
    const envelope = JSON.parse(text);
    if (envelope && envelope.success === false && envelope.error) {
      throw new AiGenerationError(
        `AI Gateway extraction error (${language}): ${envelope.provider || 'unknown'} — ${envelope.error}`,
        debug
      );
    }
  } catch (e) {
    if (e instanceof AiGenerationError) throw e;
    // Not JSON or not a gateway error — continue
  }
  console.log(`[ai-generate] ${language}: extraction response length=${text.length}`);

  let extractedText = extractTextFromGatewayResponse(text);
  console.log(`[ai-generate] ${language}: extracted text length=${extractedText.length}`);

  if (!extractedText.trim()) {
    console.log(`[ai-generate] ${language}: ERROR — no text extracted`);
    console.log(`[ai-generate] ${language}: request payload:`);
    console.log(`[ai-generate] ${language}: ${JSON.stringify({ provider: VLLM_PROVIDER, model: VLLM_MODEL, prompt: extractPrompt.slice(0, 200), wordCount: '3000', images: selectedImages }, null, 2)}`);
    console.log(`[ai-generate] ${language}: raw response (${text.length} bytes):`);
    console.log(`[ai-generate] ${language}: ${text.slice(0, 2000)}`);
    throw new AiGenerationError(`No text could be extracted for language=${language}`, debug);
  }

  return { extractedText, debug, selectedImages };
}

/** Generate flashcards & MCQs for a single language. Returns the parsed content object. */
async function generateForLanguage(dataRoot, chapter, sectionNum, page, language, sectionName, visionProvider = null, subjectId = '', cachedText = '') {
  let extractedText;
  let extractionDebug;
  if (cachedText) {
    // Reuse previously extracted text — skip the gateway call
    console.log(`[ai-generate] ${language}: reusing cached extracted text (${cachedText.length} chars)`);
    extractedText = cachedText;
    extractionDebug = {
      extractionRaw: '[reused cached extracted text]',
      generationRaw: '[generation not attempted]',
      extractionMethod: 'cache',
      extractionRequest: { endpoint: VLLM_URL, provider: VLLM_PROVIDER, model: VLLM_MODEL, prompt: '(skipped — reused cached text)', wordCount: '0', imageCount: 0 },
    };
  } else {
    const extraction = await extractPageText(dataRoot, chapter, sectionNum, page, language, visionProvider);
    extractedText = extraction.extractedText;
    extractionDebug = extraction.debug;
  }
  const subj = subjectName(subjectId);
  const genPrompt = buildGenerationPrompt(chapter, sectionName || '', page || 1, language, extractedText, subj);
  console.log(`[ai-generate] ${language}: calling generation...`);
  const generated = await runGenerationPrompt(genPrompt);
  console.log(`[ai-generate] ${language}: gen response length=${generated.raw.length}`);
  return {
    content: generated.content,
    extractedText,  // store for reuse
    debug: {
      ...extractionDebug,
      generationRaw: generated.raw,
      generationRequest: generated.genRequest || null,
    },
  };
}

async function translateGeneratedContent(chapter, sectionName, page, targetLanguage, sourceContent, referenceText, debug = {}, subjectId = '') {
  console.log(`[ai-generate] ${targetLanguage}: translating generated content to aligned ${targetLanguage} version...`);
  const subj = subjectName(subjectId);
  const prompt = buildTranslationPrompt(chapter, sectionName || '', page || 1, targetLanguage, sourceContent, referenceText || '', subj);
  const generated = await runGenerationPrompt(prompt);
  return {
    content: generated.content,
    debug: {
      extractionRaw: debug.extractionRaw || '[no reference text used]',
      extractionMethod: debug.extractionMethod || 'not-used',
      generationRaw: generated.raw,
      generationRequest: generated.genRequest || null,
    },
  };
}

/** Save generated content for a language into the shared ai-generations document */
async function saveAiContent(subjectId, bookId, sectionNum, page, language, content, userId) {
  if (!aiGenerations) return;
  if (!isValidAiContent(content)) {
    console.error(`[ai-generate] ${language}: REFUSING to save invalid content (raw wrapper or error envelope) for ${subjectId}/${bookId}/${sectionNum}/${page}`);
    return;
  }
  // Strip internal markers before persisting
  const clean = { ...content };
  delete clean._parse_error;
  delete clean._raw_truncated;
  const langField = language === 'tc' ? 'zh' : 'en';
  const now = hkNow();
  const identity = buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page });
  await aiGenerations.updateOne(
    identity,
    {
      $set: {
        [langField]: clean,
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

async function saveAlignedBilingualAiContent(subjectId, bookId, sectionNum, page, enContent, zhContent, userId, enText = '', zhText = '') {
  if (!aiGenerations) return;
  if (!isValidAiContent(enContent)) {
    console.error(`[ai-generate] REFUSING to save invalid en content (raw wrapper or error envelope) for ${subjectId}/${bookId}/${sectionNum}/${page}`);
    return;
  }
  // zhContent may be null/absent when only English generation succeeded
  if (zhContent && !isValidAiContent(zhContent)) {
    console.error(`[ai-generate] REFUSING to save invalid zh content (raw wrapper or error envelope) for ${subjectId}/${bookId}/${sectionNum}/${page}`);
    return;
  }

  // Strip internal markers before persisting
  const cleanEn = { ...enContent };
  delete cleanEn._parse_error;
  delete cleanEn._raw_truncated;
  const cleanZh = zhContent ? { ...zhContent } : null;
  if (cleanZh) {
    delete cleanZh._parse_error;
    delete cleanZh._raw_truncated;
  }

  const now = hkNow();
  const identity = buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page });

  // Use atomic upsert to prevent race-condition duplicates.
  // $set overwrites all content fields; $setOnInsert only fires on new docs.
  const setFields = {
    en: cleanEn,
    enUpdatedAt: now,
    updatedAt: now,
    alignmentVersion: BILINGUAL_ALIGNMENT_VERSION,
    ...(userId ? { user: String(userId) } : {}),
  };
  if (enText) setFields.enText = enText;
  if (zhText) setFields.zhText = zhText;
  if (zhContent) {
    setFields.zh = zhContent;
    setFields.zhUpdatedAt = now;
  } else {
    // Unset zh if not provided (e.g. en-only fallback on a doc that previously had zh)
    setFields.zh = null;
    setFields.zhUpdatedAt = null;
  }

  await aiGenerations.updateOne(
    identity,
    {
      $set: setFields,
      $setOnInsert: { createdAt: now, ...identity },
    },
    { upsert: true }
  );
  console.log(`[ai-generate] saved aligned ${zhContent ? 'bilingual' : 'en-only'} content to ai-generations`);
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
  // Reject parse-error wrappers (truncated/unparseable JSON)
  if (value._parse_error) return false;
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

/** Merge newly generated content with existing cached content, preserving
 *  parts that the user chose to skip regenerating.
 *
 *  @param {object} generated - newly generated content (en or zh)
 *  @param {object|null} existing - existing cached content for the same language
 *  @param {object} skipFlags - { summary, flashcards, quiz }
 *  @returns {object} merged content
 */
function mergeSkippedParts(generated, existing, skipFlags) {
  if (!existing || typeof existing !== 'object') return generated;
  const merged = { ...generated };
  if (skipFlags.summary && existing.summary) {
    merged.summary = existing.summary;
  }
  if (skipFlags.flashcards && existing.flashcards) {
    merged.flashcards = existing.flashcards;
  }
  if (skipFlags.quiz && existing.mcq) {
    merged.mcq = existing.mcq;
    // Also preserve existing quiz answers/state if stored
    if (existing._mcqState) merged._mcqState = existing._mcqState;
  }
  return merged;
}

/** Check DB for existing generated content for a language */
async function getCachedAiContent(subjectId, bookId, sectionNum, page, language) {
  const doc = await findAiGenerationDocument(buildAiIdentity({ subjectId, bookId, sectionId: sectionNum, pageId: page }));
  if (!doc) return null;
  const langField = language === 'tc' ? 'zh' : 'en';
  return doc[langField] || null;
}

// ── Available Vision Providers ────────────────────────────
// Returns all provider keys from the model catalog EXCEPT
// ett-vllm and ett-others (which are internal/special-purpose).

app.get('/api/vision-providers', async (_request, response) => {
  try {
    if (!AVAILABLE_MODELS_PATH || !existsSync(AVAILABLE_MODELS_PATH)) {
      // Fallback: return a sensible default list when catalog is unavailable
      response.json({ providers: ['openrouter', 'amazon', 'vllm', 'ollama'] });
      return;
    }
    const raw = readFileSync(AVAILABLE_MODELS_PATH, 'utf-8');
    const catalog = JSON.parse(raw);
    const excluded = new Set(['ett-vllm', 'ett-others']);
    const providers = Object.keys(catalog).filter((key) => !excluded.has(key));
    response.json({ providers });
  } catch (err) {
    console.error('[vision-providers] error:', err.message);
    response.status(500).json({ error: 'Failed to load vision providers' });
  }
});

app.post('/api/ai-generate', async (request, response) => {
  let keepAlive = null;  // declared here so catch block can clear it
  try {
    const identity = parseAiRequestIdentity(request.body);
    const { subjectId, bookId, sectionId: sectionNum, pageId: page } = identity;
    const sectionName = request.body.sectionName;
    const userId = request.body.userId;
    const dataRoot = getDataRoot(subjectId);
    const isTestMode = request.body.test === true || request.body.test === '1';
    const forceRegenerate = request.body.force === true || request.body.force === '1';
    const visionProvider = request.body.visionProvider || null;

    // Partial regeneration flags (only meaningful when forceRegenerate=true)
    const skipExtraction = request.body.skipExtraction === true || request.body.skipExtraction === '1';
    const skipSummary = request.body.skipSummary === true || request.body.skipSummary === '1';
    const skipFlashcards = request.body.skipFlashcards === true || request.body.skipFlashcards === '1';
    const skipQuiz = request.body.skipQuiz === true || request.body.skipQuiz === '1';
    const hasSkipFlags = skipExtraction || skipSummary || skipFlashcards || skipQuiz;

    console.log(`[ai-generate] subject=${subjectId} book=${bookId} section=${sectionNum} page=${page} visionProvider=${visionProvider || VLLM_PROVIDER} (both en + tc) force=${forceRegenerate} skipExtraction=${skipExtraction} skipSummary=${skipSummary} skipFlashcards=${skipFlashcards} skipQuiz=${skipQuiz}`);

    // ── Quick validation (before flushing headers) ──
    if (!VLLM_APIKEY) {
      response.status(500).json({ error: 'VLLM_APIKEY not configured. Set VLLM_APIKEY in .env.' });
      return;
    }

    // ── Flush headers immediately to prevent nginx proxy timeout (504) ──
    // The generation pipeline can take 2+ minutes. By sending HTTP headers
    // now, nginx sees the server is alive and won't return 504 Gateway Timeout.
    response.status(200);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.flushHeaders();
    // Disable Node.js HTTP timeouts — generation can take 2+ minutes
    request.setTimeout(0);
    response.setTimeout(0);

    // Send a keep-alive byte every 15s to prevent nginx proxy_read_timeout.
    // nginx sees data flowing and won't return 502/504 even if generation
    // takes several minutes.  JSON.parse ignores leading whitespace, so the
    // frontend can still parse the response.
    keepAlive = setInterval(() => {
      try { response.write(' '); } catch (_) { /* connection closed */ }
    }, 15000);

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
          '', // no reference text needed, we have the en content
          {},
          subjectId
        );
        results.tc = chinese.content;
        debugInfo.generationRaw.tc = chinese.debug?.generationRaw || '';
        debugInfo.generationRequest = debugInfo.generationRequest || {};
        debugInfo.generationRequest.tc = chinese.debug?.generationRequest || null;
      } catch (err) {
        console.error('[ai-generate] direct en→zh translation failed —', err.message);
        results.tc = { error: err.message };
        debugInfo.errors.tc = err.message;
      }

      // Save the updated document (en preserved, zh added)
      if (results.tc && !results.tc.error) {
        if (hasSkipFlags && cachedDoc?.zh) {
          results.tc = mergeSkippedParts(results.tc, cachedDoc.zh, { summary: skipSummary, flashcards: skipFlashcards, quiz: skipQuiz });
        }
        await saveAiContent(subjectId, bookId, sectionNum, page, 'tc', results.tc, userId);
      }
    }
    // ── Case 3: Nothing cached or force-regenerate → full generation ──
    else {
      try {
        const enCachedText = (skipExtraction && cachedDoc?.enText) ? cachedDoc.enText : '';
        const english = await generateForLanguage(dataRoot, bookId, sectionNum, page, 'en', sectionName, visionProvider, subjectId, enCachedText);
        results.en = english.content;
        const enExtractedText = english.extractedText || '';
        debugInfo.extractionRaw.en = english.debug?.extractionRaw || '';
        debugInfo.generationRaw.en = english.debug?.generationRaw || '';
        debugInfo.extractionMethod.en = english.debug?.extractionMethod || 'gateway';
        debugInfo.extractionRequest = debugInfo.extractionRequest || {};
        debugInfo.extractionRequest.en = english.debug?.extractionRequest || null;
        debugInfo.generationRequest = debugInfo.generationRequest || {};
        debugInfo.generationRequest.en = english.debug?.generationRequest || null;

        let chineseReference = { extractedText: '', debug: { extractionRaw: '[no chinese reference text]', extractionMethod: 'not-used' } };
        if (skipExtraction && cachedDoc?.zhText) {
          // Reuse cached Chinese extracted text
          console.log(`[ai-generate] tc: reusing cached extracted text (${cachedDoc.zhText.length} chars)`);
          chineseReference = {
            extractedText: cachedDoc.zhText,
            debug: {
              extractionRaw: '[reused cached extracted text]',
              extractionMethod: 'cache',
              extractionRequest: { endpoint: VLLM_URL, provider: VLLM_PROVIDER, model: VLLM_MODEL, prompt: '(skipped — reused cached text)', wordCount: '0', imageCount: 0 },
            },
          };
        } else {
          try {
            chineseReference = await extractPageText(dataRoot, bookId, sectionNum, page, 'tc', visionProvider);
          } catch (err) {
            console.warn('[ai-generate] tc: reference extraction failed, continuing with translation only');
            chineseReference = {
              extractedText: '',
              debug: {
                extractionRaw: err.debug?.extractionRaw || `[reference extraction failed] ${err.message}`,
                extractionMethod: err.debug?.extractionMethod || 'failed',
                extractionRequest: err.debug?.extractionRequest || null,
              },
            };
            debugInfo.errors.tcReference = err.message;
          }
        }

        const chinese = await translateGeneratedContent(
          bookId,
          sectionName,
          page,
          'tc',
          english.content,
          chineseReference.extractedText,
          chineseReference.debug,
          subjectId
        );
        results.tc = chinese.content;
        const zhExtractedText = chineseReference.extractedText || '';
        debugInfo.extractionRaw.tc = chinese.debug?.extractionRaw || '';
        debugInfo.generationRaw.tc = chinese.debug?.generationRaw || '';
        debugInfo.extractionMethod.tc = chinese.debug?.extractionMethod || 'not-used';
        debugInfo.extractionRequest = debugInfo.extractionRequest || {};
        debugInfo.extractionRequest.tc = chineseReference.debug?.extractionRequest || null;
        debugInfo.generationRequest = debugInfo.generationRequest || {};
        debugInfo.generationRequest.tc = chinese.debug?.generationRequest || null;

        let enToSave = english.content;
        let zhToSave = chinese.content;
        if (hasSkipFlags && cachedDoc) {
          enToSave = mergeSkippedParts(enToSave, cachedDoc.en, { summary: skipSummary, flashcards: skipFlashcards, quiz: skipQuiz });
          zhToSave = mergeSkippedParts(zhToSave, cachedDoc.zh, { summary: skipSummary, flashcards: skipFlashcards, quiz: skipQuiz });
        }
        await saveAlignedBilingualAiContent(subjectId, bookId, sectionNum, page, enToSave, zhToSave, userId, enExtractedText, zhExtractedText);
      } catch (err) {
        console.error('[ai-generate] aligned generation failed —', err.message);
        results.en = results.en || { error: err.message };
        results.tc = results.tc || { error: err.message };
        debugInfo.extractionRaw.en = debugInfo.extractionRaw.en || err.debug?.extractionRaw || '';
        debugInfo.generationRaw.en = debugInfo.generationRaw.en || err.debug?.generationRaw || '[generation not attempted]';
        debugInfo.extractionRequest = debugInfo.extractionRequest || {};
        debugInfo.extractionRequest.en = debugInfo.extractionRequest.en || err.debug?.extractionRequest || null;
        debugInfo.generationRequest = debugInfo.generationRequest || {};
        debugInfo.generationRequest.en = debugInfo.generationRequest.en || err.debug?.generationRequest || null;
        // Only assign the error to languages that actually failed
        if (!results.en || results.en.error) {
          debugInfo.errors.en = debugInfo.errors.en || err.message;
        }
        if (!results.tc || results.tc.error) {
          debugInfo.errors.tc = debugInfo.errors.tc || err.message;
        }

        // Save English content even if TC translation failed, so the user
        // gets partial results instead of losing everything.
        if (results.en && !results.en.error && aiGenerations) {
          try {
            await saveAlignedBilingualAiContent(subjectId, bookId, sectionNum, page, results.en, null, userId);
            console.log('[ai-generate] saved en-only content (tc translation failed)');
          } catch (saveErr) {
            console.error('[ai-generate] failed to save en-only fallback —', saveErr.message);
          }
        }
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
        extractionRequest: debugInfo.extractionRequest || {},
        generationRequest: debugInfo.generationRequest || {},
        extractionMethod: debugInfo.extractionMethod,
        errors: debugInfo.errors,
        subjectId, bookId, sectionId: sectionNum, pageId: page,
        languages: {
          en: !!(results.en && !results.en.error),
          zh: !!(results.tc && !results.tc.error),
        },
      };
    }
    clearInterval(keepAlive);
    response.end(JSON.stringify(responsePayload));
  } catch (err) {
    console.error('[ai-generate] error:', err);
    // Headers already flushed — send error as body
    clearInterval(keepAlive);
    response.end(JSON.stringify({ error: err.message }));
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

// ── QR decode using zbarimg (industrial-grade, same as dnschecker.org backend) ──
app.post('/api/qr-decode', asyncRoute(async (request, response) => {
  const { image } = request.body || {};
  if (!image || typeof image !== 'string') {
    return response.status(400).json({ error: 'Missing base64 image' });
  }

  // Strip data:image prefix if present
  const b64 = image.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');

  // Validate: check PNG header (8 bytes: 89 50 4E 47 0D 0A 1A 0A)
  const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const isValidPng = buf.length >= 8 && buf.slice(0, 8).equals(pngMagic);
  if (!isValidPng) {
    console.log(`[qr-decode] invalid image: ${buf.length} bytes, header: ${buf.slice(0, 8).toString('hex')}`);
    return response.json({ data: null });
  }

  console.log(`[qr-decode] received ${buf.length} bytes`);

  // Write to a temp PNG file for zbarimg
  const tmpDir = path.join(__dirname, '..', 'logs');
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `qr-tmp-${Date.now()}.png`);

  try {
    await fs.writeFile(tmpFile, buf);

    // Run zbarimg: industrial-grade QR/barcode scanner
    const result = await new Promise((resolve, reject) => {
      execFile('zbarimg', ['--quiet', '--raw', '--oneshot', '-Sdisable', '-Sqrcode.enable', tmpFile], {
        timeout: 5000,
      }, (err, stdout, stderr) => {
        if (err) {
          // zbarimg exits non-zero if no barcode found
          if (stderr) console.log('[qr-decode] zbarimg stderr:', stderr.trim());
          return resolve(null);
        }
        const data = stdout.trim();
        resolve(data || null);
      });
    });

    if (result) {
      console.log('[qr-decode] ✅ zbarimg:', result);
      response.json({ data: result });
    } else {
      // Try with preprocessed version (sharp grayscale + contrast)
      const sharpened = await sharp(buf)
        .greyscale()
        .normalize()
        .png()
        .toBuffer();
      const tmpFile2 = path.join(tmpDir, `qr-tmp-${Date.now()}-sharp.png`);
      await fs.writeFile(tmpFile2, sharpened);

      const result2 = await new Promise((resolve, reject) => {
        execFile('zbarimg', ['--quiet', '--raw', '--oneshot', '-Sdisable', '-Sqrcode.enable', tmpFile2], {
          timeout: 5000,
        }, (err, stdout, stderr) => {
          if (err) {
            if (stderr) console.log('[qr-decode] zbarimg (sharp) stderr:', stderr.trim());
            return resolve(null);
          }
          const data = stdout.trim();
          resolve(data || null);
        });
      });

      // Clean up sharp temp file
      await fs.unlink(tmpFile2).catch(() => {});

      if (result2) {
        console.log('[qr-decode] ✅ zbarimg (sharp):', result2);
        response.json({ data: result2 });
      } else {
        console.log('[qr-decode] zbarimg: no QR found');
        response.json({ data: null });
      }
    }
  } catch (err) {
    console.error('[qr-decode] error:', err.message);
    response.status(500).json({ error: err.message });
  } finally {
    // Clean up temp files
    await fs.unlink(tmpFile).catch(() => {});
  }
}));

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
