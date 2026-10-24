import fs from 'node:fs/promises';
import path from 'node:path';

const MISC_NAMES = new Set([
  'List of Definition',
  'Paragraph Length Question',
  'Summary of Diagrams',
  'Ultimate Intensive Note',
]);

export function classifyOtherLearningResource(name) {
  if (!name.endsWith('.pdf')) return null;
  const stem = name.slice(0, -4);
  if (MISC_NAMES.has(stem)) return 'misc';
  if (!/^\d{2}(?!\d)/.test(stem)) return null;
  return /\bAnswers?$/i.test(stem) ? 'answers' : 'questions';
}

/** List supported resources, preferring generated pages over the original PDF. */
export async function getOtherLearningResources(dataRoot) {
  const root = path.join(dataRoot, 'other-learning-resources');
  const catalog = { questions: [], answers: [], misc: [] };
  for (const name of (await fs.readdir(root)).sort()) {
    const category = classifyOtherLearningResource(name);
    if (!category) continue;
    const stem = name.slice(0, -4);
    let pages;
    try {
      pages = await fs.readdir(path.join(root, 'pages', stem));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      pages = [];
    }
    // Prefer PNG when both formats have been generated, without duplicating pages.
    const pageNames = new Map();
    for (const page of pages.sort()) {
      const match = page.match(/^page-(\d+)\.(png|jpg)$/);
      if (match) pageNames.set(Number(match[1]), page);
    }
    const baseUrl = '/pdf-reader/data/other-learning-resources';
    catalog[category].push({
      id: stem,
      name: stem,
      chapter: /^\d{2}/.test(stem) ? String(Number(stem.slice(0, 2))) : '',
      source: pageNames.size
        ? [...pageNames].sort(([a], [b]) => a - b)
          .map(([, page]) => `${baseUrl}/pages/${encodeURIComponent(stem)}/${page}`)
        : `${baseUrl}/${encodeURIComponent(name)}`,
    });
  }
  return catalog;
}
