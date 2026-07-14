import jsQR from 'jsqr';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/**
 * qr-utils.js — Client-side QR code detect → crop → upscale pipeline.
 *
 * How it works:
 *   1. zxing-wasm scans the source image for a QR code and returns its payload and corner locations.
 *      jsQR remains as a local fallback if ZXing does not find the code.
 *   2. The exact bounding box of the QR is cropped out.
 *   3. That crop is upscaled 3× using nearest-neighbour (pixelated) interpolation so
 *      every module stays sharp — critical for small QR codes that zbarimg / other
 *      scanners can't read at native size.
 *   4. The upscaled canvas is returned (already decoded if possible).
 *
 * Usage:
 *   import { detectCropUpscaleQr } from './qr-utils.js';
 *   const result = await detectCropUpscaleQr(imageElement);
 *   if (result.data) console.log(result.data);
 *   // result.canvas is the 3× upscaled crop for preview / download.
 *
 * Dependencies: zxing-wasm, jsQR.
 */

/**
 * @typedef {Object} QrDetectResult
 * @property {HTMLCanvasElement} canvas  - 3× upscaled crop of the QR region
 * @property {string|null}       data    - decoded QR payload (null if decode failed)
 * @property {Object|null}       location - QR location object {topLeftCorner, …}
 * @property {number}            cropW   - width of the cropped (pre-scale) region
 * @property {number}            cropH   - height of the cropped (pre-scale) region
 */

const QR_PADDING_PX = 2; // extra padding around detected QR bounds before crop

let zxingReadyPromise;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert any supported image source into { pixels: Uint8ClampedArray, w, h }. */
function getImageData(source) {
  if (source instanceof ImageData) {
    return { pixels: new Uint8ClampedArray(source.data), w: source.width, h: source.height };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (source instanceof HTMLCanvasElement) {
    canvas.width = source.width;
    canvas.height = source.height;
    ctx.drawImage(source, 0, 0);
  } else if (source instanceof HTMLImageElement) {
    canvas.width = source.naturalWidth || source.width;
    canvas.height = source.naturalHeight || source.height;
    ctx.drawImage(source, 0, 0);
  } else if (source instanceof ImageBitmap) {
    canvas.width = source.width;
    canvas.height = source.height;
    ctx.drawImage(source, 0, 0);
  } else {
    throw new TypeError('Unsupported source type: ' + Object.prototype.toString.call(source));
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels: new Uint8ClampedArray(imageData.data), w: canvas.width, h: canvas.height, canvas };
}

/** Compute axis-aligned bounding box from jsQR corner points. */
function cornersToBBox(corners, imgW, imgH) {
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs)) - QR_PADDING_PX);
  const y = Math.max(0, Math.floor(Math.min(...ys)) - QR_PADDING_PX);
  const w = Math.min(imgW - x, Math.ceil(Math.max(...xs)) - x + QR_PADDING_PX * 2);
  const h = Math.min(imgH - y, Math.ceil(Math.max(...ys)) - y + QR_PADDING_PX * 2);
  return { x, y, w, h };
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
    zxingReadyPromise = (async () => {
      // Pre-fetch WASM binary to bypass WebAssembly.instantiateStreaming
      // which fails when the reverse-proxy/CDN sends wrong MIME type.
      const wasmResp = await fetch(zxingReaderWasmUrl);
      if (!wasmResp.ok) throw new Error(`Failed to fetch WASM: ${wasmResp.status}`);
      const wasmBinary = await wasmResp.arrayBuffer();

      return prepareZXingModule({
        wasmBinary,
        // Override instantiation to use non-streaming compile
        instantiateWasm: (imports, onSuccess) => {
          WebAssembly.instantiate(wasmBinary, imports).then(
            result => onSuccess(result.instance, result.module),
          );
          return {}; // Emscripten requires returning an empty object
        },
        fireImmediately: true,
      });
    })();
  }
  return zxingReadyPromise;
}

