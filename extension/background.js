// ── Constants ────────────────────────────────────────────────────
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8666;
const DEFAULT_TEXTKIT_PORT = 8765;
const BACKEND_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes (translation/format may be long)
const TRANSCRIPT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ── Backend URL cache (yt2txt) ──────────────────────────────────
let _yt2txtBaseUrl = null;
let _yt2txtBaseUrlExpiry = 0;

async function getYt2txtEndpoint(path) {
  if (!_yt2txtBaseUrl || Date.now() > _yt2txtBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      yt2txtHost: DEFAULT_HOST,
      yt2txtPort: DEFAULT_PORT,
    });
    _yt2txtBaseUrl = buildBackendEndpoint(items.yt2txtHost, items.yt2txtPort, '');
    _yt2txtBaseUrlExpiry = Date.now() + 60_000;
  }
  return _yt2txtBaseUrl + path;
}

// ── Backend URL cache (textkit) ─────────────────────────────────
let _textkitBaseUrl = null;
let _textkitBaseUrlExpiry = 0;

async function getTextkitEndpoint(path) {
  if (!_textkitBaseUrl || Date.now() > _textkitBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      textkitHost: DEFAULT_HOST,
      textkitPort: DEFAULT_TEXTKIT_PORT,
    });
    _textkitBaseUrl = buildBackendEndpoint(items.textkitHost, items.textkitPort, '');
    _textkitBaseUrlExpiry = Date.now() + 60_000;
  }
  return _textkitBaseUrl + path;
}

// Backward-compatible alias for the original single-backend helper.
const getBackendEndpoint = getYt2txtEndpoint;

function buildBackendEndpoint(host, port, path) {
  const normalized = normalizeBackendSettings(host, port);
  return `http://${normalized.host}:${normalized.port}${path}`;
}

function normalizeBackendSettings(host, port) {
  let normalizedHost = String(host || DEFAULT_HOST).trim();
  if (/^https?:\/\//i.test(normalizedHost)) {
    normalizedHost = new URL(normalizedHost).hostname;
  }
  normalizedHost = normalizedHost.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!LOCAL_BACKEND_HOSTS.has(normalizedHost)) {
    throw new Error('Backend host must be localhost, 127.0.0.1, or ::1.');
  }

  const normalizedPort = Number.parseInt(port, 10);
  if (
    !Number.isInteger(normalizedPort) ||
    normalizedPort < 1 ||
    normalizedPort > 65535
  ) {
    throw new Error('Backend port must be between 1 and 65535.');
  }

  return {
    host: normalizedHost === '::1' ? '[::1]' : normalizedHost,
    port: normalizedPort,
  };
}

// ── Per-tab state ───────────────────────────────────────────────
let states = new Map();

function getState(tabId) {
  if (!states.has(tabId)) {
    states.set(tabId, {
      active: false,
      status: 'Idle',
      progress: 'Ready',
      transcript: '',
      error: '',
      stopRequested: false,
    });
  }
  return states.get(tabId);
}

function updateState(tabId, partial) {
  Object.assign(getState(tabId), partial);
  broadcastState(tabId);
}

function resetState(tabId) {
  Object.assign(getState(tabId), {
    active: false,
    status: 'Idle',
    progress: 'Ready',
    transcript: '',
    error: '',
    stopRequested: false,
  });
  broadcastState(tabId);
}

function broadcastState(tabId) {
  chrome.runtime
    .sendMessage({
      type: 'state:update',
      tabId,
      state: getState(tabId),
    })
    .catch(() => {});
}

// ── Translation / Format controllers ────────────────────────────
const translateControllers = new Map();
const formatControllers = new Map();
let keepAliveIntervalId = null;

function startKeepAlive() {
  if (keepAliveIntervalId) return;
  keepAliveIntervalId = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20_000);
}

function stopKeepAlive() {
  if (!keepAliveIntervalId) return;
  clearInterval(keepAliveIntervalId);
  keepAliveIntervalId = null;
}

