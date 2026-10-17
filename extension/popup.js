// ── Tab state ─────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const panels = {
  'transcript-panel': document.getElementById('transcript-panel'),
  'format-panel': document.getElementById('format-panel'),
  'translation-panel': document.getElementById('translation-panel'),
};

// ── Settings gear ─────────────────────────────────────────────
const settingsGear = document.getElementById('settings-gear');
const settingsPanel = document.getElementById('backend-settings-panel');

settingsGear.addEventListener('click', () => {
  const isOpen = !settingsPanel.classList.contains('hidden');
  settingsPanel.classList.toggle('hidden', isOpen);
  settingsGear.classList.toggle('active', !isOpen);
});

// ── Transcript panel elements ─────────────────────────────────
const urlInput = document.getElementById('url');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusBar = document.getElementById('status-bar');
const resultEl = document.getElementById('result');
const formatRetryRow = document.getElementById('format-retry-row');
const formatRetryBtn = document.getElementById('format-retry');
const formatRetryStatus = document.getElementById('format-retry-status');
const copyBtn = document.getElementById('copy');
const downloadBtn = document.getElementById('download');
// ── Format panel elements ─────────────────────────────────────
const formatBtn = document.getElementById('format-btn');
const formatStatusBar = document.getElementById('format-status-bar');
const formatResult = document.getElementById('format-result');
const formatCopy = document.getElementById('format-copy');
const formatSave = document.getElementById('format-save');
const fmtAutocopyCheckbox = document.getElementById('fmt-autocopy');
const fmtAutosaveCheckbox = document.getElementById('fmt-autosave');
const fmtAutosavePath = document.getElementById('fmt-autosave-path');
const fmtPathSuggestions = document.getElementById('fmt-path-suggestions');
const hostInput = document.getElementById('host');
const portInput = document.getElementById('port');
const forceCheckbox = document.getElementById('force');
const sourceChip = document.getElementById('source-chip');
const sourceChipIcon = document.getElementById('source-chip-icon');
const sourceChipLabel = document.getElementById('source-chip-label');

// ── Translation panel elements ────────────────────────────────
const tl2Language = document.getElementById('tl2-language');
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

// ── File Bridge backend elements ──────────────────────────────
const fileBridgeHostInput = document.getElementById('file-bridge-host');
const fileBridgePortInput = document.getElementById('file-bridge-port');
const FILE_BRIDGE_DEFAULT_PORT = 8964;
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ── File Bridge shared helpers ─────────────────────────────────
function readFileBridgeSettings() {
  let rawHost = fileBridgeHostInput.value.trim();
  if (/^https?:\/\//i.test(rawHost)) rawHost = new URL(rawHost).hostname;
  const host = rawHost || 'localhost';
  const rawPort = parseInt(fileBridgePortInput.value, 10);
  const port = (Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535)
    ? rawPort : FILE_BRIDGE_DEFAULT_PORT;
  return { host, port };
}

function validateFileBridgeSettings(host, port) {
  let normalized = String(host || 'localhost').toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!LOCAL_BACKEND_HOSTS.has(normalized)) {
    return { valid: false, error: 'File Bridge host must be localhost, 127.0.0.1, or ::1.' };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, error: 'File Bridge port must be between 1 and 65535.' };
  }
  return { valid: true, host: normalized === '::1' ? '[::1]' : normalized, port };
}

// ── Input source chip (local vs web) ───────────────────────────
// Display-only mirror of the backend's classification rules.  A mismatch
// can only mislabel the chip; the backend stays authoritative.
function inputBasename(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

function fileUrlDisplayPath(raw) {
  try {
    return decodeURIComponent(new URL(raw).pathname);
  } catch {
    return raw;
  }
}

function classifyInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.startsWith('//')) return null;
  if (/^file:/i.test(s)) {
    const full = fileUrlDisplayPath(s);
    return { kind: 'local', label: `Local file · ${inputBasename(full)}`, title: full };
  }
  if (s.startsWith('/')) {
    return { kind: 'local', label: `Local file · ${inputBasename(s)}`, title: s };
  }
  if (s.startsWith('~')) {
    return { kind: 'local', label: `Local file · ${inputBasename(s)}`, title: s };
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      return { kind: 'web', label: `Web URL · ${new URL(s).hostname}`, title: s };
    } catch {
      return null;
    }
  }
  return null;
}

