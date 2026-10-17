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
    listeners,
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

function createFetchRouter() {
  const calls = [];
  const queues = new Map();
  function fetch(url, init = {}) {
    const route = ['/transcript', '/format', '/translate', '/save']
      .find(candidate => String(url).includes(candidate));
    if (!route) return Promise.reject(new Error(`unrouted fetch: ${url}`));
    const pending = deferred();
    const entry = {
      route,
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
      init,
      pending,
    };
    calls.push(entry);
    const routeQueue = queues.get(route) || [];
    routeQueue.push(entry);
    queues.set(route, routeQueue);
    const abort = () => pending.reject(new DOMException('Aborted', 'AbortError'));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    return pending.promise;
  }
  const entries = route => queues.get(route) || [];
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
  };
}

function selectValues(values, keys) {
  if (keys === null || keys === undefined) return structuredClone(values);
  if (typeof keys === 'string') {
    return Object.hasOwn(values, keys) ? { [keys]: structuredClone(values[keys]) } : {};
  }
  if (Array.isArray(keys)) {
    const result = {};
    for (const key of keys) {
      if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
    }
    return result;
  }
  const result = { ...keys };
  for (const key of Object.keys(keys)) {
    if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
  }
  return result;
}

function createPersistentStorage(initial = {}) {
  const values = structuredClone(initial);
  const hooks = { get: null, set: null, remove: null };
  const area = {
    values,
    hooks,
    get(keys) {
      return Promise.resolve().then(async () => {
        if (hooks.get) await hooks.get(keys);
        return selectValues(values, keys);
      });
    },
    set(next) {
      return Promise.resolve().then(async () => {
        if (hooks.set) await hooks.set(structuredClone(next));
        Object.assign(values, structuredClone(next));
      });
    },
    remove(keys) {
      return Promise.resolve().then(async () => {
        if (hooks.remove) await hooks.remove([... (Array.isArray(keys) ? keys : [keys])]);
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
      });
    },
  };
  return area;
}

function createBackgroundHarness({ local, fetch, syncValues = {}, tabUrl = 'https://example.test/video' } = {}) {
  const persistent = local || createPersistentStorage();
  const sync = { ...syncValues };
  const runtimeMessages = [];
  const onStorageChanged = createEvent();
  const onTabRemoved = createEvent();
  const tab = { id: 1, windowId: 10, active: true, url: tabUrl };
  const chrome = {
    storage: {
      onChanged: onStorageChanged,
      local: persistent,
      sync: {
        get(defaults) { return Promise.resolve({ ...defaults, ...sync }); },
        set(next) { Object.assign(sync, next); return Promise.resolve(); },
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
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
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
    fetch,
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
      'var __isKeepAliveRunning = () => keepAliveIntervalId !== null;',
    context,
  );
  return { context, local: persistent, sync, runtimeMessages, onTabRemoved, tab };
}

async function reconcile(harness) {
  return harness.context.reconcileTabState(1, harness.tab.url);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function savedRecord(overrides = {}) {
  return {
    version: 1,
    rootId: 'saved-root',
    stageId: 'saved-stage',
    tabId: 1,
    stage: 'format',
    status: 'failed',
    sourceText: 'saved source',
    sourceUrl: 'https://example.test/video',
    sourceKind: 'transcript',
    language: null,
    force: true,
    error: 'previous backend error',
    ...overrides,
  };
}

function availableMarker(rootId = 'saved-root') {
  return { version: 1, rootId, terminal: 'available' };
}

function stoppedMarker(rootId = 'saved-root') {
  return { version: 1, rootId, terminal: 'stopped' };
}

function completedMarker(rootId = 'saved-root') {
  return { version: 1, rootId, terminal: 'completed' };
}

test('test_successful_transcript_groups_raw_and_force_with_available_record', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: harness.tab.url, force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'raw transcript', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');

  assert.equal(harness.local.values['transcript_raw:1'], 'raw transcript');
  assert.equal(harness.local.values['transcript_force:1'], true);
  assert.deepEqual(harness.local.values['transcript_recovery:1'], availableMarker(
    harness.local.values['transform:operation:1'].rootId,
  ));
  assert.equal(harness.local.values['transform:operation:1'].status, 'running');

  await harness.context.handleStop(1);
  await operation;
});

test('test_stale_storage_write_rolls_back_before_recovery_read', async () => {
  const router = createFetchRouter();
  const local = createPersistentStorage();
  const barrier = deferred();
  let blocked = false;
  local.hooks.set = async next => {
    if (!blocked && next['transform:operation:1']?.status === 'running') {
      blocked = true;
      await barrier.promise;
    }
  };
  const harness = createBackgroundHarness({ fetch: router.fetch, local });
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'old source', url: harness.tab.url });
  await waitFor(() => blocked, 'operation record write did not block');
  const replacement = harness.context.handleFormatStart({ tabId: 1, text: 'new source', url: harness.tab.url });
  barrier.resolve();
  await waitFor(() => router.count('/format') === 1, 'replacement format did not start');
  router.resolve('/format', jsonResponse({ text: 'new result' }));
  await replacement;
  await operation;

  assert.equal(harness.local.values['transform:operation:1'], undefined);
  assert.equal(harness.local.values['fmtResult:1'], 'new result');
});

