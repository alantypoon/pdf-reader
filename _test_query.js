import { MongoClient } from 'mongodb';
async function test() {
  const client = new MongoClient('mongodb://localhost:27017/pdf-reader');
  await client.connect();
  const db = client.db('pdf-reader');
  const col = db.collection('ai-generations');

  // Query as the server would
  const query = { subjectId: 'math-oup', bookId: '4a', sectionId: 1, pageId: 1 };
  console.log('Query:', JSON.stringify(query));
  const doc = await col.findOne(query, { sort: { updatedAt: -1 } });
  console.log('Result:', doc ? 'FOUND' : 'NOT FOUND');
  if (doc) {
    console.log('Fields:', Object.keys(doc).join(', '));
    console.log('en keys:', doc.en ? Object.keys(doc.en).join(', ') : 'null');
  }

  // Also try without pageId
  const query2 = { subjectId: 'math-oup', bookId: '4a', sectionId: 1 };
  const docs = await col.find(query2).toArray();
  console.log('\nDocs with subjectId=math-oup, bookId=4a, sectionId=1:', docs.length);
  docs.forEach(d => console.log('  pageId:', d.pageId, 'type:', typeof d.pageId));

  // Compare with chemistry-winter
  const query3 = { subjectId: 'chemistry-winter', bookId: '1', sectionId: 1, pageId: 1 };
  console.log('\nChemistry-winter query:', JSON.stringify(query3));
  const doc3 = await col.findOne(query3, { sort: { updatedAt: -1 } });
  console.log('Result:', doc3 ? 'FOUND' : 'NOT FOUND');

  await client.close();
}
test().catch(e => console.error(e));