// ── Clean up on tab close ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) {
    state.controller.abort();
  }
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
  chrome.storage.local
    .remove([
      `transcript:${tabId}`,
      `status:${tabId}`,
      `tl2Result:${tabId}`,
      `tl2Language:${tabId}`,
      `tl2Status:${tabId}`,
      `tl2Translating:${tabId}`,
      `fmtResult:${tabId}`,
      `fmtStatus:${tabId}`,
      `fmtFormatting:${tabId}`,
    ])
    .catch(() => {});
});

// ── Message routing ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    handleStart(message)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:stop') {
    handleStop()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    getActiveTab()
      .then((tab) =>
        sendResponse({ ok: true, state: getState(tab.id), tabId: tab.id })
      )
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:start') {
    handleTranslateStart(message)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'translate:stop') {
    handleTranslateStop(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'format:start') {
    handleFormatStart(message)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message?.type === 'format:stop') {
    handleFormatStop(message.tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'save:translation') {
    handleSaveTranslation(message)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// ── Keyboard shortcut ───────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'get-transcript') return;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !tab?.url) return;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;

    const url = tab.url;
    await handleStart({ url });
  } catch (e) {
    console.error('Command handler failed:', e);
  }
});

// ── Tab helpers ─────────────────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab;
}

// ── Fetch with timeout ──────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  if (signal) {
    if (signal.aborted) {
      controller.abort();
      clearTimeout(timeoutId);
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Handle start (transcript) ──────────────────────────────────
async function handleStart(msg) {
  const tab = await getActiveTab();

  if (!msg.url || !msg.url.trim()) {
    return { ok: false, error: 'URL is required.' };
  }

  const state = getState(tab.id);
  if (state.active) {
    return { ok: false, error: 'A transcript extraction is already in progress.' };
  }

  // Create AbortController
  const controller = new AbortController();
  state.controller = controller;

  resetState(tab.id);
  updateState(tab.id, {
    active: true,
    status: 'Processing',
    progress: 'Checking for subtitles...',
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSCRIPT_TIMEOUT_MS);

  let resultText = '';
  try {
    const baseUrl = await getYt2txtEndpoint('/transcript');
    const url = `${baseUrl}?_=${Date.now()}`;

    updateState(tab.id, { progress: 'Sending request to backend...' });

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url, language: msg.lang || 'en' }),
      },
      controller.signal
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || payload.detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();

    if (payload.error) {
      throw new Error(payload.error);
    }

    resultText = payload.text || '';

    // Persist result
    await chrome.storage.local.set({ [`transcript:${tab.id}`]: resultText });

    updateState(tab.id, {
      active: false,
      status: 'Complete',
      progress: `Transcript ready (source: ${payload.source}).`,
      transcript: resultText,
      error: '',
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? "Request timed out after 15 minutes."
        : 'Stopped by user.';
      updateState(tab.id, {
        active: false,
        status: 'Error',
        progress: errorMsg,
        error: errorMsg,
      });
    } else {
      const errorMsg = e.message || 'Unknown error';
      updateState(tab.id, {
        active: false,
        status: 'Error',
        progress: errorMsg,
        error: errorMsg,
      });
    }
  } finally {
    clearTimeout(timeoutId);
    state.controller = null;
    // Don't clear transcript on error — keep whatever was collected
  }

  // Fire auto-actions after a successful transcript extraction.
  if (resultText) {
    try { await autoTranslate(tab.id, resultText); } catch (e) { console.error('autoTranslate failed:', e); }
    try { await autoFormatIfEnabled(tab.id, resultText); } catch (e) { console.error('autoFormatIfEnabled failed:', e); }
  }

  return { ok: true };
}

// ── Handle stop (transcript) ───────────────────────────────────
async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);

  state.stopRequested = true;
  if (state.controller) {
    state.controller.abort();
  }
  handleTranslateStop(tab.id);
  handleFormatStop(tab.id);

  updateState(tab.id, {
    progress: 'Stopping...',
  });

  return { ok: true };
}