test('test_stop_ack_waits_for_terminal_marker_and_cleanup', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source', url: harness.tab.url });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  const rootId = harness.local.values['transform:operation:1'].rootId;
  const barrier = deferred();
  const remove = harness.local.remove.bind(harness.local);
  let removing = false;
  harness.local.remove = async keys => {
    if (keys.includes('transform:operation:1')) {
      removing = true;
      await barrier.promise;
    }
    return remove(keys);
  };
  let acknowledged = false;
  const stopped = harness.context.handleStop(1).then(result => { acknowledged = true; return result; });
  await waitFor(() => removing, 'stop cleanup did not reach removal');
  assert.equal(acknowledged, false);
  assert.deepEqual(harness.local.values['transcript_recovery:1'], stoppedMarker(rootId));
  barrier.resolve();
  assert.equal((await stopped).ok, true);
  await operation;
  assert.equal(harness.local.values['transform:operation:1'], undefined);
  assert.deepEqual(harness.local.values['transcript_recovery:1'], stoppedMarker(rootId));
});

test('test_storage_failure_returns_failed_stop_ack_after_invalidation', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source', url: harness.tab.url });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  harness.local.hooks.set = async next => {
    if (next['transcript_recovery:1']?.terminal === 'stopped') throw new Error('disk unavailable');
  };
  const result = await harness.context.handleStop(1);
  assert.equal(result.ok, false);
  assert.match(result.error, /persist|storage/i);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
  await operation;
});

test('test_matching_stopped_tombstone_beats_running_record_after_restart', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': savedRecord({ status: 'running', error: '' }),
    'transcript_recovery:1': stoppedMarker(),
    'tl2Translating:1': true,
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.equal(state.format.retry, null);
  assert.equal(state.format.active, false);
  assert.equal(local.values['transform:operation:1'], undefined);
  assert.equal(local.values['tl2Translating:1'], undefined);
  assert.deepEqual(local.values['transcript_recovery:1'], stoppedMarker());
});

test('test_matching_completed_tombstone_beats_record_cleanup_gap', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': savedRecord(),
    'transcript_recovery:1': completedMarker(),
    'tl2Translating:1': true,
    'fmtResult:1': 'already formatted',
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.equal(state.format.retry, null);
  assert.equal(local.values['transform:operation:1'], undefined);
  assert.equal(local.values['tl2Translating:1'], undefined);
});

test('test_newer_root_is_not_suppressed_by_older_terminal_marker', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': savedRecord({ rootId: 'new-root', stageId: 'new-stage' }),
    'transcript_recovery:1': stoppedMarker('old-root'),
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.deepEqual(plain(state.format.retry), { kind: 'record', rootId: 'new-root', stageId: 'new-stage' });
  assert.equal(state.format.sourceText, 'saved source');
  assert.equal(local.values['transform:operation:1'].rootId, 'new-root');
});

