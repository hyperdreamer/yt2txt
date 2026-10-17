'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_PATH = path.join(ROOT, 'extension', 'popup.js');

// Keys the background worker owns.  The popup must never touch them directly:
// hydration is a single reconciled `popup:get-state` snapshot.
const WORKER_OWNED_KEY = /^(transcript:|transcript_raw:|transcript_force:|transcript_recovery:|transform:operation:|fmtResult:|translate:result:|tl2Translating:)/;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Values cross the VM realm boundary, so prototypes differ. Compare plain data.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function hydratedState(overrides = {}) {
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
      targetLanguage: 'original',
      resultText: '',
      active: false,
      status: '',
      error: '',
      retry: null,
    },
    ...overrides,
  };
}

/**
 * Popup harness with deferred worker responses, a real message emitter and
 * storage access counters.  `chrome.storage.local` is deliberately tracked so
 * tests can prove the popup performs no independent hydration.
 */
function createPopupHarness(options = {}) {
  const syncValues = {
    yt2txtHost: 'localhost',
    yt2txtPort: 8666,
    textkitHost: 'localhost',
    textkitPort: 8765,
    fileBridgeHost: '',
    fileBridgePort: 8964,
    tl2AutoCopy: false,
    tl2AutoSave: false,
    tl2AutoSavePath: '',
    yt2txtAutoTranslate: false,
    fmtAutoCopy: false,
    fmtAutoSave: false,
    fmtAutoSavePath: '',
    tl2Language: 'original',
    ...(options.syncOverrides || {}),
  };

  const tabId = options.tabId === undefined ? 1 : options.tabId;
  const tabUrl = options.tabUrl || 'https://youtube.com/watch?v=test';

  const storageCalls = {
    localGet: [],
    localSet: [],
    localRemove: [],
    syncGet: [],
    syncSet: [],
  };
  const runtimeMessages = [];
  const localData = { ...(options.localData || {}) };
  const deferredResponses = new Map();
  const listeners = [];

  function classListStub() {
    const classes = new Set();
    return {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    };
  }

  function el(id, overrides = {}) {
    const defaults = {
      value: '',
      disabled: false,
      checked: false,
      textContent: '',
      title: '',
      classList: classListStub(),
      addEventListener() {},
      replaceChildren() {},
    };
    return { id, ...defaults, ...overrides };
  }

  function datalistEl(id) {
    const dl = el(id);
    dl._options = [];
    dl.replaceChildren = (...opts) => { dl._options = opts; };
    return dl;
  }

  const elements = {
    'transcript-panel': el('transcript-panel'),
    'format-panel': el('format-panel'),
    'translation-panel': el('translation-panel'),
    'settings-gear': el('settings-gear'),
    'backend-settings-panel': el('backend-settings-panel'),
    url: el('url'),
    start: el('start'),
    stop: el('stop'),
    'status-bar': el('status-bar'),
    result: el('result'),
    'format-retry-row': el('format-retry-row'),
    'format-retry': el('format-retry'),
    'format-retry-status': el('format-retry-status'),
    copy: el('copy'),
    download: el('download'),
    'format-btn': el('format-btn', { textContent: 'Format' }),
    'format-status-bar': el('format-status-bar'),
    'format-result': el('format-result'),
    'format-copy': el('format-copy'),
    'format-save': el('format-save'),
    'fmt-autocopy': el('fmt-autocopy'),
    'fmt-autosave': el('fmt-autosave'),
    'fmt-autosave-path': el('fmt-autosave-path'),
    'fmt-path-suggestions': datalistEl('fmt-path-suggestions'),
    host: el('host'),
    port: el('port'),
    force: el('force'),
    'source-chip': el('source-chip'),
    'source-chip-icon': el('source-chip-icon'),
    'source-chip-label': el('source-chip-label'),
    'tl2-language': el('tl2-language'),
    'tl2-status-bar': el('tl2-status-bar'),
    'tl2-result': el('tl2-result'),
    'tl2-translate': el('tl2-translate', { textContent: 'Translate' }),
    'tl2-copy': el('tl2-copy'),
    'tl2-save': el('tl2-save'),
    'tl2-download': el('tl2-download'),
    'tl2-autocopy': el('tl2-autocopy'),
    'tl2-autosave': el('tl2-autosave'),
    'tl2-autotranslate': el('tl2-autotranslate'),
    'tl2-autosave-path': el('tl2-autosave-path'),
    'tl2-path-suggestions': datalistEl('tl2-path-suggestions'),
    'textkit-host': el('textkit-host'),
    'textkit-port': el('textkit-port'),
    'file-bridge-host': el('file-bridge-host'),
    'file-bridge-port': el('file-bridge-port'),
  };

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(sel) {
      if (sel === '.tab') {
        return ['transcript-panel', 'format-panel', 'translation-panel'].map((panel) => ({
          dataset: { panel },
          classList: classListStub(),
          addEventListener() {},
        }));
      }
      return [];
    },
    querySelector() { return null; },
    addEventListener() {},
    createElement(tag) {
      return tag === 'option' ? { value: '', tagName: 'OPTION' } : {};
    },
  };

  const chrome = {
    storage: {
      sync: {
        get(defaults) {
          storageCalls.syncGet.push(defaults);
          return Promise.resolve({ ...defaults, ...syncValues });
        },
        set(values) {
          storageCalls.syncSet.push(values);
          Object.assign(syncValues, values);
          return Promise.resolve();
        },
      },
      local: {
        get(keys) {
          storageCalls.localGet.push(keys);
          let result = {};
          if (typeof keys === 'string') {
            result[keys] = localData[keys];
          } else if (Array.isArray(keys)) {
            for (const key of keys) result[key] = localData[key];
          } else if (keys && typeof keys === 'object') {
            result = { ...keys };
            for (const key of Object.keys(keys)) {
              if (Object.hasOwn(localData, key)) result[key] = localData[key];
            }
          } else {
            result = { ...localData };
          }
          return Promise.resolve(result);
        },
        set(values) {
          storageCalls.localSet.push(values);
          Object.assign(localData, values);
          return Promise.resolve();
        },
        remove(keys) {
          storageCalls.localRemove.push(keys);
          for (const key of [].concat(keys)) delete localData[key];
          return Promise.resolve();
        },
      },
    },
    tabs: {
      query: async () => [{ id: tabId, url: tabUrl }],
    },
    runtime: {
      onMessage: {
        addListener(listener) { listeners.push(listener); },
      },
      sendMessage(message) {
        runtimeMessages.push(message);
        if (typeof options.onSendMessage === 'function') {
          options.onSendMessage(message);
        }
        const queued = deferredResponses.get(message?.type);
        if (queued && queued.length) return queued.shift().promise;
        if (message?.type === 'popup:get-state') {
          return Promise.resolve({
            ok: true,
            tabId,
            state: clone(options.state || { transcript: '' }),
          });
        }
        return Promise.resolve({ ok: true });
      },
    },
    commands: { onCommand: { addListener() {} } },
  };

  const fetchCalls = [];
  function fetchMock(url) {
    fetchCalls.push({ url: String(url) });
    return Promise.resolve({ ok: true, json: async () => ({ paths: [] }) });
  }

  const context = {
    document,
    chrome,
    fetch: fetchMock,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval,
    navigator: { clipboard: { writeText() { return Promise.resolve(); } } },
    Blob: class Blob { constructor(parts) { this._parts = parts; } },
    console: { error() {}, log() {} },
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context, { filename: POPUP_PATH });

  const harness = {
    context,
    elements,
    storageCalls,
    runtimeMessages,
    fetchCalls,
    tabId,
    listenerCount() { return listeners.length; },
    emit(message) {
      assert.ok(listeners.length > 0, 'popup registered no runtime.onMessage listener');
      return listeners.map((listener) => listener(message, {}, () => {}));
    },
    defer(type) {
      const entry = deferred();
      const queued = deferredResponses.get(type) || [];
      queued.push(entry);
      deferredResponses.set(type, queued);
      return entry;
    },
    messagesOfType(type) {
      return runtimeMessages.filter((message) => message?.type === type);
    },
  };
  return harness;
}

