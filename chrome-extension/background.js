async function ensureInjection(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['jspdf.umd.min.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['pdf-lib.min.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

function sendStartAutoCapture(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'startAutoCapture' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Unknown capture error.'));
        return;
      }
      resolve(response.result);
    });
  });
}

function checkForResourceTab(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        // Check top document
        try {
          const el = document.querySelector('.EBook_UnitView-tab-selected');
          if (el && el.offsetParent !== null && getComputedStyle(el).display !== 'none') return true;
        } catch (_) {}

        // Check all iframes
        const iframes = document.getElementsByTagName('iframe');
        for (const iframe of iframes) {
          try {
            const el = iframe.contentDocument?.querySelector('.EBook_UnitView-tab-selected');
            if (el && el.offsetParent !== null && getComputedStyle(el).display !== 'none') return true;
          } catch (_) { /* cross-origin, skip */ }
        }
        return false;
      }
    }).then((results) => {
      const found = results?.some(r => r.result === true) ?? false;
      resolve(found);
    }).catch(() => {
      resolve(false);
    });
  });
}

function sendCaptureResources(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        // Find EBook_UnitView-resList — may be in an iframe, allFrames handles that
        let list = document.querySelector('.EBook_UnitView-resList');
        if (!list) {
          // Try iframes within this frame
          const iframes = document.getElementsByTagName('iframe');
          for (const iframe of iframes) {
            try {
              list = iframe.contentDocument?.querySelector('.EBook_UnitView-resList');
              if (list) break;
            } catch (_) {}
          }
        }
        if (!list) return null;

        // Poll for items to load (async population, up to 12 seconds)
        let items = list.querySelectorAll('li[filefullpath]');
        for (let attempt = 0; attempt < 60 && items.length === 0; attempt++) {
          await new Promise(r => setTimeout(r, 200));
          items = list.querySelectorAll('li[filefullpath]');
        }
        if (items.length === 0) return { _empty: true, html: list.innerHTML.slice(0, 500) };

        const en = [];
        const tc = [];
        for (const li of items) {
          const url = (li.getAttribute('filefullpath') || '').trim();
          const desc = (li.querySelector('.listDesc')?.textContent || '').trim();
          if (!url || !desc) continue;
          let fullUrl = url;
          if (url.startsWith('./') || url.startsWith('../') || (!url.startsWith('http') && !url.startsWith('//'))) {
            try { fullUrl = new URL(url, location.href).href; } catch (_) {}
          }
          const r = { name: desc, url: fullUrl };
          const pageEl = li.querySelector('.pageNum');
          if (pageEl) r.page = pageEl.textContent.trim();
          const iconName = li.querySelector('.listIcon')?.getAttribute('iconname') || '';
          const loIcon = iconName.toLowerCase();
          const loUrl = url.toLowerCase();
          const loDesc = desc.toLowerCase();
          if (loIcon.includes('resource_b_15') || loUrl.includes('youtube.com') || loUrl.includes('youtu.be')) r.type = 'video';
          else if (loIcon.includes('resource_b_14')) r.type = 'simulation';
          else if (loIcon.includes('resource_b_21') || loUrl.endsWith('.mp3')) r.type = 'audio';
          else if (loUrl.endsWith('.mp4')) r.type = 'video';
          else if (loUrl.endsWith('.pdf')) r.type = 'pdf';
          if (/[\u4e00-\u9fff]/.test(desc)) { tc.push(r); } else { en.push(r); }
        }

        let chapter = '1', heading = 'Resources';
        const hEls = document.querySelectorAll('.EBook_UnitView-title, .unit-title, .chapter-title, h1, h2');
        for (const el of hEls) {
          const t = (el.textContent || '').trim();
          const m = t.match(/^(\d+[a-z]?)\b/i) || t.match(/chapter\s*(\d+[a-z]?)/i);
          if (m) { chapter = m[1]; break; }
        }
        for (const el of hEls) {
          const t = (el.textContent || '').trim();
          if (t) { heading = t; break; }
        }
        return { chapter, heading, en, tc };
      }
    }).then((results) => {
      const allEn = [], allTc = [];
      let chapter = '1', heading = 'Resources';
      for (const r of results || []) {
        if (!r.result || r.result._empty) continue;
        if (r.result.chapter) chapter = r.result.chapter;
        if (r.result.heading) heading = r.result.heading;
        if (r.result.en) allEn.push(...r.result.en);
        if (r.result.tc) allTc.push(...r.result.tc);
      }
      if (allEn.length === 0 && allTc.length === 0) {
        console.warn('[CaptureLog] No resources found after polling. Saving empty file and continuing.');
        resolve({ chapter, contents: [{ section: '1', page: 1, en: { name: heading, resources: [] }, tc: { name: heading, resources: [] } }] });
        return;
      }
      resolve({ chapter, contents: [{ section: '1', page: 1, en: { name: heading, resources: allEn }, tc: { name: heading, resources: allTc } }] });
    }).catch(err => reject(new Error(err.message || 'Failed to capture resources.')));
  });
}

function getDatetimeStamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function saveResourcesAsJson(resources) {
  const jsonStr = JSON.stringify(resources, null, 4);
  const fileName = `resource-${getDatetimeStamp()}.json`;

  // Service workers don't have URL.createObjectURL — use base64 data URL
  const bytes = new TextEncoder().encode(jsonStr);
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  const dataUrl = 'data:application/json;base64,' + btoa(binary);

  return chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: true
  }).then((downloadId) => {
    return { downloadId, fileName };
  });
}

function savePdfDownload(dataUrl, fileName) {
  return chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: false,
    conflictAction: 'uniquify'
  }).then((downloadId) => {
    return { downloadId, fileName };
  });
}

function isForbiddenUrl(url) {
  if (!url) {
    return false;
  }
  return /^(chrome:|edge:|about:|chrome-extension:|devtools:)/i.test(url);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) {
    return;
  }

  if (isForbiddenUrl(tab.url)) {
    console.warn('Unsupported tab URL for capture:', tab.url);
    return;
  }

  try {
    await ensureInjection(tab.id);

    // Check if this is a resource tab (has EBook_UnitView-tab-selected class)
    const isResourceTab = await checkForResourceTab(tab.id);

    if (isResourceTab) {
      // Scrape resources instead of capturing PDF
      const resources = await sendCaptureResources(tab.id);
      const result = await saveResourcesAsJson(resources);
      console.log('Resources saved:', result);
    } else {
      // Normal PDF capture
      const result = await sendStartAutoCapture(tab.id);
      console.log('Capture complete:', result);
    }
  } catch (err) {
    console.error('Operation failed:', err);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'savePdfDownload') {
    savePdfDownload(request.dataUrl, request.fileName)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (request.action !== 'captureVisibleTabImage') {
    return;
  }

  const windowId = sender.tab?.windowId;
  if (typeof windowId !== 'number') {
    sendResponse({ ok: false, error: 'Missing sender window id.' });
    return;
  }

  chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    if (!dataUrl) {
      sendResponse({ ok: false, error: 'Empty capture data.' });
      return;
    }

    sendResponse({ ok: true, dataUrl });
  });

  return true;
});
