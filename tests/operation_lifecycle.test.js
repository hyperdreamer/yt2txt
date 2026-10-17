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
      if (typeof keys === 'string') {
        return Promise.resolve(Object.hasOwn(values, keys) ? { [keys]: structuredClone(values[keys]) } : {});
      }
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
          if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
        }
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
    clearTimeout: options.clearTimeout || clearTimeout,
    console,
    crypto: webcrypto,
    fetch: options.fetch,
    setInterval: () => 1,
    setTimeout: options.setTimeout || unrefTimeout,
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
  harness.context.__states.set(1, fullState({
    format: { sourceText: 'old source', resultText: 'old format', active: false, status: 'Formatted', error: '' },
    translate: { sourceText: 'old format', resultText: 'old translation', active: false, status: 'Translation complete.', error: '' },
  }));

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
  // E2-F9: persisted invalidation and the display must agree after publication.
  const state = harness.context.__states.get(1);
  assert.equal(state.format.sourceText, 'accepted transcript');
  assert.equal(state.format.resultText, 'formatted');
  assert.equal(state.translate.sourceText, '');
  assert.equal(state.translate.resultText, '');
  assert.equal(state.translate.status, '');
  const latest = harness.runtimeMessages.filter(message => message.type === 'state:update').at(-1).state;
  assert.equal(latest.translate.sourceText, '');
  assert.equal(latest.translate.resultText, '');
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

function savedOperation(overrides = {}) {
  return {
    version: 1, rootId: 'saved-root', stageId: 'saved-stage', tabId: 1,
    stage: 'format', status: 'failed', sourceText: 'saved source',
    sourceUrl: 'https://example.test/video', sourceKind: 'transcript',
    language: null, force: true, error: 'previous backend error', ...overrides,
  };
}

function recordRetry(harness) {
  return harness.context.handleTransformRetry({
    tabId: 1, descriptor: { kind: 'record', rootId: 'saved-root', stageId: 'saved-stage' },
  });
}

// E2-F1: pending acceptance must not outlive Stop, a replacement, or its saved record.
test('pending record and legacy retries stay stopped after tab lookup resumes', async t => {
  for (const kind of ['record', 'legacy']) await t.test(kind, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch, localData: {
      'transform:operation:1': savedOperation(), 'transcript_raw:1': 'saved source',
      'transcript:1': { text: 'saved source', url: 'https://example.test/video' },
    } });
    const lookup = deferred();
    let lookingUp = false;
    harness.context.chrome.tabs.get = () => { lookingUp = true; return lookup.promise; };
    const retry = harness.context.handleTransformRetry({ tabId: 1, descriptor: kind === 'record'
      ? { kind, rootId: 'saved-root', stageId: 'saved-stage' } : { kind } });
    await waitFor(() => lookingUp, 'retry did not look up the tab');
    const stopped = await harness.context.handleStop(1);
    const afterStop = harness.runtimeMessages.length;
    lookup.resolve(structuredClone(harness.tab));
    await delay();
    // Settle buggy dispatches too, so the red phase fails by assertion.
    if (router.count('/format')) router.resolve('/format', jsonResponse({ text: 'unwanted result' }));
    const result = await retry;
    assert.equal(stopped.ok, true);
    assert.equal(result.ok, false);
    assert.equal(router.calls.length, 0);
    assert.equal(harness.local.values['fmtResult:1'], undefined);
    assert.equal(harness.local.values['transform:operation:1'], undefined);
    assert.equal(harness.runtimeMessages.length, afterStop);
  });
});

test('record retry revalidates storage after lookup and cannot replace a newer root', async t => {
  for (const change of ['removed', 'changed', 'new-root']) await t.test(change, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch, localData: { 'transform:operation:1': savedOperation() } });
    const lookup = deferred();
    let lookingUp = false;
    harness.context.chrome.tabs.get = () => { lookingUp = true; return lookup.promise; };
    const retry = recordRetry(harness);
    await waitFor(() => lookingUp, 'retry did not look up the tab');
    if (change === 'removed') delete harness.local.values['transform:operation:1'];
    if (change === 'changed') harness.local.values['transform:operation:1'] = savedOperation({ sourceText: 'changed source' });
    if (change === 'new-root') {
      const replacement = harness.context.handleFormatStart({ tabId: 1, text: 'replacement', url: harness.tab.url });
      await waitFor(() => router.count('/format') === 1, 'replacement did not start');
      router.resolve('/format', jsonResponse({ text: 'replacement result' }));
      await replacement;
    }
    lookup.resolve(structuredClone(harness.tab));
    await delay();
    const expectedCount = change === 'new-root' ? 1 : 0;
    if (router.count('/format') > expectedCount) router.resolve('/format', jsonResponse({ text: 'unwanted result' }), expectedCount);
    const result = await retry;
    assert.equal(result.ok, false);
    assert.equal(router.count('/format'), expectedCount);
    assert.equal(harness.local.values['fmtResult:1'], expectedCount ? 'replacement result' : undefined);
  });
});