function workerOwnedLocalCalls(storageCalls) {
  const keysOf = (entry) => {
    if (typeof entry === 'string') return [entry];
    if (Array.isArray(entry)) return entry;
    if (entry && typeof entry === 'object') return Object.keys(entry);
    return [];
  };
  return {
    get: storageCalls.localGet.flatMap(keysOf).filter((key) => WORKER_OWNED_KEY.test(key)),
    remove: storageCalls.localRemove.flatMap(keysOf).filter((key) => WORKER_OWNED_KEY.test(key)),
    set: storageCalls.localSet.flatMap((value) => Object.keys(value || {}))
      .filter((key) => WORKER_OWNED_KEY.test(key)),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Hydration
// ═══════════════════════════════════════════════════════════════════

test('test_initial_hydration_restores_all_saved_results_from_one_worker_state', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Complete',
      progress: 'Transcript ready (source: subtitles).',
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-1',
      stageId: 'stage-1',
      format: {
        sourceText: 'TRANSCRIPT TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: 'FORMATTED TEXT',
        active: false,
        status: 'Formatted',
        error: '',
        retry: null,
      },
      translate: {
        sourceText: 'FORMATTED TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'German',
        resultText: 'ÜBERSETZTER TEXT',
        active: false,
        status: 'Translation complete.',
        error: '',
        retry: null,
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements.result.value, 'TRANSCRIPT TEXT');
  assert.equal(harness.elements['format-result'].value, 'FORMATTED TEXT');
  assert.equal(harness.elements['tl2-result'].value, 'ÜBERSETZTER TEXT');
  assert.equal(
    harness.elements['status-bar'].textContent,
    'Transcript ready (source: subtitles).',
  );
  assert.equal(harness.elements['format-status-bar'].textContent, 'Formatted');
  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Translation complete.');
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true);

  const stateRequests = harness.messagesOfType('popup:get-state');
  assert.equal(stateRequests.length, 1, 'initialization must request exactly one worker snapshot');
  const local = workerOwnedLocalCalls(harness.storageCalls);
  assert.deepEqual(local, { get: [], remove: [], set: [] });
});

