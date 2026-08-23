#!/usr/bin/env node
/**
 * Migration: backfill myPaperVersion field on existing my-paper annotations.
 *
 * Before this migration, all My Paper annotations were stored with
 * langId='my-paper' but without a consistent bookId/sectionId scope.
 * This script adds a `myPaperVersion` field to each annotation document
 * that has langId='my-paper', inferred from the document's existing fields:
 *
 *   - bookId looks like a chapter ID (e.g. '1a', '2b') AND sectionId > 0
 *     → version = 'textbook'
 *   - sectionId === 0 AND bookId === subjectId
 *     → version = 'general'
 *   - otherwise (bookId is a topic/year key)
 *     → version = 'past-paper'
 *
 * Run: node scripts/migrate-mypaper-scope.js [--dry-run]
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (same as server/index.js does via dotenv)
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '../.env');
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* .env not found — rely on system env */ }
}
loadEnv();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/pdf-reader';
const DRY_RUN = process.argv.includes('--dry-run');

function inferVersion(doc) {
  const bookId = String(doc.bookId || '');
  const subjectId = String(doc.subjectId || '');
  const sectionId = Number(doc.sectionId);

  // General: bookId equals subjectId and sectionId is 0
  if (sectionId === 0 && bookId === subjectId) return 'general';

  // Textbook: bookId looks like a chapter (short alphanumeric, e.g. '1a', '2b', '3')
  if (sectionId > 0 && /^[0-9]+[a-z]?$/i.test(bookId)) return 'textbook';

  // Past-paper: bookId is a topic or year key
  return 'past-paper';
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const col = db.collection('annotations');

  const cursor = col.find({ langId: 'my-paper' });
  let total = 0, updated = 0, skipped = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    total++;

    if (doc.myPaperVersion) {
      skipped++;
      continue;
    }

    const version = inferVersion(doc);
    if (!DRY_RUN) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { myPaperVersion: version } }
      );
    }
    updated++;
    console.log(`[${DRY_RUN ? 'DRY' : 'UPDATE'}] _id=${doc._id} user=${String(doc.userId||'').slice(0,6)} subject=${doc.subjectId} book=${doc.bookId} section=${doc.sectionId} → version=${version}`);
  }

  await client.close();
  console.log(`\nDone. total=${total} updated=${updated} skipped=${skipped}${DRY_RUN ? ' (DRY RUN — no changes written)' : ''}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
