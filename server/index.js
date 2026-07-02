import 'dotenv/config';
import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3001;
const execFileAsync = promisify(execFile);

const DATA_PATH = process.env.DATA_PATH || path.resolve(__dirname, '../data');
const dataRoot = path.join(DATA_PATH, 'biology-oup');
const remarksFile = path.join(DATA_PATH, 'remarks.json');
const DSE_AUTH_CONFIG_PATH = process.env.DSE_AUTH_CONFIG_PATH || path.resolve(__dirname, '../../../dse-auth-config.php');

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pdf-reader';
let mongoClient;
let aiGenerations;
let userActions;

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db('pdf-reader');
    aiGenerations = db.collection('ai-generations');
    userActions = db.collection('user-actions');
    console.log('[mongo] connected to', MONGO_URI.replace(/\/\/.*@/, '//<credentials>@'));
  } catch (err) {
    console.warn('[mongo] connection failed, AI content persistence disabled:', err.message);
  }
}

console.log('[server] DATA_PATH:', DATA_PATH);
console.log('[server] dataRoot:', dataRoot);
console.log('[server] remarksFile:', remarksFile);

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
    createdAt: new Date().toISOString(),
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

app.get('/api/session-user', (request, response) => {
  response.json({ userId: getAuthenticatedUserId(request) });
});

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

app.get('/api/catalog', asyncRoute(async (_request, response) => {
  console.log('[catalog] dataRoot:', dataRoot);
  if (!existsSync(dataRoot)) {
    response.status(500).json({ error: `Data root not found: ${dataRoot}` });
    return;
  }
  const folders = await fs.readdir(dataRoot, { withFileTypes: true });
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
        return {
          id: entry.name,
          name: formatBookLabel(entry.name, contents.name),
          contents: contents.contents || []
        };
      })
  );
  console.log('[catalog] returning', chapters.length, 'chapters');
  response.json({ chapters });
}));

