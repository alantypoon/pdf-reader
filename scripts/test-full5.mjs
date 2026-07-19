import sharp from 'sharp';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import jsQR from 'jsqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { readFileSync } from 'fs';

const ZXING_WASM_BINARY = readFileSync(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url));
await prepareZXingModule({
  overrides: { wasmBinary: ZXING_WASM_BINARY.buffer.slice(ZXING_WASM_BINARY.byteOffset, ZXING_WASM_BINARY.byteOffset + ZXING_WASM_BINARY.byteLength) },
  fireImmediately: true,
});

const input = process.argv[2] || 'qrcode-5.png';
const meta = await sharp(input).metadata();

// Extract green channel, find content bounds, add quiet zone
const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// Find content bounds
let minX = info.width, minY = info.height, maxX = 0, maxY = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const g = data[(y * info.width + x) * 4 + 1];
    if (g < 200) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}

const contentW = maxX - minX + 1;
const contentH = maxY - minY + 1;
console.log(`Content: ${minX},${minY} - ${maxX},${maxY} = ${contentW}x${contentH}`);

// Build a clean binary image with proper quiet zone
// Try multiple version assumptions (21, 25, 29 modules)
for (const modules of [21, 25, 29, 33]) {
  const modSize = Math.round(contentW / modules);
  console.log(`\nTrying version with ${modules} modules, modSize=${modSize}px`);

  const idealW = modules * modSize;
  const idealH = modules * modSize;

  // Center the QZ in content
  const offX = Math.round((contentW - idealW) / 2);
  const offY = Math.round((contentH - idealH) / 2);

  // Extract green channel at the precise size
  const extractL = Math.max(0, minX + offX);
  const extractT = Math.max(0, minY + offY);
  const extractW = Math.min(info.width - extractL, idealW);
  const extractH = Math.min(info.height - extractT, idealH);

  if (extractW < 50 || extractH < 50) continue;

  const cropped = await sharp(input)
    .extract({ left: extractL, top: extractT, width: extractW, height: extractH })
    .ensureAlpha()
    .extractChannel(1)
    .raw()
    .toBuffer();

  // Add quiet zone (4 modules on each side)
  const qzPx = 4 * modSize;
  const totalW = extractW + qzPx * 2;
  const totalH = extractH + qzPx * 2;

  // Build binary image with quiet zone
  const bin = Buffer.alloc(totalW * totalH, 255);
  const binInv = Buffer.alloc(totalW * totalH, 0);

  for (let y = 0; y < extractH; y++) {
    for (let x = 0; x < extractW; x++) {
      const g = cropped[y * extractW + x];
      const val = g < 134 ? 0 : 255; // Otsu ~134
      bin[(y + qzPx) * totalW + (x + qzPx)] = val;
      binInv[(y + qzPx) * totalW + (x + qzPx)] = 255 - val;
    }
  }

  // Try ZXing on binary file
  const tmpFile = join(tmpdir(), `qr5-v${modules}.png`);
  await sharp(bin, { raw: { width: totalW, height: totalH, channels: 1 } }).png().toFile(tmpFile);
  try {
    const buf = await sharp(tmpFile).png().toBuffer();
    const results = await readBarcodes(buf, {
      formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
    });
    const hit = results.find(r => r.isValid && r.text);
    if (hit) { console.log(`ZXING v${modules} BIN: ✅ ${hit.text}`); process.exit(0); }
  } catch (e) {}

  // Try inverted
  const tmpInv = join(tmpdir(), `qr5-v${modules}-inv.png`);
  await sharp(binInv, { raw: { width: totalW, height: totalH, channels: 1 } }).png().toFile(tmpInv);
  try {
    const buf = await sharp(tmpInv).png().toBuffer();
    const results = await readBarcodes(buf, {
      formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
    });
    const hit = results.find(r => r.isValid && r.text);
    if (hit) { console.log(`ZXING v${modules} INV: ✅ ${hit.text}`); process.exit(0); }
  } catch (e) {}

  // Try jsQR at multiple scales on the binary
  for (const scale of [1, 2, 3, 4]) {
    const sw = totalW * scale;
    const sh = totalH * scale;

    // Upscale binary with nearest neighbor
    const upscaled = Buffer.alloc(sw * sh, 255);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        upscaled[y * sw + x] = bin[Math.floor(y / scale) * totalW + Math.floor(x / scale)];
      }
    }

    const rgba = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) {
      const v = upscaled[i];
      const off = i * 4;
      rgba[off] = v; rgba[off+1] = v; rgba[off+2] = v; rgba[off+3] = 255;
    }

    for (const inv of ['attemptBoth', 'dontInvert', 'onlyInvert']) {
      try {
        const qr = jsQR(rgba, sw, sh, { inversionAttempts: inv });
        if (qr?.data) { console.log(`jsQR v${modules} ${scale}x ${inv}: ✅ ${qr.data}`); process.exit(0); }
      } catch (e) {}
    }

    // Inverted version
    const upscaledInv = Buffer.alloc(sw * sh, 0);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        upscaledInv[y * sw + x] = binInv[Math.floor(y / scale) * totalW + Math.floor(x / scale)];
      }
    }
    const rgbaInv = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) {
      const v = upscaledInv[i];
      const off = i * 4;
      rgbaInv[off] = v; rgbaInv[off+1] = v; rgbaInv[off+2] = v; rgbaInv[off+3] = 255;
    }
    try {
      const qr = jsQR(rgbaInv, sw, sh, { inversionAttempts: 'dontInvert' });
      if (qr?.data) { console.log(`jsQR v${modules} ${scale}x inv: ✅ ${qr.data}`); process.exit(0); }
    } catch (e) {}
  }
}

// Also try with 5x upscale (nearest) directly on the full image, no crop
for (const scale of [2, 3, 4, 5, 6, 8, 10]) {
  const sw = meta.width * scale;
  const sh = meta.height * scale;
  const buf = await sharp(input)
    .ensureAlpha()
    .extractChannel(1)
    .resize(sw, sh, { kernel: 'nearest', fit: 'fill' })
    .threshold(134)
    .png()
    .toBuffer();
  
  const results = await readBarcodes(buf, {
    formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
  });
  const hit = results.find(r => r.isValid && r.text);
  if (hit) { console.log(`ZXING full ${scale}x thresh(134): ✅ ${hit.text}`); process.exit(0); }
  
  // Inverted
  const bufInv = await sharp(input)
    .ensureAlpha()
    .extractChannel(1)
    .resize(sw, sh, { kernel: 'nearest', fit: 'fill' })
    .negate()
    .threshold(121)
    .png()
    .toBuffer();
  const results2 = await readBarcodes(bufInv, {
    formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
  });
  const hit2 = results2.find(r => r.isValid && r.text);
  if (hit2) { console.log(`ZXING full ${scale}x neg+thresh(121): ✅ ${hit2.text}`); process.exit(0); }
}

console.log('\nAll attempts failed');
// Save a debug image
await sharp(input)
  .ensureAlpha()
  .extractChannel(1)
  .resize(127*5, 127*5, { kernel: 'nearest', fit: 'fill' })
  .threshold(134)
  .png()
  .toFile('/tmp/qr5-debug-5x.png');
console.log('Saved /tmp/qr5-debug-5x.png');
