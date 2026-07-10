// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'transcript-panel': document.getElementById('transcript-panel'),
  'translation-panel': document.getElementById('translation-panel'),
};

// ── Transcript panel elements ─────────────────────────────────
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
const forceCheckbox = document.getElementById('force');

// ── Translation panel elements ────────────────────────────────
const tl2Language = document.getElementById('tl2-language');
const translatePrompt = document.getElementById('translate-prompt');
const tl2StatusBar = document.getElementById('tl2-status-bar');
const tl2Result = document.getElementById('tl2-result');
const tl2Translate = document.getElementById('tl2-translate');
const tl2Copy = document.getElementById('tl2-copy');
const tl2Save = document.getElementById('tl2-save');
const tl2Download = document.getElementById('tl2-download');
const tl2AutocopyCheckbox = document.getElementById('tl2-autocopy');
const tl2AutosaveCheckbox = document.getElementById('tl2-autosave');
const tl2AutotranslateCheckbox = document.getElementById('tl2-autotranslate');
const tl2AutosavePath = document.getElementById('tl2-autosave-path');
const tl2PathSuggestions = document.getElementById('tl2-path-suggestions');

// ── TextKit backend elements ──────────────────────────────────
const textkitHostInput = document.getElementById('textkit-host');
const textkitPortInput = document.getElementById('textkit-port');

// ── State ──────────────────────────────────────────────────────
let latestState = null;
let currentTabId = null;
let userEditedResult = false;

// ── Tab switching ──────────────────────────────────────────────
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    Object.values(panels).forEach((p) => p.classList.add('hidden'));
    panels[tab.dataset.panel].classList.remove('hidden');
  });
});

// ── Event listeners ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    statusBar.textContent = `Init failed: ${e.message}`;
    statusBar.className = 'status-bar error';
    setTl2Progress(`Init failed: ${e.message}`);
  });
});

// Transcript panel
startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);
copyBtn.addEventListener('click', copyText);
downloadBtn.addEventListener('click', downloadText);
hostInput.addEventListener('change', saveYt2txtSettings);
portInput.addEventListener('change', saveYt2txtSettings);
langSelect.addEventListener('change', saveYt2txtSettings);
resultEl.addEventListener('input', () => {
  userEditedResult = true;
  updateResultButtons();
  updateTranslationButtons();
});

// Translation panel
tl2Translate.addEventListener('click', doTranslation);
tl2Copy.addEventListener('click', () => copyResult(tl2Result, tl2Copy));
tl2Download.addEventListener('click', () => downloadAsFile(tl2Result.value.trim(), 'translate'));
tl2Save.addEventListener('click', saveTranslation);
tl2Language.addEventListener('change', () => {
  saveTl2Language();
  loadTranslatePromptForLanguage();
});
tl2AutocopyCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosaveCheckbox.addEventListener('change', saveTl2Settings);
tl2AutotranslateCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosavePath.addEventListener('input', saveTl2Settings);
translatePrompt.addEventListener('input', saveTranslatePrompt);

// TextKit backend
textkitHostInput.addEventListener('change', saveTextkitBackend);
textkitPortInput.addEventListener('change', saveTextkitBackend);

// ── Background messages ───────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    renderState(message.state);
    return;
  }
  if (message?.type === 'translation:update') {
    if (message.tabId !== currentTabId) return;
    if (message.text) {
      tl2Result.value = message.text;
      chrome.storage.local.set({ [`tl2Result:${currentTabId}`]: message.text });
    } else if (message.error) {
      // Error path: keep any existing result visible
    }
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = !message.text;
    tl2Translate.textContent = 'Translate';
    tl2Translate.classList.remove('danger');
    chrome.storage.local.remove(`tl2Translating:${currentTabId}`);
    setTl2Progress(message.text ? 'Translation complete.' : (message.error || 'Translation failed.'));
    updateTranslationButtons();
    return;
  }
  if (message?.type === 'tl2:translating') {
    if (message.tabId !== currentTabId) return;
    if (message.value) {
      tl2Translate.textContent = 'Stop';
      tl2Translate.classList.add('danger');
      tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;
      setTl2Progress('Translating...');
    } else {
      tl2Translate.textContent = 'Translate';
      tl2Translate.classList.remove('danger');
      updateTranslationButtons();
    }
    return;
  }
});

