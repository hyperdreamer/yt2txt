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

function jsonResponse(body, { ok = true, status = 200, beforeJson, beforeText } = {}) {
  return {
    ok,
    status,
    json: async () => {
      await beforeJson?.();
      return structuredClone(body);
    },
    text: async () => {
      await beforeText?.();
      return JSON.stringify(body);
    },
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

function createBackgroundHarness({
  local,
  fetch,
  syncValues = {},
  tabUrl = 'https://example.test/video',
  beforeSyncGet,
  beforeCreateDocument,
} = {}) {
  const persistent = local || createPersistentStorage();
  const sync = { ...syncValues };
  const runtimeMessages = [];
  const notifications = [];
  const onStorageChanged = createEvent();
  const onTabRemoved = createEvent();
  const tab = { id: 1, windowId: 10, active: true, url: tabUrl };
  const chrome = {
    storage: {
      onChanged: onStorageChanged,
      local: persistent,
      sync: {
        get(defaults) {
          return Promise.resolve().then(async () => {
            await beforeSyncGet?.(defaults);
            return { ...defaults, ...sync };
          });
        },
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
    offscreen: {
      createDocument: async details => { await beforeCreateDocument?.(details); },
      closeDocument: async () => {},
    },
    notifications: {
      create(...args) { notifications.push(args); },
    },
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
  return { context, local: persistent, sync, runtimeMessages, notifications, onTabRemoved, tab };
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
  await waitFor(() => harness.context.__states.get(1)?.format?.sourceText === 'new source', 'replacement root was not accepted');
  barrier.resolve();
  await waitFor(() => router.count('/format') === 1, 'replacement format did not start');
  await operation;

  const restarted = createBackgroundHarness({ local, fetch: createFetchRouter().fetch });
  const recovered = await reconcile(restarted);
  const acceptedRecord = local.values['transform:operation:1'];
  assert.equal(acceptedRecord.sourceText, 'new source');
  assert.deepEqual(plain(recovered.format.retry), {
    kind: 'record',
    rootId: acceptedRecord.rootId,
    stageId: acceptedRecord.stageId,
  });
  assert.equal(recovered.format.sourceText, 'new source');
  router.resolve('/format', jsonResponse({ text: 'new result' }));
  await replacement;

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
  assert.equal(state.format.force, true);
  assert.equal(state.force, true);
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
  assert.equal(state.format.force, false);
  assert.equal(state.force, false);
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

async function runAtAsyncBoundary(boundary) {
  const gate = deferred();
  let entered = false;
  let hookUsed = false;
  const block = async () => {
    if (hookUsed) return;
    hookUsed = true;
    entered = true;
    await gate.promise;
  };
  const local = boundary === 'recovery-read'
    ? createPersistentStorage({
      'transform:operation:1': savedRecord({ status: 'running', error: '' }),
    })
    : createPersistentStorage();
  const router = createFetchRouter();
  const harnessOptions = { local, fetch: router.fetch };

  if (boundary === 'storage-set') {
    local.hooks.set = async next => {
      if (next['transform:operation:1']?.status === 'running') await block();
    };
  } else if (boundary === 'storage-remove') {
    local.hooks.remove = async keys => {
      if (keys.includes('tl2Translating:1')) await block();
    };
  } else if (boundary === 'recovery-read') {
    local.hooks.get = async keys => {
      if (Array.isArray(keys) && keys.includes('transform:operation:1')) await block();
    };
  } else if (boundary === 'textkit-endpoint-settings') {
    harnessOptions.beforeSyncGet = async defaults => {
      if (Object.hasOwn(defaults, 'textkitHost')) await block();
    };
  } else if (boundary === 'auto-copy-settings') {
    harnessOptions.syncValues = { fmtAutoCopy: true };
    harnessOptions.beforeSyncGet = async defaults => {
      if (Object.hasOwn(defaults, 'fmtAutoCopy')) await block();
    };
  } else if (boundary === 'auto-save-settings') {
    harnessOptions.syncValues = { fmtAutoSave: true, fmtAutoSavePath: 'formatted.txt' };
    harnessOptions.beforeSyncGet = async defaults => {
      if (Object.hasOwn(defaults, 'fmtAutoSave')) await block();
    };
  } else if (boundary === 'auto-translate-settings') {
    harnessOptions.syncValues = { yt2txtAutoTranslate: true, tl2Language: 'Japanese' };
    harnessOptions.beforeSyncGet = async defaults => {
      if (Object.hasOwn(defaults, 'yt2txtAutoTranslate')) await block();
    };
  } else if (boundary === 'filebridge-endpoint-settings') {
    harnessOptions.syncValues = { fmtAutoSave: true, fmtAutoSavePath: 'formatted.txt' };
    harnessOptions.beforeSyncGet = async defaults => {
      if (Object.hasOwn(defaults, 'fileBridgeHost')) await block();
    };
  } else if (boundary === 'copy-setup') {
    harnessOptions.syncValues = { fmtAutoCopy: true };
    harnessOptions.beforeCreateDocument = block;
  } else if (boundary === 'save-response') {
    harnessOptions.syncValues = { fmtAutoSave: true, fmtAutoSavePath: 'formatted.txt' };
  } else if (boundary === 'response-parse') {
    harnessOptions.syncValues = { fmtAutoCopy: true };
  }

  const harness = createBackgroundHarness(harnessOptions);
  let initialOperation;
  let reconciliation;
  if (boundary === 'recovery-read') {
    reconciliation = reconcile(harness);
    await waitFor(() => entered, 'reconciliation storage read did not block');
  } else {
    initialOperation = harness.context.handleFormatStart({
      tabId: 1,
      text: 'initial source',
      url: harness.tab.url,
    });
    if (boundary === 'storage-set' || boundary === 'storage-remove' || boundary === 'textkit-endpoint-settings') {
      await waitFor(() => entered, `${boundary} did not block`);
    } else {
      await waitFor(() => router.count('/format') === 1, 'initial format did not start');
      if (boundary === 'response-parse') {
        router.resolve('/format', jsonResponse({ text: 'formatted source' }, { beforeJson: block }));
        await waitFor(() => entered, 'response parsing did not block');
      } else {
        router.resolve('/format', jsonResponse({ text: 'formatted source' }));
        if (boundary === 'auto-copy-settings' || boundary === 'auto-save-settings' ||
            boundary === 'auto-translate-settings' || boundary === 'filebridge-endpoint-settings') {
          await waitFor(() => entered, `${boundary} did not block`);
        } else if (boundary === 'copy-setup') {
          await waitFor(() => entered, 'offscreen copy setup did not block');
        } else if (boundary === 'save-response') {
          await waitFor(() => router.count('/save') === 1, 'automatic save did not start');
          router.resolve('/save', jsonResponse({ ok: true, path: 'formatted.txt' }, { beforeText: block }));
          await waitFor(() => entered, 'save response read did not block');
        }
      }
    }
  }

  return {
    boundary,
    gate,
    harness,
    initialOperation,
    reconciliation,
    router,
    release() { gate.resolve(); },
  };
}

async function interleaveAtBoundary(scenario, interleaving) {
  const { context } = scenario.harness;
  const state = context.__states.get(1);
  const originalRootId = state?.rootId || null;
  const initialFormatCalls = scenario.router.count('/format');
  let newerOperation;

  if (interleaving === 'stop') {
    const stopping = context.handleStop(1);
    scenario.release();
    assert.equal((await stopping).ok, true);
  } else if (interleaving === 'replacement') {
    newerOperation = context.handleFormatStart({ tabId: 1, text: 'replacement source', url: scenario.harness.tab.url });
    await waitFor(() => {
      const current = context.__states.get(1);
      return current?.format?.sourceText === 'replacement source' && current.rootId !== originalRootId;
    }, 'replacement root was not accepted');
    scenario.release();
    await waitFor(() => scenario.router.count('/format') === initialFormatCalls + 1, 'replacement format was not dispatched');
  } else if (interleaving === 'close') {
    const closing = scenario.harness.onTabRemoved.emit(1)[0];
    scenario.release();
    await closing;
  } else if (interleaving === 'new-work') {
    const stopping = context.handleStop(1);
    scenario.release();
    assert.equal((await stopping).ok, true);
    if (scenario.initialOperation) await scenario.initialOperation;
    if (scenario.reconciliation) await scenario.reconciliation;
    newerOperation = context.handleFormatStart({ tabId: 1, text: 'new work source', url: scenario.harness.tab.url });
    await waitFor(() => scenario.router.count('/format') === initialFormatCalls + 1, 'new work format was not dispatched');
  } else {
    assert.fail(`unknown interleaving: ${interleaving}`);
  }

  if (scenario.initialOperation) await scenario.initialOperation;
  if (scenario.reconciliation) await scenario.reconciliation;

  const expectedFormatCalls = initialFormatCalls + (interleaving === 'replacement' || interleaving === 'new-work' ? 1 : 0);
  assert.equal(scenario.router.count('/format'), expectedFormatCalls);
  assert.equal(scenario.router.count('/translate'), 0);
  assert.equal(scenario.router.count('/save'), scenario.boundary === 'save-response' ? 1 : 0);
  assert.equal(
    scenario.harness.runtimeMessages.filter(message => message.type === 'offscreen:copy').length,
    0,
  );
  assert.equal(scenario.harness.notifications.length, 0);

  if (newerOperation) {
    const stopping = context.handleStop(1);
    await stopping;
    await newerOperation;
  }
}

for (const boundary of [
  'storage-set',
  'storage-remove',
  'recovery-read',
  'textkit-endpoint-settings',
  'auto-copy-settings',
  'auto-save-settings',
  'auto-translate-settings',
  'filebridge-endpoint-settings',
  'response-parse',
  'copy-setup',
  'save-response',
]) {
  for (const interleaving of ['stop', 'replacement', 'close', 'new-work']) {
    test(`stale ${boundary} continuation is fenced during ${interleaving}`, async () => {
      const scenario = await runAtAsyncBoundary(boundary);
      await interleaveAtBoundary(scenario, interleaving);
    });
  }
}

test('test_newer_in_memory_root_beats_older_matching_terminal_record', async () => {
  const router = createFetchRouter();
  const local = createPersistentStorage();
  const harness = createBackgroundHarness({ local, fetch: router.fetch });
  const currentOperation = harness.context.handleFormatStart({
    tabId: 1,
    text: 'new source',
    url: harness.tab.url,
  });
  await waitFor(() => router.count('/format') === 1, 'newer format did not start');
  const stateBefore = harness.context.__states.get(1);
  const newerRootId = stateBefore.rootId;
  const newerStageId = stateBefore.stageId;
  await local.set({
    'transform:operation:1': savedRecord({ rootId: 'old-root', stageId: 'old-stage' }),
    'transcript_recovery:1': completedMarker('old-root'),
  });

  const state = await reconcile(harness);
  assert.equal(state.rootId, newerRootId);
  assert.equal(state.stageId, newerStageId);
  assert.equal(state.active, false);
  assert.equal(state.format.active, true);
  assert.equal(state.format.sourceText, 'new source');

  await harness.context.handleFormatStop(1, { rootId: newerRootId, stageId: newerStageId });
  await currentOperation;
});

function localTranscript(text, url) {
  return {
    'transcript:1': { text, url },
    'transcript_raw:1': text,
  };
}

test('reconciliation hydrates persisted transcript object for the exact tab URL', async () => {
  const local = createPersistentStorage(localTranscript('matching text', 'https://example.test/video'));
  const state = await reconcile(createBackgroundHarness({ local, fetch: createFetchRouter().fetch }));
  assert.equal(state.transcript, 'matching text');
});

test('reconciliation hydrates persisted raw local path for an equivalent file URL', async () => {
  const local = createPersistentStorage(localTranscript('local text', '/a/My Video.mp4'));
  const harness = createBackgroundHarness({
    local,
    fetch: createFetchRouter().fetch,
    tabUrl: 'file:///a/My%20Video.mp4',
  });
  const state = await reconcile(harness);
  assert.equal(state.transcript, 'local text');
  assert.deepEqual(plain(state.format.retry), { kind: 'legacy' });
});

test('reconciliation hydrates a file URL transcript for its equivalent raw path', async () => {
  const local = createPersistentStorage(localTranscript('local text', 'file:///a/My%20Video.mp4'));
  const harness = createBackgroundHarness({
    local,
    fetch: createFetchRouter().fetch,
    tabUrl: '/a/My Video.mp4',
  });
  const state = await reconcile(harness);
  assert.equal(state.transcript, 'local text');
  assert.deepEqual(plain(state.format.retry), { kind: 'legacy' });
});

test('legacy local-path retry accepts the equivalent file URL and retains Force', async () => {
  const router = createFetchRouter();
  const local = createPersistentStorage({
    ...localTranscript('local text', '/a/My Video.mp4'),
    'transcript_force:1': true,
  });
  const harness = createBackgroundHarness({
    local,
    fetch: router.fetch,
    tabUrl: 'file:///a/My%20Video.mp4',
  });
  const state = await reconcile(harness);
  const retry = harness.context.handleTransformRetry({ tabId: 1, descriptor: state.format.retry });
  await waitFor(() => router.count('/format') === 1, 'local transcript retry did not start');
  assert.equal(JSON.parse(router.entry('/format').init.body).force, true);
  router.resolve('/format', jsonResponse({ text: 'formatted local text' }));
  assert.equal((await retry).ok, true);
});

test('reconciliation hydrates a legacy string transcript entry', async () => {
  const local = createPersistentStorage({ 'transcript:1': 'legacy transcript text' });
  const state = await reconcile(createBackgroundHarness({ local, fetch: createFetchRouter().fetch }));
  assert.equal(state.transcript, 'legacy transcript text');
});

test('reconciliation does not hydrate a transcript object from another URL', async () => {
  const local = createPersistentStorage(localTranscript('other source', 'https://example.test/other'));
  const state = await reconcile(createBackgroundHarness({ local, fetch: createFetchRouter().fetch }));
  assert.equal(state.transcript, '');
  assert.equal(state.format.retry, null);
});

test('legacy recovery defaults absent Force to false', async () => {
  const local = createPersistentStorage({
    'transcript_raw:1': 'saved transcript',
    'transcript:1': { text: 'saved transcript', url: 'https://example.test/video' },
  });
  const state = await reconcile(createBackgroundHarness({ local, fetch: createFetchRouter().fetch }));
  assert.equal(state.force, false);
  assert.equal(state.format.force, false);
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