test('Stop fences starts waiting for their initial tab lookup', async t => {
  for (const stage of ['format', 'translate', 'transcript']) await t.test(stage, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch });
    const lookup = deferred();
    if (stage === 'transcript') harness.context.chrome.tabs.query = () => lookup.promise;
    else harness.context.chrome.tabs.get = () => lookup.promise;
    const operation = stage === 'format' ? harness.context.handleFormatStart({ tabId: 1, text: 'source' })
      : stage === 'translate' ? harness.context.handleTranslateStart({ tabId: 1, text: 'source', language: 'French' })
        : harness.context.handleStart({ url: harness.tab.url });
    const stopped = await harness.context.handleStop(1);
    lookup.resolve(stage === 'transcript' ? [structuredClone(harness.tab)] : structuredClone(harness.tab));
    await delay();
    for (const call of router.calls) call.pending.resolve(jsonResponse({ error: 'unwanted dispatch' }, { ok: false, status: 500 }));
    const result = await operation;
    assert.equal(stopped.ok, true);
    assert.equal(result.ok, false);
    assert.equal(router.calls.length, 0);
    assert.equal(harness.context.__states.has(1), false);
    assert.equal(harness.runtimeMessages.some(message => message.type === 'state:update'), false);
  });
});

// E2-F2/F3: Stop writes its marker before removal and covers pending cleanup awaits.
test('Stop persists a root-owned stopped marker before acknowledging cleanup', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: harness.tab.url });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'accepted transcript' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  const rootId = harness.local.values['transform:operation:1'].rootId;
  const remove = harness.local.remove;
  let markerBeforeRemoval;
  harness.local.remove = async keys => {
    if (keys.includes('transform:operation:1')) markerBeforeRemoval = structuredClone(harness.local.values['transcript_recovery:1']);
    return remove(keys);
  };
  const result = await harness.context.handleStop(1);
  await operation;
  const marker = { version: 1, rootId, terminal: 'stopped' };
  assert.equal(result.ok, true);
  assert.deepEqual(markerBeforeRemoval, marker);
  assert.deepEqual(harness.local.values['transcript_recovery:1'], marker);
  assert.equal(harness.local.values['transform:operation:1'], undefined);
  assert.equal(harness.local.values['tl2Translating:1'], undefined);
  assert.equal(harness.context.__states.get(1).format.active, false);
  assert.ok(harness.runtimeMessages.some(message => message.type === 'tl2:translating' && message.value === false));
});

test('Stop reports a terminal-marker storage failure and releases cleanup coverage', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  const set = harness.local.set;
  harness.local.set = next => Object.hasOwn(next, 'transcript_recovery:1')
    ? Promise.reject(new Error('disk unavailable')) : set(next);
  const result = await harness.context.handleStop(1);
  await operation;
  assert.equal(result.ok, false);
  assert.match(result.error, /persist|storage/i);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
  assert.equal(harness.context.__states.get(1).format.active, false);
});

test('Stop and tab close retain keepalive while queued cleanup is blocked', async t => {
  for (const action of ['stop', 'tab-close']) await t.test(action, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch });
    const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
    await waitFor(() => router.count('/format') === 1, 'format did not start');
    const barrier = deferred();
    let removing = false;
    const remove = harness.local.remove;
    harness.local.remove = async keys => {
      if (keys.includes('transform:operation:1')) { removing = true; await barrier.promise; }
      return remove(keys);
    };
    let acknowledged = false;
    const cleanup = action === 'stop'
      ? harness.context.handleStop(1).then(result => { acknowledged = true; return result; })
      : Promise.all(harness.onTabRemoved.emit(1));
    await waitFor(() => removing, 'cleanup did not reach storage');
    await operation;
    const covered = harness.context.__isKeepAliveRunning();
    const earlyAck = acknowledged;
    barrier.resolve();
    await cleanup;
    await waitFor(() => !harness.context.__isKeepAliveRunning(), 'cleanup coverage leaked');
    assert.equal(covered, true);
    assert.equal(earlyAck, false);
    assert.equal(harness.local.values['transform:operation:1'], undefined);
    if (action === 'tab-close') assert.equal(harness.context.__states.has(1), false);
  });
});