test('test_live_worker_state_is_not_labeled_interrupted_on_popup_reopen', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Complete',
      progress: 'Transcript ready (source: subtitles).',
      transcript: 'LIVE TEXT',
      rootId: 'root-live',
      stageId: 'stage-live',
      format: {
        sourceText: 'LIVE TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: 'LIVE FORMAT',
        active: false,
        status: 'Formatted',
        error: '',
        retry: null,
      },
      translate: {
        sourceText: 'LIVE FORMAT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'English',
        resultText: 'LIVE TRANSLATION',
        active: false,
        status: 'Translation complete.',
        error: '',
        retry: null,
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements['format-status-bar'].textContent, 'Formatted');
  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Translation complete.');
  for (const id of ['status-bar', 'format-status-bar', 'tl2-status-bar']) {
    assert.ok(
      !/interrupt/i.test(harness.elements[id].textContent),
      `${id} must not invent an interrupted label: ${harness.elements[id].textContent}`,
    );
  }
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true);
  assert.equal(harness.elements['tl2-translate'].textContent, 'Translate');
});

test('test_interrupted_format_record_exposes_retry_with_saved_source', async () => {
  const descriptor = { kind: 'record', rootId: 'root-fmt', stageId: 'stage-fmt' };
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Idle',
      progress: 'Interrupted after worker restart.',
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-fmt',
      stageId: 'stage-fmt',
      format: {
        sourceText: 'SAVED SOURCE TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: '',
        active: false,
        status: 'Interrupted after worker restart.',
        error: 'Interrupted after worker restart.',
        retry: descriptor,
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false);
  assert.match(harness.elements['format-retry-status'].textContent, /Interrupted/);

  await harness.context.retryFormat();

  const retries = harness.messagesOfType('transform:retry');
  assert.equal(retries.length, 1);
  assert.deepEqual(plain(retries[0]), {
    type: 'transform:retry',
    tabId: 1,
    descriptor,
  });
  assert.equal(harness.messagesOfType('format:start').length, 0);
});

test('test_interrupted_translation_record_exposes_saved_language_and_force', async () => {
  const descriptor = {
    kind: 'record',
    rootId: 'root-tl',
    stageId: 'stage-tl',
    language: 'German',
  };
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Idle',
      progress: 'Interrupted after worker restart.',
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-tl',
      stageId: 'stage-tl',
      translate: {
        sourceText: 'SAVED TRANSLATION SOURCE',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: true,
        targetLanguage: 'German',
        resultText: '',
        active: false,
        status: 'Interrupted after worker restart.',
        error: 'Interrupted after worker restart.',
        retry: descriptor,
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements['tl2-translate'].textContent, 'Retry');
  assert.equal(harness.elements['tl2-translate'].disabled, false);

  // A changed selector must not become the retry provenance.
  harness.elements['tl2-language'].value = 'Japanese';
  await harness.context.doTranslation();

  const retries = harness.messagesOfType('transform:retry');
  assert.equal(retries.length, 1);
  assert.deepEqual(plain(retries[0]), {
    type: 'transform:retry',
    tabId: 1,
    descriptor,
  });
  assert.equal(retries[0].language, undefined, 'retry provenance comes from the descriptor');
  assert.equal(retries[0].force, undefined, 'retry Force comes from the persisted record');
  assert.equal(harness.messagesOfType('translate:start').length, 0);
});

test('test_legacy_raw_recovery_uses_available_marker_and_absent_force', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Idle',
      progress: 'Transcript ready to retry formatting.',
      transcript: 'LEGACY TRANSCRIPT',
      rootId: 'root-legacy',
      stageId: null,
      force: false,
      format: {
        sourceText: 'LEGACY TRANSCRIPT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: '',
        active: false,
        status: 'Ready to retry formatting.',
        error: '',
        retry: { kind: 'legacy' },
      },
      translate: {
        sourceText: '',
        sourceUrl: '',
        sourceKind: '',
        force: false,
        targetLanguage: 'original',
        resultText: '',
        active: false,
        status: '',
        error: '',
        // The worker never emits this, but a legacy descriptor routes to the
        // format stage, so the translation action must not treat it as retry.
        retry: { kind: 'legacy' },
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false);
  assert.equal(harness.elements['tl2-translate'].textContent, 'Translate',
    'a legacy format descriptor must not become a translation retry');

  await harness.context.retryFormat();

  const retries = harness.messagesOfType('transform:retry');
  assert.equal(retries.length, 1);
  assert.deepEqual(plain(retries[0]), {
    type: 'transform:retry',
    tabId: 1,
    descriptor: { kind: 'legacy' },
  });
  assert.equal(retries[0].force, undefined, 'legacy retry has no popup Force provenance');
});