async function detectWithZxing(imageData) {
  await ensureZxingReady();
  const results = await readBarcodes(imageData, {
    formats: ['QRCode'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    maxNumberOfSymbols: 1,
  });

  const match = results.find(entry => entry?.isValid && entry?.text && entry?.position);
  if (!match) return null;

  return {
    data: match.text,
    location: positionToLocation(match.position),
  };
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Detect, crop, and upscale a QR code from any image source.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageData|ImageBitmap} source
 * @param {Object} [opts]
 * @param {number} [opts.scaleFactor=3]      - upscale multiplier
 * @param {boolean} [opts.inversionAttempts=true] - passed to jsQR
 * @param {boolean} [opts.returnCanvasOnly=false]  - skip re-decoding, just return canvas
 * @param {boolean} [opts.copyToClipboard=true]     - copy 3× upscaled PNG to clipboard
 * @returns {Promise<QrDetectResult>}
 */
export async function detectCropUpscaleQr(source, opts = {}) {
  const {
    scaleFactor = 3,
    inversionAttempts = true,
    returnCanvasOnly = false,
    copyToClipboard = true,
  } = opts;

  const result = {
    canvas: null,
    data: null,
    location: null,
    cropW: 0,
    cropH: 0,
  };

  // 1. Get raw pixels
  const img = getImageData(source);
  const { pixels, w, h, canvas: srcCanvas } = img;
  console.log('[qr-utils] detectCropUpscaleQr: source', w + '×' + h, '| scaleFactor=' + scaleFactor);

  // 2. Detect QR position with ZXing first, then jsQR fallback
  let qr;
  const tDetect0 = performance.now();
  try {
    qr = await detectWithZxing(new ImageData(new Uint8ClampedArray(pixels), w, h));
  } catch (err) {
    console.warn('[qr-utils] ZXing threw:', err.message || err);
  }
  console.log('[qr-utils] ZXing detection:', (performance.now() - tDetect0).toFixed(1), 'ms',
    '→', qr ? 'found' : 'not found');

  if (!qr || !qr.location) {
    try {
      qr = jsQR(pixels, w, h, {
        inversionAttempts: inversionAttempts ? 'attemptBoth' : 'dontInvert',
      });
      console.log('[qr-utils] jsQR fallback:', qr ? 'found' : 'not found');
    } catch (err) {
      console.warn('[qr-utils] jsQR threw:', err.message || err);
    }
  }

  if ((!qr || !qr.location) && inversionAttempts) {
    console.log('[qr-utils] trying inverted image...');
    const inv = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      inv[i]     = 255 - pixels[i];
      inv[i + 1] = 255 - pixels[i + 1];
      inv[i + 2] = 255 - pixels[i + 2];
      inv[i + 3] = pixels[i + 3];
    }
    try {
      qr = jsQR(inv, w, h, { inversionAttempts: 'dontInvert' });
      console.log('[qr-utils] inverted detection:', qr ? 'found' : 'not found');
    } catch { /* ignore */ }
  }

  if (!qr || !qr.location) {
    console.log('[qr-utils] ❌ No QR detected in source');
    return result; // nothing detected
  }

  result.location = qr.location;
  result.data = qr.data; // may be set if jsQR decoded on first pass

  // 3. Get tight bounding box
  const bbox = cornersToBBox(qr.location.topLeftCorner && qr.location.topRightCorner
    ? [qr.location.topLeftCorner, qr.location.topRightCorner,
       qr.location.bottomRightCorner, qr.location.bottomLeftCorner]
    : [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    w, h);

  result.cropW = bbox.w;
  result.cropH = bbox.h;

  if (bbox.w <= 0 || bbox.h <= 0) return result;

  // 4. Crop
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = bbox.w;
  cropCanvas.height = bbox.h;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(
    srcCanvas || source,
    bbox.x, bbox.y, bbox.w, bbox.h,
    0, 0, bbox.w, bbox.h,
  );
  console.log('[qr-utils] cropped:', bbox.w + '×' + bbox.h, 'at', bbox.x + ',' + bbox.y);

  // 5. Upscale 3× with nearest-neighbour (pixelated)
  const upW = bbox.w * scaleFactor;
  const upH = bbox.h * scaleFactor;
  const upCanvas = document.createElement('canvas');
  upCanvas.width = upW;
  upCanvas.height = upH;
  const upCtx = upCanvas.getContext('2d');
  upCtx.imageSmoothingEnabled = false; // ← critical: keep QR modules sharp
  upCtx.drawImage(cropCanvas, 0, 0, upW, upH);
  console.log('[qr-utils] upscaled:', upW + '×' + upH, '(nearest-neighbour)');

  result.canvas = upCanvas;

  // 5b. Copy upscaled QR to clipboard (fire-and-forget, don't block)
  if (copyToClipboard) {
    const tClip = performance.now();
    upCanvas.toBlob(async (blob) => {
      if (!blob) { console.log('[qr-utils] 📋 toBlob returned null'); return; }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        console.log('[qr-utils] 📋 3× upscaled QR copied to clipboard (',
          (blob.size / 1024).toFixed(1), 'KB,',
          (performance.now() - tClip).toFixed(1), 'ms)');
      } catch (err) {
        console.log('[qr-utils] 📋 clipboard write failed:', err.message || err);
      }
    }, 'image/png');
  }

  // 6. Re-decode on upscaled image (more reliable at larger size)
  if (!returnCanvasOnly) {
    const upImageData = upCtx.getImageData(0, 0, upW, upH);
    try {
      const qrUp = jsQR(upImageData.data, upW, upH, {
        inversionAttempts: inversionAttempts ? 'attemptBoth' : 'dontInvert',
      });
      if (qrUp?.data) {
        result.data = qrUp.data;
        console.log('[qr-utils] ✅ re-decoded on upscaled:', JSON.stringify(qrUp.data.substring(0, 80)));
      } else {
        console.log('[qr-utils] re-decode on upscaled: no data (keeping original)' + (result.data ? ': ' + JSON.stringify(result.data.substring(0, 80)) : ''));
      }
    } catch { /* keep existing result.data from step 2 if set */ }
  }

  return result;
}