// ── Handle translate start ─────────────────────────────────────
async function handleTranslateStart(msg) {
  const { tabId, text, language, host, port } = msg;
  if (!tabId || !text) return { ok: false, error: 'Missing tabId or text' };

  // Abort any in-flight translation for this tab
  handleTranslateStop(tabId);

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  try {
    translateControllers.set(tabId, controller);
    startKeepAlive();
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BACKEND_TIMEOUT_MS);

    // Persist state so popup reopen shows "Stop" button.
    await chrome.storage.local.set({
      [`tl2Translating:${tabId}`]: true,
      [`tl2Status:${tabId}`]: `Translating to ${language}...`,
    });
    // Clear stale result so init() doesn't mistake an old result
    // for a just-completed translation.
    await chrome.storage.local.remove(`tl2Result:${tabId}`);
    chrome.runtime
      .sendMessage({ type: 'tl2:translating', tabId, value: true })
      .catch(() => {});

    try {
      const key = `translatePrompt:${language}`;
      const stored = await chrome.storage.local.get(key);
      // "Original" with no custom prompt → pass through unchanged
      if (language === 'original' && !stored[key]) {
        const translated = text;
        await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
        chrome.runtime
          .sendMessage({ type: 'translation:update', tabId, text: translated })
          .catch(() => {});
        if (translated) autoCopyIfEnabled(translated);
        if (translated) autoSaveIfEnabled(translated);
        if (translated) autoFormatIfEnabled(tabId, translated, host, port);
        return { ok: true };
      }

      const baseUrl = await getTextkitEndpoint('/translate');
      const url = `${baseUrl}?_=${Date.now()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language, prompt: stored[key] || undefined }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (payload.error) throw new Error(payload.error);

      const translated = payload.text || '';
      await chrome.storage.local.set({ [`tl2Result:${tabId}`]: translated });
      chrome.runtime
        .sendMessage({ type: 'translation:update', tabId, text: translated })
        .catch(() => {});
      // Auto-copy / auto-save translated text
      if (translated) autoCopyIfEnabled(translated);
      if (translated) autoSaveIfEnabled(translated);
      // Auto-format: trigger from background so it survives popup close
      if (translated) autoFormatIfEnabled(tabId, translated, host, port);
    } catch (e) {
      if (e.name === 'AbortError') {
        const message = timedOut ? 'Translation timed out.' : 'Translation stopped.';
        await chrome.storage.local.set({ [`tl2Status:${tabId}`]: message });
        if (timedOut) {
          chrome.runtime
            .sendMessage({ type: 'translation:update', tabId, text: '', error: message })
            .catch(() => {});
        }
        return { ok: !timedOut, error: timedOut ? message : undefined };
      }
      const errorMessage = e.message || 'Translation failed.';
      await chrome.storage.local.set({ [`tl2Status:${tabId}`]: errorMessage });
      chrome.runtime
        .sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage })
        .catch(() => {});
      return { ok: false, error: errorMessage };
    }
  } finally {
    clearTimeout(timeoutId);
    if (translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      chrome.storage.local.remove(`tl2Translating:${tabId}`);
      chrome.runtime
        .sendMessage({ type: 'tl2:translating', tabId, value: false })
        .catch(() => {});
    }
    if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }

  return { ok: true };
}

// ── Handle translate stop ──────────────────────────────────────
function handleTranslateStop(tabId) {
  const controller = translateControllers.get(tabId);
  if (controller) {
    controller.abort();
    translateControllers.delete(tabId);
    chrome.storage.local.remove(`tl2Translating:${tabId}`);
  }
}

// ── Handle save translation ─────────────────────────────────────
async function handleSaveTranslation(msg) {
  const { text, path } = msg;
  if (!text || !path) return { ok: false, error: 'Missing text or path' };
  const url = await getTextkitEndpoint('/save');
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, path }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) return { ok: false, error: payload.error || `HTTP ${response.status}` };
  return { ok: true, path: payload.path || path };
}

// ── Handle format start ────────────────────────────────────────
async function handleFormatStart(msg) {
  const { tabId, text, prompt, host, port } = msg;
  if (!tabId || !text || !prompt) return { ok: false, error: 'Missing tabId, text, or prompt' };

  // Abort any in-flight formatting for this tab
  handleFormatStop(tabId);

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  try {
    formatControllers.set(tabId, controller);
    startKeepAlive();
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, BACKEND_TIMEOUT_MS);

    // Persist state so popup reopen shows "Stop" button.
    await chrome.storage.local.set({
      [`fmtFormatting:${tabId}`]: true,
      [`fmtStatus:${tabId}`]: 'Formatting...',
    });
    await chrome.storage.local.remove(`fmtResult:${tabId}`);
    chrome.runtime
      .sendMessage({ type: 'fmt:formatting', tabId, value: true })
      .catch(() => {});

    try {
      const baseUrl = await getTextkitEndpoint('/format');
      const url = `${baseUrl}?_=${Date.now()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, prompt }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (payload.error) throw new Error(payload.error);

      const formatted = payload.text || '';
      await chrome.storage.local.set({ [`fmtResult:${tabId}`]: formatted });
      chrome.runtime
        .sendMessage({ type: 'format:update', tabId, text: formatted })
        .catch(() => {});
      // Auto-copy / auto-save formatted text
      if (formatted) fmtAutoCopyIfEnabled(formatted);
      if (formatted) fmtAutoSaveIfEnabled(formatted);
    } catch (e) {
      if (e.name === 'AbortError') {
        const message = timedOut ? 'Formatting timed out.' : 'Formatting stopped.';
        await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: message });
        if (timedOut) {
          chrome.runtime
            .sendMessage({ type: 'format:update', tabId, text: '', error: message })
            .catch(() => {});
        }
        return { ok: !timedOut, error: timedOut ? message : undefined };
      }
      const errorMessage = e.message || 'Formatting failed.';
      await chrome.storage.local.set({ [`fmtStatus:${tabId}`]: errorMessage });
      chrome.runtime
        .sendMessage({ type: 'format:update', tabId, text: '', error: errorMessage })
        .catch(() => {});
      return { ok: false, error: errorMessage };
    }
  } finally {
    clearTimeout(timeoutId);
    if (formatControllers.get(tabId) === controller) {
      formatControllers.delete(tabId);
      chrome.storage.local.remove(`fmtFormatting:${tabId}`);
      chrome.runtime
        .sendMessage({ type: 'fmt:formatting', tabId, value: false })
        .catch(() => {});
    }
    if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }

  return { ok: true };
}

