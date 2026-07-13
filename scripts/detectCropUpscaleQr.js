#!/usr/bin/env node
/**
 * detectCropUpscaleQr.js — CLI script: detect a QR code in an image.
 *
 * Detection: uses zxing-wasm for a single QR detection pass, falls back to zbarimg.
 *
 * Usage:
 *   node detectCropUpscaleQr.js <input.png> [output.png]
 *   node detectCropUpscaleQr.js qrcode-2.png
 *   node detectCropUpscaleQr.js qrcode-2.png qr-upscaled.png
 *
 * Dependencies: sharp, jsqr, zxing-wasm, zbarimg (system)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const execFileAsync = promisify(execFile);

const SCALE_FACTOR = 3;
const QR_PADDING_PX = 2;
const MIN_DIM = 150;  // pre-upscale images smaller than this for detection
const JSQR_SCALE_CANDIDATES = [1, 2, 3, 4];
const JSQR_THRESHOLD_SWEEP = [40, 60, 80, 100, 120, 140, 160, 180, 200, 220];
const ZXING_WASM_BINARY = readFileSync(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url));

let zxingReadyPromise;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute axis-aligned bounding box from jsQR corner points. */
function cornersToBBox(corners, imgW, imgH) {
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs)) - QR_PADDING_PX);
  const y = Math.max(0, Math.floor(Math.min(...ys)) - QR_PADDING_PX);
  const w = Math.min(imgW - x, Math.ceil(Math.max(...xs)) - x + QR_PADDING_PX * 2);
  const h = Math.min(imgH - y, Math.ceil(Math.max(...ys)) - y + QR_PADDING_PX * 2);
  return { left: x, top: y, width: w, height: h };
}

/**
 * Binarize RGBA pixels to pure black/white using Otsu's method on luminance.
 */
function binarizeOtsu(rawPixels, w, h) {
  const total = w * h;
  const lum = new Uint8Array(total);
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const L = Math.round(rawPixels[off] * 0.299 + rawPixels[off + 1] * 0.587 + rawPixels[off + 2] * 0.114);
    lum[i] = L;
    hist[L]++;
  }
  let sumB = 0, wB = 0, maxVariance = 0, threshold = 128;
  const sumTotal = lum.reduce((a, b) => a + b, 0);
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const between = wB * wF * Math.pow(sumB / wB - (sumTotal - sumB) / wF, 2);
    if (between > maxVariance) { maxVariance = between; threshold = t; }
  }
  const out = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const v = lum[i] < threshold ? 0 : 255;
    out[off] = v; out[off + 1] = v; out[off + 2] = v; out[off + 3] = 255;
  }
  return out;
}

function thresholdPixels(rawPixels, threshold) {
  const out = new Uint8ClampedArray(rawPixels.length);
  for (let i = 0; i < rawPixels.length; i += 4) {
    const lum = rawPixels[i] * 0.299 + rawPixels[i + 1] * 0.587 + rawPixels[i + 2] * 0.114;
    const value = lum < threshold ? 0 : 255;
    out[i] = value;
    out[i + 1] = value;
    out[i + 2] = value;
    out[i + 3] = 255;
  }
  return out;
}

function invertedThresholdPixels(rawPixels, threshold) {
  const out = new Uint8ClampedArray(rawPixels.length);
  for (let i = 0; i < rawPixels.length; i += 4) {
    const lum = rawPixels[i] * 0.299 + rawPixels[i + 1] * 0.587 + rawPixels[i + 2] * 0.114;
    const value = lum < threshold ? 255 : 0;
    out[i] = value;
    out[i + 1] = value;
    out[i + 2] = value;
    out[i + 3] = 255;
  }
  return out;
}

function averageLuminance(rawPixels) {
  let sum = 0;
  for (let i = 0; i < rawPixels.length; i += 4) {
    sum += rawPixels[i] * 0.299 + rawPixels[i + 1] * 0.587 + rawPixels[i + 2] * 0.114;
  }
  return sum / (rawPixels.length / 4);
}

function extractRawCrop(rawPixels, width, height, bbox) {
  const out = new Uint8ClampedArray(bbox.width * bbox.height * 4);
  for (let y = 0; y < bbox.height; y++) {
    const srcStart = ((bbox.top + y) * width + bbox.left) * 4;
    const srcEnd = srcStart + bbox.width * 4;
    out.set(rawPixels.subarray(srcStart, srcEnd), y * bbox.width * 4);
  }
  return out;
}