test('tab-close cleanup failure releases keepalive and reports its storage error', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const errors = [];
  harness.context.console = { ...console, error: (...args) => errors.push(args) };
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  harness.local.remove = async () => { throw new Error('disk unavailable'); };
  await Promise.all(harness.onTabRemoved.emit(1));
  await operation;
  assert.equal(harness.context.__isKeepAliveRunning(), false);
  assert.equal(harness.context.__states.has(1), false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /storage|disk unavailable/i);
});

// E2-F4: a rejected publication must surface an error and release every reserved stage.
test('storage publication failures terminate stages and preserve previous results', async t => {
  for (const stage of ['transcript', 'format', 'translate', 'original']) await t.test(stage, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch, localData: {
      'transcript:1': { text: 'previous transcript', url: 'https://example.test/video' },
      'transcript_raw:1': 'previous transcript', 'fmtResult:1': 'previous format',
      'translate:result:1': 'previous translation',
    } });
    const resultKey = stage === 'transcript' ? 'transcript:1' : stage === 'format' ? 'fmtResult:1' : 'translate:result:1';
    const set = harness.local.set;
    let failed = false;
    harness.local.set = async next => {
      if (!failed && Object.hasOwn(next, resultKey)) { failed = true; throw new Error('disk unavailable'); }
      return set(next);
    };
    const operation = stage === 'transcript' ? harness.context.handleStart({ url: harness.tab.url })
      : stage === 'format' ? harness.context.handleFormatStart({ tabId: 1, text: 'source' })
        : harness.context.handleTranslateStart({ tabId: 1, text: 'source', language: stage === 'original' ? 'original' : 'French' });
    if (stage !== 'original') {
      await waitFor(() => router.count(`/${stage}`) === 1, `${stage} did not start`);
      router.resolve(`/${stage}`, jsonResponse({ text: 'new result' }));
    }
    const result = await operation;
    assert.equal(result.ok, false);
    assert.match(result.error, /persist|storage/i);
    const state = harness.context.__states.get(1);
    const display = stage === 'transcript' ? state : state[stage === 'format' ? 'format' : 'translate'];
    assert.equal(display.active, false);
    assert.match(display.error, /persist|storage/i);
    assert.equal(harness.context.__formatControllers.has(1), false);
    assert.equal(harness.context.__translateControllers.has(1), false);
    assert.equal(harness.context.__transcriptControllers.has(1), false);
    assert.equal(harness.context.__isKeepAliveRunning(), false);
    assert.equal(harness.local.values['fmtResult:1'], 'previous format');
    assert.equal(harness.local.values['translate:result:1'], 'previous translation');
    assert.equal(harness.local.values['transcript_raw:1'], 'previous transcript');
    assert.equal(harness.local.values['tl2Translating:1'], undefined);
    if (stage === 'format' || stage === 'translate') {
      assert.equal(harness.local.values['transform:operation:1'].status, 'failed');
      assert.match(harness.local.values['transform:operation:1'].error, /persist|storage/i);
    } else assert.equal(harness.local.values['transform:operation:1'], undefined);
    assert.ok(harness.runtimeMessages.some(message => message.type === 'state:update' && (stage === 'transcript'
      ? message.state.error : message.state[stage === 'format' ? 'format' : 'translate'].error)));
    if (stage === 'transcript') assert.equal(router.count('/format'), 0);
  });
});