// ── Handle format stop ─────────────────────────────────────────
function handleFormatStop(tabId) {
  const controller = formatControllers.get(tabId);
  if (controller) {
    controller.abort();
    formatControllers.delete(tabId);
    chrome.storage.local.remove(`fmtFormatting:${tabId}`);
  }
}

// ── Clipboard ──────────────────────────────────────────────────
async function copyToClipboard(text) {
  if (!text) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD', 'DOM_PARSER'],
      justification: 'Clipboard access for auto-copy results',
    });
  } catch (e) {
    // Document may already exist — that's fine
  }
  chrome.runtime.sendMessage({ type: 'offscreen:copy', text }).catch(() => {});
  // Close the offscreen document after the copy completes so it doesn't block
  // future offscreen operations (MV3 allows only one at a time).
  setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => {});
  }, 2000);
}

// ── Auto-copy / auto-save helpers (translation) ────────────────
async function autoCopyIfEnabled(text) {
  const { tl2AutoCopy } = await chrome.storage.sync.get({ tl2AutoCopy: false });
  if (!tl2AutoCopy || !text) return;
  copyToClipboard(text);
  chrome.notifications.create('yt2txt-auto-copy', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'YT2TXT — Copied',
    message: 'Translation copied to system clipboard.',
    priority: 0,
  });
}

