(() => {
const NEXT_BUTTON_SELECTOR = '#ebk-btn_0';
const PREV_BUTTON_SELECTOR = '#ebk-btn_1, .prev-btn, [title="Previous"], [title="Prev"]';
const PAGE_TURN_WAIT_MS = 1200;
const PAGE_TURN_POLL_MS = 400;
const PAGE_TURN_MAX_WAIT_MS = 15000;
const MIN_CAPTURE_INTERVAL_MS = 700;
const CAPTURE_RETRY_DELAY_MS = 1200;
const MAX_PAGES = 2000;
const MAX_PREV_STEPS = 500;
const PDF_MARGIN_MM = 6;
const PDF_PART_SIZE_LIMIT_BYTES = Math.floor(64 * 1024 * 1024 * 0.9);
const TRIM_DIFF_THRESHOLD = 14;
const TRIM_ALPHA_THRESHOLD = 8;
const HIDE_BEFORE_CAPTURE_SELECTOR = '.copyright, .blur1';
const MESSAGE_LISTENER_KEY = '__ebookPdfCaptureMessageListener';
let isCapturing = false;
let lastCaptureAt = 0;

const existingMessageListener = window[MESSAGE_LISTENER_KEY];
if (typeof existingMessageListener === 'function') {
  chrome.runtime.onMessage.removeListener(existingMessageListener);
}

const runtimeMessageListener = (request, _sender, sendResponse) => {
  if (request.action !== 'startAutoCapture') {
    return;
  }

  if (window.top !== window.self) {
    sendResponse({ ok: false, error: 'This frame is not capturable.' });
    return;
  }

  if (isCapturing) {
    sendResponse({ ok: false, error: 'Capture already running.' });
    return;
  }

  startAutoCapture()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      console.error('Auto capture failed:', err);
      sendResponse({ ok: false, error: err.message });
    });

  return true;
};

window[MESSAGE_LISTENER_KEY] = runtimeMessageListener;
chrome.runtime.onMessage.addListener(runtimeMessageListener);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getSameOriginFrameDocuments(rootDoc = document) {
  const docs = [rootDoc];
  const iframes = rootDoc.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      if (iframe.contentDocument) {
        docs.push(iframe.contentDocument);
      }
    } catch (_err) {
      // Ignore cross-origin frames.
    }
  }
  return docs;
}

function findButton(selector) {
  const docs = getSameOriginFrameDocuments(document);
  for (const doc of docs) {
    const button = doc.querySelector(selector);
    if (button) {
      return button;
    }
  }
  return null;
}

function isDisabled(button) {
  if (!button) {
    return true;
  }
  const className = String(button.className || '');
  const attrDisabled = button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true';
  const statusDisabled = button.getAttribute('status') === 'disable';
  const classDisabled = /(disabled|inactive|off)/i.test(className);
  return attrDisabled || statusDisabled || classDisabled;
}

function clickElement(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function sanitizeFilePart(text) {
  return String(text || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function buildDefaultPdfFileName() {
  const baseName = getSuggestedBaseName();
  return `${baseName || 'ebook'}-${getTimestamp()}.pdf`;
}

function buildPartFileName(fileName, partNumber) {
  const suffix = `_${partNumber}`;
  if (fileName.toLowerCase().endsWith('.pdf')) {
    return `${fileName.slice(0, -4)}${suffix}.pdf`;
  }
  return `${fileName}${suffix}`;
}

function getSuggestedBaseName() {
  const docs = getSameOriginFrameDocuments(document);
  const candidates = [document.title];

  for (const doc of docs) {
    candidates.push(doc.title || '');
    const h1 = doc.querySelector('h1, .book-title, .title');
    if (h1?.textContent) {
      candidates.push(h1.textContent);
    }
  }

  for (const candidate of candidates) {
    const cleaned = sanitizeFilePart(candidate);
    if (cleaned) {
      return cleaned;
    }
  }
  return 'ebook';
}

function getTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

async function waitForCaptureQuota() {
  const now = Date.now();
  const elapsedMs = now - lastCaptureAt;
  if (elapsedMs < MIN_CAPTURE_INTERVAL_MS) {
    await sleep(MIN_CAPTURE_INTERVAL_MS - elapsedMs);
  }
  lastCaptureAt = Date.now();
}

function isCaptureQuotaError(message) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota/i.test(String(message || ''));
}

async function captureVisibleTabImage() {
  while (true) {
    await waitForCaptureQuota();

    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureVisibleTabImage' }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok || !response?.dataUrl) {
            reject(new Error(response?.error || 'Failed to capture visible tab.'));
            return;
          }
          resolve(response.dataUrl);
        });
      });
    } catch (err) {
      if (!isCaptureQuotaError(err?.message)) {
        throw err;
      }
      await sleep(CAPTURE_RETRY_DELAY_MS);
    }
  }
}