// E2-F5: the worker's own deadline must retain authority to publish its terminal error.
test('transcript deadline publishes an idle timeout and permits a subsequent start', async () => {
  const router = createFetchRouter();
  const timers = [];
  const harness = createBackgroundHarness({ fetch: router.fetch,
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout() {},
  });
  const first = harness.context.handleStart({ url: harness.tab.url });
  await waitFor(() => router.count('/transcript') === 1, 'first transcript did not start');
  timers.find(timer => timer.ms === 120 * 60 * 1000).callback();
  await first;
  const timedOut = structuredClone(harness.context.__states.get(1));
  const second = harness.context.handleStart({ url: harness.tab.url });
  await delay();
  if (router.count('/transcript') === 2) {
    router.resolve('/transcript', jsonResponse({ text: 'after timeout' }), 1);
    await waitFor(() => router.count('/format') === 1, 'second format did not start');
    router.resolve('/format', jsonResponse({ text: 'after timeout formatted' }));
  }
  const result = await second;
  assert.equal(timedOut.active, false);
  assert.match(timedOut.error, /timed out after 120 minutes/i);
  assert.ok(harness.runtimeMessages.some(message => message.type === 'state:update' && /timed out/i.test(message.state.error)));
  assert.equal(result.ok, true);
  assert.equal(router.count('/transcript'), 2);
  assert.equal(harness.local.values['transcript_raw:1'], 'after timeout');
  assert.equal(harness.local.values['fmtResult:1'], 'after timeout formatted');
});

// E2-F6: only the replacement's activity survives cross-stage root acceptance.
test('replacement roots clear predecessor activity while retaining completed text', async t => {
  for (const [previous, replacement] of [['transcript', 'format'], ['format', 'translate'], ['translate', 'format']]) {
    await t.test(`${previous} to ${replacement}`, async () => {
      const router = createFetchRouter();
      const harness = createBackgroundHarness({ fetch: router.fetch });
      harness.context.__states.set(1, fullState({ transcript: 'previous completed transcript' }));
      const first = previous === 'transcript' ? harness.context.handleStart({ url: harness.tab.url })
        : previous === 'format' ? harness.context.handleFormatStart({ tabId: 1, text: 'old source' })
          : harness.context.handleTranslateStart({ tabId: 1, text: 'old source', language: 'French' });
      await waitFor(() => router.count(`/${previous}`) === 1, 'predecessor did not start');
      const second = replacement === 'format' ? harness.context.handleFormatStart({ tabId: 1, text: 'replacement source' })
        : harness.context.handleTranslateStart({ tabId: 1, text: 'replacement source', language: 'French' });
      await waitFor(() => router.count(`/${replacement}`) === 1, 'replacement did not start');
      router.resolve(`/${replacement}`, jsonResponse({ text: 'replacement result' }));
      await second;
      await first;
      const state = structuredClone(harness.context.__states.get(1));
      const latest = harness.runtimeMessages.filter(message => message.type === 'state:update').at(-1).state;
      for (const displayed of [state, latest]) {
        assert.equal(displayed.active, false);
        assert.equal(displayed.format.active, false);
        assert.equal(displayed.translate.active, false);
      }
      assert.equal(state.transcript, 'previous completed transcript');
      assert.equal(harness.context.__isKeepAliveRunning(), false);
      assert.equal(harness.local.values[replacement === 'format' ? 'fmtResult:1' : 'translate:result:1'], 'replacement result');
      assert.equal(harness.local.values['tl2Translating:1'], undefined);
      if (previous === 'transcript') {
        const next = harness.context.handleStart({ url: harness.tab.url });
        await delay();
        assert.equal(router.count('/transcript'), 2);
        await harness.context.handleStop(1);
        await next;
      }
    });
  }
});

// E2-F7: preliminary tab lookup must not resurrect a closed tab.
test('tab close fences every start before its initial lookup resolves', async t => {
  for (const stage of ['transcript', 'format', 'translate']) await t.test(stage, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch });
    const lookup = deferred();
    if (stage === 'transcript') harness.context.chrome.tabs.query = () => lookup.promise;
    else harness.context.chrome.tabs.get = () => lookup.promise;
    const operation = stage === 'transcript' ? harness.context.handleStart({ url: harness.tab.url })
      : stage === 'format' ? harness.context.handleFormatStart({ tabId: 1, text: 'source' })
        : harness.context.handleTranslateStart({ tabId: 1, text: 'source', language: 'French' });
    await Promise.all(harness.onTabRemoved.emit(1));
    lookup.resolve(stage === 'transcript' ? [structuredClone(harness.tab)] : structuredClone(harness.tab));
    const result = await operation;
    assert.equal(result.ok, false);
    assert.equal(harness.context.__states.has(1), false);
    assert.equal(router.calls.length, 0);
    assert.equal(harness.runtimeMessages.length, 0);
    assert.deepEqual(harness.local.values, {});
  });
});