function sourceKey(raw) {
  const s = String(raw ?? '');
  if (/^file:/i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s;
    }
  }
  return s;
}

function updateSourceChip() {
  const info = classifyInput(urlInput.value);
  sourceChip.classList.toggle('hidden', !info);
  sourceChipIcon.textContent = info ? (info.kind === 'local' ? '📁' : '🌐') : '';
  sourceChipLabel.textContent = info ? info.label : '';
  sourceChip.title = info ? info.title : '';
}

// ── State ──────────────────────────────────────────────────────
let latestState = null;
let currentTabId = null;
let userEditedResult = false;
let tlUserEdited = false;
// Monotonic view generation.  Every relevant background event and every
// local start/stop/retry command advances it.  A worker snapshot captured
// before an advance is stale: rendering it would resurrect superseded
// activity or overwrite a newer result, so it is discarded instead.
let viewGeneration = 0;
// Tab whose fully hydrated state is currently on screen.  Until a tab has
// one, a discarded snapshot still needs to be re-requested.
let renderedTabId = null;

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
formatSave.addEventListener('click', saveFormatResult);
fmtAutocopyCheckbox.addEventListener('change', saveFmtSettings);
fmtAutosaveCheckbox.addEventListener('change', saveFmtSettings);
fmtAutosavePath.addEventListener('input', () => {
  saveFmtSettings();
  updateFmtPathSuggestions(fmtAutosavePath.value);
});
urlInput.addEventListener('input', updateSourceChip);
hostInput.addEventListener('change', saveYt2txtSettings);
portInput.addEventListener('change', saveYt2txtSettings);
resultEl.addEventListener('input', () => {
  userEditedResult = true;
  updateResultButtons();
  updateTranslationButtons();
});
formatRetryBtn.addEventListener('click', retryFormat);

// Translation panel
tl2Translate.addEventListener('click', doTranslation);
tl2Copy.addEventListener('click', () => copyResult(tl2Result, tl2Copy));
tl2Download.addEventListener('click', () => downloadAsFile(tl2Result.value.trim(), 'translate'));
tl2Save.addEventListener('click', saveTranslation);
tl2Language.addEventListener('change', () => {
  saveTl2Language();
});
tl2AutocopyCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosaveCheckbox.addEventListener('change', saveTl2Settings);
tl2AutotranslateCheckbox.addEventListener('change', saveTl2Settings);
tl2AutosavePath.addEventListener('input', () => {
  saveTl2Settings();
  updatePathSuggestions(tl2AutosavePath.value);
});

// TextKit backend
textkitHostInput.addEventListener('change', saveTextkitBackend);
textkitPortInput.addEventListener('change', saveTextkitBackend);

// File Bridge backend
fileBridgeHostInput.addEventListener('change', saveFileBridgeSettings);
fileBridgePortInput.addEventListener('change', saveFileBridgeSettings);

// ── Background messages ───────────────────────────────────────
// Registered at module scope so no snapshot request can be answered before
// the listeners exist.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'state:update') {
    if (message.tabId !== currentTabId) return;
    viewGeneration += 1;
    renderState(message.state);
    return;
  }
  if (message?.type === 'translation:update' || message?.type === 'tl2:translating') {
    if (message.tabId !== currentTabId) return;
    // Partial messages are only meaningful for the stage currently on
    // screen.  A late partial from a superseded root must never repaint.
    if (!partialOwnershipMatches(message)) return;
    viewGeneration += 1;
    if (message.type === 'translation:update') {
      if (message.text) tl2Result.value = message.text;
      // Error path keeps any existing result visible.
      if (latestState?.translate) latestState.translate.active = false;
      setTl2Progress(message.text ? 'Translation complete.' : (message.error || 'Translation failed.'));
      applyTranslateButtonState();
      return;
    }
    if (latestState?.translate) latestState.translate.active = message.value === true;
    if (message.value) setTl2Progress('Translating...');
    applyTranslateButtonState();
    return;
  }
});

