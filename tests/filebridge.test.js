'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function delay(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, message, timeoutMs = 250) {
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
    emit(...args) { for (const listener of [...listeners]) listener(...args); }
  };
}

function createBackgroundHarness(options = {}) {
  const syncValues = { ...(options.syncValues || {}) };
  const localData = { ...(options.localData || {}) };
  const fetchCalls = [];
  const runtimeMessages = [];

  const onStorageChanged = createEvent();

  const chrome = {
    storage: {
      onChanged: onStorageChanged,
      local: {
        get(keys) {
          let result = {};
          if (Array.isArray(keys)) {
            for (const key of keys) result[key] = localData[key];
          } else if (keys && typeof keys === 'object') {
            result = { ...keys };
            for (const key of Object.keys(keys)) {
              if (Object.hasOwn(localData, key)) result[key] = localData[key];
            }
          } else result = { ...localData };
          return Promise.resolve(result);
        },
        set(values) { Object.assign(localData, values); return Promise.resolve(); },
        remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localData[key];
          return Promise.resolve();
        }
      },
      sync: {
        get(defaults) { return Promise.resolve({ ...defaults, ...syncValues }); },
        set(values) { Object.assign(syncValues, values); return Promise.resolve(); }
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [{ id: 1, windowId: 10, active: true }]
    },
    runtime: {
      onMessage: createEvent(),
      sendMessage(msg) { runtimeMessages.push(msg); return Promise.resolve(); },
      getPlatformInfo(cb) { if (cb) cb({}); }
    },
    offscreen: {
      createDocument() { return Promise.resolve(); },
      closeDocument() { return Promise.resolve(); }
    },
    notifications: { create() {} },
    commands: { onCommand: createEvent() }
  };

  const context = {
    AbortController,
    URL,
    chrome,
    clearInterval,
    clearTimeout,
    console,
    fetch: (url, ...args) => {
      fetchCalls.push({ url: String(url), args });
      return options.fetch ? options.fetch(url, ...args) : fetch(url, ...args);
    },
    setInterval: () => 1,
    setTimeout: options.setTimeout || setTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), context, { filename: BACKGROUND_PATH });

  // Expose internal Maps via var aliases for tests.
  vm.runInContext("var __states = states; var __translateControllers = translateControllers; var __formatControllers = formatControllers;", context);

  return { context, fetchCalls, onStorageChanged, syncValues, localData, runtimeMessages };
}

// ── File Bridge save routing ──────────────────────────────────────

test('handleSaveTranslation uses File Bridge endpoint, not TextKit', async () => {
  let fetchedUrl = '';
  const harness = createBackgroundHarness({
    syncValues: {
      fileBridgeHost: 'localhost',
      fileBridgePort: 8964,
      textkitHost: 'localhost',
      textkitPort: 8765
    },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ ok: true, path: 'saved/file.txt' }) };
    }
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'hello world',
    path: 'notes/hello.txt'
  });

  assert.equal(result.ok, true);
  assert.ok(fetchedUrl.includes('/save'));
  assert.ok(fetchedUrl.includes(':8964'));
  // Must NOT use TextKit port
  assert.ok(!fetchedUrl.includes(':8765'));
  assert.equal(result.path, 'saved/file.txt');
});

test('handleSaveTranslation uses configured File Bridge host and port', async () => {
  let fetchedUrl = '';
  const harness = createBackgroundHarness({
    syncValues: { fileBridgeHost: '127.0.0.1', fileBridgePort: 9777 },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    }
  });

  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/test.txt' });
  assert.equal(fetchedUrl, 'http://127.0.0.1:9777/save');
});

test('blank File Bridge host defaults to localhost with configured port', async () => {
  let fetchedUrl = '';
  const harness = createBackgroundHarness({
    syncValues: {
      fileBridgeHost: '',
      fileBridgePort: 8964,
      textkitHost: '127.0.0.1',
      textkitPort: 9876
    },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    }
  });

  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/test.txt' });
  assert.equal(fetchedUrl, 'http://localhost:8964/save');
});

// ── File Bridge cache invalidation ───────────────────────────────

test('changing fileBridge settings invalidates File Bridge cache only', async () => {
  let fetchedUrl = '';
  const harness = createBackgroundHarness({
    syncValues: {
      fileBridgeHost: '127.0.0.1',
      fileBridgePort: 8766,
      textkitHost: 'localhost',
      textkitPort: 8765
    },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    }
  });

  // First call — uses initial settings
  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/test.txt' });
  assert.equal(fetchedUrl, 'http://127.0.0.1:8766/save');

  // Change only file bridge settings — should invalidate
  harness.syncValues.fileBridgePort = 9777;
  harness.syncValues.fileBridgeHost = 'localhost';
  harness.onStorageChanged.emit(
    { fileBridgePort: { oldValue: 8766, newValue: 9777 } },
    'sync'
  );

  fetchedUrl = '';
  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/test.txt' });
  assert.equal(fetchedUrl, 'http://localhost:9777/save');
});

