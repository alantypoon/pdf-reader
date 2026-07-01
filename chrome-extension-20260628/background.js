async function ensureInjection(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['jspdf.umd.min.js']
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
    const result = await sendStartAutoCapture(tab.id);
    console.log('Capture complete:', result);
  } catch (err) {
    console.error('Capture failed:', err);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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
