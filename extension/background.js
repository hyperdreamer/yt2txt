importScripts('operation_ownership.js', 'storage_queue.js');

// ── Constants ────────────────────────────────────────────────────
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8666;
const DEFAULT_TEXTKIT_PORT = 8765;
const FILE_BRIDGE_DEFAULT_PORT = 8964;
const BACKEND_TIMEOUT_MS = 12 * 60 * 1000;
const TRANSCRIPT_TIMEOUT_MS = 120 * 60 * 1000; // keepalive protects long extraction
const LOCAL_BACKEND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SUPPORTED_TRANSLATION_LANGUAGES = new Set([
  'Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish',
]);

function formatTimeoutMessage(ms) {
  return `Request timed out after ${Math.round(ms / 60000)} minutes.`;
}

function sanitizeError(error, fallback) {
  const message = error && error.message ? error.message : String(error || '');
  return message.trim() || fallback;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ── Backend URL cache ───────────────────────────────────────────
let _yt2txtBaseUrl = null;
let _yt2txtBaseUrlExpiry = 0;
let _textkitBaseUrl = null;
let _textkitBaseUrlExpiry = 0;
let _fileBridgeBaseUrl = null;
let _fileBridgeBaseUrlExpiry = 0;

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

async function getFileBridgeEndpoint(path) {
  if (!_fileBridgeBaseUrl || Date.now() > _fileBridgeBaseUrlExpiry) {
    const items = await chrome.storage.sync.get({
      fileBridgeHost: '',
      fileBridgePort: FILE_BRIDGE_DEFAULT_PORT,
    });
    const configuredHost = String(items.fileBridgeHost || '').trim();
    const host = configuredHost ? items.fileBridgeHost : DEFAULT_HOST;
    const port = items.fileBridgePort || FILE_BRIDGE_DEFAULT_PORT;
    _fileBridgeBaseUrl = buildBackendEndpoint(host, port, '');
    _fileBridgeBaseUrlExpiry = Date.now() + 60_000;
  }
  return _fileBridgeBaseUrl + path;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.yt2txtHost || changes.yt2txtPort) {
    _yt2txtBaseUrl = null;
    _yt2txtBaseUrlExpiry = 0;
  }
  if (changes.textkitHost || changes.textkitPort) {
    _textkitBaseUrl = null;
    _textkitBaseUrlExpiry = 0;
  }
  if (changes.fileBridgeHost || changes.fileBridgePort) {
    _fileBridgeBaseUrl = null;
    _fileBridgeBaseUrlExpiry = 0;
  }
});

const getBackendEndpoint = getYt2txtEndpoint;

function buildBackendEndpoint(host, port, path) {
  const normalized = normalizeBackendSettings(host, port);
  return `http://${normalized.host}:${normalized.port}${path}`;
}

function normalizeBackendSettings(host, port) {
  let normalizedHost = String(host || DEFAULT_HOST).trim();
  if (/^https?:\/\//i.test(normalizedHost)) normalizedHost = new URL(normalizedHost).hostname;
  normalizedHost = normalizedHost.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!LOCAL_BACKEND_HOSTS.has(normalizedHost)) {
    throw new Error('Backend host must be localhost, 127.0.0.1, or ::1.');
  }
  const normalizedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('Backend port must be between 1 and 65535.');
  }
  return {
    host: normalizedHost === '::1' ? '[::1]' : normalizedHost,
    port: normalizedPort,
  };
}

// ── Operation ownership and queued persistence ─────────────────
const operationOwnership = createOperationOwnership();
const storageQueue = createStorageQueue(chrome.storage.local);
const activeRoots = new Map();
const closedTabs = new Set();
// Starts capture this clock before their first await, even before the tab is known.
let acceptanceClock = 0;
const acceptanceChanges = new Map();

function fenceStarts(tabId) {
  acceptanceChanges.set(tabId, ++acceptanceClock);
}

function canAcceptStart(tabId, acceptance) {
  return (acceptanceChanges.get(tabId) || 0) <= acceptance;
}

function claimRoot(tabId, details) {
  if (closedTabs.has(tabId)) return null;
  const root = operationOwnership.claimRoot(tabId, details);
  if (!root) return null;
  fenceStarts(tabId);
  activeRoots.set(tabId, root);
  // The new stage is registered synchronously by the caller. Keep coverage
  // while removing registrations and display activity belonging to its predecessor.
  abortTabControllers(tabId, false);
  const state = states.get(tabId);
  if (state) {
    if (state.active) Object.assign(state, { active: false, status: 'Idle', progress: 'Ready', error: '' });
    if (state.format?.active) Object.assign(state.format, { active: false, status: '', error: '' });
    if (state.translate?.active) {
      Object.assign(state.translate, { active: false, status: '', error: '' });
      chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    }
    Object.assign(state, {
      rootId: root.rootId,
      stageId: null,
      sourceUrl: root.url || '',
      force: root.force === true,
      stopRequested: false,
    });
  }
  return root;
}

function currentRoot(tabId) {
  return activeRoots.get(tabId) || null;
}

function isCurrent(context) {
  return Boolean(context && operationOwnership.isCurrent(context));
}

function operationKey(tabId) {
  return `transform:operation:${tabId}`;
}

function transcriptKey(tabId) {
  return `transcript:${tabId}`;
}

function transcriptRawKey(tabId) {
  return `transcript_raw:${tabId}`;
}

function transcriptForceKey(tabId) {
  return `transcript_force:${tabId}`;
}

function transcriptRecoveryKey(tabId) {
  return `transcript_recovery:${tabId}`;
}

function translationActivityKey(tabId) {
  return `tl2Translating:${tabId}`;
}

function formatResultKey(tabId) {
  return `fmtResult:${tabId}`;
}

function translationResultKey(tabId) {
  return `translate:result:${tabId}`;
}

function makeOperationRecord(context, stage, sourceText, sourceUrl, sourceKind, language, status, error) {
  return {
    version: 1,
    rootId: context.rootId,
    stageId: context.stageId,
    tabId: context.tabId,
    stage,
    status,
    sourceText,
    sourceUrl,
    sourceKind,
    language,
    force: context.force === true,
    error: error || '',
  };
}

function makeRecoveryMarker(context, terminal = 'available') {
  return { version: 1, rootId: context.rootId, terminal };
}

function validRecoveryMarker(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 3 && value.version === 1 &&
    isNonEmptyString(value.rootId) &&
    (value.terminal === 'available' || value.terminal === 'stopped' || value.terminal === 'completed'));
}

function registerStage(map, contextMap, context) {
  map.set(context.tabId, context.controller);
  contextMap.set(context.tabId, context);
  syncKeepAlive();
}

function releaseStageContext(map, contextMap, context) {
  if (!context) return;
  operationOwnership.releaseStage(context);
  if (contextMap.get(context.tabId) === context) contextMap.delete(context.tabId);
  if (map.get(context.tabId) === context.controller) map.delete(context.tabId);
  syncKeepAlive();
}

