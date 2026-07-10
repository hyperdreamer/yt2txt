// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'transcript-panel': document.getElementById('transcript-panel'),
  'format-panel': document.getElementById('format-panel'),
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
// ── Format panel elements ─────────────────────────────────────
const formatSource = document.getElementById('format-source');
const formatPrompt = document.getElementById('format-prompt');
const formatBtn = document.getElementById('format-btn');
const formatStatusBar = document.getElementById('format-status-bar');
const formatResult = document.getElementById('format-result');
const formatCopy = document.getElementById('format-copy');
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
let formatUserEdited = false;
let tlUserEdited = false;

// ── Tab switching ──────────────────────────────────────────────
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.panel);
  });
});

function switchTab(panelName) {
  // 1. Update active tab button
  tabs.forEach((t) => t.classList.remove('active'));
  const btn = document.querySelector(`[data-panel="${panelName}"]`);
  if (btn) btn.classList.add('active');

  // 2. Show/hide panels
  Object.values(panels).forEach((p) => p.classList.add('hidden'));
  if (panels[panelName]) panels[panelName].classList.remove('hidden');

  // 3. Auto-fill downstream data
  if (panelName === 'format-panel' && !formatSource.value.trim()) {
    // Pre-fill from transcript result
    const transcriptText = resultEl.value.trim();
    if (transcriptText) {
      formatSource.value = transcriptText;
      formatBtn.disabled = false;
    }
  }

  if (panelName === 'translation-panel' && !tl2Result.value.trim()) {
    // Pre-fill translate source from format result, falling back to
    // format source, falling back to transcript result.
    const formatOutput = formatResult.value.trim();
    const formatInput = formatSource.value.trim();
    const transcriptText = resultEl.value.trim();
    const next = formatOutput || formatInput || transcriptText;
    if (next && !tl2Result.value.trim()) {
      // The legacy tl2-* flow does not have a separate "source" textarea —
      // the transcript is taken from resultEl on Translate.  No need to
      // populate anything here; this is the unified-format-tab flow
      // (which is not used by the legacy tl2-* buttons).
    }
  }
}

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
// Format panel
formatBtn.addEventListener('click', doFormat);
formatCopy.addEventListener('click', () => copyResult(formatResult, formatCopy));
formatSource.addEventListener('input', () => {
  formatUserEdited = true;
  formatBtn.disabled = !formatSource.value.trim();
});
formatPrompt.addEventListener('input', () => {
  if (currentTabId) {
    chrome.storage.local.set({ [`format:prompt:${currentTabId}`]: formatPrompt.value });
  }
});
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
tl2AutosavePath.addEventListener('input', () => {
  saveTl2Settings();
  updatePathSuggestions(tl2AutosavePath.value);
});
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
      // Store with sourceUrl so init() validates on reopen
      const lang = tl2Language.value;
      chrome.storage.local.set({
        [`tl2Result:${currentTabId}`]: { text: message.text, sourceUrl: message.sourceUrl || urlInput.value, language: lang },
      });
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
  if (message?.type === 'format:update') {
    // Legacy TextKit format:update — no longer used by the unified popup
    // (renderState() handles the new state:update broadcast).  Kept for
    // backward compatibility with any external callers.
    return;
  }
});

// ── Init ───────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const newTabId = tab?.id || null;
  // Reset user-edited flag when switching tabs so the new tab's
  // transcript populates the textarea instead of being blocked.
  if (newTabId !== currentTabId) {
    userEditedResult = false;
  }
  currentTabId = newTabId;

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
      const entry = tl2Stored[`tl2Result:${currentTabId}`];
      if (typeof entry === 'object' && entry.text) {
        if (entry.sourceUrl === tab?.url) {
          tl2Result.value = entry.text;
          if (entry.language) tl2Language.value = entry.language;
        }
        // sourceUrl mismatch → leave empty
      } else if (typeof entry === 'string') {
        // Legacy format
        tl2Result.value = entry;
      }
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
  loadPathSuggestions();

  // Restore unified Format tab state (per-tab)
  if (currentTabId) {
    const fmtKeys = [
      `format:result:${currentTabId}`,
      `format:status:${currentTabId}`,
      `format:prompt:${currentTabId}`,
    ];
    const fmtStored = await chrome.storage.local.get(fmtKeys);
    if (fmtStored[`format:result:${currentTabId}`]) {
      formatResult.value = fmtStored[`format:result:${currentTabId}`];
      formatCopy.disabled = false;
    }
    if (fmtStored[`format:prompt:${currentTabId}`]) {
      formatPrompt.value = fmtStored[`format:prompt:${currentTabId}`];
    }
    // Auto-fill format source from transcript result if empty
    if (!formatSource.value.trim() && resultEl.value.trim()) {
      formatSource.value = resultEl.value.trim();
    }
  }

  updateResultButtons();
  updateTranslationButtons();
  updateFormatButtons();
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

// ── Lightweight TextKit fetches (popup → backend) ─────────────────
// These prompt / path fetches intentionally call fetch() directly from
// the popup instead of routing through the background service worker.
// Rationale:
//   - These are low-stakes read-only config fetches, not long-running
//     operations like transcription, translation, or formatting.
//   - Route-through-SW would add message-passing latency, which is
//     noticeable for interactive UX (path autocomplete with debounce).
//   - Failures are non-critical: the popup falls back to local storage.
//   - A short (10 s) timeout prevents them from blocking the UI.
async function _popupFetch(url) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 10_000);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function loadTranslatePromptForLanguage() {
  const lang = tl2Language.value;
  // Try textkit backend first (source of truth for prompts)
  try {
    const host = textkitHostInput.value.trim() || 'localhost';
    const port = parseInt(textkitPortInput.value, 10) || 8765;
    const resp = await _popupFetch(`http://${host}:${port}/prompts/translate?language=${encodeURIComponent(lang)}`);
    if (resp.ok) {
      const data = await resp.json();
      translatePrompt.value = data.template || '';
      return;
    }
  } catch {}
  // Fallback to local storage
  const stored = await chrome.storage.local.get([`translatePrompt:${lang}`]);
  translatePrompt.value = stored[`translatePrompt:${lang}`] || '';
}

