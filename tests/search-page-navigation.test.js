import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

for (const { subject, w, h, count, target } of [
  { subject: 'chemistry-aristo', w: 1693, h: 2245, count: 31, target: 25 },
  { subject: 'physics-oup', w: 1709, h: 2237, count: 60, target: 52 },
]) {
  for (const zoom of [0.75, 1, 1.5]) {
    test(`${subject} at zoom ${zoom} reserves full page heights before search destination images load`, async () => {
      const source = await readFile(new URL('../src/PdfPane.jsx', import.meta.url), 'utf8');
      const start = source.indexOf('        const w = baseWidth * zoom;');
      const end = source.indexOf('        // Also update any .my-paper-page', start);
      const images = Array.from({ length: count }, () => ({ w, h }));
      const imgs = images.map(() => ({ style: {}, naturalWidth: 0, naturalHeight: 0 }));
      const placeholders = [1, target, count].map((page) => ({
        dataset: { page: String(page) },
        style: { height: '1061px' },
      }));
      vm.runInNewContext(source.slice(start, end), {
        baseWidth: 600,
        zoom,
        images,
        imgs,
        placeholders,
      });
      const expectedHeight = `${Math.round(h * 600 * zoom / w)}px`;
      assert.deepEqual(
        [...imgs, ...placeholders].map(({ style }) => [style.width, style.height]),
        Array.from({ length: count + placeholders.length }, () => [`${600 * zoom}px`, expectedHeight]),
      );
    });
  }
}

test('resizing preserves each page aspect ratio and uses loaded dimensions for legacy URLs', async () => {
  const source = await readFile(new URL('../src/PdfPane.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('        const w = baseWidth * zoom;');
  const end = source.indexOf('        // Also update any .my-paper-page', start);
  const imgs = [
    { style: {}, naturalWidth: 0, naturalHeight: 0 },
    { style: {}, naturalWidth: 0, naturalHeight: 0 },
    { style: {}, naturalWidth: 800, naturalHeight: 1200 },
  ];
  const placeholders = [3, 1, 2].map((page) => ({
    dataset: { page: String(page) },
    style: { height: '1061px' },
  }));
  vm.runInNewContext(source.slice(start, end), {
    baseWidth: 600,
    zoom: 1,
    images: [{ w: 1200, h: 800 }, { w: 800, h: 1200 }, 'legacy.png'],
    imgs,
    placeholders,
  });
  assert.deepEqual(
    [...imgs, ...placeholders].map(({ style }) => [style.width, style.height]),
    [400, 900, 900, 900, 400, 900].map((height) => ['600px', `${height}px`]),
  );
});