function findDenseForegroundCrop(rawPixels, width, height) {
  const total = width * height;
  const foreground = new Uint8Array(total);
  for (let index = 0; index < total; index++) {
    const offset = index * 4;
    const red = rawPixels[offset];
    const green = rawPixels[offset + 1];
    const blue = rawPixels[offset + 2];
    const alpha = rawPixels[offset + 3];
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    foreground[index] = alpha > 0 && luminance < 245 && (saturation > 0.18 || luminance < 140) ? 1 : 0;
  }

  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += foreground[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const radius = Math.max(3, Math.round(Math.min(width, height) / 70));
  const windowSize = radius * 2 + 1;
  const minCount = Math.max(6, Math.round(windowSize * windowSize * 0.18));
  const dense = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const count = integral[(bottom + 1) * (width + 1) + (right + 1)]
        - integral[top * (width + 1) + (right + 1)]
        - integral[(bottom + 1) * (width + 1) + left]
        + integral[top * (width + 1) + left];
      dense[y * width + x] = count >= minCount ? 1 : 0;
    }
  }

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const minComponentDim = Math.max(12, Math.round(Math.min(width, height) * 0.06));
  let best = null;

  for (let start = 0; start < total; start++) {
    if (!dense[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let count = 0;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbors = [index - 1, index + 1, index - width, index + width];
      for (const next of neighbors) {
        if (next < 0 || next >= total || visited[next] || !dense[next]) continue;
        const nextX = next % width;
        const nextY = Math.floor(next / width);
        if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxWidth < minComponentDim || boxHeight < minComponentDim) continue;

    const aspectScore = Math.min(boxWidth, boxHeight) / Math.max(boxWidth, boxHeight);
    const fillRatio = count / (boxWidth * boxHeight);
    const score = count * fillRatio * aspectScore;
    if (!best || score > best.score) {
      best = { minX, minY, maxX, maxY, score };
    }
  }

  if (!best) return null;

  const padding = radius * 2 + QR_PADDING_PX;
  const left = Math.max(0, best.minX - padding);
  const top = Math.max(0, best.minY - padding);
  const right = Math.min(width, best.maxX + padding + 1);
  const bottom = Math.min(height, best.maxY + padding + 1);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function findRedSquareCrop(rawPixels, width, height) {
  if (Math.max(width, height) > 1200) return null;

  const total = width * height;
  const redMask = new Uint8Array(total);
  let redCount = 0;
  for (let index = 0; index < total; index++) {
    const offset = index * 4;
    const red = rawPixels[offset];
    const green = rawPixels[offset + 1];
    const blue = rawPixels[offset + 2];
    const alpha = rawPixels[offset + 3];
    const isRed = alpha > 0 && red > 140 && red - green > 15 && red - blue > 15;
    redMask[index] = isRed ? 1 : 0;
    if (isRed) redCount++;
  }
  if (redCount < 100) return null;

  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += redMask[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }

  const minSide = Math.max(24, Math.round(Math.min(width, height) * 0.08));
  const maxSide = Math.min(Math.round(Math.min(width, height) * 0.35), Math.min(width, height));
  let best = null;

  for (let side = minSide; side <= maxSide; side += Math.max(6, Math.round(side / 8))) {
    const step = Math.max(4, Math.round(side / 10));
    for (let top = 0; top <= height - side; top += step) {
      for (let left = 0; left <= width - side; left += step) {
        const right = left + side;
        const bottom = top + side;
        const count = integral[bottom * (width + 1) + right]
          - integral[top * (width + 1) + right]
          - integral[bottom * (width + 1) + left]
          + integral[top * (width + 1) + left];
        const density = count / (side * side);
        if (density < 0.18 || density > 0.7) continue;
        const score = count * density;
        if (!best || score > best.score) {
          best = { left, top, side, score };
        }
      }
    }
  }

  if (!best) return null;

  const padding = Math.max(6, Math.round(best.side * 0.12));
  const left = Math.max(0, best.left - padding);
  const top = Math.max(0, best.top - padding);
  const right = Math.min(width, best.left + best.side + padding);
  const bottom = Math.min(height, best.top + best.side + padding);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function translateQrLocation(qr, offsetX, offsetY, scale) {
  if (!qr?.location) return qr;
  for (const key of ['topLeftCorner', 'topRightCorner', 'bottomRightCorner', 'bottomLeftCorner']) {
    if (qr.location[key]) {
      qr.location[key].x = (qr.location[key].x + offsetX) / scale;
      qr.location[key].y = (qr.location[key].y + offsetY) / scale;
    }
  }
  return qr;
}

function positionToLocation(position) {
  if (!position?.topLeft || !position?.topRight || !position?.bottomRight || !position?.bottomLeft) {
    return null;
  }
  return {
    topLeftCorner: position.topLeft,
    topRightCorner: position.topRight,
    bottomRightCorner: position.bottomRight,
    bottomLeftCorner: position.bottomLeft,
  };
}

async function ensureZxingReady() {
  if (!zxingReadyPromise) {
    const wasmBinary = ZXING_WASM_BINARY.buffer.slice(
      ZXING_WASM_BINARY.byteOffset,
      ZXING_WASM_BINARY.byteOffset + ZXING_WASM_BINARY.byteLength,
    );
    zxingReadyPromise = prepareZXingModule({
      overrides: { wasmBinary },
      fireImmediately: true,
    });
  }
  return zxingReadyPromise;
}

// ── Detection strategies ─────────────────────────────────────────────────────

/**
 * Strategy A: jsQR with Otsu binarization + auto pre-upscale for small images.
 * Returns { data, location } or null.
 */
async function detectWithJsQR(inputPath, meta) {
  const { width, height } = meta;

  const baseScale = width < MIN_DIM || height < MIN_DIM
    ? Math.ceil(Math.max(MIN_DIM / width, MIN_DIM / height))
    : 1;
  const scales = [...new Set(JSQR_SCALE_CANDIDATES.map(scale => scale * baseScale))];

  const tryVariant = (pixels, sw, sh, label) => {
    try {
      const qr = jsQR(pixels, sw, sh, { inversionAttempts: 'attemptBoth' });
      if (qr?.data) {
        console.log(`[qr-cli] jsQR ${label}: ✅ found`);
        return qr;
      }
    } catch {
      // ignore and continue with the next variant
    }
    return null;
  };

  const runVariants = (pixels, sw, sh, labelPrefix) => {
    const autoThreshold = Math.max(60, Math.min(200, averageLuminance(pixels) * 0.8));
    const variants = [
      { label: `${labelPrefix} raw`, pixels },
      { label: `${labelPrefix} otsu`, pixels: binarizeOtsu(pixels, sw, sh) },
      { label: `${labelPrefix} contrast t=${autoThreshold.toFixed(0)}`, pixels: thresholdPixels(pixels, autoThreshold) },
      { label: `${labelPrefix} inverted t=${autoThreshold.toFixed(0)}`, pixels: invertedThresholdPixels(pixels, autoThreshold) },
    ];

    for (const threshold of JSQR_THRESHOLD_SWEEP) {
      variants.push({
        label: `${labelPrefix} sweep t=${threshold}`,
        pixels: thresholdPixels(pixels, threshold),
      });
    }

    for (const variant of variants) {
      const qr = tryVariant(variant.pixels, sw, sh, variant.label);
      if (qr) return qr;
    }
    return null;
  };

  for (const scale of scales) {
    const sw = Math.round(width * scale);
    const sh = Math.round(height * scale);
    const { data: scaledRaw } = scale === 1
      ? await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      : await sharp(inputPath)
          .ensureAlpha()
          .resize(sw, sh, { kernel: 'nearest', fit: 'fill' })
          .raw()
          .toBuffer({ resolveWithObject: true });

    if (scale !== 1) {
      console.log(`[qr-cli] jsQR: trying ${scale}× upscale for detection...`);
    }

    let qr = runVariants(scaledRaw, sw, sh, `${sw}×${sh}`);
    if (!qr) {
      const crop = findDenseForegroundCrop(scaledRaw, sw, sh);
      if (crop) {
        console.log(`[qr-cli] jsQR ${sw}×${sh}: trying dense crop ${crop.width}×${crop.height} at (${crop.left},${crop.top})`);
        const croppedRaw = extractRawCrop(scaledRaw, sw, sh, crop);
        qr = runVariants(croppedRaw, crop.width, crop.height, `${sw}×${sh} crop`);
        if (qr) {
          return translateQrLocation(qr, crop.left, crop.top, scale);
        }
      }
    }

    if (!qr) {
      const crop = findRedSquareCrop(scaledRaw, sw, sh);
      if (crop) {
        console.log(`[qr-cli] jsQR ${sw}×${sh}: trying red square crop ${crop.width}×${crop.height} at (${crop.left},${crop.top})`);
        const croppedRaw = extractRawCrop(scaledRaw, sw, sh, crop);
        qr = runVariants(croppedRaw, crop.width, crop.height, `${sw}×${sh} red-crop`);
        if (qr) {
          return translateQrLocation(qr, crop.left, crop.top, scale);
        }
      }
    }

    if (qr) {
      return translateQrLocation(qr, 0, 0, scale);
    }
  }

  console.log(`[qr-cli] jsQR (${width}×${height}): not found after multi-pass scan`);
  return null;
}

async function detectWithZxing(inputPath, meta) {
  await ensureZxingReady();
  const inputBytes = await readFile(inputPath);
  const results = await readBarcodes(inputBytes, {
    formats: ['QRCode'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    maxNumberOfSymbols: 1,
  });

  const result = results.find(entry => entry?.isValid && entry?.text);
  if (!result) {
    console.log(`[qr-cli] ZXing (${meta.width}×${meta.height}): not found`);
    return null;
  }

  console.log('[qr-cli] ZXing: ✅ found');
  return {
    data: result.text,
    location: positionToLocation(result.position),
    bbox: result.position
      ? cornersToBBox([
          result.position.topLeft,
          result.position.topRight,
          result.position.bottomRight,
          result.position.bottomLeft,
        ], meta.width, meta.height)
      : null,
  };
}

/**
 * Strategy B: zbarimg on pre-upscaled image (system tool).
 * zbarimg needs the QR code to be at least ~250px, with smooth edges (lanczos3).
 */
async function detectWithZbar(inputPath) {
  const meta = await sharp(inputPath).metadata();
  const ZBAR_MIN_DIM = 250;
  let scanPath = inputPath;
  let tmpPath = null;

  if (meta.width < ZBAR_MIN_DIM || meta.height < ZBAR_MIN_DIM) {
    const preScale = Math.ceil(Math.max(ZBAR_MIN_DIM / meta.width, ZBAR_MIN_DIM / meta.height));
    tmpPath = join(tmpdir(), `qr-zbar-${Date.now()}.png`);
    await sharp(inputPath)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(Math.round(meta.width * preScale), Math.round(meta.height * preScale), {
        kernel: 'lanczos3', fit: 'fill',
      })
      .threshold(128)
      .png()
      .toFile(tmpPath);
    scanPath = tmpPath;
    console.log(`[qr-cli] zbarimg: pre-upscaled ${preScale}× (lanczos3+threshold)`);
  }

  try {
    const { stdout } = await execFileAsync('zbarimg', ['-q', '--raw', scanPath], { timeout: 10000 });
    const data = stdout.trim();
    if (data) {
      console.log(`[qr-cli] zbarimg: ✅ ${data}`);
      return { data, location: null };
    }
  } catch (err) {
    if (err.code !== 4) console.warn('[qr-cli] zbarimg error:', err.message);
  } finally {
    if (tmpPath) unlink(tmpPath).catch(() => {});
  }
  console.log('[qr-cli] zbarimg: not found');
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function detectCropUpscaleQr(inputPath, outputPath) {
  const t0 = performance.now();
  const meta = await sharp(inputPath).metadata();
  console.log(`[qr-cli] Loaded: ${inputPath}  (${meta.width}×${meta.height}, ${meta.channels || '?'} channels)`);

  // 1. Detect QR (single ZXing pass, then zbarimg fallback)
  const tDetect = performance.now();
  const qr = await detectWithZxing(inputPath, meta);

  // zbarimg fallback — only used for decoding; if it is the only hit we crop the full image.
  let zbarData = null;
  if (!qr) {
    const zr = await detectWithZbar(inputPath);
    if (zr) zbarData = zr.data;
  }

  if (!qr && !zbarData) {
    console.error('[qr-cli] ❌ No QR code detected by ZXing or zbarimg.');
    process.exit(1);
  }

  const decodedData = qr?.data || zbarData;
  console.log(`[qr-cli] Decoded: ${decodedData}`);
  console.log(`[qr-cli] Detection time: ${(performance.now() - tDetect).toFixed(1)} ms`);

  if (outputPath && outputPath !== inputPath) {
    const tSave = performance.now();
    await copyFile(inputPath, outputPath);
    console.log(`[qr-cli] Saved original image without transformation: ${outputPath}`);
    console.log(`[qr-cli] Save: ${(performance.now() - tSave).toFixed(1)} ms`);
  } else {
    console.log('[qr-cli] Skipped image transformation after successful decode.');
  }

  console.log(`[qr-cli] Total: ${(performance.now() - t0).toFixed(1)} ms`);
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node ${basename(process.argv[1])} <input> [output]

  Detect a QR code in an image.

  Arguments:
    input    Path to input image (PNG, JPEG, etc.)
    output   Optional output path for an unchanged copy of the input image

  Examples:
    node detectCropUpscaleQr.js qrcode-2.png
    node detectCropUpscaleQr.js photo.jpg qr-result.png
`);
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const inputPath = args[0];
const outputPath = args[1] || (() => {
  const ext = extname(inputPath);
  const base = basename(inputPath, ext);
  return `${base}-qr-3x.png`;
})();

try {
  await detectCropUpscaleQr(inputPath, outputPath);
} catch (err) {
  console.error('[qr-cli] ❌ Error:', err.message || err);
  process.exit(1);
}
