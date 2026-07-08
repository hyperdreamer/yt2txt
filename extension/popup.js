// ── Elements ────────────────────────────────────────────────────
const urlInput = document.getElementById('url');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusBar = document.getElementById('status-bar');
const resultEl = document.getElementById('result');
const copyBtn = document.getElementById('copy');
const downloadBtn = document.getElementById('download');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const langSelect = document.getElementById('lang');

// ── State ──────────────────────────────────────────────────────
let latestState = null;
let currentTabId = null;
let userEditedResult = false;

// ── Event listeners ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    statusBar.textContent = `Init failed: ${e.message}`;
    statusBar.className = 'error';
  });
});
startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);
copyBtn.addEventListener('click', copyText);
downloadBtn.addEventListener('click', downloadText);
hostInput.addEventListener('change', saveSettings);
portInput.addEventListener('change', saveSettings);
langSelect.addEventListener('change', saveSettings);
resultEl.addEventListener('input', () => {
  userEditedResult = true;
  updateResultButtons();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    renderState(message.state);
  }
});

// ── Init ────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  // Load settings
  const items = await chrome.storage.sync.get({
    yt2txtHost: 'localhost',
    yt2txtPort: 8666,
    yt2txtLang: 'en',
  });
  hostInput.value = items.yt2txtHost;
  portInput.value = items.yt2txtPort;
  langSelect.value = items.yt2txtLang;

  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }

  // Refresh state from background
  await refreshState();

  // Load persisted result
  const resultKey = currentTabId ? `transcript:${currentTabId}` : null;
  if (!resultEl.value.trim() && resultKey) {
    const stored = await chrome.storage.local.get(resultKey);
    if (stored[resultKey]) resultEl.value = stored[resultKey];
  }

  updateResultButtons();
}

// ── Settings ────────────────────────────────────────────────────
async function saveSettings() {
  await chrome.storage.sync.set({
    yt2txtHost: hostInput.value.trim() || 'localhost',
    yt2txtPort: parseInt(portInput.value, 10) || 8666,
    yt2txtLang: langSelect.value,
  });
}

// ── State sync ──────────────────────────────────────────────────
async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
    if (response?.ok) {
      currentTabId = response.tabId || currentTabId;
      renderState(response.state);
    }
  } catch {
    // Background may not be ready
  }
}

// ── Actions ─────────────────────────────────────────────────────
async function startCapture() {
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent = 'Enter a video URL first.';
    statusBar.className = 'error';
    return;
  }

  userEditedResult = false;
  resultEl.value = '';
  copyBtn.disabled = true;
  downloadBtn.disabled = true;

  startBtn.disabled = true;
  stopBtn.classList.remove('hidden');
  statusBar.textContent = 'Starting...';
  statusBar.className = '';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup:start',
      url,
      lang: langSelect.value,
    });
    if (!response?.ok) {
      statusBar.textContent = response?.error || 'Failed to start.';
      statusBar.className = 'error';
      startBtn.disabled = false;
      stopBtn.classList.add('hidden');
    }
  } catch (e) {
    statusBar.textContent = e.message || 'Failed to start.';
    statusBar.className = 'error';
    startBtn.disabled = false;
    stopBtn.classList.add('hidden');
  }
}

async function stopCapture() {
  stopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'popup:stop' });
  } catch {
    // Best effort
  }
}

async function copyText() {
  const text = resultEl.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  } catch {
    resultEl.select();
    document.execCommand('copy');
  }
}

function downloadText() {
  const text = resultEl.value.trim();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transcript.txt';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Render ──────────────────────────────────────────────────────
function renderState(state) {
  latestState = state || {};
  const isActive = Boolean(latestState.active);

  // Progress / status
  if (latestState.error) {
    statusBar.textContent = latestState.error;
    statusBar.className = 'error';
  } else if (latestState.progress) {
    statusBar.textContent = latestState.progress;
    statusBar.className = isActive ? '' : 'success';
  } else {
    statusBar.textContent = latestState.status || 'Ready';
    statusBar.className = '';
  }

  // Result text
  if (!userEditedResult && latestState.transcript) {
    resultEl.value = latestState.transcript;
  }

  // Buttons
  startBtn.disabled = isActive;
  stopBtn.classList.toggle('hidden', !isActive);

  updateResultButtons();
}

function updateResultButtons() {
  const hasText = resultEl.value.trim().length > 0;
  copyBtn.disabled = !hasText;
  downloadBtn.disabled = !hasText;
}