test('changing textkit settings does not invalidate File Bridge cache', async () => {
  let fetchedUrl = '';
  const harness = createBackgroundHarness({
    syncValues: {
      fileBridgeHost: '127.0.0.1',
      fileBridgePort: 8977,
      textkitHost: 'localhost',
      textkitPort: 8765
    },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, text: async () => JSON.stringify({ ok: true }) };
    }
  });

  // First save — caches File Bridge endpoint
  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/a.txt' });
  assert.equal(fetchedUrl, 'http://127.0.0.1:8977/save');

  // Emit a textkit-only change
  harness.onStorageChanged.emit(
    { textkitPort: { oldValue: 8765, newValue: 9999 } },
    'sync'
  );

  fetchedUrl = '';
  await harness.context.handleSaveTranslation({ text: 'test', path: 'notes/b.txt' });
  // Should still use the cached (unchanged) File Bridge endpoint
  assert.equal(fetchedUrl, 'http://127.0.0.1:8977/save');
});

// ── File Bridge response contract ─────────────────────────────────

test('save requires ok === true, not just HTTP 200', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error: 'disk full' })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'disk full');
});

test('save rejects implicit success — requires explicit ok === true', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ path: 'notes/saved.txt' })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
});

test('save handles empty response', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({ ok: true, status: 200, text: async () => '' })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid or empty/);
});

test('save handles invalid JSON response', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: true, status: 200, text: async () => '<html>proxy error</html>'
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /invalid or empty/);
});

test('save handles HTTP error with detail field', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ detail: 'internal server error' })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /internal server error/);
});

test('save handles HTTP error with error field', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'forbidden' })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /forbidden/);
});

test('save handles non-JSON HTTP error gracefully', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway'
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/test.txt'
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 502/);
});

test('save returns the path from the response when present', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, path: '/home/user/save_root/notes/out.txt' })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/out.txt'
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, '/home/user/save_root/notes/out.txt');
});

test('save falls back to input path when response has no path', async () => {
  const harness = createBackgroundHarness({
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true })
    })
  });

  const result = await harness.context.handleSaveTranslation({
    text: 'test', path: 'notes/myfile.txt'
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, 'notes/myfile.txt');
});

// ── Backend independence ──────────────────────────────────────────

test('yt2txt endpoint is independent of File Bridge settings', async () => {
  const harness = createBackgroundHarness({
    syncValues: {
      yt2txtHost: 'localhost',
      yt2txtPort: 8666,
      fileBridgeHost: '127.0.0.1',
      fileBridgePort: 9999
    }
  });

  const url = await harness.context.getYt2txtEndpoint('/transcript');
  assert.equal(url, 'http://localhost:8666/transcript');
});

test('textkit endpoint is independent of File Bridge settings', async () => {
  const harness = createBackgroundHarness({
    syncValues: {
      textkitHost: 'localhost',
      textkitPort: 8765,
      fileBridgeHost: '127.0.0.1',
      fileBridgePort: 9999
    }
  });

  const url = await harness.context.getTextkitEndpoint('/translate');
  assert.equal(url, 'http://localhost:8765/translate');
});

test('file bridge endpoint is independent of textkit settings', async () => {
  const harness = createBackgroundHarness({
    syncValues: {
      textkitHost: '127.0.0.1',
      textkitPort: 7777,
      fileBridgeHost: 'localhost',
      fileBridgePort: 8964
    }
  });

  const url = await harness.context.getFileBridgeEndpoint('/save');
  assert.equal(url, 'http://localhost:8964/save');
});

// ── Validation ────────────────────────────────────────────────────

test('file bridge host is validated as local-only, same as other backends', () => {
  const harness = createBackgroundHarness();
  // Valid: localhost/127.0.0.1/::1
  harness.context.normalizeBackendSettings('localhost', 8964);
  harness.context.normalizeBackendSettings('127.0.0.1', 8964);
  harness.context.normalizeBackendSettings('[::1]', 8964);

  // Invalid: external host
  assert.throws(
    () => harness.context.normalizeBackendSettings('example.com', 8964),
    /must be localhost/
  );
});

test('file bridge port is validated to be 1-65535', () => {
  const harness = createBackgroundHarness();
  assert.throws(
    () => harness.context.normalizeBackendSettings('localhost', 0),
    /between 1 and 65535/
  );
  assert.throws(
    () => harness.context.normalizeBackendSettings('localhost', 99999),
    /between 1 and 65535/
  );
  // Valid
  const result = harness.context.normalizeBackendSettings('localhost', 8964);
  assert.equal(result.port, 8964);
});

// ── handleTranslateStop ──────────────────────────────────────