function partialOwnershipMatches(message) {
  const rootId = latestState?.rootId;
  const stageId = latestState?.stageId;
  if (typeof message.rootId !== 'string' || typeof message.stageId !== 'string') return false;
  return message.rootId === rootId && message.stageId === stageId;
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const newTabId = tab?.id || null;
  // Reset user-edited flag when switching tabs so the new tab's
  // transcript populates the textarea instead of being blocked.  A new tab
  // also invalidates any snapshot still in flight for the previous one.
  if (newTabId !== currentTabId) {
    viewGeneration += 1;
    renderedTabId = null;
    userEditedResult = false;
    tlUserEdited = false;
    formatRetryRow.classList.add('hidden');
  }
  currentTabId = newTabId;

  // Load settings
  const items = await chrome.storage.sync.get({
    yt2txtHost: 'localhost',
    yt2txtPort: 8666,
    textkitHost: '',
    textkitPort: 8765,
    fileBridgeHost: '',
    fileBridgePort: FILE_BRIDGE_DEFAULT_PORT,
    tl2AutoCopy: false,
    tl2AutoSave: false,
    tl2AutoSavePath: '',
    yt2txtAutoTranslate: false,
  });

  // Auto-fill TextKit host from yt2txt host if empty (common single-machine case)
  if (!items.textkitHost) items.textkitHost = items.yt2txtHost;

  hostInput.value = items.yt2txtHost;
  portInput.value = items.yt2txtPort;
  textkitHostInput.value = items.textkitHost;
  textkitPortInput.value = items.textkitPort;
  fileBridgeHostInput.value = items.fileBridgeHost || '';
  fileBridgePortInput.value = items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT;

  tl2AutocopyCheckbox.checked = items.tl2AutoCopy;
  tl2AutosaveCheckbox.checked = items.tl2AutoSave;
  tl2AutosavePath.value = items.tl2AutoSavePath;
  tl2AutotranslateCheckbox.checked = items.yt2txtAutoTranslate;

  // Format tab settings
  const fmtItems = await chrome.storage.sync.get({
    fmtAutoCopy: false,
    fmtAutoSave: false,
    fmtAutoSavePath: '',
  });
  fmtAutocopyCheckbox.checked = fmtItems.fmtAutoCopy;
  fmtAutosaveCheckbox.checked = fmtItems.fmtAutoSave;
  fmtAutosavePath.value = fmtItems.fmtAutoSavePath;

  // Pre-fill URL from current tab
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
    urlInput.value = tab.url;
  }
  updateSourceChip();

  // Refresh state from the worker. Reconciliation hydrates transcript,
  // transformation results, active stage IDs, and retry descriptors.
  await refreshState();

  // Load translation tab language preference (global)
  const { tl2Language: tl2Lang } = await chrome.storage.sync.get({ tl2Language: 'original' });
  tl2Language.value = tl2Lang || 'original';

  loadPathSuggestions();

  // Format button enabled if transcript has text
  if (resultEl.value.trim()) {
    formatBtn.disabled = false;
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
  });
}

function saveTextkitBackend() {
  chrome.storage.sync.set({
    textkitHost: textkitHostInput.value.trim() || 'localhost',
    textkitPort: parseInt(textkitPortInput.value, 10) || 8765,
  });
}

function saveFileBridgeSettings() {
  const rawHost = fileBridgeHostInput.value.trim();
  const rawPort = parseInt(fileBridgePortInput.value, 10);
  const validation = validateFileBridgeSettings(rawHost, rawPort);
  if (!validation.valid) {
    statusBar.textContent = validation.error;
    statusBar.className = 'status-bar error';
    return;
  }
  chrome.storage.sync.set({
    fileBridgeHost: validation.host,
    fileBridgePort: validation.port,
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
  chrome.storage.sync.set({ tl2Language: tl2Language.value });
}

// ── Format tab settings ──────────────────────────────────────
function saveFmtSettings() {
  chrome.storage.sync.set({
    fmtAutoCopy: fmtAutocopyCheckbox.checked,
    fmtAutoSave: fmtAutosaveCheckbox.checked,
    fmtAutoSavePath: fmtAutosavePath.value.trim(),
  });
}

async function saveFormatResult() {
  const text = formatResult.value.trim();
  const path = fmtAutosavePath.value.trim();
  if (!text || !path) {
    setFormatStatus('Enter a save path first.');
    return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'save:translation', text, path });
    if (r?.ok) {
      formatSave.textContent = 'Saved!';
      setTimeout(() => (formatSave.textContent = 'Save'), 1500);
      setFormatStatus(`Saved to ${r.path || path}`);
    } else {
      setFormatStatus(r?.error || 'Save failed.');
    }
  } catch (e) {
    setFormatStatus(e.message || 'Save failed.');
  }
}