function stageForRoot(root, stage, map, contextMap) {
  const context = operationOwnership.claimStage(root, stage);
  if (context) registerStage(map, contextMap, context);
  return context;
}

async function queueOwnedTransaction(tabId, spec, context) {
  const result = await storageQueue.transact(tabId, {
    ...spec,
    owner: () => isCurrent(context),
  });
  if (!isCurrent(context)) return { status: 'superseded' };
  if (result.status !== 'committed') {
    throw Object.assign(new Error('Unable to persist operation storage.'), { code: 'STORAGE_PUBLICATION' });
  }
  return result;
}

async function queueCleanup(tabId, token, keys) {
  const recoveryKey = transcriptRecoveryKey(tabId);
  return storageQueue.transact(tabId, {
    keys: [...keys, recoveryKey],
    set: { [recoveryKey]: { version: 1, rootId: token.rootId, terminal: 'stopped' } },
    remove: keys,
    cleanup: { token, rootId: token.rootId },
  });
}

// ── Per-tab state ───────────────────────────────────────────────
let states = new Map();
let lastActiveTabId = null;

function createState() {
  return {
    active: false,
    status: 'Idle',
    progress: 'Ready',
    transcript: '',
    error: '',
    stopRequested: false,
    rootId: null,
    stageId: null,
    sourceUrl: '',
    force: false,
    format: {
      sourceText: '',
      sourceUrl: '',
      sourceKind: '',
      force: false,
      resultText: '',
      active: false,
      status: '',
      error: '',
      retry: null,
    },
    translate: {
      sourceText: '',
      sourceUrl: '',
      sourceKind: '',
      force: false,
      targetLanguage: 'zh',
      resultText: '',
      active: false,
      status: '',
      error: '',
      retry: null,
    },
  };
}

function getState(tabId) {
  if (!states.has(tabId)) states.set(tabId, createState());
  return states.get(tabId);
}

function broadcastState(tabId, context) {
  if (context && !isCurrent(context)) return false;
  const state = states.get(tabId);
  if (!state) return false;
  chrome.runtime.sendMessage({
    type: 'state:update',
    tabId,
    state,
  }).catch(() => {});
  return true;
}

function updateState(tabId, partial, context) {
  if (context && !isCurrent(context)) return false;
  const state = states.get(tabId);
  if (!state) return false;
  Object.assign(state, partial);
  broadcastState(tabId, context);
  return true;
}

function updateStageState(tabId, stage, partial, context) {
  if (context && !isCurrent(context)) return false;
  const state = states.get(tabId);
  if (!state || !state[stage]) return false;
  Object.assign(state[stage], partial);
  if (context) {
    state.rootId = context.rootId;
    state.stageId = context.stageId;
  }
  broadcastState(tabId, context);
  return true;
}

function resetState(tabId) {
  const state = states.get(tabId);
  if (!state) return false;
  Object.assign(state, {
    active: false,
    status: 'Idle',
    progress: 'Ready',
    error: '',
    stopRequested: false,
  });
  return broadcastState(tabId);
}

function validateOperationRecord(value, tabId, currentUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['version', 'rootId', 'stageId', 'tabId', 'stage', 'status', 'sourceText',
    'sourceUrl', 'sourceKind', 'language', 'force', 'error'];
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) return null;
  if (value.version !== 1 || !Number.isInteger(value.tabId) || value.tabId !== tabId) return null;
  if (!isNonEmptyString(value.rootId) || !isNonEmptyString(value.stageId)) return null;
  if (value.stage !== 'format' && value.stage !== 'translate') return null;
  if (value.status !== 'running' && value.status !== 'failed') return null;
  if (!isNonEmptyString(value.sourceText)) return null;
  if (typeof value.sourceUrl !== 'string' || value.sourceUrl !== currentUrl) return null;
  if (value.sourceKind !== 'transcript' && value.sourceKind !== 'format' && value.sourceKind !== 'standalone') return null;
  if (typeof value.force !== 'boolean' || typeof value.error !== 'string') return null;
  if (value.status === 'failed' && !isNonEmptyString(value.error)) return null;
  if (value.stage === 'format') return value.language === null ? value : null;
  return validateLanguage(value.language) ? value : null;
}

function retryDescriptorFor(record) {
  return { kind: 'record', rootId: record.rootId, stageId: record.stageId };
}

function applyPersistedResults(state, stored, tabId, currentUrl) {
  const transcript = stored[transcriptKey(tabId)];
  const transcriptMatches = transcript && typeof transcript === 'object' &&
    typeof transcript.url === 'string' && transcript.url === currentUrl;
  const raw = stored[transcriptRawKey(tabId)];
  if (transcriptMatches) state.transcript = isNonEmptyString(raw) ? raw : (transcript.text || '');
  if (typeof stored[formatResultKey(tabId)] === 'string') {
    state.format.resultText = stored[formatResultKey(tabId)];
  }
  if (typeof stored[translationResultKey(tabId)] === 'string') {
    state.translate.resultText = stored[translationResultKey(tabId)];
  }
}

function applyRecordState(state, record, interrupted = false) {
  const stageState = state[record.stage];
  const message = interrupted ? 'Interrupted after worker restart.' : record.error;
  state.active = false;
  state.status = 'Idle';
  state.progress = message || 'Ready';
  state.error = '';
  state.stopRequested = false;
  state.rootId = record.rootId;
  state.stageId = record.stageId;
  state.sourceUrl = record.sourceUrl;
  state.force = record.force;
  Object.assign(stageState, {
    sourceText: record.sourceText,
    sourceUrl: record.sourceUrl,
    sourceKind: record.sourceKind,
    force: record.force,
    active: false,
    status: message || (record.stage === 'format' ? 'Formatting failed.' : 'Translation failed.'),
    error: message,
    retry: retryDescriptorFor(record),
  });
  if (record.stage === 'translate') stageState.targetLanguage = record.language;
  const otherStage = record.stage === 'format' ? 'translate' : 'format';
  state[otherStage].active = false;
  state[otherStage].retry = null;
}

function applyLegacyRecoveryState(state, text, sourceUrl, force) {
  state.active = false;
  state.status = 'Idle';
  state.progress = 'Transcript ready to retry formatting.';
  state.error = '';
  state.stopRequested = false;
  state.sourceUrl = sourceUrl;
  state.force = undefined;
  state.format.sourceText = text;
  state.format.sourceUrl = sourceUrl;
  state.format.sourceKind = 'transcript';
  state.format.force = undefined;
  state.format.active = false;
  state.format.status = 'Ready to retry formatting.';
  state.format.error = '';
  state.format.retry = { kind: 'legacy' };
  state.translate.retry = null;
}

function reconcileOwner(tabId, acceptance, rootId) {
  return () => canAcceptStart(tabId, acceptance) && (currentRoot(tabId)?.rootId || null) === rootId;
}