async function autoSaveIfEnabled(text) {
  const { tl2AutoSave, tl2AutoSavePath } = await chrome.storage.sync.get({
    tl2AutoSave: false,
    tl2AutoSavePath: '',
  });
  if (!tl2AutoSave || !tl2AutoSavePath || !text) return;
  try {
    const result = await handleSaveTranslation({ text, path: tl2AutoSavePath });
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('yt2txt-auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT — Saved',
      message: `Translation saved to ${result.path || tl2AutoSavePath}.`,
      priority: 0,
    });
  } catch (e) {
    console.error('Auto-save failed:', e);
    chrome.notifications.create('yt2txt-auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT — Save failed',
      message: e.message,
      priority: 1,
    });
  }
}

// ── Auto-copy / auto-save helpers (format) ─────────────────────
async function fmtAutoCopyIfEnabled(text) {
  const { fmtAutoCopy } = await chrome.storage.sync.get({ fmtAutoCopy: false });
  if (!fmtAutoCopy || !text) return;
  copyToClipboard(text);
  chrome.notifications.create('yt2txt-fmt-auto-copy', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'YT2TXT — Copied',
    message: 'Formatted text copied to system clipboard.',
    priority: 0,
  });
}

async function fmtAutoSaveIfEnabled(text) {
  const { fmtAutoSave, fmtSavePath } = await chrome.storage.sync.get({
    fmtAutoSave: false,
    fmtSavePath: '',
  });
  if (!fmtAutoSave || !fmtSavePath || !text) return;
  try {
    const result = await handleSaveTranslation({ text, path: fmtSavePath });
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('yt2txt-fmt-auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT — Saved',
      message: `Formatted text saved to ${result.path || fmtSavePath}.`,
      priority: 0,
    });
  } catch (e) {
    console.error('Auto-save format failed:', e);
    chrome.notifications.create('yt2txt-fmt-auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT — Save failed',
      message: e.message,
      priority: 1,
    });
  }
}

// ── Auto-format helper ─────────────────────────────────────────
async function autoFormatIfEnabled(tabId, text, host, port) {
  const settings = await chrome.storage.sync.get({ fmtAutoFormat: false });
  if (!settings.fmtAutoFormat) return;
  const prompt = await chrome.storage.local.get('formatPrompt');
  if (!prompt.formatPrompt || !prompt.formatPrompt.trim()) return;
  // Fall back to sync storage if caller didn't provide host/port
  if (!host || port === undefined) {
    const backend = await chrome.storage.sync.get({
      textkitHost: DEFAULT_HOST,
      textkitPort: DEFAULT_TEXTKIT_PORT,
    });
    host = backend.textkitHost;
    port = backend.textkitPort;
  }
  handleFormatStart({
    tabId,
    text,
    prompt: prompt.formatPrompt.trim(),
    host,
    port,
  }).catch((e) => console.error('autoFormatIfEnabled failed:', e));
}

// ── Auto-translate helper (called from handleStart) ────────────
async function autoTranslate(tabId, text) {
  const { yt2txtAutoTranslate } = await chrome.storage.sync.get({
    yt2txtAutoTranslate: false,
  });
  if (!yt2txtAutoTranslate) return;

  // Read language from Translation tab's per-tab setting
  const tl2LangKey = `tl2Language:${tabId}`;
  const tl2Lang = await chrome.storage.local.get(tl2LangKey);
  const language = tl2Lang[tl2LangKey] || 'original';
  // "Original" with no custom prompt → skip (nothing to do)
  if (language === 'original') {
    const promptKey = 'translatePrompt:original';
    const promptStored = await chrome.storage.local.get(promptKey);
    if (!promptStored[promptKey]) return;
  }

  // Pull TextKit host/port from sync storage for the auto path
  const backend = await chrome.storage.sync.get({
    textkitHost: DEFAULT_HOST,
    textkitPort: DEFAULT_TEXTKIT_PORT,
  });

  handleTranslateStart({
    tabId,
    text,
    language,
    host: backend.textkitHost,
    port: backend.textkitPort,
  }).catch((e) => console.error('autoTranslate failed:', e));
}