// ── Shared File Bridge path suggestion fetch ──────────────────
async function fetchFileBridgePathSuggestions(prefix, datalistEl) {
  try {
    const { host, port } = readFileBridgeSettings();
    const validation = validateFileBridgeSettings(host, port);
    if (!validation.valid) return;
    const fbHost = validation.host;
    const fbPort = validation.port;
    const resp = await _popupFetch(`http://${fbHost}:${fbPort}/paths?prefix=${encodeURIComponent(prefix)}`);
    const data = await resp.json().catch(() => ({}));
    const paths = data.paths || [];
    const tildePrefix = prefix.startsWith('~/') ? '~/' : (prefix === '~' ? '~/' : '');
    datalistEl.replaceChildren(...paths.map((path) => {
      const option = document.createElement('option');
      option.value = tildePrefix + path;
      return option;
    }));
  } catch {}
}

async function fetchFmtPathSuggestions(prefix) {
  return fetchFileBridgePathSuggestions(prefix, fmtPathSuggestions);
}

let _fmtPathDebounceTimer = null;
function updateFmtPathSuggestions(current) {
  if (!current) return;
  clearTimeout(_fmtPathDebounceTimer);
  _fmtPathDebounceTimer = setTimeout(() => fetchFmtPathSuggestions(current), 300);
}

// ── Lightweight backend fetches (popup → backend) ─────────────────
// Path-autocomplete fetches to File Bridge /paths call fetch() directly
// from the popup instead of routing through the background service
// worker.
// Rationale:
//   - These are low-stakes read-only config fetches, not long-running
//     operations like transcription, translation, or formatting.
//   - Route-through-SW would add message-passing latency, which is
//     noticeable for interactive UX (path autocomplete with debounce).
//   - Failures are non-critical: the popup keeps existing suggestions.
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

// ── Path autocomplete (via File Bridge backend) ────────────────────
let _pathDebounceTimer = null;

function loadPathSuggestions() {
  // Initial load: fetch root-level paths from backend
  fetchPathSuggestions('');
}

async function fetchPathSuggestions(prefix) {
  return fetchFileBridgePathSuggestions(prefix, tl2PathSuggestions);
}

function updatePathSuggestions(current) {
  if (!current) return;
  // Debounce: fetch real filesystem paths after typing stops
  clearTimeout(_pathDebounceTimer);
  _pathDebounceTimer = setTimeout(() => fetchPathSuggestions(current), 300);
}

// ── State sync ─────────────────────────────────────────────────
// Capture the view a continuation belongs to.  Local commands must not
// repaint the DOM after a newer render has taken ownership of the view.
function captureView() {
  return { generation: viewGeneration, tabId: currentTabId };
}

function viewOwns(view) {
  return Boolean(view) && view.generation === viewGeneration && view.tabId === currentTabId;
}

// One reconciled worker snapshot is the only hydration source.  The popup
// never rebuilds state from its own storage reads.
async function refreshState() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = viewGeneration;
    const tabId = currentTabId;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'popup:get-state' });
    } catch {
      // Background may not be ready
      return;
    }
    if (generation !== viewGeneration || tabId !== currentTabId) {
      // A newer background event or local command already owns the view.
      // Only ask again while this tab has no rendered state at all.
      if (renderedTabId === currentTabId) return;
      continue;
    }
    if (!response?.ok || !response.state) return;
    const responseTabId = response.tabId === undefined || response.tabId === null
      ? tabId
      : response.tabId;
    if (tabId !== null && responseTabId !== tabId) {
      if (renderedTabId === currentTabId) return;
      continue;
    }
    if (responseTabId !== null) currentTabId = responseTabId;
    renderState(response.state);
    return;
  }
}