async function reconcileCleanup(tabId, acceptance, rootId, keys, remove) {
  const result = await storageQueue.transact(tabId, {
    keys,
    remove,
    owner: reconcileOwner(tabId, acceptance, rootId),
  });
  if (!canAcceptStart(tabId, acceptance) || result.status !== 'committed') return false;
  return true;
}

async function reconcileInterruptedRecord(tabId, acceptance, rootId, record) {
  const interrupted = {
    ...record,
    status: 'failed',
    error: record.error || 'Interrupted after worker restart.',
  };
  const result = await storageQueue.transact(tabId, {
    keys: [operationKey(tabId)],
    set: { [operationKey(tabId)]: interrupted },
    owner: reconcileOwner(tabId, acceptance, rootId),
  });
  return canAcceptStart(tabId, acceptance) && result.status === 'committed' ? interrupted : record;
}

async function reconcileTabState(tabId, currentUrl, acceptance = acceptanceClock) {
  if (closedTabs.has(tabId)) return states.get(tabId) || createState();
  if (typeof currentUrl !== 'string') currentUrl = await getTabUrl(tabId);
  if (!canAcceptStart(tabId, acceptance)) return states.get(tabId) || createState();

  const keys = [
    operationKey(tabId),
    transcriptRawKey(tabId),
    transcriptForceKey(tabId),
    transcriptKey(tabId),
    transcriptRecoveryKey(tabId),
    formatResultKey(tabId),
    translationResultKey(tabId),
    translationActivityKey(tabId),
  ];
  const stored = await storageQueue.read(tabId, keys);
  if (!canAcceptStart(tabId, acceptance) || closedTabs.has(tabId)) {
    return states.get(tabId) || createState();
  }

  const operationName = operationKey(tabId);
  const recoveryName = transcriptRecoveryKey(tabId);
  const activityName = translationActivityKey(tabId);
  const recordPresent = Object.hasOwn(stored, operationName);
  const markerPresent = Object.hasOwn(stored, recoveryName);
  const marker = markerPresent ? stored[recoveryName] : null;
  const markerValid = validRecoveryMarker(marker);
  const record = validateOperationRecord(stored[operationName], tabId, currentUrl);
  const current = currentRoot(tabId);
  const liveStage = record?.stage === 'format' ? formatContexts.get(tabId)
    : record?.stage === 'translate' ? translateContexts.get(tabId) : null;
  const liveRecord = Boolean(record && current && liveStage &&
    current.rootId === record.rootId && liveStage.rootId === record.rootId &&
    liveStage.stageId === record.stageId && isCurrent(liveStage));
  const liveTranscript = Boolean(current && transcriptContexts.get(tabId) &&
    isCurrent(transcriptContexts.get(tabId)));
  const observedRootId = current?.rootId || null;

  const terminalMatchesRecord = markerValid &&
    (marker.terminal === 'stopped' || marker.terminal === 'completed') &&
    (!current || current.rootId === marker.rootId) &&
    typeof stored[operationName]?.rootId === 'string' &&
    stored[operationName].rootId === marker.rootId;

  let terminalSuppressed = false;
  if (!liveRecord && !liveTranscript && terminalMatchesRecord) {
    const cleaned = await reconcileCleanup(
      tabId,
      acceptance,
      observedRootId,
      [operationName, activityName],
      [operationName, activityName],
    );
    if (!cleaned) return states.get(tabId) || createState();
    terminalSuppressed = true;
  }

  if (liveRecord || liveTranscript) {
    if (!states.has(tabId)) states.set(tabId, createState());
    const state = states.get(tabId);
    applyPersistedResults(state, stored, tabId, currentUrl);
    if (liveRecord) {
      state.rootId = record.rootId;
      state.stageId = record.stageId;
      state.sourceUrl = record.sourceUrl;
      state.force = record.force;
      state[record.stage].retry = null;
    }
    return state;
  }

  let hydratedRecord = terminalSuppressed ? null : record;
  if (hydratedRecord && hydratedRecord.status === 'running') {
    hydratedRecord = await reconcileInterruptedRecord(tabId, acceptance, observedRootId, hydratedRecord);
    if (!canAcceptStart(tabId, acceptance)) return states.get(tabId) || createState();
  }

  if (!states.has(tabId)) states.set(tabId, createState());
  const state = states.get(tabId);
  applyPersistedResults(state, stored, tabId, currentUrl);
  state.format.retry = null;
  state.translate.retry = null;
  state.format.active = false;
  state.translate.active = false;

  if (terminalSuppressed) {
    state.rootId = typeof record?.rootId === 'string' ? record.rootId : marker.rootId;
    state.stageId = typeof record?.stageId === 'string' ? record.stageId : null;
    state.sourceUrl = typeof record?.sourceUrl === 'string' ? record.sourceUrl : currentUrl;
    state.force = record?.force === true;
    return state;
  }

  if (recordPresent && !record) {
    // A malformed or unknown operation is a recovery discriminator. It must
    // never fall through to the older raw transcript path.
    state.rootId = typeof stored[operationName]?.rootId === 'string' ? stored[operationName].rootId : null;
    state.stageId = typeof stored[operationName]?.stageId === 'string' ? stored[operationName].stageId : null;
    if (!current && Object.hasOwn(stored, activityName)) {
      await reconcileCleanup(tabId, acceptance, observedRootId, [activityName], [activityName]);
    }
    return state;
  }

  if (hydratedRecord) {
    if (markerValid && (marker.terminal === 'stopped' || marker.terminal === 'completed') &&
        marker.rootId === hydratedRecord.rootId) {
      if (!current && Object.hasOwn(stored, activityName)) {
        await reconcileCleanup(tabId, acceptance, observedRootId, [activityName], [activityName]);
      }
      state.rootId = hydratedRecord.rootId;
      state.stageId = hydratedRecord.stageId;
      state.sourceUrl = hydratedRecord.sourceUrl;
      state.force = hydratedRecord.force;
      return state;
    }
    applyRecordState(state, hydratedRecord, record?.status === 'running');
    return state;
  }

  const markerAllowsLegacy = !markerPresent || (markerValid && marker.terminal === 'available');
  const transcript = stored[transcriptKey(tabId)];
  const transcriptUrl = transcript && typeof transcript === 'object' ? transcript.url : null;
  const raw = stored[transcriptRawKey(tabId)];
  const formatResult = stored[formatResultKey(tabId)];
  const legacyUrlMatches = typeof transcriptUrl === 'string' && transcriptUrl === currentUrl;
  if (markerAllowsLegacy && legacyUrlMatches && isNonEmptyString(raw) && !isNonEmptyString(formatResult)) {
    applyLegacyRecoveryState(state, raw, transcriptUrl, stored[transcriptForceKey(tabId)] === true);
  }
  if (!current && Object.hasOwn(stored, activityName)) {
    await reconcileCleanup(tabId, acceptance, observedRootId, [activityName], [activityName]);
  }
  return state;
}