app.get('/api/page', asyncRoute(async (request, response) => {
  const { chapter, language, page } = request.query;
  console.log(`[page] request: chapter=${chapter} language=${language} page=${page}`);
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
      .map((f) => `/pdf-reader/data/biology-oup/${chapter}/${language}/contents/pages/${f}`);

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
      pdfUrl = `/pdf-reader/data/biology-oup/${chapter}/${language}/contents/${exactMatch}`;
    } else {
      const prefixMatch = dirFiles.find(
        (f) => f.startsWith(`${String(page)}-`) && f.endsWith('.pdf')
      );
      if (prefixMatch) {
        pdfUrl = `/pdf-reader/data/biology-oup/${chapter}/${language}/contents/${prefixMatch}`;
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

function remarksPath(userId) {
  const safe = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_PATH, `remarks-${safe}.json`);
}

app.get('/api/remarks', asyncRoute(async (request, response) => {
  const file = remarksPath(request.query.userId);
  response.json(await readJSON(file, { remarks: [] }));
}));

app.post('/api/remarks', asyncRoute(async (request, response) => {
  const { userId, ...remark } = request.body;
  const file = remarksPath(userId);
  const current = await readJSON(file, { remarks: [] });
  const remarks = [...current.remarks, remark];
  await fs.writeFile(file, JSON.stringify({ remarks }, null, 2));
  response.json({ remarks });
}));

app.delete('/api/remarks', async (request, response) => {
  try {
    const { userId, chapter, page } = request.query;
    const file = remarksPath(userId);
    console.log(`[remarks] DELETE userId=${userId} chapter=${chapter} page=${page} file=${file}`);
    const current = await readJSON(file, { remarks: [] });
    console.log(`[remarks]   before: ${current.remarks.length} remarks`);
    let remarks;
    if (page != null) {
      remarks = current.remarks.filter(
        (r) => !(r.chapter === chapter && Number(r.page) === Number(page))
      );
    } else {
      remarks = current.remarks.filter(
        (r) => r.chapter !== chapter
      );
    }
    console.log(`[remarks]   after: ${remarks.length} remarks`);
    await fs.writeFile(file, JSON.stringify({ remarks }, null, 2));
    response.json({ remarks });
  } catch (err) {
    console.error('[remarks] DELETE error:', err);
    response.status(500).json({ error: 'Failed to erase remarks' });
  }
});

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
      headers: { 'User-Agent': 'PDF Reader Proxy/1.0' },
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

/** Find split page image files for a given section within a chapter/language */
async function findPageImages(chapter, language, section) {
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

  return results;
}

/** Build the AI prompt for flash card and MCQ generation */
function buildGenerationPrompt(chapter, sectionName, pageNum, language, extractedText) {
  const langInstruction = language === 'tc'
    ? '所有內容必須使用繁體中文。問題和答案都要用中文書寫。'
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
1. 4-6 flashcards (each with "question" and "answer")
2. 3-5 MCQ questions (each with "question", 4 "options" labeled A-D, "correct" letter, and "explanation")

Output ONLY the JSON object, no markdown:
{
  "flashcards": [{"question":"...","answer":"..."}],
  "mcq": [{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A","explanation":"..."}]
}`;
}

function buildTranslationPrompt(chapter, sectionName, pageNum, targetLanguage, sourceContent, referenceText) {
  const langInstruction = targetLanguage === 'tc'
    ? 'Translate everything into Traditional Chinese.'
    : 'Translate everything into English.';

  return `You are an expert bilingual biology educator. Translate the study materials below while preserving the meaning EXACTLY.

The content is from:
- Chapter: ${chapter}
- Section: ${sectionName}
- Page: ${pageNum}

${langInstruction}

IMPORTANT REQUIREMENTS:
- The translated English and Chinese versions must match in meaning item-by-item.
- Keep the SAME number of flashcards and MCQ questions.
- Preserve the SAME ordering.
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

async function extractTextWithTesseract(imagePaths, language) {
  const tesseractLanguage = language === 'tc' ? 'eng' : 'eng';
  const outputs = [];
  for (const imagePath of imagePaths) {
    const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '--psm', '11', '-l', tesseractLanguage], {
      maxBuffer: 20 * 1024 * 1024,
    });
    if (stdout?.trim()) {
      outputs.push(stdout.trim());
    }
  }
  return outputs.join('\n\n').trim();
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
  genFormData.append('max_tokens', '1000');

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

async function extractPageText(chapter, sectionNum, page, language) {
  const sectionImages = await findPageImages(chapter, language, sectionNum);
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
    ? '從這些教科書頁面圖像中提取並轉錄所有文字內容。包括所有標題、正文和圖片說明。請用繁體中文輸出。'
    : 'Extract and transcribe all text content from these textbook page images. Include all headings, body text, and captions.';

  const formData = new FormData();
  formData.append('provider', AIGATEWAY_PROVIDER);
  formData.append('apiKey', AIGATEWAY_APIKEY);
  formData.append('model', AIGATEWAY_MODEL);
  formData.append('wordCount', '3000');
  formData.append('prompt', extractPrompt);

  for (const imgPath of selectedImages) {
    const imgBuffer = await fs.readFile(imgPath);
    const filename = path.basename(imgPath);
    formData.append('files', new Blob([imgBuffer]), filename);
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
    try {
      const ocrText = await extractTextWithTesseract(selectedImages, language);
      if (ocrText.trim()) {
        debug.extractionMethod = language === 'tc' ? 'tesseract-fallback-eng' : 'tesseract-fallback';
        debug.extractionRaw = `${text}\n\n=== Tesseract fallback ===\n${ocrText}`;
        extractedText = ocrText;
        console.log(`[ai-generate] ${language}: using local OCR fallback, text length=${extractedText.length}`);
      }
    } catch (err) {
      debug.extractionRaw = `${text}\n\n=== Tesseract fallback error ===\n${err.message}`;
      console.warn(`[ai-generate] ${language}: tesseract fallback failed — ${err.message}`);
    }
  }

  if (!extractedText.trim()) {
    throw new AiGenerationError(`No text could be extracted for language=${language}`, debug);
  }

  return { extractedText, debug, selectedImages };
}

/** Generate flashcards & MCQs for a single language. Returns the parsed content object. */
async function generateForLanguage(chapter, sectionNum, page, language, sectionName) {
  const extraction = await extractPageText(chapter, sectionNum, page, language);
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
async function saveAiContent(chapter, sectionNum, page, language, content, userId) {
  if (!aiGenerations) return;
  const langField = language === 'tc' ? 'zh' : 'en';
  const now = new Date().toISOString();
  await aiGenerations.updateOne(
    {
      bookId: String(chapter),
      sectionId: Number(sectionNum),
      pageId: Number(page),
    },
    {
      $set: {
        [langField]: content,
        [`${langField}UpdatedAt`]: now,
        updatedAt: now,
        ...(userId ? { user: String(userId) } : {}),
      },
      $setOnInsert: { createdAt: now, bookId: String(chapter), sectionId: Number(sectionNum), pageId: Number(page) },
    },
    { upsert: true }
  );
  console.log(`[ai-generate] ${language}: saved to ai-generations (field=${langField})`);
}

async function saveAlignedBilingualAiContent(chapter, sectionNum, page, enContent, zhContent, userId) {
  if (!aiGenerations) return;
  const now = new Date().toISOString();
  const identity = {
    bookId: String(chapter),
    sectionId: Number(sectionNum),
    pageId: Number(page),
  };
  await aiGenerations.deleteMany(identity);
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

async function getAiContentDocument(chapter, sectionNum, page) {
  if (!aiGenerations) return null;
  return aiGenerations.findOne({
    bookId: String(chapter),
    sectionId: Number(sectionNum),
    pageId: Number(page),
  });
}

function hasStoredAiContent(doc) {
  return !!(doc && (doc.en || doc.zh));
}

/** Check DB for existing generated content for a language */
async function getCachedAiContent(chapter, sectionNum, page, language) {
  if (!aiGenerations) return null;
  const doc = await aiGenerations.findOne({
    bookId: String(chapter),
    sectionId: Number(sectionNum),
    pageId: Number(page),
  });
  if (!doc) return null;
  const langField = language === 'tc' ? 'zh' : 'en';
  return doc[langField] || null;
}

app.post('/api/ai-generate', async (request, response) => {
  try {
    const { chapter, section: sectionNum, page, sectionName, userId } = request.body;
    const isTestMode = request.body.test === true || request.body.test === '1';
    const forceRegenerate = request.body.force === true || request.body.force === '1';
    console.log(`[ai-generate] chapter=${chapter} section=${sectionNum} page=${page} (both en + tc)`);
    const debugInfo = {
      request: {
        chapter,
        section: sectionNum,
        page,
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

    const cachedDoc = await getAiContentDocument(chapter, sectionNum, page);
    if (!forceRegenerate && hasStoredAiContent(cachedDoc)) {
      console.log('[ai-generate] using cached ai content from database');
      results.en = cachedDoc.en;
      results.tc = cachedDoc.zh;
      debugInfo.cache = 'existing-document-hit';
    } else {
      try {
        const english = await generateForLanguage(chapter, sectionNum, page, 'en', sectionName);
        results.en = english.content;
        debugInfo.extractionRaw.en = english.debug?.extractionRaw || '';
        debugInfo.generationRaw.en = english.debug?.generationRaw || '';
        debugInfo.extractionMethod.en = english.debug?.extractionMethod || 'gateway';

        let chineseReference = { extractedText: '', debug: { extractionRaw: '[no chinese reference text]', extractionMethod: 'not-used' } };
        try {
          chineseReference = await extractPageText(chapter, sectionNum, page, 'tc');
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
          chapter,
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

        await saveAlignedBilingualAiContent(chapter, sectionNum, page, english.content, chinese.content, userId);
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
        chapter, section: sectionNum, page,
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

// ── AI Content CRUD (MongoDB) ────────────────────────────

app.get('/api/ai-content', async (request, response) => {
  try {
    const { chapter, section, page, language } = request.query;
    if (!aiGenerations) {
      return response.json({ content: null });
    }
    const query = {
      bookId: String(chapter),
      sectionId: Number(section),
    };
    if (page != null) {
      query.pageId = Number(page);
    }
    const doc = await aiGenerations.findOne(query, { sort: { updatedAt: -1 } });
    if (!doc) {
      return response.json({ content: null });
    }
    // If a specific language is requested, return just that; otherwise return both
    if (language === 'en' || language === 'tc') {
      const langField = language === 'tc' ? 'zh' : 'en';
      response.json({ content: doc[langField] || null, updatedAt: doc.updatedAt || null });
    } else {
      response.json({ content: { en: doc.en || null, zh: doc.zh || null }, updatedAt: doc.updatedAt || null });
    }
  } catch (err) {
    console.error('[ai-content] GET error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.post('/api/ai-content', async (request, response) => {
  try {
    const { userId, chapter, section, page, language, content } = request.body;
    if (!aiGenerations) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    const langField = language === 'tc' ? 'zh' : 'en';
    const now = new Date().toISOString();
    const identity = {
      bookId: String(chapter),
      sectionId: Number(section),
      pageId: Number(page),
    };
    const existing = await aiGenerations.findOne(identity);
    await aiGenerations.deleteMany(identity);
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
    const { chapter, section } = request.query;
    if (!aiGenerations) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    await aiGenerations.deleteOne({
      bookId: String(chapter),
      sectionId: Number(section),
    });
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