test('test_stopped_or_completed_marker_suppresses_legacy_recovery', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-legacy',
      format: {
        sourceText: 'TRANSCRIPT TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: '',
        active: false,
        status: 'Ready to retry formatting.',
        error: '',
        retry: { kind: 'legacy' },
      },
    }),
  });

  await harness.context.init();
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false);

  // The worker cleaned the record because the marker is stopped/completed.
  harness.emit({
    type: 'state:update',
    tabId: 1,
    state: hydratedState({
      status: 'Idle',
      progress: 'Ready',
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-legacy',
      stageId: null,
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
    }),
  });

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true);

  await harness.context.retryFormat();
  assert.equal(harness.messagesOfType('transform:retry').length, 0,
    'suppressed legacy recovery must not dispatch a retry');
});

test('test_corrupt_record_is_safe_idle_without_retry', async () => {
  const harness = createPopupHarness({
    state: hydratedState({ status: 'Idle', progress: 'Ready', transcript: '' }),
  });

  await harness.context.init();

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true);
  assert.equal(harness.elements.result.value, '');
  assert.equal(harness.elements['format-result'].value, '');
  assert.equal(harness.elements['tl2-result'].value, '');
  assert.equal(harness.elements['tl2-translate'].textContent, 'Translate');
  assert.equal(harness.elements['tl2-translate'].disabled, true);
  assert.ok(!harness.elements['status-bar'].className.includes('error'),
    'a corrupt record must not surface as an error state');
  assert.equal(harness.elements['status-bar'].textContent, 'Ready');
  assert.equal(harness.messagesOfType('transform:retry').length, 0);
  assert.equal(harness.messagesOfType('format:start').length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// Retry provenance
// ═══════════════════════════════════════════════════════════════════

test('test_retry_uses_saved_source_when_textarea_is_empty', async () => {
  const descriptor = { kind: 'record', rootId: 'root-fmt', stageId: 'stage-fmt' };
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: '',
      rootId: 'root-fmt',
      stageId: 'stage-fmt',
      format: {
        sourceText: 'SAVED SOURCE TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: true,
        resultText: '',
        active: false,
        status: 'Formatting failed.',
        error: 'Formatting failed.',
        retry: descriptor,
      },
    }),
  });

  await harness.context.init();

  assert.equal(harness.elements.result.value, '', 'textarea starts empty');
  await harness.context.retryFormat();

  const retries = harness.messagesOfType('transform:retry');
  assert.equal(retries.length, 1);
  assert.deepEqual(plain(retries[0]), { type: 'transform:retry', tabId: 1, descriptor });
  assert.equal(retries[0].text, undefined, 'the worker recovers saved source, not the popup');
  assert.equal(harness.messagesOfType('format:start').length, 0);
});

test('test_translation_retry_uses_saved_language_not_current_setting', async () => {
  const descriptor = {
    kind: 'record',
    rootId: 'root-tl',
    stageId: 'stage-tl',
    language: 'French',
  };
  const harness = createPopupHarness({
    state: hydratedState({
      rootId: 'root-tl',
      stageId: 'stage-tl',
      translate: {
        sourceText: 'SAVED SOURCE',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'French',
        resultText: '',
        active: false,
        status: 'Translation failed.',
        error: 'Translation failed.',
        retry: descriptor,
      },
    }),
  });

  await harness.context.init();
  harness.elements['tl2-language'].value = 'Korean';

  await harness.context.doTranslation();

  const retries = harness.messagesOfType('transform:retry');
  assert.equal(retries.length, 1);
  assert.deepEqual(plain(retries[0].descriptor), descriptor);
  assert.notEqual(retries[0].descriptor.language, harness.elements['tl2-language'].value);
  assert.equal(harness.messagesOfType('translate:start').length, 0);
});

test('test_ordinary_start_does_not_include_force', async () => {
  const harness = createPopupHarness({
    state: hydratedState({ transcript: 'TRANSCRIPT TEXT' }),
  });
  await harness.context.init();

  harness.elements['result'].value = 'TRANSCRIPT TEXT';
  harness.elements['tl2-language'].value = 'Spanish';
  await harness.context.doFormat();
  await harness.context.doTranslation();

  const formatStarts = harness.messagesOfType('format:start');
  const translateStarts = harness.messagesOfType('translate:start');
  assert.equal(formatStarts.length, 1);
  assert.equal(translateStarts.length, 1);
  assert.deepEqual(Object.keys(formatStarts[0]).sort(), ['tabId', 'text', 'type']);
  assert.deepEqual(Object.keys(translateStarts[0]).sort(), ['language', 'tabId', 'text', 'type']);
  assert.equal(formatStarts[0].force, undefined);
  assert.equal(translateStarts[0].force, undefined);
});