// ── Stage controllers and keepalive ─────────────────────────────
const translateControllers = new Map();
const formatControllers = new Map();
const transcriptControllers = new Map();
const translateContexts = new Map();
const formatContexts = new Map();
const transcriptContexts = new Map();
let keepAliveIntervalId = null;
let pendingCleanups = 0;

function retainCleanupCoverage() {
  pendingCleanups++;
  syncKeepAlive();
  return () => {
    pendingCleanups--;
    syncKeepAlive();
  };
}

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

function syncKeepAlive() {
  const hasWork = pendingCleanups > 0 || transcriptControllers.size > 0 || formatControllers.size > 0 || translateControllers.size > 0;
  if (hasWork) startKeepAlive();
  else stopKeepAlive();
}

function abortTabControllers(tabId, resync = true) {
  for (const [map, contextMap] of [
    [transcriptControllers, transcriptContexts],
    [formatControllers, formatContexts],
    [translateControllers, translateContexts],
  ]) {
    const controller = map.get(tabId);
    if (controller) controller.abort();
    map.delete(tabId);
    contextMap.delete(tabId);
  }
  if (resync) syncKeepAlive();
}

// ── Clean up on tab close ───────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const releaseCoverage = retainCleanupCoverage();
  fenceStarts(tabId);
  closedTabs.add(tabId);
  operationOwnership.markClosed(tabId);
  abortTabControllers(tabId);
  states.delete(tabId);
  if (lastActiveTabId === tabId) lastActiveTabId = null;
  activeRoots.delete(tabId);
  try {
    await storageQueue.clear(tabId);
  } catch (error) {
    console.error('Unable to clear closed-tab storage:', error);
  } finally {
    releaseCoverage();
  }
});

// ── Message routing ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'popup:start') {
    handleStart(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Failed to start.') }));
    return true;
  }
  if (message?.type === 'popup:stop') {
    handleStop(message.tabId, message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Failed to stop.') }));
    return true;
  }
  if (message?.type === 'popup:get-state') {
    const acceptance = acceptanceClock;
    getActiveTab()
      .then(async tab => {
        const state = await reconcileTabState(tab.id, tab.url, acceptance);
        if (!canAcceptStart(tab.id, acceptance)) {
          sendResponse({ ok: true, state: states.get(tab.id) || createState(), tabId: tab.id });
          return;
        }
        sendResponse({ ok: true, state, tabId: tab.id });
      })
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'No active tab found.') }));
    return true;
  }
  if (message?.type === 'translate:start') {
    handleTranslateStart(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Translation failed.') }));
    return true;
  }
  if (message?.type === 'translate:stop') {
    handleTranslateStop(message.tabId, message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Failed to stop translation.') }));
    return true;
  }
  if (message?.type === 'format:start') {
    handleFormatStart(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Formatting failed.') }));
    return true;
  }
  if (message?.type === 'format:stop') {
    handleFormatStop(message.tabId, message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Failed to stop formatting.') }));
    return true;
  }
  if (message?.type === 'transform:retry') {
    handleTransformRetry(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Retry failed.') }));
    return true;
  }
  if (message?.type === 'save:translation') {
    handleSaveTranslation(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: sanitizeError(error, 'Save failed.') }));
    return true;
  }
  return false;
});

// ── Keyboard shortcut ───────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'get-transcript') return;
  const acceptance = acceptanceClock;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) return;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) return;
    await handleStart({ url: tab.url }, acceptance);
  } catch (error) {
    console.error('Command handler failed:', error);
  }
});

// ── Tab and fetch helpers ───────────────────────────────────────
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  lastActiveTabId = tab.id;
  return tab;
}

async function getTabUrl(tabId, suppliedUrl) {
  if (typeof suppliedUrl === 'string') return suppliedUrl;
  if (chrome.tabs.get) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) return tab.url;
    } catch {}
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === tabId && typeof tab.url === 'string') return tab.url;
  } catch {}
  return '';
}