test('test_corrupt_record_suppresses_legacy_raw_recovery', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': { version: 99, rootId: 'bad' },
    'transcript_raw:1': 'legacy source',
    'transcript:1': { text: 'legacy source', url: 'https://example.test/video' },
    'transcript_force:1': true,
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.equal(state.format.retry, null);
  assert.equal(state.format.sourceText, '');
  assert.deepEqual(local.values['transform:operation:1'], { version: 99, rootId: 'bad' });
});

test('test_stop_before_first_format_result_suppresses_legacy_retry', async () => {
  const local = createPersistentStorage({
    'transcript_raw:1': 'saved transcript',
    'transcript:1': { text: 'saved transcript', url: 'https://example.test/video' },
    'transcript_force:1': true,
    'transcript_recovery:1': stoppedMarker('stopped-root'),
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.equal(state.format.retry, null);
});

test('test_absent_marker_allows_legacy_raw_force_recovery', async () => {
  const local = createPersistentStorage({
    'transcript_raw:1': 'saved transcript',
    'transcript:1': { text: 'saved transcript', url: 'https://example.test/video' },
    'transcript_force:1': true,
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.deepEqual(plain(state.format.retry), { kind: 'legacy' });
  assert.equal(state.format.sourceText, 'saved transcript');
  assert.equal(state.format.force, undefined);
});

test('test_available_marker_allows_legacy_raw_recovery_without_completed_result', async () => {
  const local = createPersistentStorage({
    'transcript_raw:1': 'saved transcript',
    'transcript:1': { text: 'saved transcript', url: 'https://example.test/video' },
    'transcript_force:1': false,
    'transcript_recovery:1': availableMarker('transcript-root'),
  });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.deepEqual(plain(state.format.retry), { kind: 'legacy' });
  assert.equal(state.format.sourceText, 'saved transcript');
  assert.equal(local.values['fmtResult:1'], undefined);
});

test('test_saved_source_retry_works_when_textarea_is_empty', async () => {
  const router = createFetchRouter();
  const local = createPersistentStorage({ 'transform:operation:1': savedRecord() });
  const harness = createBackgroundHarness({ local, fetch: router.fetch });
  const state = await reconcile(harness);
  assert.equal(state.transcript, '');
  assert.equal(state.format.sourceText, 'saved source');
  assert.deepEqual(plain(state.format.retry), { kind: 'record', rootId: 'saved-root', stageId: 'saved-stage' });
  const retry = harness.context.handleTransformRetry({
    tabId: 1,
    descriptor: state.format.retry,
  });
  await waitFor(() => router.count('/format') === 1, 'saved source retry did not start');
  router.resolve('/format', jsonResponse({ text: 'retried result' }));
  assert.equal((await retry).ok, true);
});

test('test_orphan_activity_marker_is_cleared', async () => {
  const local = createPersistentStorage({ 'tl2Translating:1': true });
  const harness = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const state = await reconcile(harness);
  assert.equal(state.translate.active, false);
  assert.equal(local.values['tl2Translating:1'], undefined);
});

test('test_record_url_mismatch_is_safe_and_nonretryable', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': savedRecord({ sourceUrl: 'https://example.test/other' }),
    'transcript_raw:1': 'legacy source',
    'transcript:1': { text: 'legacy source', url: 'https://example.test/video' },
  });
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ local, fetch: router.fetch });
  const state = await reconcile(harness);
  assert.equal(state.format.retry, null);
  assert.equal(router.calls.length, 0);
  assert.deepEqual(local.values['transform:operation:1'], savedRecord({ sourceUrl: 'https://example.test/other' }));
});

test('test_restart_between_terminal_write_and_record_removal_is_idempotent', async () => {
  const local = createPersistentStorage({
    'transform:operation:1': savedRecord({ status: 'running', error: '' }),
    'transcript_recovery:1': stoppedMarker(),
    'tl2Translating:1': true,
  });
  const first = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const firstState = await reconcile(first);
  assert.equal(firstState.format.retry, null);
  assert.equal(local.values['transform:operation:1'], undefined);
  assert.equal(local.values['tl2Translating:1'], undefined);

  const second = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const secondState = await reconcile(second);
  assert.equal(secondState.format.retry, null);
  assert.equal(local.values['transform:operation:1'], undefined);
  assert.deepEqual(local.values['transcript_recovery:1'], stoppedMarker());
});