function savePdfDownload(pdfBlob, fileName) {
  return new Promise((resolve, reject) => {
    try {
      const objectUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      link.style.display = 'none';
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      resolve({ fileName });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to save PDF download.'));
    }
  });
}

function createPdfDocument() {
  const { jsPDF } = window.jspdf;
  return new jsPDF('p', 'mm', 'a4');
}

function addImageToPdf(pdf, imageDataUrl) {
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = pdf.internal.pageSize.getHeight();
  const imgProps = pdf.getImageProperties(imageDataUrl);
  const usableWidth = Math.max(1, pdfWidth - (PDF_MARGIN_MM * 2));
  const usableHeight = Math.max(1, pdfHeight - (PDF_MARGIN_MM * 2));
  const ratio = Math.min(usableWidth / imgProps.width, usableHeight / imgProps.height);
  const newWidth = imgProps.width * ratio;
  const newHeight = imgProps.height * ratio;
  const x = PDF_MARGIN_MM + ((usableWidth - newWidth) / 2);
  const y = PDF_MARGIN_MM + ((usableHeight - newHeight) / 2);

  pdf.addImage(imageDataUrl, 'JPEG', x, y, newWidth, newHeight);
}

async function mergePdfParts(partBlobs) {
  if (!window.PDFLib?.PDFDocument) {
    throw new Error('PDF merge library is not available in this page context.');
  }

  const mergedPdf = await window.PDFLib.PDFDocument.create();

  for (const partBlob of partBlobs) {
    const partBytes = await partBlob.arrayBuffer();
    const sourcePdf = await window.PDFLib.PDFDocument.load(partBytes);
    const pageIndices = sourcePdf.getPageIndices();
    const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);
    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }
  }

  const mergedBytes = await mergedPdf.save();
  return new Blob([mergedBytes], { type: 'application/pdf' });
}

function getCaptureRectCssPixels() {
  const frame = document.querySelector('iframe.ebook-main-frame[data-visible="true"]')
    || document.querySelector('iframe.ebook-main-frame');

  if (!frame) {
    return null;
  }

  const rect = frame.getBoundingClientRect();
  if (!rect || rect.width <= 1 || rect.height <= 1) {
    return null;
  }

  try {
    const frameDoc = frame.contentDocument;
    const pageEl = frameDoc?.querySelector('.page, .ebk-page, .book-page, #page, .content-page, .sheet, canvas');
    if (pageEl) {
      const innerRect = pageEl.getBoundingClientRect();
      if (innerRect.width > 1 && innerRect.height > 1) {
        return {
          x: rect.left + innerRect.left,
          y: rect.top + innerRect.top,
          width: innerRect.width,
          height: innerRect.height
        };
      }
    }
  } catch (_err) {
    // Ignore frame access issues and use the frame rectangle fallback.
  }

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

async function cropImageDataUrl(rawDataUrl, rectCssPixels) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const sx = Math.max(0, Math.floor(rectCssPixels.x * dpr));
      const sy = Math.max(0, Math.floor(rectCssPixels.y * dpr));
      const sw = Math.max(1, Math.floor(rectCssPixels.width * dpr));
      const sh = Math.max(1, Math.floor(rectCssPixels.height * dpr));

      const clampedW = Math.min(sw, img.width - sx);
      const clampedH = Math.min(sh, img.height - sy);
      if (clampedW <= 0 || clampedH <= 0) {
        reject(new Error('Calculated content crop area is outside the captured image.'));
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = clampedW;
      canvas.height = clampedH;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create canvas context for image crop.'));
        return;
      }

      ctx.drawImage(img, sx, sy, clampedW, clampedH, 0, 0, clampedW, clampedH);
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };

    img.onerror = () => reject(new Error('Failed to decode captured tab image.'));
    img.src = rawDataUrl;
  });
}

