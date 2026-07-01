import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3001;

const DATA_PATH = process.env.DATA_PATH || path.resolve(__dirname, '../data');
const dataRoot = path.join(DATA_PATH, 'biology-oup');
const remarksFile = path.join(DATA_PATH, 'remarks.json');

// ── MongoDB ───────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pdf-reader';
let mongoClient;
let aiContentCollection;

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db();
    aiContentCollection = db.collection('ai_content');
    console.log('[mongo] connected to', MONGO_URI.replace(/\/\/.*@/, '//<credentials>@'));
  } catch (err) {
    console.warn('[mongo] connection failed, AI content persistence disabled:', err.message);
  }
}

console.log('[server] DATA_PATH:', DATA_PATH);
console.log('[server] dataRoot:', dataRoot);
console.log('[server] remarksFile:', remarksFile);

app.use(express.json({ limit: '2mb' }));

async function readJSON(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

app.get('/api/catalog', async (_request, response) => {
  console.log('[catalog] dataRoot:', dataRoot);
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
        return { id: entry.name, name: contents.chapter || entry.name, contents: contents.contents || [] };
      })
  );
  console.log('[catalog] returning', chapters.length, 'chapters');
  response.json({ chapters });
});

app.get('/api/page', async (request, response) => {
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
});

function remarksPath(userId) {
  const safe = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_PATH, `remarks-${safe}.json`);
}

app.get('/api/remarks', async (request, response) => {
  const file = remarksPath(request.query.userId);
  response.json(await readJSON(file, { remarks: [] }));
});

app.post('/api/remarks', async (request, response) => {
  const { userId, ...remark } = request.body;
  const file = remarksPath(userId);
  const current = await readJSON(file, { remarks: [] });
  const remarks = [...current.remarks, remark];
  await fs.writeFile(file, JSON.stringify({ remarks }, null, 2));
  response.json({ remarks });
});

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

// SPA fallback — only for navigation routes (no file extension)
app.get('*', (request, response) => {
  if (request.path.includes('.')) {
    return response.status(404).send('Not found');
  }
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.sendFile(path.join(distPath, 'index.html'));
});

// ── AI Generation ─────────────────────────────────────────

const AIGATEWAY_URL = process.env.AIGATEWAY_API_URL || 'https://aigateway.aied.hku.hk/api/generate';
const AIGATEWAY_PROVIDER = process.env.AIGATEWAY_PROVIDER || 'ett';
const AIGATEWAY_MODEL = process.env.AIGATEWAY_MODEL || 'vllm|OpenGVLab/InternVL3_5-38B';
const AIGATEWAY_APIKEY = process.env.AIGATEWAY_APIKEY || '';

/** Find page image files on disk for a given chapter/language/page */
async function findPageImages(chapter, language, page) {
  const langDir = path.join(dataRoot, String(chapter), String(language));
  const pagesDir = path.join(langDir, 'contents', 'pages');
  const results = [];

  // Try split page images first
  try {
    const files = await fs.readdir(pagesDir);
    const prefix = `${String(page)}-`;
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
      const imgPath = path.join(imgDir, `${String(page)}.${ext}`);
      if (existsSync(imgPath)) {
        results.push(imgPath);
        break;
      }
    }
  }

  return results;
}

/** Build the AI prompt for flash card and MCQ generation */
function buildGenerationPrompt(chapter, sectionName, pageNum, language) {
  const langLabel = language === 'tc' ? 'Traditional Chinese' : 'English';
  return `You are an expert biology educator. Analyze the provided textbook page image(s) and generate learning materials to help a student study this content.

The content is from:
- Chapter: ${chapter}
- Section: ${sectionName}
- Page: ${pageNum}

Please generate the following in ${langLabel}:

1. **Flash Cards** (4-6 cards): Each flash card should have a concise question on the front and a clear answer on the back. Cover key concepts, definitions, processes, and diagrams from the page.

2. **MCQ Quiz** (3-5 questions): Multiple choice questions with 4 options each (A-D). Indicate the correct answer and provide a brief explanation for why it's correct.

Format your response as a JSON object with this exact structure:
{
  "flashcards": [
    { "question": "...", "answer": "..." }
  ],
  "mcq": [
    {
      "question": "...",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "correct": "A",
      "explanation": "..."
    }
  ]
}

Output ONLY the JSON object, no other text.`;
}

