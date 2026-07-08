// ── Constants ────────────────────────────────────────────────────
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8666;
const BACKEND_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ── Backend URL cache ───────────────────────────────────────────
let _backendBaseUrl = null;
let _backendBaseUrlExpiry = 0;

async function getBackendEndpoint(path) {
  if (!_backendBaseUrl || Date.now() > _backendBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      yt2txtHost: DEFAULT_HOST,
      yt2txtPort: DEFAULT_PORT,
    });
    _backendBaseUrl = buildBackendEndpoint(items.yt2txtHost, items.yt2txtPort, '');
    _backendBaseUrlExpiry = Date.now() + 60_000;
  }
  return _backendBaseUrl + path;
}

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

// ── Clean up on tab close ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) {
    state.controller.abort();
  }
  states.delete(tabId);
  chrome.storage.local
    .remove([`transcript:${tabId}`, `status:${tabId}`])
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

// ── Handle start ────────────────────────────────────────────────
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
  }, BACKEND_TIMEOUT_MS);

  try {
    const baseUrl = await getBackendEndpoint('/transcript');
    const url = `${baseUrl}?_=${Date.now()}`;

    updateState(tab.id, { progress: 'Sending request to backend...' });

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url }),
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

    const resultText = payload.text || '';

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
      const msg = timedOut
        ? 'Request timed out after 10 minutes.'
        : 'Stopped by user.';
      updateState(tab.id, {
        active: false,
        status: 'Error',
        progress: msg,
        error: msg,
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

  return { ok: true };
}

// ── Handle stop ─────────────────────────────────────────────────
async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);

  state.stopRequested = true;
  if (state.controller) {
    state.controller.abort();
  }

  updateState(tab.id, {
    progress: 'Stopping...',
  });

  return { ok: true };
}
