import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3001;

const DATA_PATH = process.env.DATA_PATH || path.resolve(__dirname, '../data');
const dataRoot = path.join(DATA_PATH, 'biology-oup');
const remarksFile = path.join(DATA_PATH, 'remarks.json');

console.log('[server] DATA_PATH:', DATA_PATH);
console.log('[server] dataRoot:', dataRoot);
console.log('[server] remarksFile:', remarksFile);

app.use(express.json());

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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