// E2-F8: a persisted retry initializes display state without a prior popup request.
test('saved-record retries publish activity and completion in a fresh worker', async t => {
  for (const stage of ['format', 'translate']) await t.test(stage, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch,
      localData: { 'transform:operation:1': savedOperation({ stage, language: stage === 'format' ? null : 'French' }) },
    });
    const retry = recordRetry(harness);
    await waitFor(() => router.count(`/${stage}`) === 1, 'retry did not start');
    const runningRecord = structuredClone(harness.local.values['transform:operation:1']);
    router.resolve(`/${stage}`, jsonResponse({ text: 'retried result' }));
    await retry;
    assert.ok(harness.runtimeMessages.some(message => message.type === 'state:update' && message.state[stage].active));
    assert.ok(harness.runtimeMessages.some(message => message.type === 'state:update' && message.state[stage].resultText === 'retried result' && !message.state[stage].active));
    assert.equal(harness.context.__states.get(1)[stage].resultText, 'retried result');
    assert.equal(runningRecord.force, true);
    assert.notEqual(runningRecord.rootId, 'saved-root');
    assert.notEqual(runningRecord.stageId, 'saved-stage');
    assert.equal(harness.local.values[stage === 'format' ? 'fmtResult:1' : 'translate:result:1'], 'retried result');
    assert.equal(harness.local.values['transform:operation:1'], undefined);
  });
});

// E2-F10: malformed records must never cross the retry trust boundary.
test('retry rejects failed records with empty errors or missing required fields', async t => {
  const cases = [
    ['empty error', savedOperation({ error: '' })], ['whitespace error', savedOperation({ error: ' \n\t' })],
    ['unknown version', savedOperation({ version: 2 })], ['wrong tab', savedOperation({ tabId: 2 })],
    ['empty source', savedOperation({ sourceText: ' ' })],
    ['wrong source URL', savedOperation({ sourceUrl: 'https://example.test/other' })],
    ['unsupported language', savedOperation({ stage: 'translate', language: 'unsupported' })],
    ['string tab ID', savedOperation({ tabId: '1' }), '1'],
    ['non-Boolean force', savedOperation({ force: 'true' })],
    ['non-string error', savedOperation({ error: 1 })],
    ['running record', savedOperation({ status: 'running', error: '' })],
    ['empty root ID', savedOperation({ rootId: '' })],
    ['empty stage ID', savedOperation({ stageId: '' })],
    ['invalid source kind', savedOperation({ sourceKind: 'other' })],
    ['extra field', savedOperation({ extra: true })],
  ];
  for (const key of Object.keys(savedOperation())) {
    const record = savedOperation();
    delete record[key];
    cases.push([`missing ${key}`, record]);
  }
  for (const [name, record, tabId = 1] of cases) await t.test(name, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch, localData: { 'transform:operation:1': record } });
    const retry = harness.context.handleTransformRetry({
      tabId, descriptor: { kind: 'record', rootId: 'saved-root', stageId: 'saved-stage' },
    });
    await delay();
    for (const call of router.calls) call.pending.resolve(jsonResponse({ text: 'unwanted result' }));
    const result = await retry;
    assert.equal(result.ok, false);
    assert.match(result.error, /retry|saved|invalid/i);
    assert.equal(router.calls.length, 0);
    assert.equal(harness.context.__states.has(1), false);
    assert.deepEqual(harness.local.values, { 'transform:operation:1': record });
  });
});

// E2-F11: preserve the existing public translation result/activity notifications.
test('provider and Original translations publish result and activity messages with persistence', async t => {
  for (const language of ['French', 'original']) await t.test(language, async () => {
    const router = createFetchRouter();
    const harness = createBackgroundHarness({ fetch: router.fetch });
    const operation = harness.context.handleTranslateStart({ tabId: 1, text: 'source text', language });
    if (language !== 'original') {
      await waitFor(() => router.count('/translate') === 1, 'translation did not start');
      assert.equal(harness.local.values['tl2Translating:1'], true);
      router.resolve('/translate', jsonResponse({ text: 'translated text' }));
    }
    await operation;
    const text = language === 'original' ? 'source text' : 'translated text';
    assert.deepEqual(harness.runtimeMessages.filter(message => message.type === 'tl2:translating'), [
      { type: 'tl2:translating', tabId: 1, value: true }, { type: 'tl2:translating', tabId: 1, value: false },
    ]);
    assert.deepEqual(harness.runtimeMessages.filter(message => message.type === 'translation:update'), [
      { type: 'translation:update', tabId: 1, text },
    ]);
    assert.equal(harness.context.__states.get(1).translate.resultText, text);
    assert.equal(harness.local.values['translate:result:1'], text);
    assert.equal(harness.local.values['tl2Translating:1'], undefined);
  });
});