test('test_stop_message_contains_displayed_stage_ids', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      active: true,
      status: 'Processing',
      progress: 'Sending request to backend...',
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-stop',
      stageId: 'stage-stop',
      format: {
        sourceText: 'TRANSCRIPT TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: '',
        active: true,
        status: 'Formatting...',
        error: '',
        retry: null,
      },
    }),
  });

  await harness.context.init();

  await harness.context.stopCapture();
  harness.elements['format-btn'].textContent = 'Stop';
  await harness.context.doFormat();
  harness.elements['tl2-translate'].textContent = 'Stop';
  await harness.context.doTranslation();

  for (const type of ['popup:stop', 'format:stop', 'translate:stop']) {
    const sent = harness.messagesOfType(type);
    assert.equal(sent.length, 1, `expected one ${type}`);
    assert.equal(sent[0].tabId, 1);
    assert.equal(sent[0].rootId, 'root-stop', `${type} must carry the displayed root id`);
    assert.equal(sent[0].stageId, 'stage-stop', `${type} must carry the displayed stage id`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// Races and ownership
// ═══════════════════════════════════════════════════════════════════

test('test_delayed_initial_snapshot_cannot_overwrite_newer_state_event', async () => {
  const stale = hydratedState({ transcript: 'STALE SNAPSHOT', rootId: 'root-stale' });
  const live = hydratedState({
    transcript: 'FRESH EVENT',
    status: 'Complete',
    progress: 'Transcript ready (source: subtitles).',
    rootId: 'root-live',
    stageId: 'stage-live',
  });

  let harness;
  harness = createPopupHarness({
    state: stale,
    onSendMessage(message) {
      if (message?.type !== 'popup:get-state') return;
      // The worker broadcast lands while the snapshot request is in flight.
      harness.emit({ type: 'state:update', tabId: 1, state: live });
    },
  });
  assert.ok(harness.listenerCount() > 0,
    'the message listener must be registered before initialization requests state');

  const snapshot = harness.defer('popup:get-state');
  const initPromise = harness.context.init();
  await tick();
  snapshot.resolve({ ok: true, tabId: 1, state: stale });
  await initPromise;

  assert.equal(harness.elements.result.value, 'FRESH EVENT');
  assert.equal(harness.elements['status-bar'].textContent, 'Transcript ready (source: subtitles).');
});

test('test_delayed_snapshot_after_local_retry_is_discarded', async () => {
  const descriptor = { kind: 'record', rootId: 'root-fmt', stageId: 'stage-fmt' };
  const hydrated = hydratedState({
    transcript: 'TRANSCRIPT TEXT',
    rootId: 'root-fmt',
    stageId: 'stage-fmt',
    format: {
      sourceText: 'TRANSCRIPT TEXT',
      sourceUrl: 'https://youtube.com/watch?v=test',
      sourceKind: 'transcript',
      force: false,
      resultText: '',
      active: false,
      status: 'Formatting failed.',
      error: 'Formatting failed.',
      retry: descriptor,
    },
  });
  const staleSnapshot = clone(hydrated);
  staleSnapshot.format.resultText = 'STALE FORMAT';
  staleSnapshot.format.retry = descriptor;

  let harness;
  harness = createPopupHarness({
    state: hydrated,
    onSendMessage(message) {
      if (message?.type !== 'popup:get-state') return;
      harness.emit({ type: 'state:update', tabId: 1, state: hydrated });
    },
  });

  const snapshot = harness.defer('popup:get-state');
  const initPromise = harness.context.init();
  await tick();

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false,
    'the live event should expose the retry row');
  await harness.context.retryFormat();
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true,
    'a successful retry hides the row');

  snapshot.resolve({ ok: true, tabId: 1, state: staleSnapshot });
  await initPromise;

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true,
    'a delayed snapshot must not resurrect the retry row');
  assert.equal(harness.elements['format-result'].value, '',
    'a delayed snapshot must not overwrite the rendered result');
});

