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
    set(next) { Object.assign(values, structuredClone(next)); return Promise.resolve(); },
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

async function stopCurrent(harness) {
  const result = await harness.context.handleStop();
  assert.equal(result.ok, true);
  await delay();
}

test('test_forced_chain_sends_force_true_to_format_and_translate', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({
    fetch: router.fetch,
    syncValues: { yt2txtAutoTranslate: true, tl2Language: 'French' },
  });
  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  assert.deepEqual(router.entry('/transcript').body, {
    url: 'https://example.test/video',
    force: true,
  });
  router.resolve('/transcript', jsonResponse({ text: 'raw', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  assert.deepEqual(router.entry('/format').body, { text: 'raw', force: true });
  router.resolve('/format', jsonResponse({ text: 'formatted' }));
  await waitFor(() => router.count('/translate') === 1, 'translate did not start');
  assert.deepEqual(router.entry('/translate').body, {
    text: 'formatted',
    language: 'French',
    force: true,
  });
  router.resolve('/translate', jsonResponse({ text: 'translated' }));
  await operation;
});

test('test_forced_chain_does_not_enable_translation', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch, syncValues: { yt2txtAutoTranslate: false } });
  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'raw', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  router.resolve('/format', jsonResponse({ text: 'formatted' }));
  await operation;
  assert.equal(router.count('/translate'), 0);
});

test('test_keyboard_and_standalone_actions_omit_force', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const keyboard = harness.context.handleStart({ url: 'https://example.test/keyboard' });
  await waitFor(() => router.count('/transcript') === 1, 'keyboard transcript did not start');
  assert.deepEqual(router.entry('/transcript').body, { url: 'https://example.test/keyboard' });
  router.resolve('/transcript', jsonResponse({ text: 'keyboard raw', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'keyboard format did not start');
  assert.deepEqual(router.entry('/format').body, { text: 'keyboard raw' });
  router.resolve('/format', jsonResponse({ text: 'keyboard formatted' }));
  await keyboard;

  const format = harness.context.handleFormatStart({ tabId: 1, text: 'standalone format', force: true });
  await waitFor(() => router.count('/format') === 2, 'standalone format did not start');
  assert.deepEqual(router.entry('/format', 1).body, { text: 'standalone format' });
  router.resolve('/format', jsonResponse({ text: 'standalone formatted' }), 1);
  await format;

  const translate = harness.context.handleTranslateStart({
    tabId: 1,
    text: 'standalone translation',
    language: 'French',
    force: true,
  });
  await waitFor(() => router.count('/translate') === 1, 'standalone translation did not start');
  assert.deepEqual(router.entry('/translate').body, {
    text: 'standalone translation',
    language: 'French',
  });
  router.resolve('/translate', jsonResponse({ text: 'standalone translated' }));
  await translate;
});

test('test_original_translation_does_not_receive_force_provider_work', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const result = await harness.context.handleTranslateStart({
    tabId: 1,
    text: 'keep this text',
    language: 'original',
    force: true,
  });
  assert.equal(result.ok, true);
  assert.equal(router.count('/translate'), 0);
  assert.equal(harness.local.values['translate:result:1'], 'keep this text');
});

test('test_forced_backend_validation_error_is_not_retried_without_force', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({ fetch: router.fetch });
  const operation = harness.context.handleStart({ url: 'https://example.test/video', force: true });
  await waitFor(() => router.count('/transcript') === 1, 'transcript did not start');
  router.resolve('/transcript', jsonResponse({ text: 'source', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'format did not start');
  assert.deepEqual(router.entry('/format').body, { text: 'source', force: true });
  router.resolve('/format', jsonResponse({ error: 'force is unsupported' }, { ok: false, status: 422 }));
  const result = await operation;
  assert.equal(router.count('/format'), 1);
  assert.equal(result.ok, true);
  assert.equal(harness.context.__states.get(1).format.error, 'force is unsupported');
});

test('test_record_retry_body_uses_saved_force_provenance', async () => {
  const router = createFetchRouter();
  const harness = createBackgroundHarness({
    fetch: router.fetch,
    localData: {
      'transform:operation:1': {
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
      },
    },
  });

  const retry = harness.context.handleTransformRetry({
    tabId: 1,
    descriptor: { kind: 'record', rootId: 'saved-root', stageId: 'saved-stage' },
  });
  await waitFor(() => router.count('/format') === 1, 'record retry did not start');
  assert.deepEqual(router.entry('/format').body, { text: 'saved source', force: true });
  assert.equal(router.count('/format'), 1);
  router.resolve('/format', jsonResponse({ text: 'retried format' }));
  const result = await retry;
  assert.equal(result.ok, true);
});