test('stale translation finalizers cannot publish idle or results for a replacement', async () => {
  const router = createFetchRouter({ ignoreAbort: true });
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const first = harness.context.handleTranslateStart({ tabId: 1, text: 'old source', language: 'French' });
  await waitFor(() => router.count('/translate') === 1, 'first translation did not start');
  const second = harness.context.handleTranslateStart({ tabId: 1, text: 'new source', language: 'French' });
  await waitFor(() => router.count('/translate') === 2, 'replacement translation did not start');
  const messages = harness.runtimeMessages.length;
  router.resolve('/translate', jsonResponse({ text: 'stale result' }));
  await first;
  assert.equal(harness.runtimeMessages.length, messages);
  assert.equal(harness.local.values['tl2Translating:1'], true);
  router.resolve('/translate', jsonResponse({ text: 'current result' }), 1);
  await second;
  assert.deepEqual(harness.runtimeMessages.filter(message => message.type === 'translation:update'), [
    { type: 'translation:update', tabId: 1, text: 'current result' },
  ]);
  assert.equal(harness.local.values['translate:result:1'], 'current result');
});

// E2-F13: resource cleanup outlives stage currency and respects newer copies.
test('offscreen document closes after its successful stage has released ownership', async () => {
  const router = createFetchRouter();
  const timers = [];
  const harness = createBackgroundHarness({ fetch: router.fetch, syncValues: { fmtAutoCopy: true },
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout() {},
  });
  let closed = 0;
  harness.context.chrome.offscreen.closeDocument = async () => { closed++; };
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  router.resolve('/format', jsonResponse({ text: 'formatted' }));
  await operation;
  assert.equal(harness.context.__formatControllers.has(1), false);
  assert.ok(harness.runtimeMessages.some(message => message.type === 'offscreen:copy' && message.text === 'formatted'));
  await timers.find(timer => timer.ms === 2000).callback();
  await delay();
  assert.equal(closed, 1);
  assert.equal(harness.local.values['fmtResult:1'], 'formatted');
});

test('invalidation during offscreen creation still closes the document without copying', async () => {
  const router = createFetchRouter();
  const timers = [];
  const harness = createBackgroundHarness({ fetch: router.fetch, syncValues: { fmtAutoCopy: true },
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout() {},
  });
  const creation = deferred();
  let creating = false;
  let closed = 0;
  harness.context.chrome.offscreen.createDocument = () => { creating = true; return creation.promise; };
  harness.context.chrome.offscreen.closeDocument = async () => { closed++; };
  const operation = harness.context.handleFormatStart({ tabId: 1, text: 'source' });
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  router.resolve('/format', jsonResponse({ text: 'formatted' }));
  await waitFor(() => creating, 'offscreen creation did not start');
  await harness.context.handleStop(1);
  creation.resolve();
  await operation;
  for (const timer of timers.filter(timer => timer.ms === 2000)) await timer.callback();
  await delay();
  assert.equal(closed, 1);
  assert.equal(harness.runtimeMessages.some(message => message.type === 'offscreen:copy'), false);
  assert.equal(harness.context.__states.get(1).format.active, false);
});

test('older offscreen cleanup cannot close a document reserved for a newer copy', async () => {
  const timers = [];
  const harness = createBackgroundHarness({ fetch: createFetchRouter().fetch,
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout() {},
  });
  let closed = 0;
  harness.context.chrome.offscreen.closeDocument = async () => { closed++; };
  await harness.context.copyToClipboard('first copy');
  const oldCleanup = timers[0];
  const creation = deferred();
  harness.context.chrome.offscreen.createDocument = () => creation.promise;
  const second = harness.context.copyToClipboard('second copy');
  await oldCleanup.callback();
  const earlyClose = closed;
  creation.resolve();
  await second;
  await timers.at(-1).callback();
  await delay();
  assert.equal(earlyClose, 0);
  assert.equal(closed, 1);
  assert.deepEqual(harness.runtimeMessages.filter(message => message.type === 'offscreen:copy').map(message => message.text), ['first copy', 'second copy']);
});