// ── Init ───────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;

  // Load settings
  const items = await chrome.storage.sync.get({
    yt2txtHost: 'localhost',
    yt2txtPort: 8666,
    yt2txtLang: '',
    textkitHost: '',
    textkitPort: 8765,
    tl2AutoCopy: false,
    tl2AutoSave: false,
    tl2AutoSavePath: '',
    yt2txtAutoTranslate: false,
  });

  // Auto-fill TextKit host from yt2txt host if empty (common single-machine case)
  if (!items.textkitHost) items.textkitHost = items.yt2txtHost;

  hostInput.value = items.yt2txtHost;
  portInput.value = items.yt2txtPort;
  langSelect.value = items.yt2txtLang;
  textkitHostInput.value = items.textkitHost;
  textkitPortInput.value = items.textkitPort;

  tl2AutocopyCheckbox.checked = items.tl2AutoCopy;
  tl2AutosaveCheckbox.checked = items.tl2AutoSave;
  tl2AutosavePath.value = items.tl2AutoSavePath;
  tl2AutotranslateCheckbox.checked = items.yt2txtAutoTranslate;

  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }

  // Refresh state from background
  await refreshState();

  // Load persisted transcript result (keyed by tabId+URL)
  const resultKey = currentTabId ? `transcript:${currentTabId}` : null;
  if (!resultEl.value.trim() && resultKey) {
    const stored = await chrome.storage.local.get(resultKey);
    const entry = stored[resultKey];
    if (entry) {
      if (typeof entry === 'object' && entry.url === tab?.url) {
        resultEl.value = entry.text || '';
      } else if (typeof entry === 'string') {
        // Legacy format (pre-URL-keyed)
        resultEl.value = entry;
      }
      // Otherwise: stored URL doesn't match → leave textarea empty
    }
  }

  // Load translation tab state (per-tab)
  if (currentTabId) {
    const tl2Keys = [
      `tl2Result:${currentTabId}`,
      `tl2Language:${currentTabId}`,
      `tl2Status:${currentTabId}`,
      `tl2Translating:${currentTabId}`,
    ];
    const tl2Stored = await chrome.storage.local.get(tl2Keys);
    if (tl2Stored[`tl2Language:${currentTabId}`]) {
      tl2Language.value = tl2Stored[`tl2Language:${currentTabId}`];
    }
    if (tl2Stored[`tl2Result:${currentTabId}`]) {
      tl2Result.value = tl2Stored[`tl2Result:${currentTabId}`];
    }
    if (tl2Stored[`tl2Status:${currentTabId}`]) {
      setTl2Progress(tl2Stored[`tl2Status:${currentTabId}`]);
    }

    // Restore "Stop" button state if mid-translation
    if (tl2Stored[`tl2Translating:${currentTabId}`]) {
      // If we also have a result, this is "completed while closed" — show result.
      if (tl2Result.value.trim()) {
        chrome.storage.local.remove(`tl2Translating:${currentTabId}`);
        tl2Translate.textContent = 'Translate';
        tl2Translate.classList.remove('danger');
      } else {
        tl2Translate.textContent = 'Stop';
        tl2Translate.classList.add('danger');
        setTl2Progress('Translating...');
      }
    }
  }

  // Load translation prompt for current language
  await loadTranslatePromptForLanguage();

  updateResultButtons();
  updateTranslationButtons();
}

// ── Settings ───────────────────────────────────────────────────
async function saveYt2txtSettings() {
  await chrome.storage.sync.set({
    yt2txtHost: hostInput.value.trim() || 'localhost',
    yt2txtPort: parseInt(portInput.value, 10) || 8666,
    yt2txtLang: langSelect.value,
  });
}

// Backward-compatible alias (some scripts/old code may reference it)
const saveSettings = saveYt2txtSettings;

function saveTextkitBackend() {
  chrome.storage.sync.set({
    textkitHost: textkitHostInput.value.trim() || 'localhost',
    textkitPort: parseInt(textkitPortInput.value, 10) || 8765,
  });
}

function saveTl2Settings() {
  chrome.storage.sync.set({
    tl2AutoCopy: tl2AutocopyCheckbox.checked,
    tl2AutoSave: tl2AutosaveCheckbox.checked,
    tl2AutoSavePath: tl2AutosavePath.value.trim(),
    yt2txtAutoTranslate: tl2AutotranslateCheckbox.checked,
  });
}

function saveTl2Language() {
  if (!currentTabId) return;
  chrome.storage.local.set({ [`tl2Language:${currentTabId}`]: tl2Language.value });
}

function saveTranslatePrompt() {
  const lang = tl2Language.value;
  chrome.storage.local.set({ [`translatePrompt:${lang}`]: translatePrompt.value });
}

async function loadTranslatePromptForLanguage() {
  const lang = tl2Language.value;
  const stored = await chrome.storage.local.get([`translatePrompt:${lang}`]);
  translatePrompt.value = stored[`translatePrompt:${lang}`] || '';
}

// ── State sync ─────────────────────────────────────────────────
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