test('test_partial_result_for_old_root_is_ignored', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-new',
      stageId: 'stage-new',
    }),
  });
  await harness.context.init();

  harness.elements['tl2-result'].value = 'CURRENT RESULT';

  harness.emit({
    type: 'translation:update',
    tabId: 1,
    rootId: 'root-old',
    stageId: 'stage-old',
    text: 'OLD PARTIAL',
  });
  assert.equal(harness.elements['tl2-result'].value, 'CURRENT RESULT',
    'a partial for an old root must be ignored');

  harness.emit({ type: 'translation:update', tabId: 1, text: 'ID-LESS PARTIAL' });
  assert.equal(harness.elements['tl2-result'].value, 'CURRENT RESULT',
    'a partial without ownership ids must be ignored');

  harness.emit({ type: 'tl2:translating', tabId: 1, value: true });
  assert.equal(harness.elements['tl2-translate'].textContent, 'Translate',
    'an activity message without ownership ids must be ignored');

  harness.emit({
    type: 'translation:update',
    tabId: 1,
    rootId: 'root-new',
    stageId: 'stage-new',
    text: 'LIVE PARTIAL',
  });
  assert.equal(harness.elements['tl2-result'].value, 'LIVE PARTIAL',
    'a partial matching the displayed ownership ids must apply');
});

test('test_popup_never_reads_or_removes_worker_owned_activity_keys', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-1',
      stageId: 'stage-1',
      format: {
        sourceText: 'TRANSCRIPT TEXT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        resultText: 'FORMATTED',
        active: false,
        status: 'Formatted',
        error: '',
        retry: { kind: 'record', rootId: 'root-1', stageId: 'stage-1' },
      },
      translate: {
        sourceText: 'FORMATTED',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'English',
        resultText: '',
        active: false,
        status: 'Translation failed.',
        error: 'Translation failed.',
        retry: { kind: 'record', rootId: 'root-2', stageId: 'stage-2', language: 'English' },
      },
    }),
    localData: {
      'transcript:1': { text: 'STORED', url: 'https://youtube.com/watch?v=test' },
      'transcript_raw:1': 'STORED RAW',
      'transcript_force:1': true,
      'transcript_recovery:1': { version: 1, rootId: 'root-1', terminal: 'available' },
      'transform:operation:1': { version: 1, rootId: 'root-1', stageId: 'stage-1' },
      'fmtResult:1': 'STORED FORMAT',
      'translate:result:1': 'STORED TRANSLATION',
      'tl2Translating:1': true,
    },
  });

  await harness.context.init();

  // Message handling must not read or remove worker-owned keys either.
  harness.emit({ type: 'state:update', tabId: 1, state: hydratedState({
    transcript: 'UPDATED',
    rootId: 'root-3',
    stageId: 'stage-3',
  }) });
  harness.emit({
    type: 'translation:update',
    tabId: 1,
    rootId: 'root-3',
    stageId: 'stage-3',
    text: 'UPDATED TRANSLATION',
  });
  harness.emit({ type: 'tl2:translating', tabId: 1, rootId: 'root-3', stageId: 'stage-3', value: false });

  const local = workerOwnedLocalCalls(harness.storageCalls);
  assert.deepEqual(local, { get: [], remove: [], set: [] });
  assert.equal(harness.storageCalls.localGet.length, 0,
    'initialization must not read local storage at all');
  assert.equal(harness.storageCalls.localRemove.length, 0);
  assert.equal(harness.storageCalls.localSet.length, 0);

  // The stored orphan activity flag must not revive the translation UI.
  assert.notEqual(harness.elements['tl2-translate'].textContent, 'Stop');
  assert.equal(harness.elements.result.value, 'UPDATED');
});

// ═══════════════════════════════════════════════════════════════════
// Local command responses are generation-guarded (T4-01)
//
// A start/format/translate/retry command captures `{generation, tabId}`
// before it awaits the worker.  If a newer background event lands while the
// command is in flight, the command's response must not repaint the view:
// the newer render wins.
// ═══════════════════════════════════════════════════════════════════

function formatBlock(resultText, status, extra = {}) {
  return {
    sourceText: 'TRANSCRIPT TEXT',
    sourceUrl: 'https://youtube.com/watch?v=test',
    sourceKind: 'transcript',
    force: false,
    resultText,
    active: false,
    status,
    error: '',
    retry: null,
    ...extra,
  };
}

function newerTranscriptState(format = formatBlock('', '')) {
  return hydratedState({
    status: 'Complete',
    progress: 'Transcript ready (source: subtitles).',
    transcript: 'FRESH TRANSCRIPT',
    rootId: 'root-new',
    stageId: 'stage-new',
    format,
  });
}

test('test_delayed_start_response_cannot_overwrite_newer_state_event', async () => {
  const harness = createPopupHarness({
    state: hydratedState({ transcript: '', rootId: 'root-old', stageId: 'stage-old' }),
  });
  await harness.context.init();

  harness.elements.force.checked = true;
  const pending = harness.defer('popup:start');
  const command = harness.context.startCapture();

  // A newer worker state arrives while the start command is still in flight.
  harness.emit({ type: 'state:update', tabId: 1, state: newerTranscriptState() });
  assert.equal(harness.elements.result.value, 'FRESH TRANSCRIPT');

  pending.resolve({ ok: false, error: 'STALE START ERROR' });
  await command;

  assert.equal(harness.elements['status-bar'].textContent,
    'Transcript ready (source: subtitles).',
    'a stale start response must not replace the newer status');
  assert.equal(harness.elements.result.value, 'FRESH TRANSCRIPT');
  assert.equal(harness.elements.start.disabled, false,
    'a stale start response must not re-enable its own start button state');
  assert.equal(harness.elements.force.disabled, false);
  assert.equal(harness.elements.stop.classList.contains('hidden'), true);
  assert.equal(harness.elements.force.checked, true,
    'a stale start response must not clear the Force control of the newer view');
});