/**
 * Simple convenience: take any image source, run the pipeline, return the decoded
 * string (or null).  The 3× canvas is discarded.
 */
export async function scanQr(source, opts = {}) {
  const r = await detectCropUpscaleQr(source, opts);
  return r.data;
}

/**
 * Full pipeline + copy the 3× upscaled QR crop to clipboard as PNG.
 * Useful for pasting into dnschecker.org, zbarimg, or any image-based QR scanner.
 *
 * @returns {Promise<{ data: string|null, copied: boolean, error?: string }>}
 */
export async function detectCropUpscaleToClipboard(source, opts = {}) {
  console.log('[qr-utils] detectCropUpscaleToClipboard: starting pipeline...');
  const t0 = performance.now();

  const result = await detectCropUpscaleQr(source, opts);
  const t1 = performance.now();
  console.log('[qr-utils] detectCropUpscaleQr took', (t1 - t0).toFixed(1), 'ms');

  if (!result.location) {
    console.log('[qr-utils] ❌ No QR location detected — aborting clipboard copy');
    return { data: null, copied: false, error: 'No QR code detected' };
  }

  console.log('[qr-utils] ✅ QR located:',
    'crop=' + result.cropW + '×' + result.cropH,
    '| upsample=3×',
    '| output=' + result.canvas.width + '×' + result.canvas.height,
    '| decoded=' + (result.data ? `"${result.data.substring(0, 60)}${result.data.length > 60 ? '…' : ''}"` : '(null)'),
  );

  try {
    console.log('[qr-utils] 📋 Converting upscaled canvas to PNG blob...');
    const blob = await new Promise(resolve => result.canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      console.log('[qr-utils] ❌ canvas.toBlob returned null');
      return { data: result.data, copied: false, error: 'Canvas toBlob failed' };
    }
    console.log('[qr-utils] PNG blob:', (blob.size / 1024).toFixed(1), 'KB');

    console.log('[qr-utils] 📋 Writing to navigator.clipboard...');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const t2 = performance.now();
    console.log('[qr-utils] ✅ Clipboard copy OK — total', (t2 - t0).toFixed(1), 'ms');
    return { data: result.data, copied: true };
  } catch (err) {
    console.log('[qr-utils] ❌ Clipboard write failed:', err.message || err);
    return { data: result.data, copied: false, error: err.message || 'Clipboard write failed' };
  }
}