// ── Transcript actions ─────────────────────────────────────────
async function startCapture() {
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent = 'Enter a video URL first.';
    statusBar.className = 'status-bar error';
    return;
  }

  userEditedResult = false;
  resultEl.value = '';
  copyBtn.disabled = true;
  downloadBtn.disabled = true;

  startBtn.disabled = true;
  forceCheckbox.disabled = true;
  stopBtn.classList.remove('hidden');
  statusBar.textContent = 'Starting...';
  statusBar.className = 'status-bar';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup:start',
      url,
      lang: langSelect.value,
      force: forceCheckbox.checked,
    });
    forceCheckbox.checked = false;
    if (!response?.ok) {
      statusBar.textContent = response?.error || 'Failed to start.';
      statusBar.className = 'status-bar error';
      startBtn.disabled = false;
      forceCheckbox.disabled = false;
      stopBtn.classList.add('hidden');
    }
  } catch (e) {
    statusBar.textContent = e.message || 'Failed to start.';
    statusBar.className = 'status-bar error';
    startBtn.disabled = false;
    forceCheckbox.disabled = false;
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

// ── Translation panel actions ─────────────────────────────────
async function doTranslation() {
  if (tl2Translate.textContent === 'Stop') {
    tl2Translate.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'translate:stop', tabId: currentTabId });
    } catch {
      // Best effort
    }
    return;
  }

  const text = resultEl.value.trim();
  if (!text) {
    setTl2Progress('No transcript text to translate.');
    return;
  }
  const language = tl2Language.value;

  tl2Result.value = '';
  tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;

  const host = textkitHostInput.value.trim() || 'localhost';
  const port = parseInt(textkitPortInput.value, 10) || 8765;

  try {
    await chrome.runtime.sendMessage({
      type: 'translate:start',
      tabId: currentTabId,
      text,
      language,
      host,
      port,
    });
  } catch {
    // Background will broadcast status
  }
}

async function saveTranslation() {
  const text = tl2Result.value.trim();
  const path = tl2AutosavePath.value.trim();
  if (!text || !path) {
    setTl2Progress('Enter a save path first.');
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'save:translation', text, path });
    if (r?.ok) {
      tl2Save.textContent = 'Saved!';
      setTimeout(() => (tl2Save.textContent = 'Save'), 1500);
      setTl2Progress(`Saved to ${r.path || path}`);
    } else {
      setTl2Progress(r?.error || 'Save failed.');
    }
  } catch (e) {
    setTl2Progress(e.message || 'Save failed.');
  }
}

// ── Shared helpers ────────────────────────────────────────────
async function copyResult(textarea, button) {
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied!';
    setTimeout(() => (button.textContent = 'Copy'), 1500);
  } catch {
    textarea.select();
    document.execCommand('copy');
  }
}

function downloadAsFile(text, prefix) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Progress helpers ──────────────────────────────────────────
function setTl2Progress(msg) {
  tl2StatusBar.textContent = msg;
  tl2StatusBar.className = 'status-bar';
  if (msg && (msg.includes('failed') || msg.includes('timed out') || msg.includes('error') || msg.includes('Error'))) {
    tl2StatusBar.className = 'status-bar error';
  }
  if (msg && (msg.includes('complete') || msg.includes('Ready') || msg.includes('Saved'))) {
    tl2StatusBar.className = 'status-bar success';
  }
}

function updateTranslationButtons() {
  const hasSource = resultEl.value.trim().length > 0;
  const hasResult = tl2Result.value.trim().length > 0;
  const isActive = tl2Translate.textContent === 'Stop';
  tl2Translate.disabled = isActive ? false : !hasSource;
  tl2Copy.disabled = !hasResult;
  tl2Save.disabled = !hasResult;
  tl2Download.disabled = !hasResult;
}

function updateResultButtons() {
  const hasText = resultEl.value.trim().length > 0;
  copyBtn.disabled = !hasText;
  downloadBtn.disabled = !hasText;
}

// ── Render ─────────────────────────────────────────────────────
function renderState(state) {
  latestState = state || {};
  const isActive = Boolean(latestState.active);

  // Progress / status
  if (latestState.error) {
    statusBar.textContent = latestState.error;
    statusBar.className = 'status-bar error';
  } else if (latestState.progress) {
    statusBar.textContent = latestState.progress;
    statusBar.className = isActive ? 'status-bar' : 'status-bar success';
  } else {
    statusBar.textContent = latestState.status || 'Ready';
    statusBar.className = 'status-bar';
  }

  // Result text
  if (!userEditedResult && latestState.transcript) {
    resultEl.value = latestState.transcript;
  }

  // Buttons
  startBtn.disabled = isActive;
  forceCheckbox.disabled = isActive;
  stopBtn.classList.toggle('hidden', !isActive);

  updateResultButtons();
  updateTranslationButtons();
}
