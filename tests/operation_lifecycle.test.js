'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension');
const BACKGROUND_PATH = path.join(EXTENSION, 'background.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail(message);
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { return [...listeners].map(listener => listener(...args)); },
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => structuredClone(body),
    text: async () => JSON.stringify(body),
  };
}

function createFetchRouter({ ignoreAbort = false } = {}) {
  const calls = [];
  const queues = new Map();

  function fetch(url, init = {}) {
    const text = String(url);
    const route = ['/transcript', '/format', '/translate', '/save']
      .find(candidate => text.includes(candidate));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${text}`));

    const pending = deferred();
    const entry = {
      route,
      url: text,
      body: init.body ? JSON.parse(init.body) : undefined,
      init,
      pending,
    };
    calls.push(entry);
    const routeQueue = queues.get(route) || [];
    routeQueue.push(entry);
    queues.set(route, routeQueue);

    if (!ignoreAbort) {
      const abort = () => pending.reject(new DOMException('Aborted', 'AbortError'));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
    }
    return pending.promise;
  }

  function entries(route) {
    return queues.get(route) || [];
  }

  return {
    fetch,
    calls,
    count(route) { return entries(route).length; },
    entry(route, index = 0) { return entries(route)[index]; },
    resolve(route, response, index = 0) {
      const entry = entries(route)[index];
      assert.ok(entry, `no pending ${route} request at index ${index}`);
      entry.pending.resolve(response);
    },
    reject(route, error, index = 0) {
      const entry = entries(route)[index];
      assert.ok(entry, `no pending ${route} request at index ${index}`);
      entry.pending.reject(error);
    },
  };
}

function createStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    get(keys) {
      if (keys === null || keys === undefined) return Promise.resolve(structuredClone(values));
      if (typeof keys === 'string') return Promise.resolve({ [keys]: structuredClone(values[keys]) });
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) result[key] = structuredClone(values[key]);
        return Promise.resolve(result);
      }
      const result = { ...keys };
      for (const key of Object.keys(keys)) {
        if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
      }
      return Promise.resolve(result);
    },
    set(next) {
      Object.assign(values, structuredClone(next));
      return Promise.resolve();
    },
    remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
      return Promise.resolve();
    },
  };
}

function createBackgroundHarness(options = {}) {
  const local = createStorage(options.localData || {});
  const syncValues = { ...(options.syncValues || {}) };
  const runtimeMessages = [];
  const onStorageChanged = createEvent();
  const onTabRemoved = createEvent();
  const tab = {
    id: options.tabId || 1,
    windowId: 10,
    active: true,
    url: options.tabUrl || 'https://example.test/video',
  };
  const chrome = {
    storage: {
      onChanged: onStorageChanged,
      local,
      sync: {
        get(defaults) { return Promise.resolve({ ...defaults, ...syncValues }); },
        set(next) { Object.assign(syncValues, next); return Promise.resolve(); },
      },
    },
    tabs: {
      onRemoved: onTabRemoved,
      query: async () => [structuredClone(tab)],
      get: async id => id === tab.id ? structuredClone(tab) : { id, url: tab.url },
    },
    runtime: {
      onMessage: createEvent(),
      sendMessage(message) { runtimeMessages.push(structuredClone(message)); return Promise.resolve(); },
      getPlatformInfo(callback) { callback?.({}); },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    notifications: { create() {} },
    commands: { onCommand: createEvent() },
  };
  const unrefTimeout = (...args) => {
    const timer = setTimeout(...args);
    timer.unref?.();
    return timer;
  };
  const context = {
    AbortController,
    DOMException,
    URL,
    chrome,
    clearInterval,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: options.fetch,
    setInterval: () => 1,
    setTimeout: unrefTimeout,
    structuredClone,
  };
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...files) => {
    for (const file of files) {
      const helperPath = path.join(EXTENSION, file);
      vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
    }
  };
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), context, { filename: BACKGROUND_PATH });
  vm.runInContext(
    'var __states = states;' +
      'var __translateControllers = translateControllers;' +
      'var __formatControllers = formatControllers;' +
      'var __transcriptControllers = transcriptControllers;' +
      'var __isKeepAliveRunning = () => keepAliveIntervalId !== null;',
    context,
  );
  return { context, local, syncValues, runtimeMessages, onTabRemoved, tab };
}

function fullState(overrides = {}) {
  return {
    active: false,
    status: 'Idle',
    progress: 'Ready',
    transcript: '',
    error: '',
    stopRequested: false,
    format: { sourceText: '', resultText: '', active: false, status: '', error: '' },
    translate: { sourceText: '', resultText: '', targetLanguage: 'zh', active: false, status: '', error: '' },
    ...overrides,
  };
}

async function stopCurrent(harness) {
  const result = await harness.context.handleStop();
  assert.equal(result.ok, true);
  await delay();
}

test('test_new_root_supersedes_downstream_work', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const first = harness.context.handleFormatStart({ tabId: 1, text: 'old format' });
  await waitFor(() => router.count('/format') === 1, 'first format did not start');
  const firstController = harness.context.__formatControllers.get(1);

  const second = harness.context.handleStart({ url: 'https://example.test/new' });
  await waitFor(() => router.count('/transcript') === 1, 'replacement transcript did not start');

  assert.equal(firstController.signal.aborted, true);
  assert.equal(harness.context.__transcriptControllers.has(1), true);

  router.resolve('/transcript', jsonResponse({ text: 'new transcript', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 2, 'replacement format did not start');
  router.resolve('/format', jsonResponse({ text: 'new formatted' }), 1);
  await second;
  await stopCurrent(harness);
  await first;
});

test('test_transcript_success_publishes_only_when_root_is_current', async () => {
  const router = createFetchRouter({ ignoreAbort: true });
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const transcript = harness.context.handleStart({ url: 'https://example.test/old' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');

  const replacement = harness.context.handleFormatStart({ tabId: 1, text: 'replacement' });
  await waitFor(() => router.count('/format') === 1, 'replacement format did not start');
  router.resolve('/format', jsonResponse({ text: 'replacement result' }));
  await replacement;

  router.resolve('/transcript', jsonResponse({ text: 'stale transcript', source: 'subtitles' }));
  await transcript;
  await delay();

  assert.equal(harness.local.values['transcript:1'], undefined);
  assert.equal(harness.local.values['transcript_raw:1'], undefined);
  assert.equal(harness.context.__states.has(1), true);
});

test('test_successful_transcript_clears_obsolete_downstream_results', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({
    fetch: router.fetch,
    localData: {
      'fmtResult:1': 'old format',
      'translate:result:1': 'old translation',
      'tl2Translating:1': true,
      'transform:operation:1': { version: 1, status: 'failed' },
    },
  });

  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'accepted transcript', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format handoff did not start');

  assert.deepEqual(harness.local.values['transcript:1'], {
    text: 'accepted transcript',
    url: 'https://example.test/video',
  });
  assert.equal(harness.local.values['transcript_raw:1'], 'accepted transcript');
  assert.equal(harness.local.values['transcript_force:1'], true);
  assert.deepEqual(harness.local.values['transcript_recovery:1'], {
    version: 1,
    rootId: harness.local.values['transform:operation:1'].rootId,
    terminal: 'available',
  });
  assert.equal(harness.local.values['fmtResult:1'], undefined);
  assert.equal(harness.local.values['translate:result:1'], undefined);
  assert.equal(harness.local.values['tl2Translating:1'], undefined);
  assert.deepEqual(harness.local.values['transform:operation:1'], {
    version: 1,
    rootId: harness.local.values['transform:operation:1'].rootId,
    stageId: harness.local.values['transform:operation:1'].stageId,
    tabId: 1,
    stage: 'format',
    status: 'running',
    sourceText: 'accepted transcript',
    sourceUrl: 'https://example.test/video',
    sourceKind: 'transcript',
    language: null,
    force: true,
    error: '',
  });

  router.resolve('/format', jsonResponse({ text: 'formatted' }));
  await operation;
});

test('test_transcript_failure_preserves_previous_completed_results', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({
    fetch: router.fetch,
    localData: {
      'transcript:1': { text: 'previous transcript', url: 'https://example.test/video' },
      'transcript_raw:1': 'previous transcript',
      'fmtResult:1': 'previous format',
      'translate:result:1': 'previous translation',
    },
  });
  harness.context.__states.set(1, fullState({
    transcript: 'previous transcript',
    format: { sourceText: 'previous transcript', resultText: 'previous format', active: false, status: 'Formatted', error: '' },
    translate: { sourceText: 'previous format', resultText: 'previous translation', active: false, status: 'Complete', error: '' },
  }));

  const operation = harness.context.handleStart({ url: 'https://example.test/video' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ error: 'backend exploded' }, { ok: false, status: 500 }));
  await operation;

  assert.deepEqual(harness.local.values['transcript:1'], {
    text: 'previous transcript',
    url: 'https://example.test/video',
  });
  assert.equal(harness.local.values['transcript_raw:1'], 'previous transcript');
  assert.equal(harness.local.values['fmtResult:1'], 'previous format');
  assert.equal(harness.local.values['translate:result:1'], 'previous translation');
  const state = harness.context.__states.get(1);
  assert.equal(state.transcript, 'previous transcript');
  assert.match(state.error, /backend exploded/);
  assert.equal(state.active, false);
});

test('test_transcript_to_format_to_translate_keeps_one_root_and_successor_registration', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({
    fetch: router.fetch,
    syncValues: { yt2txtAutoTranslate: true, tl2Language: 'French' },
  });

  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'raw text', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  const formatRecord = harness.local.values['transform:operation:1'];
  assert.equal(formatRecord.stage, 'format');
  assert.equal(formatRecord.force, true);

  router.resolve('/format', jsonResponse({ text: 'formatted text' }));
  await waitFor(() => router.count('/translate') === 1, 'translation did not start');
  const translateRecord = harness.local.values['transform:operation:1'];
  assert.equal(translateRecord.stage, 'translate');
  assert.equal(translateRecord.rootId, formatRecord.rootId);
  assert.equal(translateRecord.force, true);
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  router.resolve('/translate', jsonResponse({ text: 'translated text' }));
  await operation;
  await waitFor(() => !harness.context.__isKeepAliveRunning(), 'keepalive did not stop');
  assert.equal(harness.local.values['transform:operation:1'], undefined);
});

test('test_tab_close_fences_preclose_continuations', async () => {
  const router = createFetchRouter({ ignoreAbort: true });
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: 'https://example.test/video' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');

  harness.onTabRemoved.emit(1);
  await delay();
  router.resolve('/transcript', jsonResponse({ text: 'late text', source: 'subtitles' }));
  await operation;
  await delay();

  assert.equal(harness.context.__states.has(1), false);
  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.local.values['transcript:1'], undefined);
  assert.equal(harness.local.values['transcript_raw:1'], undefined);
  assert.equal(harness.local.values['transform:operation:1'], undefined);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});

test('test_stale_handler_cannot_create_state_or_broadcast', async () => {
  const router = createFetchRouter({ ignoreAbort: true });
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: 'https://example.test/video' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  const beforeClose = harness.runtimeMessages.length;
  harness.onTabRemoved.emit(1);
  router.resolve('/transcript', jsonResponse({ text: 'late text', source: 'subtitles' }));
  await operation;
  await delay();

  assert.equal(harness.context.__states.has(1), false);
  assert.equal(harness.runtimeMessages.length, beforeClose);
});

test('test_forced_transcript_body_is_exact', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  assert.deepEqual(router.entry('/transcript').body, {
    url: 'https://example.test/video',
    force: true,
  });
  await stopCurrent(harness);
  await operation;
});

test('test_ordinary_transcript_omits_force', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: false });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  assert.deepEqual(router.entry('/transcript').body, {
    url: 'https://example.test/video',
  });
  await stopCurrent(harness);
  await operation;
});