test('handleTranslateStop aborts controller, removes storage key, resets state, sends tl2:false and state:update', async () => {
  const harness = createBackgroundHarness();
  const tabId = 42;

  harness.context.__states.set(tabId, {
    active: false,
    status: 'Ready',
    transcript: 'hello world',
    translate: { active: true, status: 'Translating...', error: '', resultText: '', sourceText: 'test', targetLanguage: 'Chinese' }
  });
  const ctrl = new AbortController();
  harness.context.__translateControllers.set(tabId, ctrl);
  harness.localData['tl2Translating:42'] = true;

  harness.context.handleTranslateStop(tabId);

  // Controller deleted and aborted
  assert.equal(harness.context.__translateControllers.has(tabId), false);
  assert.equal(ctrl.signal.aborted, true);
  // Storage key removed
  assert.equal(harness.localData['tl2Translating:42'], undefined);
  // State reset
  const state = harness.context.__states.get(tabId);
  assert.equal(state.translate.active, false);
  assert.equal(state.translate.status, 'Translation stopped.');
  assert.equal(state.translate.error, '');
  // tl2:translating false sent
  assert.ok(harness.runtimeMessages.some(m => m.type === 'tl2:translating' && m.tabId === tabId && m.value === false));
  // state:update broadcast
  assert.ok(harness.runtimeMessages.some(m => m.type === 'state:update' && m.tabId === tabId));
});

test('handleTranslateStop preserves unrelated transcript and format state', async () => {
  const harness = createBackgroundHarness();
  const tabId = 42;

  harness.context.__states.set(tabId, {
    active: false,
    status: 'Ready',
    transcript: 'hello world',
    format: { active: false, status: 'Formatted', error: '', resultText: 'formatted text' },
    translate: { active: true, status: 'Translating...', error: '', resultText: '' }
  });
  const ctrl = new AbortController();
  harness.context.__translateControllers.set(tabId, ctrl);

  harness.context.handleTranslateStop(tabId);

  const state = harness.context.__states.get(tabId);
  assert.equal(state.transcript, 'hello world');
  assert.equal(state.format.resultText, 'formatted text');
  assert.equal(state.format.status, 'Formatted');
  assert.equal(state.format.active, false);
  assert.equal(state.translate.active, false);
  assert.equal(state.translate.status, 'Translation stopped.');
});

test('handleTranslateStop with no active translation does not throw or broadcast state:update', async () => {
  const harness = createBackgroundHarness();
  const tabId = 99;

  harness.context.__states.set(tabId, {
    active: false,
    status: 'Ready',
    transcript: '',
    translate: { active: false, status: 'Ready', error: '', resultText: '' }
  });

  harness.context.handleTranslateStop(tabId);

  // No state:update (translate was not active)
  const updates = harness.runtimeMessages.filter(m => m.type === 'state:update' && m.tabId === tabId);
  assert.equal(updates.length, 0);
  // State unchanged
  const state = harness.context.__states.get(tabId);
  assert.equal(state.translate.active, false);
  assert.equal(state.translate.status, 'Ready');
});

test('handleTranslateStop with no state at all does not throw', async () => {
  const harness = createBackgroundHarness();
  assert.doesNotThrow(() => { harness.context.handleTranslateStop(404); });
});

test('translation has no fixed timeout — Stop still aborts via AbortController', async () => {
  const scheduledTimeouts = [];
  const harness = createBackgroundHarness({
    setTimeout: (callback, delay, ...args) => {
      scheduledTimeouts.push(delay);
      return setTimeout(callback, delay, ...args);
    },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleTranslateStart({
    tabId: 1,
    text: 'source',
    language: 'French'
  });

  await waitFor(
    () => harness.context.__translateControllers.has(1)
      && harness.context.__states.get(1)?.translate?.active,
    'translation did not become active'
  );

  assert.equal(
    scheduledTimeouts.includes(12 * 60 * 1000),
    false,
    'translation must not schedule the fixed backend timeout'
  );
  assert.equal(
    harness.context.__translateControllers.has(1),
    true,
    'translate controller should still be registered (no fixed timeout fired)'
  );

  // Stop via user path — must still work.
  harness.context.handleTranslateStop(1);

  const result = await operation;
  assert.equal(result.ok, true);
  const state = harness.context.__states.get(1);
  assert.equal(state.translate.status, 'Translation stopped.');
});

test('format has no fixed timeout — Stop still aborts via AbortController', async () => {
  const scheduledTimeouts = [];
  const harness = createBackgroundHarness({
    setTimeout: (callback, delay, ...args) => {
      scheduledTimeouts.push(delay);
      return setTimeout(callback, delay, ...args);
    },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    })
  });

  const operation = harness.context.handleFormatStart({
    tabId: 1,
    text: 'source'
  });

  await waitFor(
    () => harness.context.__formatControllers.has(1),
    'format controller was not registered'
  );

  assert.equal(
    scheduledTimeouts.includes(12 * 60 * 1000),
    false,
    'format must not schedule the fixed backend timeout'
  );
  assert.equal(
    harness.context.__formatControllers.has(1),
    true,
    'format controller should still be registered (no fixed timeout fired)'
  );

  // Stop via user path — must still work.
  harness.context.handleFormatStop(1);

  const result = await operation;
  assert.equal(result.ok, true);
  const state = harness.context.__states.get(1);
  assert.equal(state.format.status, 'Formatting stopped.');
});