test('test_delayed_format_response_cannot_overwrite_newer_state_event', async () => {
  const harness = createPopupHarness({
    state: hydratedState({ transcript: 'TRANSCRIPT TEXT', rootId: 'root-old', stageId: 'stage-old' }),
  });
  await harness.context.init();

  const pending = harness.defer('format:start');
  const command = harness.context.doFormat();
  assert.equal(harness.elements['format-btn'].textContent, 'Stop');

  harness.emit({
    type: 'state:update',
    tabId: 1,
    state: newerTranscriptState(formatBlock('FRESH FORMAT', 'Formatted')),
  });
  assert.equal(harness.elements['format-result'].value, 'FRESH FORMAT');

  pending.resolve({ ok: false, error: 'STALE FORMAT ERROR' });
  await command;

  assert.equal(harness.elements['format-status-bar'].textContent, 'Formatted',
    'a stale format response must not replace the newer status');
  assert.equal(harness.elements['format-result'].value, 'FRESH FORMAT');
  assert.equal(harness.elements['format-btn'].textContent, 'Format');
  assert.equal(harness.elements['format-copy'].disabled, false);
  assert.equal(harness.elements['format-save'].disabled, false);
});

test('test_delayed_translate_start_response_cannot_overwrite_newer_state_event', async () => {
  const harness = createPopupHarness({
    state: hydratedState({ transcript: 'TRANSCRIPT TEXT', rootId: 'root-old', stageId: 'stage-old' }),
  });
  await harness.context.init();
  harness.elements['tl2-language'].value = 'German';

  const pending = harness.defer('translate:start');
  const command = harness.context.doTranslation();

  harness.emit({
    type: 'state:update',
    tabId: 1,
    state: hydratedState({
      status: 'Complete',
      progress: 'Transcript ready (source: subtitles).',
      transcript: 'FRESH TRANSCRIPT',
      rootId: 'root-new',
      stageId: 'stage-new',
      translate: {
        sourceText: 'FRESH TRANSCRIPT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'transcript',
        force: false,
        targetLanguage: 'German',
        resultText: 'FRESH TRANSLATION',
        active: false,
        status: 'Translation complete.',
        error: '',
        retry: null,
      },
    }),
  });
  assert.equal(harness.elements['tl2-result'].value, 'FRESH TRANSLATION');

  pending.reject(new Error('STALE TRANSLATE ERROR'));
  await command;

  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Translation complete.',
    'a stale translate failure must not replace the newer status');
  assert.equal(harness.elements['tl2-result'].value, 'FRESH TRANSLATION');
  assert.equal(harness.elements['tl2-copy'].disabled, false);
});

test('test_delayed_translation_retry_response_cannot_overwrite_newer_state_event', async () => {
  const descriptor = { kind: 'record', rootId: 'root-tl', stageId: 'stage-tl', language: 'German' };
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-tl',
      stageId: 'stage-tl',
      translate: {
        sourceText: 'SAVED SOURCE',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'German',
        resultText: '',
        active: false,
        status: 'Translation failed.',
        error: 'Translation failed.',
        retry: descriptor,
      },
    }),
  });
  await harness.context.init();
  assert.equal(harness.elements['tl2-translate'].textContent, 'Retry');

  const pending = harness.defer('transform:retry');
  const command = harness.context.doTranslation();
  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Retrying translation...');

  harness.emit({
    type: 'state:update',
    tabId: 1,
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-tl',
      stageId: 'stage-tl',
      translate: {
        sourceText: 'SAVED SOURCE',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'German',
        resultText: '',
        active: true,
        status: 'Translating...',
        error: '',
        retry: null,
      },
    }),
  });
  assert.equal(harness.elements['tl2-translate'].textContent, 'Stop');

  pending.resolve({ ok: false, error: 'STALE RETRY ERROR' });
  await command;

  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Translating...',
    'a stale retry response must not replace the newer status');
  assert.equal(harness.elements['tl2-translate'].textContent, 'Stop',
    'a stale retry response must not re-derive the button from stale state');
  assert.equal(harness.elements['tl2-translate'].disabled, false);
});