async function fetchWithTimeout(url, options = {}, signal) {
  if (signal) return fetch(url, { ...options, signal });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function transcriptBody(context) {
  const body = { url: context.url };
  if (context.force === true) body.force = true;
  return body;
}

function formatBody(context, text) {
  const body = { text };
  if (context.force === true) body.force = true;
  return body;
}

function translateBody(context, text, language) {
  const body = { text, language };
  if (context.force === true) body.force = true;
  return body;
}

function parseJsonResponse(response) {
  return response.json().catch(() => ({}));
}

function responseError(payload, response, fallback) {
  return payload?.error || payload?.detail || `HTTP ${response.status}` || fallback;
}

function validateLanguage(language) {
  return SUPPORTED_TRANSLATION_LANGUAGES.has(language);
}

// ── Handle transcript start ─────────────────────────────────────
async function handleStart(msg, acceptance = acceptanceClock) {
  if (!isNonEmptyString(msg?.url)) return { ok: false, error: 'URL is required.' };
  const tab = await getActiveTab();
  if (!canAcceptStart(tab.id, acceptance)) return { ok: false, error: 'Start was cancelled or superseded.' };
  const url = msg.url.trim();
  const state = states.get(tab.id);
  if (state?.active || transcriptControllers.has(tab.id)) {
    return { ok: false, error: 'A transcript extraction is already in progress.' };
  }

  const root = claimRoot(tab.id, { url, force: msg.force === true });
  if (!root) return { ok: false, error: 'The tab is no longer available.' };
  const context = stageForRoot(root, 'transcript', transcriptControllers, transcriptContexts);
  if (!context) return { ok: false, error: 'Unable to claim transcript operation.' };
  getState(tab.id);

  updateState(tab.id, {
    active: true,
    status: 'Processing',
    progress: 'Checking for subtitles...',
    error: '',
    stopRequested: false,
    rootId: context.rootId,
    stageId: context.stageId,
  }, context);

  let timeoutId = null;
  let timedOut = false;
  let accepted = false;
  let formatContext = null;
  let resultText = '';
  const ownsTimeout = () => timedOut && isCurrent(root) && transcriptContexts.get(tab.id) === context;
  const transcriptIsRunning = () => {
    if (ownsTimeout()) throw new Error(formatTimeoutMessage(TRANSCRIPT_TIMEOUT_MS));
    return isCurrent(context);
  };
  try {
    timeoutId = setTimeout(() => {
      timedOut = true;
      context.controller.abort();
    }, TRANSCRIPT_TIMEOUT_MS);

    const endpoint = await getYt2txtEndpoint('/transcript');
    if (!transcriptIsRunning()) return { ok: true };
    updateState(tab.id, { progress: 'Sending request to backend...' }, context);

    const response = await fetchWithTimeout(
      `${endpoint}?_=${Date.now()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transcriptBody(context)),
      },
      context.signal,
    );
    if (!transcriptIsRunning()) return { ok: true };
    const payload = await parseJsonResponse(response);
    if (!transcriptIsRunning()) return { ok: true };
    if (!response.ok) throw new Error(responseError(payload, response, 'Transcript failed.'));
    if (payload.error) throw new Error(payload.error);
    resultText = typeof payload.text === 'string' ? payload.text : '';
    if (!resultText) throw new Error('Transcript response was empty.');
    if (!transcriptIsRunning()) return { ok: true };
    clearTimeout(timeoutId);
    timeoutId = null;

    formatContext = stageForRoot(root, 'format', formatControllers, formatContexts);
    if (!formatContext || !isCurrent(context)) return { ok: true };
    const record = makeOperationRecord(
      formatContext,
      'format',
      resultText,
      url,
      'transcript',
      null,
      'running',
      '',
    );
    const transcriptStorage = await queueOwnedTransaction(tab.id, {
      keys: [
        transcriptKey(tab.id),
        transcriptRawKey(tab.id),
        transcriptForceKey(tab.id),
        transcriptRecoveryKey(tab.id),
        operationKey(tab.id),
        formatResultKey(tab.id),
        translationResultKey(tab.id),
        translationActivityKey(tab.id),
      ],
      set: {
        [transcriptKey(tab.id)]: { text: resultText, url },
        [transcriptRawKey(tab.id)]: resultText,
        [transcriptForceKey(tab.id)]: context.force === true,
        [transcriptRecoveryKey(tab.id)]: makeRecoveryMarker(formatContext),
        [operationKey(tab.id)]: record,
      },
      remove: [formatResultKey(tab.id), translationResultKey(tab.id), translationActivityKey(tab.id)],
    }, formatContext);
    if (transcriptStorage.status !== 'committed' || !isCurrent(formatContext)) return { ok: true };

    accepted = true;
    releaseStageContext(transcriptControllers, transcriptContexts, context);
    const display = states.get(tab.id);
    for (const stage of ['format', 'translate']) {
      Object.assign(display[stage], { sourceText: '', resultText: '', active: false, status: '', error: '' });
    }
    updateState(tab.id, {
      active: false,
      status: 'Complete',
      progress: `Transcript ready (source: ${payload.source || 'unknown'}).`,
      transcript: resultText,
      error: '',
      stopRequested: false,
      rootId: formatContext.rootId,
      stageId: formatContext.stageId,
    }, formatContext);

    await runFormat(formatContext, {
      text: resultText,
      sourceKind: 'transcript',
      recordPublished: true,
    });
    return { ok: true };
  } catch (error) {
    const terminalContext = ownsTimeout() ? root : context;
    if (!isCurrent(terminalContext)) return { ok: true };
    const errorMessage = timedOut
      ? formatTimeoutMessage(TRANSCRIPT_TIMEOUT_MS)
      : isAbortError(error) ? 'Stopped by user.' : sanitizeError(error, 'Unknown error');
    updateState(tab.id, {
      active: false,
      status: 'Error',
      progress: errorMessage,
      error: errorMessage,
      stopRequested: false,
    }, terminalContext);
    if (error?.code === 'STORAGE_PUBLICATION') return { ok: false, error: errorMessage };
    return { ok: true };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (!accepted) {
      releaseStageContext(formatControllers, formatContexts, formatContext);
      releaseStageContext(transcriptControllers, transcriptContexts, context);
    }
    syncKeepAlive();
  }
}

// ── Stop and durable cleanup ────────────────────────────────────
function stopDescriptor(message) {
  if (!message || typeof message !== 'object') return null;
  if (!isNonEmptyString(message.rootId) || !isNonEmptyString(message.stageId)) return null;
  return { rootId: message.rootId, stageId: message.stageId };
}

function stopTarget(tabId, kind, descriptor) {
  const context = kind === 'format' ? formatContexts.get(tabId)
    : kind === 'translate' ? translateContexts.get(tabId)
      : transcriptContexts.get(tabId);
  if (!descriptor) return context || currentRoot(tabId);
  if (!context) return null;
  return context.rootId === descriptor.rootId &&
    (kind === 'transcript' || context.stageId === descriptor.stageId) ? context : null;
}

async function stopTab(tabId, kind, descriptor = null) {
  const target = stopTarget(tabId, kind, descriptor);
  if (descriptor && !target) return { ok: true };
  const state = states.get(tabId);
  const hadWork = Boolean(
    transcriptControllers.has(tabId) ||
    formatControllers.has(tabId) ||
    translateControllers.has(tabId) ||
    state?.active ||
    state?.format?.active ||
    state?.translate?.active
  );
  const releaseCoverage = retainCleanupCoverage();
  fenceStarts(tabId);
  const token = operationOwnership.invalidate(tabId, 'stop');
  activeRoots.delete(tabId);
  abortTabControllers(tabId);
  if (state && hadWork) {
    state.stopRequested = true;
    state.active = false;
    state.status = 'Error';
    state.progress = 'Stopped by user.';
    state.error = 'Stopped by user.';
    if (state.format?.active) {
      state.format.active = false;
      state.format.status = 'Formatting stopped.';
      state.format.error = '';
    }
    if (state.translate?.active) {
      state.translate.active = false;
      state.translate.status = 'Translation stopped.';
      state.translate.error = '';
    }
    if (kind === 'translate' && state.translate) {
      state.translate.active = false;
      state.translate.status = 'Translation stopped.';
    }
    if (kind === 'format' && state.format) {
      state.format.active = false;
      state.format.status = 'Formatting stopped.';
    }
    broadcastState(tabId);
  }

  try {
    const cleanup = await queueCleanup(tabId, token, [operationKey(tabId), translationActivityKey(tabId)]);
    if (cleanup.status !== 'cleanup-applied' || !token.isCurrent()) {
      return { ok: false, error: 'Unable to persist Stop cleanup.' };
    }
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    return { ok: true };
  } catch {
    return { ok: false, error: 'Unable to persist Stop cleanup.' };
  } finally {
    releaseCoverage();
  }
}

function handleStop(tabId, message) {
  const knownTabId = tabId ?? lastActiveTabId;
  const descriptor = stopDescriptor(message);
  if (knownTabId !== null && knownTabId !== undefined) return stopTab(knownTabId, 'transcript', descriptor);
  return getActiveTab().then(tab => stopTab(tab.id, 'transcript', descriptor));
}

function handleTranslateStop(tabId, message) {
  return stopTab(tabId, 'translate', stopDescriptor(message));
}

function handleFormatStop(tabId, message) {
  return stopTab(tabId, 'format', stopDescriptor(message));
}

// ── Format operation ────────────────────────────────────────────
async function persistRunningOperation(context, record, includeActivity) {
  const recoveryKey = transcriptRecoveryKey(context.tabId);
  const keys = [operationKey(context.tabId), translationActivityKey(context.tabId), recoveryKey];
  const set = {
    [operationKey(context.tabId)]: record,
    [recoveryKey]: makeRecoveryMarker(context),
  };
  const remove = [];
  if (includeActivity) set[translationActivityKey(context.tabId)] = true;
  else remove.push(translationActivityKey(context.tabId));
  const result = await queueOwnedTransaction(context.tabId, { keys, set, remove }, context);
  return result.status === 'committed';
}

async function persistFailedOperation(context, record, includeActivity) {
  const recoveryKey = transcriptRecoveryKey(context.tabId);
  const keys = [operationKey(context.tabId), recoveryKey];
  const set = {
    [operationKey(context.tabId)]: record,
    [recoveryKey]: makeRecoveryMarker(context),
  };
  const remove = [];
  if (includeActivity) {
    keys.push(translationActivityKey(context.tabId));
    remove.push(translationActivityKey(context.tabId));
  }
  const result = await queueOwnedTransaction(context.tabId, { keys, set, remove }, context);
  return result.status === 'committed';
}

async function completeOperation(context) {
  const recoveryKey = transcriptRecoveryKey(context.tabId);
  const activityKey = translationActivityKey(context.tabId);
  const result = await queueOwnedTransaction(context.tabId, {
    keys: [operationKey(context.tabId), activityKey, recoveryKey],
    set: { [recoveryKey]: makeRecoveryMarker(context, 'completed') },
    remove: [operationKey(context.tabId), activityKey],
  }, context);
  return result.status === 'committed';
}

const removeOperation = completeOperation;

async function runFormat(context, details) {
  const { text, sourceKind, recordPublished = false } = details;
  const tabId = context.tabId;
  const operationRecord = makeOperationRecord(
    context,
    'format',
    text,
    context.url,
    sourceKind,
    null,
    'running',
    '',
  );
  updateStageState(tabId, 'format', {
    sourceText: text,
    sourceUrl: context.url,
    sourceKind,
    force: context.force === true,
    retry: null,
    active: true,
    status: 'Formatting...',
    error: '',
  }, context);

  try {
    if (!recordPublished) {
      if (!await persistRunningOperation(context, operationRecord, false)) {
        if (!isCurrent(context)) return { ok: true };
        throw new Error('Unable to persist formatting operation.');
      }
    }
    if (!isCurrent(context)) return { ok: true };

    const endpoint = await getTextkitEndpoint('/format');
    if (!isCurrent(context)) return { ok: true };
    const response = await fetch(
      `${endpoint}?_=${Date.now()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formatBody(context, text)),
        signal: context.signal,
      },
    );
    if (!isCurrent(context)) return { ok: true };
    const payload = await parseJsonResponse(response);
    if (!isCurrent(context)) return { ok: true };
    if (!response.ok) throw new Error(responseError(payload, response, 'Formatting failed.'));
    if (payload.error) throw new Error(payload.error);
    const formatted = typeof payload.text === 'string' ? payload.text : '';
    if (!isCurrent(context)) return { ok: true };

    const persisted = await queueOwnedTransaction(tabId, {
      keys: [formatResultKey(tabId)],
      set: { [formatResultKey(tabId)]: formatted },
    }, context);
    if (persisted.status !== 'committed' || !isCurrent(context)) return { ok: true };
    updateStageState(tabId, 'format', {
      resultText: formatted,
      status: 'Formatted',
      error: '',
      active: false,
    }, context);

    if (formatted) {
      await fmtAutoCopyIfEnabled(formatted, context);
      if (!isCurrent(context)) return { ok: true };
      await fmtAutoSaveIfEnabled(tabId, formatted, context);
      if (!isCurrent(context)) return { ok: true };
    }

    const handoff = formatted ? await autoTranslate(tabId, formatted, context) : null;
    if (handoff?.stale || !isCurrent(context)) return { ok: true };
    if (!handoff) {
      if (!await completeOperation(context)) return { ok: true };
    }
    return { ok: true };
  } catch (error) {
    if (!isCurrent(context)) return { ok: true };
    let errorMessage = isAbortError(error) ? 'Formatting stopped.' : sanitizeError(error, 'Formatting failed.');
    const failedRecord = makeOperationRecord(
      context,
      'format',
      text,
      context.url,
      sourceKind,
      null,
      'failed',
      errorMessage,
    );
    try {
      await persistFailedOperation(context, failedRecord, false);
    } catch {
      errorMessage = `Unable to persist formatting failure. ${errorMessage}`;
    }
    if (!isCurrent(context)) return { ok: true };
    updateStageState(tabId, 'format', {
      active: false,
      status: errorMessage,
      error: errorMessage,
      retry: retryDescriptorFor(operationRecord),
    }, context);
    return { ok: false, error: errorMessage };
  } finally {
    releaseStageContext(formatControllers, formatContexts, context);
  }
}