function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (dr * dr) + (dg * dg) + (db * db);
}

async function trimUniformBorder(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create canvas for border trim.'));
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const w = canvas.width;
      const h = canvas.height;

      const sampleOffsets = [
        [0, 0],
        [w - 1, 0],
        [0, h - 1],
        [w - 1, h - 1]
      ];

      let bgR = 0;
      let bgG = 0;
      let bgB = 0;
      for (const [sx, sy] of sampleOffsets) {
        const idx = ((sy * w) + sx) * 4;
        bgR += data[idx];
        bgG += data[idx + 1];
        bgB += data[idx + 2];
      }
      bgR = Math.round(bgR / sampleOffsets.length);
      bgG = Math.round(bgG / sampleOffsets.length);
      bgB = Math.round(bgB / sampleOffsets.length);

      const diffSqThreshold = TRIM_DIFF_THRESHOLD * TRIM_DIFF_THRESHOLD;
      const isContentPixel = (x, y) => {
        const idx = ((y * w) + x) * 4;
        const a = data[idx + 3];
        if (a < TRIM_ALPHA_THRESHOLD) {
          return false;
        }
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        return colorDistanceSq(r, g, b, bgR, bgG, bgB) > diffSqThreshold;
      };

      let top = 0;
      while (top < h) {
        let found = false;
        for (let x = 0; x < w; x += 2) {
          if (isContentPixel(x, top)) {
            found = true;
            break;
          }
        }
        if (found) {
          break;
        }
        top += 1;
      }

      let bottom = h - 1;
      while (bottom >= top) {
        let found = false;
        for (let x = 0; x < w; x += 2) {
          if (isContentPixel(x, bottom)) {
            found = true;
            break;
          }
        }
        if (found) {
          break;
        }
        bottom -= 1;
      }

      let left = 0;
      while (left < w) {
        let found = false;
        for (let y = top; y <= bottom; y += 2) {
          if (isContentPixel(left, y)) {
            found = true;
            break;
          }
        }
        if (found) {
          break;
        }
        left += 1;
      }

      let right = w - 1;
      while (right >= left) {
        let found = false;
        for (let y = top; y <= bottom; y += 2) {
          if (isContentPixel(right, y)) {
            found = true;
            break;
          }
        }
        if (found) {
          break;
        }
        right -= 1;
      }

      const trimW = right - left + 1;
      const trimH = bottom - top + 1;
      if (trimW < 50 || trimH < 50) {
        resolve(dataUrl);
        return;
      }

      const trimmedCanvas = document.createElement('canvas');
      trimmedCanvas.width = trimW;
      trimmedCanvas.height = trimH;
      const trimmedCtx = trimmedCanvas.getContext('2d');
      if (!trimmedCtx) {
        resolve(dataUrl);
        return;
      }
      trimmedCtx.drawImage(canvas, left, top, trimW, trimH, 0, 0, trimW, trimH);
      resolve(trimmedCanvas.toDataURL('image/jpeg', 0.95));
    };

    img.onerror = () => reject(new Error('Failed to decode image for border trim.'));
    img.src = dataUrl;
  });
}

function hideCaptureOverlays() {
  const docs = getSameOriginFrameDocuments(document);

  for (const doc of docs) {
    const overlays = doc.querySelectorAll(HIDE_BEFORE_CAPTURE_SELECTOR);
    for (const overlay of overlays) {
      overlay.remove();
    }
  }
}

async function captureCroppedPageImageDataUrl() {
  const rect = getCaptureRectCssPixels();
  if (!rect) {
    throw new Error('Could not detect ebook content area. Open the ebook reader view before capturing.');
  }

  hideCaptureOverlays();
  const rawImage = await captureVisibleTabImage();
  const cropped = await cropImageDataUrl(rawImage, rect);
  return trimUniformBorder(cropped);
}