app.post('/api/ai-generate', async (request, response) => {
  try {
    const { chapter, section: sectionNum, page, sectionName, language } = request.body;
    console.log(`[ai-generate] chapter=${chapter} section=${sectionNum} page=${page} language=${language}`);

    if (!AIGATEWAY_APIKEY) {
      return response.status(500).json({ error: 'AIGATEWAY_APIKEY not configured' });
    }

    // Find page images on disk
    const imagePaths = await findPageImages(chapter, language || 'en', page);
    console.log(`[ai-generate] found ${imagePaths.length} images:`, imagePaths);

    if (imagePaths.length === 0) {
      return response.status(404).json({ error: 'No page images found for this page' });
    }

    // Build prompt
    const prompt = buildGenerationPrompt(chapter, sectionName || '', page, language || 'en');

    // Build FormData for aigateway
    const formData = new FormData();
    formData.append('provider', AIGATEWAY_PROVIDER);
    formData.append('apiKey', AIGATEWAY_APIKEY);
    formData.append('model', AIGATEWAY_MODEL);
    formData.append('wordCount', '2000');

    // Attach page images as files
    for (const imgPath of imagePaths) {
      const imgBuffer = await fs.readFile(imgPath);
      const filename = path.basename(imgPath);
      const blob = new Blob([imgBuffer]);
      formData.append('files', blob, filename);
    }

    // Send the prompt as a plain string (aigateway expects 'prompt', not 'messages')
    formData.append('prompt', prompt);

    console.log(`[ai-generate] calling aigateway: ${AIGATEWAY_URL}`);
    const aiResponse = await fetch(AIGATEWAY_URL, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: formData,
    });

    console.log(`[ai-generate] response status: ${aiResponse.status}`);

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error(`[ai-generate] error: ${errText}`);
      return response.status(502).json({ error: `AI Gateway error: ${aiResponse.status}` });
    }

    // Parse SSE stream to extract the final content
    const text = await aiResponse.text();
    console.log(`[ai-generate] raw response length: ${text.length}`);

    // SSE lines are "data: ..." — collect all data chunks
    let collected = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const chunk = line.slice(6).trim();
        if (chunk && chunk !== '[DONE]') {
          try {
            const parsed = JSON.parse(chunk);
            if (parsed.choices?.[0]?.delta?.content) {
              collected += parsed.choices[0].delta.content;
            } else if (parsed.choices?.[0]?.message?.content) {
              collected += parsed.choices[0].message.content;
            } else if (typeof parsed.content === 'string') {
              collected += parsed.content;
            } else if (typeof parsed.text === 'string') {
              collected += parsed.text;
            }
          } catch {
            // non-JSON data line, skip
          }
        }
      }
    }

    console.log(`[ai-generate] collected content length: ${collected.length}`);

    // Try to parse the collected content as JSON
    let result;
    try {
      // Find JSON object in the response (may have markdown fences)
      const jsonMatch = collected.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = JSON.parse(collected);
      }
    } catch {
      console.warn('[ai-generate] could not parse as JSON, returning raw content');
      result = { raw: collected };
    }

    response.json({ content: result });
  } catch (err) {
    console.error('[ai-generate] error:', err);
    response.status(500).json({ error: err.message });
  }
});

// ── AI Content CRUD (MongoDB) ────────────────────────────

app.get('/api/ai-content', async (request, response) => {
  try {
    const { userId, chapter, section } = request.query;
    if (!aiContentCollection) {
      return response.json({ content: null });
    }
    const doc = await aiContentCollection.findOne({
      userId: String(userId || 'default'),
      chapter: String(chapter),
      section: Number(section),
    });
    response.json({ content: doc?.content || null, updatedAt: doc?.updatedAt || null });
  } catch (err) {
    console.error('[ai-content] GET error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.post('/api/ai-content', async (request, response) => {
  try {
    const { userId, chapter, section, page, content } = request.body;
    if (!aiContentCollection) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    const now = new Date().toISOString();
    await aiContentCollection.updateOne(
      {
        userId: String(userId || 'default'),
        chapter: String(chapter),
        section: Number(section),
      },
      {
        $set: { content, page: Number(page), updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    response.json({ ok: true });
  } catch (err) {
    console.error('[ai-content] POST error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.delete('/api/ai-content', async (request, response) => {
  try {
    const { userId, chapter, section } = request.query;
    if (!aiContentCollection) {
      return response.status(500).json({ error: 'MongoDB not connected' });
    }
    await aiContentCollection.deleteOne({
      userId: String(userId || 'default'),
      chapter: String(chapter),
      section: Number(section),
    });
    response.json({ ok: true });
  } catch (err) {
    console.error('[ai-content] DELETE error:', err);
    response.status(500).json({ error: err.message });
  }
});

app.listen(port, async () => {
  await connectMongo();
  console.log(`Server running on http://localhost:${port}`);
});