// ── Transcript actions ─────────────────────────────────────────
async function startCapture() {
  const url = urlInput.value.trim();
  if (!url) {
    statusBar.textContent =
      'Enter a video URL or a local video path (for example the file:// URL of a video open in this tab).';
    statusBar.className = 'status-bar error';
    return;
  }

  viewGeneration += 1;
  const view = captureView();
  userEditedResult = false;
  formatRetryRow.classList.add('hidden');
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
      force: forceCheckbox.checked,
    });
    // A newer event or command owns the view now; this response is stale.
    if (!viewOwns(view)) return;
    forceCheckbox.checked = false;
    if (!response?.ok) {
      statusBar.textContent = response?.error || 'Failed to start.';
      statusBar.className = 'status-bar error';
      startBtn.disabled = false;
      forceCheckbox.disabled = false;
      stopBtn.classList.add('hidden');
    }
  } catch (e) {
    if (!viewOwns(view)) return;
    statusBar.textContent = e.message || 'Failed to start.';
    statusBar.className = 'status-bar error';
    startBtn.disabled = false;
    forceCheckbox.disabled = false;
    stopBtn.classList.add('hidden');
  }
}

async function stopCapture() {
  viewGeneration += 1;
  stopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'popup:stop',
      tabId: currentTabId,
      rootId: latestState?.rootId,
      stageId: latestState?.stageId,
    });
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
    viewGeneration += 1;
    formatBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'format:stop',
        tabId: currentTabId,
        rootId: latestState?.rootId,
        stageId: latestState?.stageId,
      });
    } catch {}
    return;
  }

  const text = resultEl.value.trim();
  if (!text) {
    setFormatStatus('No text to format.');
    return;
  }

  viewGeneration += 1;
  const view = captureView();
  formatBtn.textContent = 'Stop';
  formatBtn.classList.add('danger');
  formatResult.value = '';
  formatCopy.disabled = true;
  formatSave.disabled = true;
  setFormatStatus('Formatting...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'format:start',
      tabId: currentTabId,
      text,
    });
    // A newer event or command owns the view now; this response is stale.
    if (!viewOwns(view)) return;
    if (!response?.ok) {
      setFormatStatus(response?.error || 'Format failed.');
      resetFormatButton();
    }
  } catch (e) {
    if (!viewOwns(view)) return;
    setFormatStatus(e.message || 'Format failed.');
    resetFormatButton();
  }
}

function resetFormatButton() {
  formatBtn.textContent = 'Format';
  formatBtn.classList.remove('danger');
  formatBtn.disabled = !resultEl.value.trim();
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
  const hasSource = resultEl.value.trim().length > 0;
  const hasResult = formatResult.value.trim().length > 0;
  const isActive = formatBtn.textContent === 'Stop';
  formatBtn.disabled = isActive ? false : !hasSource;
  formatCopy.disabled = isActive || !hasResult;
  formatSave.disabled = isActive || !hasResult;
}

