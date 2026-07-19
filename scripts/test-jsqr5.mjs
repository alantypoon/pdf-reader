import sharp from 'sharp';
import jsQR from 'jsqr';

const input = process.argv[2] || 'qrcode-5.png';
const meta = await sharp(input).metadata();
console.log('Image:', meta.width, 'x', meta.height);

// Manually test jsQR with green channel preprocessing
for (const scale of [2, 3, 4, 5, 6, 8]) {
  const sw = meta.width * scale;
  const sh = meta.height * scale;

  // Green channel → nearest upscale → raw
  const raw = await sharp(input)
    .ensureAlpha()
    .extractChannel(1)
    .resize(sw, sh, { kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer();

  // Convert to RGBA (raw grayscale)
  const rgba = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const v = raw[i];
    const off = i * 4;
    rgba[off] = v; rgba[off + 1] = v; rgba[off + 2] = v; rgba[off + 3] = 255;
  }

  try {
    let qr = jsQR(rgba, sw, sh, { inversionAttempts: 'dontInvert' });
    if (qr?.data) { console.log(`${scale}x raw dontInvert: ${qr.data}`); process.exit(0); }

    qr = jsQR(rgba, sw, sh, { inversionAttempts: 'attemptBoth' });
    if (qr?.data) { console.log(`${scale}x raw attemptBoth: ${qr.data}`); process.exit(0); }

    qr = jsQR(rgba, sw, sh, { inversionAttempts: 'onlyInvert' });
    if (qr?.data) { console.log(`${scale}x raw onlyInvert: ${qr.data}`); process.exit(0); }
  } catch (e) {
    console.log(`  ${scale}x raw: error - ${e.message}`);
  }

  // Also try with Otsu binarization
  const hist = new Uint32Array(256);
  const total = raw.length;
  for (let i = 0; i < total; i++) hist[raw[i]]++;
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  const sumTotal = raw.reduce((a, b) => a + b, 0);
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const between = wB * wF * ((sumB / wB) - ((sumTotal - sumB) / wF)) ** 2;
    if (between > maxVar) { maxVar = between; thr = t; }
  }

  // Normal binary (dark = black)
  const binRgba = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const v = raw[i] < thr ? 0 : 255;
    const off = i * 4;
    binRgba[off] = v; binRgba[off + 1] = v; binRgba[off + 2] = v; binRgba[off + 3] = 255;
  }

  try {
    let qr = jsQR(binRgba, sw, sh, { inversionAttempts: 'attemptBoth' });
    if (qr?.data) { console.log(`${scale}x otsu(${thr}) attemptBoth: ${qr.data}`); process.exit(0); }

    qr = jsQR(binRgba, sw, sh, { inversionAttempts: 'dontInvert' });
    if (qr?.data) { console.log(`${scale}x otsu(${thr}) dontInvert: ${qr.data}`); process.exit(0); }
  } catch (e) {
    console.log(`  ${scale}x otsu(${thr}): error - ${e.message}`);
  }

  // Inverted binary (dark = white, i.e. QR is white-on-black)
  const invRgba = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const v = raw[i] < thr ? 255 : 0;
    const off = i * 4;
    invRgba[off] = v; invRgba[off + 1] = v; invRgba[off + 2] = v; invRgba[off + 3] = 255;
  }

  try {
    let qr = jsQR(invRgba, sw, sh, { inversionAttempts: 'dontInvert' });
    if (qr?.data) { console.log(`${scale}x otsu(${thr}) inv: ${qr.data}`); process.exit(0); }
  } catch (e) {
    console.log(`  ${scale}x otsu(${thr}) inv: error - ${e.message}`);
  }

  console.log(`  ${scale}x: no match`);
}

// Also try lanczos3 + threshold from sharp directly (what zbarimg pipeline would produce)
for (const scale of [2, 3, 4, 6, 8]) {
  const sw = meta.width * scale;
  const sh = meta.height * scale;

  const buf = await sharp(input)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(sw, sh, { kernel: 'lanczos3', fit: 'fill' })
    .threshold(128)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgba = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const off = i * 4;
    // all channels are same after flatten+threshold+grayscale
    const v = buf.data[off];
    rgba[off] = v; rgba[off + 1] = v; rgba[off + 2] = v; rgba[off + 3] = 255;
  }

  try {
    let qr = jsQR(rgba, sw, sh, { inversionAttempts: 'attemptBoth' });
    if (qr?.data) { console.log(`${scale}x lanczos+thresh both: ${qr.data}`); process.exit(0); }

    qr = jsQR(rgba, sw, sh, { inversionAttempts: 'dontInvert' });
    if (qr?.data) { console.log(`${scale}x lanczos+thresh: ${qr.data}`); process.exit(0); }
  } catch (e) {
    console.log(`  ${scale}x lanczos+thresh: error - ${e.message}`);
  }
  console.log(`  ${scale}x lanczos+thresh: no match`);
}

console.log('All manual attempts failed');