async function waitForPageTurn(directionSelector, previousSignature) {
  await sleep(PAGE_TURN_WAIT_MS);

  let elapsedMs = PAGE_TURN_WAIT_MS;
  while (elapsedMs <= PAGE_TURN_MAX_WAIT_MS) {
    const imageDataUrl = await captureCroppedPageImageDataUrl();
    const signature = imageDataUrl.slice(0, 12000);
    const navButton = findButton(directionSelector);

    if (signature !== previousSignature) {
      return { imageDataUrl, signature, buttonDisabled: isDisabled(navButton) };
    }

    if (isDisabled(navButton)) {
      return { imageDataUrl, signature, buttonDisabled: true };
    }

    await sleep(PAGE_TURN_POLL_MS);
    elapsedMs += PAGE_TURN_POLL_MS;
  }

  throw new Error('Timed out waiting for the next page to finish loading.');
}

async function moveToFirstPage() {
  let stagnantCount = 0;

  for (let i = 0; i < MAX_PREV_STEPS; i++) {
    const prevBtn = findButton(PREV_BUTTON_SELECTOR);
    if (!prevBtn || isDisabled(prevBtn)) {
      break;
    }

    const beforeTurn = await captureCroppedPageImageDataUrl();
    const beforeSignature = beforeTurn.slice(0, 12000);

    clickElement(prevBtn);
    const { signature: afterSignature } = await waitForPageTurn(PREV_BUTTON_SELECTOR, beforeSignature);

    if (beforeSignature === afterSignature) {
      stagnantCount += 1;
      if (stagnantCount >= 2) {
        break;
      }
    } else {
      stagnantCount = 0;
    }
  }
}

async function startAutoCapture() {
  if (!window.jspdf?.jsPDF) {
    throw new Error('jsPDF is not available in this page context.');
  }
  if (!window.PDFLib?.PDFDocument) {
    throw new Error('PDFLib is not available in this page context.');
  }

  const fileName = buildDefaultPdfFileName();

  isCapturing = true;
  try {
    await moveToFirstPage();

    let pdf = createPdfDocument();
    const partBlobs = [];
    let partNumber = 1;
    let pagesCaptured = 0;
    let pagesInCurrentPart = 0;
    let lastSignature = null;

    while (pagesCaptured < MAX_PAGES) {
      const imageDataUrl = await captureCroppedPageImageDataUrl();
      const signature = imageDataUrl.slice(0, 12000);

      if (signature === lastSignature) {
        throw new Error('The page did not change after the last turn while the Next button remained enabled.');
      }
      lastSignature = signature;

      if (pagesInCurrentPart > 0) {
        pdf.addPage();
      }

      addImageToPdf(pdf, imageDataUrl);
      pagesCaptured += 1;
      pagesInCurrentPart += 1;

      let currentPartBlob = pdf.output('blob');
      if (currentPartBlob.size >= PDF_PART_SIZE_LIMIT_BYTES) {
        if (pagesInCurrentPart === 1) {
          throw new Error('A single captured page exceeds the PDF part size limit. Reduce capture size before exporting.');
        }

        pdf.deletePage(pagesInCurrentPart);
        pagesInCurrentPart -= 1;
        const finalizedPartBlob = pdf.output('blob');
        partBlobs.push(finalizedPartBlob);
        partNumber += 1;

        pdf = createPdfDocument();
        addImageToPdf(pdf, imageDataUrl);
        pagesInCurrentPart = 1;
        currentPartBlob = pdf.output('blob');

        if (currentPartBlob.size >= PDF_PART_SIZE_LIMIT_BYTES) {
          throw new Error('A single captured page exceeds the PDF part size limit. Reduce capture size before exporting.');
        }
      }

      const nextBtn = findButton(NEXT_BUTTON_SELECTOR);
      if (!nextBtn || isDisabled(nextBtn)) {
        break;
      }

      clickElement(nextBtn);
      const afterTurn = await waitForPageTurn(NEXT_BUTTON_SELECTOR, lastSignature);
      if (afterTurn.buttonDisabled) {
        break;
      }
    }

    if (pagesCaptured === 0) {
      throw new Error('No pages were captured.');
    }

    const finalPartBlob = pdf.output('blob');
    if (partBlobs.length > 0) {
      partBlobs.push(finalPartBlob);
      const mergedPdfBlob = await mergePdfParts(partBlobs);
      await savePdfDownload(mergedPdfBlob, fileName);
      return { pagesCaptured, fileName, partsSaved: partBlobs.length };
    }

    await savePdfDownload(finalPartBlob, fileName);
    return { pagesCaptured, fileName, partsSaved: 1 };
  } finally {
    isCapturing = false;
  }
}

})();