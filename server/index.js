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
  const folders = await fs.readdir(dataRoot, { withFileTypes: true });
  const chapters = await Promise.all(
    folders
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const contentsPath = path.join(dataRoot, entry.name, 'contents.json');
        console.log('[catalog] reading contents.json:', contentsPath);
        const contents = await readJSON(contentsPath, { contents: [] });
        return { id: entry.name, name: contents.chapter || entry.name, contents: contents.contents || [] };
      })
  );
  response.json({ chapters });
});

app.get('/api/page', async (request, response) => {
  const { chapter, language, page } = request.query;
  const filePath = path.join(dataRoot, String(chapter), String(language), `${String(page)}.pdf`);
  const url = `/data/biology-oup/${chapter}/${language}/${page}.pdf`;
  console.log('[page] checking PDF:', filePath, '→ url:', url);
  try {
    await fs.access(filePath);
    response.json({ url });
  } catch {
    console.log('[page] PDF not found:', filePath);
    response.json({ url: '' });
  }
});

app.get('/api/remarks', async (_request, response) => {
  response.json(await readJSON(remarksFile, { remarks: [] }));
});

app.post('/api/remarks', async (request, response) => {
  const current = await readJSON(remarksFile, { remarks: [] });
  const remarks = [...current.remarks, request.body];
  await fs.writeFile(remarksFile, JSON.stringify({ remarks }, null, 2));
  response.json({ remarks });
});

app.use('/data', express.static(path.resolve(__dirname, '../data')));

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