async function handleFormatStart(msg, acceptance = acceptanceClock, inheritedForce = false) {
  const tabId = msg?.tabId;
  const text = msg?.text;
  if (!tabId || !isNonEmptyString(text)) return { ok: false, error: 'Missing tabId or text' };
  const url = await getTabUrl(tabId, msg.url);
  if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Start was cancelled or superseded.' };
  const root = claimRoot(tabId, { url, force: inheritedForce === true });
  if (!root) return { ok: false, error: 'The tab is no longer available.' };
  const context = stageForRoot(root, 'format', formatControllers, formatContexts);
  if (!context) return { ok: false, error: 'Unable to claim formatting operation.' };
  getState(tabId);
  return runFormat(context, { text, sourceKind: 'standalone' });
}

// ── Translation operation ───────────────────────────────────────
async function runTranslate(context, details) {
  const { text, language, sourceKind } = details;
  const tabId = context.tabId;
  const operationRecord = language === 'original' ? null : makeOperationRecord(
    context,
    'translate',
    text,
    context.url,
    sourceKind,
    language,
    'running',
    '',
  );
  updateStageState(tabId, 'translate', {
    sourceText: text,
    sourceUrl: context.url,
    sourceKind,
    force: context.force === true,
    retry: null,
    targetLanguage: language,
    active: true,
    status: 'Translating...',
    error: '',
  }, context);

  try {
    if (language === 'original') {
      await queueOwnedTransaction(tabId, {
        keys: [translationActivityKey(tabId)],
        set: { [translationActivityKey(tabId)]: true },
      }, context);
    } else {
      await persistRunningOperation(context, operationRecord, true);
    }
    if (!isCurrent(context)) return { ok: true };
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: true }).catch(() => {});

    let translated = text;
    if (language !== 'original') {
      const endpoint = await getTextkitEndpoint('/translate');
      if (!isCurrent(context)) return { ok: true };
      const response = await fetch(
        `${endpoint}?_=${Date.now()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(translateBody(context, text, language)),
          signal: context.signal,
        },
      );
      if (!isCurrent(context)) return { ok: true };
      const payload = await parseJsonResponse(response);
      if (!isCurrent(context)) return { ok: true };
      if (!response.ok) throw new Error(responseError(payload, response, 'Translation failed.'));
      if (payload.error) throw new Error(payload.error);
      translated = typeof payload.text === 'string' ? payload.text : '';
    }
    if (!isCurrent(context)) return { ok: true };

    await queueOwnedTransaction(tabId, {
      keys: [translationResultKey(tabId), translationActivityKey(tabId)],
      set: { [translationResultKey(tabId)]: translated },
      remove: [translationActivityKey(tabId)],
    }, context);
    if (!isCurrent(context)) return { ok: true };
    updateStageState(tabId, 'translate', {
      resultText: translated,
      status: 'Translation complete.',
      active: false,
      error: '',
    }, context);
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: translated }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    if (translated) {
      await autoCopyIfEnabled(translated, context);
      if (!isCurrent(context)) return { ok: true };
      await autoSaveIfEnabled(translated, context);
      if (!isCurrent(context)) return { ok: true };
    }
    if (!await completeOperation(context)) return { ok: true };
    return { ok: true };
  } catch (error) {
    if (!isCurrent(context)) return { ok: true };
    let errorMessage = isAbortError(error) ? 'Translation stopped.' : sanitizeError(error, 'Translation failed.');
    try {
      if (language === 'original') {
        await queueOwnedTransaction(tabId, {
          keys: [operationKey(tabId), translationActivityKey(tabId)],
          remove: [operationKey(tabId), translationActivityKey(tabId)],
        }, context);
      } else {
        const failedRecord = makeOperationRecord(
          context,
          'translate',
          text,
          context.url,
          sourceKind,
          language,
          'failed',
          errorMessage,
        );
        await persistFailedOperation(context, failedRecord, true);
      }
    } catch {
      errorMessage = `Unable to persist translation failure. ${errorMessage}`;
    }
    if (!isCurrent(context)) return { ok: true };
    updateStageState(tabId, 'translate', {
      active: false,
      status: errorMessage,
      error: errorMessage,
      retry: operationRecord ? retryDescriptorFor(operationRecord) : null,
    }, context);
    chrome.runtime.sendMessage({ type: 'translation:update', tabId, text: '', error: errorMessage }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'tl2:translating', tabId, value: false }).catch(() => {});
    return { ok: false, error: errorMessage };
  } finally {
    releaseStageContext(translateControllers, translateContexts, context);
  }
}

async function handleTranslateStart(msg, acceptance = acceptanceClock) {
  const tabId = msg?.tabId;
  const text = msg?.text;
  const language = msg?.language;
  if (!tabId || !isNonEmptyString(text)) return { ok: false, error: 'Missing tabId or text' };
  if (language !== 'original' && !validateLanguage(language)) {
    return { ok: false, error: 'Unsupported translation language.' };
  }
  const url = await getTabUrl(tabId, msg.url);
  if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Start was cancelled or superseded.' };
  const root = claimRoot(tabId, { url, force: false });
  if (!root) return { ok: false, error: 'The tab is no longer available.' };
  const context = stageForRoot(root, 'translate', translateControllers, translateContexts);
  if (!context) return { ok: false, error: 'Unable to claim translation operation.' };
  getState(tabId);
  return runTranslate(context, { text, language, sourceKind: 'standalone' });
}

// ── Clipboard, save, and automatic effects ──────────────────────
let offscreenCopyId = 0;
let pendingOffscreenCopies = 0;

async function copyToClipboard(text, context) {
  if (!text || (context && !isCurrent(context))) return false;
  const copyId = ++offscreenCopyId;
  pendingOffscreenCopies++;
  try {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD', 'DOM_PARSER'],
        justification: 'Clipboard access for auto-copy results',
      });
    } catch {}
    if (copyId !== offscreenCopyId || (context && !isCurrent(context))) return false;
    chrome.runtime.sendMessage({ type: 'offscreen:copy', text }).catch(() => {});
    return true;
  } finally {
    // Resource lifetime is independent of the provider stage. A newer copy
    // reserves the document before awaiting creation and supersedes this timer.
    pendingOffscreenCopies--;
    if (pendingOffscreenCopies === 0) {
      const cleanupId = offscreenCopyId;
      setTimeout(() => {
        if (cleanupId === offscreenCopyId && pendingOffscreenCopies === 0) {
          return chrome.offscreen.closeDocument().catch(() => {});
        }
      }, 2000);
    }
  }
}

async function autoCopyIfEnabled(text, context) {
  if (context && !isCurrent(context)) return false;
  const { tl2AutoCopy } = await chrome.storage.sync.get({ tl2AutoCopy: false });
  if (context && !isCurrent(context)) return false;
  if (!tl2AutoCopy || !text) return false;
  if (!await copyToClipboard(text, context)) return false;
  if (context && !isCurrent(context)) return false;
  chrome.notifications.create('yt2txt-auto-copy', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'YT2TXT - Copied',
    message: 'Translation copied to system clipboard.',
    priority: 0,
  });
  return true;
}

async function autoSaveIfEnabled(text, context) {
  if (context && !isCurrent(context)) return false;
  const settings = await chrome.storage.sync.get({ tl2AutoSave: false, tl2AutoSavePath: '' });
  if (context && !isCurrent(context)) return false;
  if (!settings.tl2AutoSave || !settings.tl2AutoSavePath || !text) return false;
  try {
    const result = await handleSaveTranslation({ text, path: settings.tl2AutoSavePath }, context);
    if (context && !isCurrent(context)) return false;
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('yt2txt-auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT - Saved',
      message: `Translation saved to ${result.path || settings.tl2AutoSavePath}.`,
      priority: 0,
    });
    return true;
  } catch (error) {
    if (context && !isCurrent(context)) return false;
    console.error('Auto-save failed:', error);
    chrome.notifications.create('yt2txt-auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT - Save failed',
      message: sanitizeError(error, 'Save failed.'),
      priority: 1,
    });
    return false;
  }
}

async function fmtAutoCopyIfEnabled(text, context) {
  if (context && !isCurrent(context)) return false;
  const { fmtAutoCopy } = await chrome.storage.sync.get({ fmtAutoCopy: false });
  if (context && !isCurrent(context)) return false;
  if (!fmtAutoCopy || !text) return false;
  if (!await copyToClipboard(text, context)) return false;
  if (context && !isCurrent(context)) return false;
  chrome.notifications.create('yt2txt-fmt-auto-copy', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'YT2TXT - Copied',
    message: 'Formatted text copied to system clipboard.',
    priority: 0,
  });
  return true;
}

async function fmtAutoSaveIfEnabled(tabId, text, context) {
  if (context && !isCurrent(context)) return false;
  const settings = await chrome.storage.sync.get({ fmtAutoSave: false, fmtAutoSavePath: '' });
  if (context && !isCurrent(context)) return false;
  if (!settings.fmtAutoSave || !settings.fmtAutoSavePath || !text) return false;
  try {
    const result = await handleSaveTranslation({ text, path: settings.fmtAutoSavePath }, context);
    if (context && !isCurrent(context)) return false;
    if (!result.ok) throw new Error(result.error || 'Save failed');
    chrome.notifications.create('yt2txt-fmt-auto-save', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT - Saved',
      message: `Formatted text saved to ${result.path || settings.fmtAutoSavePath}.`,
      priority: 0,
    });
    return true;
  } catch (error) {
    if (context && !isCurrent(context)) return false;
    console.error('Auto-save format failed:', error);
    chrome.notifications.create('yt2txt-fmt-auto-save-failed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'YT2TXT - Save failed',
      message: sanitizeError(error, 'Save failed.'),
      priority: 1,
    });
    return false;
  }
}

async function autoTranslate(tabId, text, predecessor) {
  if (!isCurrent(predecessor)) return { stale: true };
  const settings = await chrome.storage.sync.get({
    yt2txtAutoTranslate: false,
    tl2Language: 'original',
  });
  if (!isCurrent(predecessor)) return { stale: true };
  if (!settings.yt2txtAutoTranslate) return null;
  const language = settings.tl2Language || 'original';
  if (language === 'original') return null;
  if (!validateLanguage(language)) return null;

  if (!isCurrent(predecessor)) return { stale: true };
  const root = currentRoot(predecessor.tabId);
  if (!root || !isCurrent(predecessor)) return { stale: true };
  const context = stageForRoot(root, 'translate', translateControllers, translateContexts);
  if (!context || !isCurrent(context)) return { stale: true };
  const promise = runTranslate(context, { text, language, sourceKind: 'format' });
  promise.catch(error => console.error('autoTranslate failed:', error));
  return { context, promise };
}

async function handleSaveTranslation(msg, ownerContext) {
  const { text, path } = msg || {};
  if (!text || !path) return { ok: false, error: 'Missing text or path' };
  if (ownerContext && !isCurrent(ownerContext)) return { ok: false, error: 'Operation superseded.' };
  const endpoint = await getFileBridgeEndpoint('/save');
  if (ownerContext && !isCurrent(ownerContext)) return { ok: false, error: 'Operation superseded.' };
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, path }),
  }, ownerContext?.signal);
  if (ownerContext && !isCurrent(ownerContext)) return { ok: false, error: 'Operation superseded.' };
  let payload = null;
  try {
    const raw = await response.text();
    if (ownerContext && !isCurrent(ownerContext)) return { ok: false, error: 'Operation superseded.' };
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {}
  if (ownerContext && !isCurrent(ownerContext)) return { ok: false, error: 'Operation superseded.' };
  if (!response.ok) {
    return { ok: false, error: (payload && (payload.error || payload.detail)) || `HTTP ${response.status}` };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'File bridge returned an invalid or empty response.' };
  }
  if (payload.ok !== true) {
    return { ok: false, error: payload.error || payload.detail || 'File bridge save was not acknowledged.' };
  }
  return { ok: true, path: payload.path || path };
}

// ── Record retry seam ────────────────────────────────────────────
function validOperationRecord(record, tabId, descriptor, tabUrl) {
  const valid = validateOperationRecord(record, tabId, tabUrl);
  return Boolean(valid && valid.status === 'failed' &&
    valid.rootId === descriptor.rootId && valid.stageId === descriptor.stageId);
}

async function handleTransformRetry(message) {
  const acceptance = acceptanceClock;
  const tabId = message?.tabId;
  const descriptor = message?.descriptor;
  if (!tabId || !descriptor || typeof descriptor !== 'object') {
    return { ok: false, error: 'Invalid retry descriptor.' };
  }
  if (descriptor.kind === 'legacy') {
    const stored = await storageQueue.read(tabId, [
      transcriptRawKey(tabId), transcriptKey(tabId), transcriptForceKey(tabId),
      transcriptRecoveryKey(tabId), formatResultKey(tabId),
    ]);
    if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
    const text = stored[transcriptRawKey(tabId)];
    const transcript = stored[transcriptKey(tabId)];
    const marker = stored[transcriptRecoveryKey(tabId)];
    const markerPresent = Object.hasOwn(stored, transcriptRecoveryKey(tabId));
    const markerAllowsLegacy = !markerPresent || (validRecoveryMarker(marker) && marker.terminal === 'available');
    if (!markerAllowsLegacy || isNonEmptyString(stored[formatResultKey(tabId)])) {
      return { ok: false, error: 'The saved transcript is no longer retryable.' };
    }
    if (!isNonEmptyString(text)) return { ok: false, error: 'No transcript is available to retry.' };
    const url = await getTabUrl(tabId);
    if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
    const savedUrl = transcript && typeof transcript === 'object' ? transcript.url : url;
    if (savedUrl && url && savedUrl !== url) return { ok: false, error: 'Retry source no longer matches this tab.' };
    const latest = await storageQueue.read(tabId, [
      transcriptRawKey(tabId), transcriptKey(tabId), transcriptForceKey(tabId),
      transcriptRecoveryKey(tabId), formatResultKey(tabId),
    ]);
    if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
    if (latest[transcriptRawKey(tabId)] !== text ||
        latest[transcriptKey(tabId)]?.url !== transcript?.url ||
        latest[transcriptForceKey(tabId)] !== stored[transcriptForceKey(tabId)] ||
        JSON.stringify(latest[transcriptRecoveryKey(tabId)]) !== JSON.stringify(marker) ||
        isNonEmptyString(latest[formatResultKey(tabId)])) {
      return { ok: false, error: 'The saved transcript is no longer retryable.' };
    }
    return handleFormatStart(
      { tabId, text, url: savedUrl || url },
      acceptance,
      stored[transcriptForceKey(tabId)] === true,
    );
  }
  if (descriptor.kind !== 'record' || !isNonEmptyString(descriptor.rootId) || !isNonEmptyString(descriptor.stageId)) {
    return { ok: false, error: 'Invalid retry descriptor.' };
  }
  const stored = await storageQueue.read(tabId, operationKey(tabId));
  if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
  const previous = stored[operationKey(tabId)];
  const tabUrl = await getTabUrl(tabId);
  if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
  const latest = await storageQueue.read(tabId, operationKey(tabId));
  if (!canAcceptStart(tabId, acceptance)) return { ok: false, error: 'Retry was cancelled or superseded.' };
  const record = latest[operationKey(tabId)];
  if (!validOperationRecord(record, tabId, descriptor, tabUrl) ||
      !validOperationRecord(previous, tabId, descriptor, tabUrl) ||
      Object.keys(record).some(key => record[key] !== previous[key])) {
    return { ok: false, error: 'The saved operation is no longer retryable.' };
  }
  const root = claimRoot(tabId, { url: record.sourceUrl, force: record.force === true });
  if (!root) return { ok: false, error: 'The tab is no longer available.' };
  if (record.stage === 'format') {
    const context = stageForRoot(root, 'format', formatControllers, formatContexts);
    if (!context) return { ok: false, error: 'Unable to claim formatting retry.' };
    getState(tabId);
    return runFormat(context, { text: record.sourceText, sourceKind: record.sourceKind });
  }
  const context = stageForRoot(root, 'translate', translateControllers, translateContexts);
  if (!context) return { ok: false, error: 'Unable to claim translation retry.' };
  getState(tabId);
  return runTranslate(context, {
    text: record.sourceText,
    language: record.language,
    sourceKind: record.sourceKind,
  });
}