test('test_delayed_format_retry_response_cannot_overwrite_newer_state_event', async () => {
  const descriptor = { kind: 'record', rootId: 'root-fmt', stageId: 'stage-fmt' };
  const harness = createPopupHarness({
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-fmt',
      stageId: 'stage-fmt',
      format: formatBlock('', 'Formatting failed.', {
        error: 'Formatting failed.',
        retry: descriptor,
      }),
    }),
  });
  await harness.context.init();
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false);

  const pending = harness.defer('transform:retry');
  const command = harness.context.retryFormat();
  assert.equal(harness.elements['format-retry-status'].textContent, 'Formatting...');

  harness.emit({ type: 'state:update', tabId: 1, state: newerTranscriptState() });
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true);

  pending.resolve({ ok: false, error: 'STALE RETRY ERROR' });
  await command;

  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), true,
    'a stale retry response must not resurrect the retry row');
  assert.equal(harness.elements['format-retry-status'].textContent, '',
    'a stale retry response must not write into the retry status');

  // A later retryable snapshot must own the control again: the stale command's
  // disabled state must not survive into a fresh render.
  harness.emit({
    type: 'state:update',
    tabId: 1,
    state: hydratedState({
      transcript: 'TRANSCRIPT TEXT',
      rootId: 'root-fmt',
      stageId: 'stage-fmt',
      format: formatBlock('', 'Formatting failed.', {
        error: 'Formatting failed.',
        retry: descriptor,
      }),
    }),
  });
  assert.equal(harness.elements['format-retry-row'].classList.contains('hidden'), false);
  assert.equal(harness.elements['format-retry'].disabled, false,
    'a fresh render must re-enable the retry control');
});

// ═══════════════════════════════════════════════════════════════════
// renderState renders the complete snapshot (T4-02)
// ═══════════════════════════════════════════════════════════════════

test('test_newer_root_state_clears_stale_results_statuses_and_controls', async () => {
  const harness = createPopupHarness({
    state: hydratedState({
      status: 'Complete',
      progress: 'Transcript ready (source: subtitles).',
      transcript: 'OLD TRANSCRIPT',
      rootId: 'root-old',
      stageId: 'stage-old',
      format: formatBlock('OLD FORMAT', 'Formatted'),
      translate: {
        sourceText: 'OLD FORMAT',
        sourceUrl: 'https://youtube.com/watch?v=test',
        sourceKind: 'format',
        force: false,
        targetLanguage: 'German',
        resultText: 'OLD TRANSLATION',
        active: false,
        status: 'Translation complete.',
        error: '',
        retry: { kind: 'record', rootId: 'root-old', stageId: 'stage-old-tl' },
      },
    }),
  });
  await harness.context.init();

  // Hydration really did restore the saved results and controls.
  assert.equal(harness.elements['format-result'].value, 'OLD FORMAT');
  assert.equal(harness.elements['tl2-result'].value, 'OLD TRANSLATION');
  assert.equal(harness.elements['format-status-bar'].textContent, 'Formatted');
  assert.equal(harness.elements['tl2-status-bar'].textContent, 'Translation complete.');
  assert.equal(harness.elements['format-copy'].disabled, false);
  assert.equal(harness.elements['format-save'].disabled, false);
  assert.equal(harness.elements['tl2-copy'].disabled, false);
  assert.equal(harness.elements['tl2-save'].disabled, false);
  assert.equal(harness.elements['tl2-download'].disabled, false);
  assert.equal(harness.elements['tl2-translate'].textContent, 'Retry');

  // A full snapshot for a newer root with no saved results at all.
  harness.emit({ type: 'state:update', tabId: 1, state: newerTranscriptState() });

  assert.equal(harness.elements['format-result'].value, '',
    'the format textarea must clear when the newer state says it is empty');
  assert.equal(harness.elements['tl2-result'].value, '',
    'the translation textarea must clear when the newer state says it is empty');
  assert.equal(harness.elements['format-status-bar'].textContent, '',
    'the format status must reset when the newer state has none');
  assert.equal(harness.elements['tl2-status-bar'].textContent, '',
    'the translation status must reset when the newer state has none');
  assert.equal(harness.elements['format-copy'].disabled, true,
    'copy controls must follow the rendered value, not the previous one');
  assert.equal(harness.elements['format-save'].disabled, true);
  assert.equal(harness.elements['tl2-copy'].disabled, true);
  assert.equal(harness.elements['tl2-save'].disabled, true);
  assert.equal(harness.elements['tl2-download'].disabled, true);
  assert.equal(harness.elements['format-btn'].textContent, 'Format');
  assert.equal(harness.elements['tl2-translate'].textContent, 'Translate',
    'the newer state has no retry descriptor, so the action is not a retry');
  assert.equal(harness.elements.result.value, 'FRESH TRANSCRIPT');

  // No effect was launched by rendering the newer snapshot.
  assert.equal(harness.messagesOfType('transform:retry').length, 0);
  assert.equal(harness.messagesOfType('format:start').length, 0);
  assert.equal(harness.messagesOfType('translate:start').length, 0);
});