// ── Path autocomplete (via textkit backend) ────────────────────
let _pathDebounceTimer = null;

function loadPathSuggestions() {
  // Initial load: fetch root-level paths from backend
  fetchPathSuggestions('');
}

async function fetchPathSuggestions(prefix) {
  try {
    const host = textkitHostInput.value.trim() || 'localhost';
    const port = parseInt(textkitPortInput.value, 10) || 8765;
    const resp = await _popupFetch(`http://${host}:${port}/paths?prefix=${encodeURIComponent(prefix)}`);
    const data = await resp.json().catch(() => ({}));
    const paths = data.paths || [];
    // If user typed a ~ prefix, prepend ~/ so the browser's <datalist>
    // filtering matches. The backend returns paths relative to save_root;
    // we only need to restore the tilde the user typed.
    const tildePrefix = prefix.startsWith('~/') ? '~/' : (prefix === '~' ? '~/' : '');
    tl2PathSuggestions.replaceChildren(...paths.map((path) => {
      const option = document.createElement('option');
      option.value = tildePrefix + path;
      return option;
    }));
  } catch {
    // Backend unreachable — keep existing suggestions
  }
}

function updatePathSuggestions(current) {
  if (!current) return;
  // Debounce: fetch real filesystem paths after typing stops
  clearTimeout(_pathDebounceTimer);
  _pathDebounceTimer = setTimeout(() => fetchPathSuggestions(current), 300);
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

// ── Format panel actions ──────────────────────────────────────
async function doFormat() {
  if (formatBtn.textContent === 'Stop') {
    // Stop in-progress format
    formatBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'popup:format-stop',
        tabId: currentTabId,
      });
    } catch {}
    return;
  }

  const text = formatSource.value.trim();
  if (!text) {
    setFormatStatus('No text to format.');
    return;
  }

  formatBtn.textContent = 'Stop';
  formatBtn.classList.add('danger');
  formatResult.value = '';
  formatCopy.disabled = true;
  setFormatStatus('Formatting...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup:format-start',
      tabId: currentTabId,
      text,
      prompt: formatPrompt.value.trim(),
    });
    if (!response?.ok) {
      setFormatStatus(response?.error || 'Format failed.');
      resetFormatButton();
    }
  } catch (e) {
    setFormatStatus(e.message || 'Format failed.');
    resetFormatButton();
  }
}

function resetFormatButton() {
  formatBtn.textContent = 'Format';
  formatBtn.classList.remove('danger');
  formatBtn.disabled = !formatSource.value.trim();
}

function setFormatStatus(msg) {
  formatStatusBar.textContent = msg;
  formatStatusBar.className = 'status-bar';
  if (
    msg && (
      msg.includes('failed') ||
      msg.includes('timed out') ||
      msg.includes('error') ||
      msg.includes('Error') ||
      msg.includes('Stop')
    )
  ) {
    formatStatusBar.className = 'status-bar error';
  }
  if (msg && (msg.includes('Formatted') || msg.includes('Ready'))) {
    formatStatusBar.className = 'status-bar success';
  }
}

function updateFormatButtons() {
  const hasSource = formatSource.value.trim().length > 0;
  const hasResult = formatResult.value.trim().length > 0;
  const isActive = formatBtn.textContent === 'Stop';
  formatBtn.disabled = isActive ? false : !hasSource;
  formatCopy.disabled = !hasResult;
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
      sourceUrl: urlInput.value,
      sourceLang: langSelect.value,
      host,
      port,
    });
  } catch (e) {
    // sendMessage itself failed (SW terminated, context invalidated, etc.)
    setTl2Progress(`Failed to start translation: ${e.message || 'unknown error'}`);
    tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = false;
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

  // ── Format tab state (unified flow) ──
  if (state.format) {
    if (state.format.resultText && !formatUserEdited) {
      formatResult.value = state.format.resultText;
    } else if (state.format.resultText && formatResult.value !== state.format.resultText) {
      // Only overwrite if user hasn't manually edited the format source
      // and the result is genuinely new.
      if (!formatUserEdited) {
        formatResult.value = state.format.resultText;
      }
    }
    if (state.format.status) {
      setFormatStatus(state.format.status);
    }
    if (state.format.active) {
      formatBtn.textContent = 'Stop';
      formatBtn.classList.add('danger');
      formatCopy.disabled = true;
    } else if (formatBtn.textContent === 'Stop') {
      resetFormatButton();
      if (state.format.resultText) {
        formatCopy.disabled = false;
      }
    }
    if (state.format.prompt !== undefined) {
      // Persisted prompt from background — restore on initial load
      // (popup.js init() will overwrite this for known tabIds).
    }
  }

  // ── Translate tab state (legacy tl2-* flow renders separately) ──
  // The legacy tl2:* messages are handled in the chrome.runtime.onMessage
  // listener above; the renderState() function only needs to update the
  // transcript tab here.

  updateResultButtons();
  updateTranslationButtons();
  updateFormatButtons();
}