// ── Translation panel actions ─────────────────────────────────
async function doTranslation() {
  if (tl2Translate.textContent === 'Stop') {
    viewGeneration += 1;
    tl2Translate.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'translate:stop',
        tabId: currentTabId,
        rootId: latestState?.rootId,
        stageId: latestState?.stageId,
      });
    } catch {
      // Best effort
    }
    return;
  }

  // A durable interrupted record owns its own source text, language, and
  // Force flag.  The descriptor is the only provenance the popup forwards.
  const descriptor = translateRetryDescriptor();
  if (descriptor) {
    viewGeneration += 1;
    const view = captureView();
    tl2Translate.disabled = true;
    setTl2Progress('Retrying translation...');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'transform:retry',
        tabId: currentTabId,
        descriptor,
      });
      // A newer event or command owns the view now; this response is stale.
      if (!viewOwns(view)) return;
      if (!response?.ok) setTl2Progress(response?.error || 'Retry failed.');
    } catch (e) {
      if (!viewOwns(view)) return;
      setTl2Progress(e.message || 'Retry failed.');
    }
    // Every stale continuation returned above, so the view is still ours.
    applyTranslateButtonState();
    return;
  }

  const text = resultEl.value.trim();
  if (!text) {
    setTl2Progress('No transcript text to translate.');
    return;
  }
  const language = tl2Language.value;

  viewGeneration += 1;
  const view = captureView();
  tl2Result.value = '';
  tl2Copy.disabled = tl2Save.disabled = tl2Download.disabled = true;

  try {
    await chrome.runtime.sendMessage({
      type: 'translate:start',
      tabId: currentTabId,
      text,
      language,
    });
  } catch (e) {
    // A newer event or command owns the view now; this failure is stale.
    if (!viewOwns(view)) return;
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

function translateRetryDescriptor() {
  const retry = latestState?.translate?.retry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return null;
  // The worker routes `legacy` descriptors to the format stage, so only a
  // record descriptor is a valid translation retry.
  if (retry.kind !== 'record') return null;
  if (typeof retry.rootId !== 'string' || typeof retry.stageId !== 'string') return null;
  return retry;
}

// Derive the translation button label from reconciled state, never from a
// previous label or a stale local guess.
function applyTranslateButtonState() {
  const translate = latestState?.translate || {};
  if (translate.active) {
    tl2Translate.textContent = 'Stop';
    tl2Translate.classList.add('danger');
  } else {
    tl2Translate.textContent = translateRetryDescriptor() ? 'Retry' : 'Translate';
    tl2Translate.classList.remove('danger');
  }
  updateTranslationButtons();
}

function updateTranslationButtons() {
  const hasSource = resultEl.value.trim().length > 0;
  const hasResult = tl2Result.value.trim().length > 0;
  const isActive = tl2Translate.textContent === 'Stop';
  const canRetry = Boolean(translateRetryDescriptor());
  tl2Translate.disabled = isActive ? false : !(hasSource || canRetry);
  tl2Copy.disabled = isActive || !hasResult;
  tl2Save.disabled = isActive || !hasResult;
  tl2Download.disabled = isActive || !hasResult;
}

function updateResultButtons() {
  const hasText = resultEl.value.trim().length > 0;
  copyBtn.disabled = !hasText;
  downloadBtn.disabled = !hasText;
}

// ── Format retry (manual re-trigger of TextKit formatting) ─────
async function retryFormat() {
  if (!currentTabId) return;
  const descriptor = latestState?.format?.retry;
  if (!descriptor || typeof descriptor !== 'object') {
    formatRetryStatus.textContent = 'No saved formatting operation is available.';
    return;
  }
  viewGeneration += 1;
  const view = captureView();
  formatRetryBtn.disabled = true;
  formatRetryStatus.textContent = 'Formatting...';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'transform:retry',
      tabId: currentTabId,
      descriptor,
    });
    // A newer event or command owns the view now; this response is stale.
    if (!viewOwns(view)) return;
    if (response?.ok) {
      formatRetryRow.classList.add('hidden');
    } else {
      formatRetryStatus.textContent = response?.error || 'Retry failed.';
    }
  } catch (e) {
    if (!viewOwns(view)) return;
    formatRetryStatus.textContent = e.message || 'Retry failed.';
  } finally {
    if (viewOwns(view)) formatRetryBtn.disabled = false;
  }
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
  if (!userEditedResult) {
    resultEl.value = latestState.transcript || '';
  }

  // Buttons
  startBtn.disabled = isActive;
  forceCheckbox.disabled = isActive;
  stopBtn.classList.toggle('hidden', !isActive);

  // ── Format tab state (unified flow) ──
  // Render the complete snapshot: an empty result, status, or descriptor in
  // the newer state must clear whatever the previous root left on screen.
  const formatState = state.format && typeof state.format === 'object' ? state.format : {};
  const formatText = typeof formatState.resultText === 'string' ? formatState.resultText : '';
  formatResult.value = formatText;
  setFormatStatus(formatState.status || '');

  if (formatState.active) {
    formatBtn.textContent = 'Stop';
    formatBtn.classList.add('danger');
  } else {
    resetFormatButton();
  }

  // Show the retry row whenever reconciliation supplies a durable
  // operation descriptor. The background owns source-text recovery.
  if (formatState.retry && !formatState.active) {
    formatRetryRow.classList.remove('hidden');
    formatRetryStatus.textContent = formatState.error || 'Formatting can be retried.';
  } else {
    formatRetryRow.classList.add('hidden');
    formatRetryStatus.textContent = '';
  }
  // The retry control follows the rendered snapshot, never a previous command.
  formatRetryBtn.disabled = false;

  // ── Translate tab state ──
  const translateState = state.translate && typeof state.translate === 'object'
    ? state.translate
    : {};
  const translateText = typeof translateState.resultText === 'string'
    ? translateState.resultText
    : '';
  if (!tlUserEdited) tl2Result.value = translateText;
  if (translateState.error) {
    setTl2Progress(translateState.error);
  } else {
    setTl2Progress(translateState.status || '');
  }

  renderedTabId = currentTabId;
  updateResultButtons();
  applyTranslateButtonState();
  updateFormatButtons();
}
