import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';

const SORT_FIELDS = ['datetime', 'bookName', 'sectionName'];
const SEARCH_FIELDS = ['createdAt', 'actionType', 'subjectId', 'bookName', 'sectionName', 'chapter', 'section', 'language', 'source'];

export function parseActionLogQuery(query) {
  const sort = query.sort ?? 'datetime';
  const direction = query.direction ?? 'desc';
  const search = query.search ?? '';
  const limit = Number(query.limit ?? 50);
  if (!SORT_FIELDS.includes(sort) || !['asc', 'desc'].includes(direction)
    || typeof search !== 'string' || search.length > 200
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Invalid log search, sort, direction or limit.');
  }
  let cursor = null;
  if (query.cursor != null) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 8000) throw new Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor.value !== 'string' || cursor.value.length > 4000
        || typeof cursor.id !== 'string' || !/^[a-f0-9]{24}$/i.test(cursor.id)
        || cursor.sort !== sort || cursor.direction !== direction || cursor.search !== search.trim()) {
        throw new Error();
      }
    } catch {
      throw new RangeError('Invalid log pagination cursor.');
    }
  }
  return { sort, direction, search: search.trim(), limit, cursor };
}

function labelSwitch(branches, fallback) {
  return branches.length ? { $switch: { branches, default: fallback } } : fallback;
}

async function catalogLabels(collection, userId, textbooksRoot) {
  const subjects = await collection.distinct('subjectId', { userId });
  const books = [];
  const sections = [];
  for (const subject of subjects) {
    if (typeof subject !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(subject)) continue;
    const root = path.join(textbooksRoot, subject);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let contents;
      try {
        contents = JSON.parse(await fs.readFile(path.join(root, entry.name, 'contents.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const location = [
        { $eq: ['$subjectId', { $literal: subject }] },
        { $eq: ['$_chapter', { $literal: entry.name }] },
      ];
      const name = contents.nameEn || contents.name || contents.nameZh;
      books.push({
        case: { $and: location },
        then: { $literal: name && name.toUpperCase() !== entry.name.toUpperCase() ? `${entry.name.toUpperCase()} - ${name}` : entry.name.toUpperCase() },
      });
      const chapterSections = [];
      for (const section of contents.contents || []) {
        const sectionId = section.page ?? section.section;
        const sectionName = (typeof section.en === 'string' ? section.en : section.en?.name)
          || (typeof section.tc === 'string' ? section.tc : section.tc?.name) || section.name;
        if (sectionId == null || !sectionName) continue;
        const branch = {
          case: { $and: [...location, { $eq: ['$_section', { $literal: String(sectionId) }] }] },
          then: { $literal: String(sectionName) },
        };
        if (section['page-num'] != null) {
          sections.push({
            case: { $and: [...branch.case.$and, { $eq: [
              { $convert: { input: { $ifNull: ['$page', '$metadata.page'] }, to: 'string', onNull: '', onError: '' } },
              { $literal: String(section['page-num']) },
            ] }] },
            then: branch.then,
          });
        }
        chapterSections.push(branch);
      }
      sections.push(...chapterSections);
    }
  }
  return { books, sections };
}

export async function readActionLogPage(collection, userId, textbooksRoot, options) {
  const { books, sections } = await catalogLabels(collection, userId, textbooksRoot);
  const { sort, direction, search, limit, cursor } = options;
  const order = direction === 'asc' ? 1 : -1;
  const stringValue = (input) => ({ $convert: { input, to: 'string', onNull: '', onError: '' } });
  const labelStages = [
    { $addFields: {
      _chapter: stringValue({ $ifNull: ['$chapter', '$metadata.chapter'] }),
      _section: stringValue({ $ifNull: ['$section', '$metadata.section'] }),
    } },
    { $addFields: {
      bookName: { $ifNull: ['$bookName', labelSwitch(books, '$_chapter')] },
      sectionName: { $ifNull: ['$sectionName', { $ifNull: ['$metadata.sectionName', labelSwitch(sections, '$_section')] }] },
    } },
  ];
  // Resolve labels after pagination when they cannot affect matching or ordering.
  const earlyLabels = sort !== 'datetime' || Boolean(search);
  const pipeline = [
    { $match: { userId } },
    ...(earlyLabels ? labelStages : []),
    { $addFields: {
      _sortValue: sort === 'datetime'
        ? { $dateToString: { date: { $convert: { input: '$createdAt', to: 'date', onError: null, onNull: null } }, onNull: '' } }
        : stringValue(`$${sort}`),
    } },
  ];
  if (search) {
    const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pipeline.push({ $match: { $or: SEARCH_FIELDS.map((field) => ({
      [field]: { $regex: literal, $options: 'i' },
    })) } });
  }
  if (cursor) {
    const comparison = order === 1 ? '$gt' : '$lt';
    pipeline.push({ $match: { $or: [
      { _sortValue: { [comparison]: cursor.value } },
      { _sortValue: cursor.value, _id: { [comparison]: new ObjectId(cursor.id) } },
    ] } });
  }
  pipeline.push(
    { $sort: { _sortValue: order, _id: order } },
    { $limit: limit + 1 },
    ...(!earlyLabels ? labelStages : []),
    { $project: {
      userId: 1, createdAt: 1, actionType: 1, subjectId: 1, bookName: 1, sectionName: 1,
      chapter: '$_chapter', section: '$_section', page: { $ifNull: ['$page', '$metadata.page'] },
      language: { $ifNull: ['$language', '$metadata.language'] }, durationMs: 1, metadata: 1, _sortValue: 1,
    } },
  );
  const rows = await collection.aggregate(pipeline, {
    collation: { locale: 'en', strength: 2, numericOrdering: true },
    maxTimeMS: 15000,
  }).toArray();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({
    value: last._sortValue, id: String(last._id), sort, direction, search,
  })).toString('base64url') : null;
  return {
    userId,
    items: page.map(({ _id, _sortValue, ...row }) => ({ ...row, id: String(_id) })),
    nextCursor,
  };
}
