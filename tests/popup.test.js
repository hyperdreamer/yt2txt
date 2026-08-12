'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const POPUP_PATH = path.join(ROOT, 'extension', 'popup.js');

/**
 * Create a minimal DOM+chrome mock and run popup.js in a VM sandbox.
 * Returns the VM context so tests can call the exported helper functions
 * and inspect fetch calls.
 */
function createPopupHarness(options = {}) {
  const syncValues = {
    yt2txtHost: 'localhost',
    yt2txtPort: 8666,
    textkitHost: 'localhost',
    textkitPort: 8765,
    fileBridgeHost: options.fileBridgeHost !== undefined ? options.fileBridgeHost : '',
    fileBridgePort: options.fileBridgePort !== undefined ? options.fileBridgePort : 8964,
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

  const fetchCalls = [];
  const runtimeMessages = [];

  // ---- minimal DOM elements -------------------------------------------
  function el(id, overrides = {}) {
    const defaults = {
      value: '',
      disabled: false,
      checked: false,
      textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() {} },
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

  const fmtPS = datalistEl('fmt-path-suggestions');
  const tl2PS = datalistEl('tl2-path-suggestions');

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
    'fmt-path-suggestions': fmtPS,
    host: el('host'),
    port: el('port'),
    force: el('force'),
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
    'tl2-path-suggestions': tl2PS,
    'textkit-host': el('textkit-host'),
    'textkit-port': el('textkit-port'),
    'file-bridge-host': el('file-bridge-host'),
    'file-bridge-port': el('file-bridge-port'),
  };

  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(sel) {
      if (sel === '.tab') {
        return [
          { dataset: { panel: 'transcript-panel' }, classList: { add() {}, remove() {} }, addEventListener() {} },
          { dataset: { panel: 'format-panel' }, classList: { add() {}, remove() {} }, addEventListener() {} },
          { dataset: { panel: 'translation-panel' }, classList: { add() {}, remove() {} }, addEventListener() {} },
        ];
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
        get(defaults) { return Promise.resolve({ ...defaults, ...syncValues }); },
        set(values) {
          Object.assign(syncValues, values);
          return Promise.resolve();
        },
      },
      local: {
        get(keys) {
          let result = {};
          if (typeof keys === 'object' && !Array.isArray(keys)) result = { ...keys };
          return Promise.resolve(result);
        },
        set() { return Promise.resolve(); },
        remove() { return Promise.resolve(); },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://youtube.com/watch?v=test' }],
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) { runtimeMessages.push(msg); return Promise.resolve({ ok: true }); },
    },
    commands: { onCommand: { addListener() {} } },
  };

  const fetchMock = (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return Promise.resolve({
      ok: true,
      json: async () => ({ paths: ['notes/test.txt', 'docs/readme.md'] }),
    });
  };

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
    MutationObserver: class { observe() {} disconnect() {} },
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(POPUP_PATH, 'utf8'), context, { filename: POPUP_PATH });

  return { context, elements, fetchCalls, syncValues, runtimeMessages };
}

// ═══════════════════════════════════════════════════════════════════
// Format and Translation autocomplete tests
// ═══════════════════════════════════════════════════════════════════

test('format autocomplete calls File Bridge /paths with configured host', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: '127.0.0.1',
    fileBridgePort: 8964,
  });
  harness.elements['file-bridge-host'].value = '127.0.0.1';
  harness.elements['file-bridge-port'].value = '8964';

  await harness.context.fetchFmtPathSuggestions('notes/');

  assert.ok(harness.fetchCalls.length >= 1, 'expected at least one fetch call');
  const call = harness.fetchCalls.find((c) => c.url.includes('/paths'));
  assert.ok(call, 'expected a /paths fetch call');
  assert.ok(call.url.includes('127.0.0.1:8964'), 'URL should use configured File Bridge host:port');
  assert.ok(call.url.includes('/paths?prefix='), 'URL should include /paths endpoint');
});

test('translation autocomplete calls File Bridge /paths with configured host', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: '127.0.0.1',
    fileBridgePort: 9999,
  });
  harness.elements['file-bridge-host'].value = '127.0.0.1';
  harness.elements['file-bridge-port'].value = '9999';

  await harness.context.fetchPathSuggestions('docs/');

  const call = harness.fetchCalls.find((c) => c.url.includes('/paths'));
  assert.ok(call, 'expected a /paths fetch call');
  assert.ok(call.url.includes('127.0.0.1:9999'), 'URL should use configured File Bridge host:port');
});

test('blank File Bridge host defaults to localhost for autocomplete', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: '',
    fileBridgePort: 8964,
  });
  harness.elements['file-bridge-host'].value = '';
  harness.elements['file-bridge-port'].value = '8964';

  await harness.context.fetchFileBridgePathSuggestions(
    'data/',
    harness.elements['fmt-path-suggestions'],
  );

  const call = harness.fetchCalls.find((c) => c.url.includes('/paths'));
  assert.ok(call, 'expected a /paths fetch call');
  assert.ok(call.url.includes('localhost:8964'), `URL should default to localhost, got: ${call.url}`);
});

test('autocomplete never routes through TextKit', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: 'localhost',
    fileBridgePort: 8964,
  });
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '8964';
  harness.elements['textkit-host'].value = '127.0.0.1';
  harness.elements['textkit-port'].value = '8765';

  await harness.context.fetchFileBridgePathSuggestions(
    'x/',
    harness.elements['tl2-path-suggestions'],
  );

  const calls = harness.fetchCalls.filter((c) => c.url.includes('/paths'));
  for (const c of calls) {
    assert.ok(!c.url.includes(':8765'), `URL should not use TextKit port: ${c.url}`);
  }
});

test('autocomplete prefix is URI-encoded', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: 'localhost',
    fileBridgePort: 8964,
  });
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '8964';

  await harness.context.fetchFileBridgePathSuggestions(
    'my docs/foo bar',
    harness.elements['fmt-path-suggestions'],
  );

  const call = harness.fetchCalls.find((c) => c.url.includes('/paths'));
  assert.ok(call, 'expected a /paths fetch call');
  assert.ok(
    call.url.includes('prefix=my%20docs%2Ffoo%20bar'),
    `prefix should be encoded, got: ${call.url}`,
  );
});

test('File Bridge autocomplete independent of TextKit backend settings', async () => {
  const harness = createPopupHarness({
    fileBridgeHost: 'localhost',
    fileBridgePort: 8964,
  });
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '8964';
  // Set TextKit to a different host/port — should not affect FB autocomplete
  harness.elements['textkit-host'].value = '10.0.0.1';
  harness.elements['textkit-port'].value = '7777';

  await harness.context.fetchFileBridgePathSuggestions(
    'd/',
    harness.elements['tl2-path-suggestions'],
  );

  const call = harness.fetchCalls.find((c) => c.url.includes('/paths'));
  assert.ok(call, 'expected a /paths fetch call');
  assert.ok(call.url.includes('localhost:8964'), `should use FB settings, got: ${call.url}`);
  assert.ok(!call.url.includes('10.0.0.1'), 'should not use TextKit host');
  assert.ok(!call.url.includes(':7777'), 'should not use TextKit port');
});

// ═══════════════════════════════════════════════════════════════════
// Shared function populates both datalists
// ═══════════════════════════════════════════════════════════════════

test('shared helper populates format datalist', async () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '8964';

  await harness.context.fetchFileBridgePathSuggestions(
    'n/',
    harness.elements['fmt-path-suggestions'],
  );

  const options = harness.elements['fmt-path-suggestions']._options;
  assert.ok(options.length > 0, 'format datalist should have options');
  assert.equal(options[0].value, 'notes/test.txt');
});

test('shared helper populates translation datalist', async () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '8964';

  // The datalist should start empty
  assert.equal(harness.elements['tl2-path-suggestions']._options.length, 0,
    'datalist should start empty');

  await harness.context.fetchFileBridgePathSuggestions(
    'd/',
    harness.elements['tl2-path-suggestions'],
  );

  const options = harness.elements['tl2-path-suggestions']._options;
  assert.ok(options.length > 0, 'translation datalist should have options');
});

// ═══════════════════════════════════════════════════════════════════
// Validation: invalid settings are not persisted or fetched
// ═══════════════════════════════════════════════════════════════════

test('saveFileBridgeSettings rejects external host and shows error status', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'evil.com';
  harness.elements['file-bridge-port'].value = '8964';

  const before = { ...harness.syncValues };
  harness.context.saveFileBridgeSettings();

  // Must not persist
  assert.equal(harness.syncValues.fileBridgeHost, before.fileBridgeHost,
    'external host must not be persisted');
  assert.equal(harness.syncValues.fileBridgePort, before.fileBridgePort,
    'port must not be persisted alongside invalid host');
  // Must show error on status bar
  assert.ok(
    harness.elements['status-bar'].textContent.includes('must be localhost'),
    `expected localhost error, got: ${harness.elements['status-bar'].textContent}`,
  );
});

test('saveFileBridgeSettings rejects port 0', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '0';

  const before = { ...harness.syncValues };
  harness.context.saveFileBridgeSettings();

  assert.equal(harness.syncValues.fileBridgePort, before.fileBridgePort,
    'port 0 must not be persisted');
  assert.ok(
    harness.elements['status-bar'].textContent.includes('between 1 and 65535'),
    `expected port range error, got: ${harness.elements['status-bar'].textContent}`,
  );
});

test('saveFileBridgeSettings rejects port 99999', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'localhost';
  harness.elements['file-bridge-port'].value = '99999';

  const before = { ...harness.syncValues };
  harness.context.saveFileBridgeSettings();

  assert.equal(harness.syncValues.fileBridgePort, before.fileBridgePort,
    'port 99999 must not be persisted');
});

test('autocomplete does not fetch when settings are invalid', async () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = 'evil.com';
  harness.elements['file-bridge-port'].value = '8964';

  await harness.context.fetchFileBridgePathSuggestions(
    'x/',
    harness.elements['fmt-path-suggestions'],
  );

  const pathCalls = harness.fetchCalls.filter((c) => c.url.includes('/paths'));
  assert.equal(pathCalls.length, 0, 'no fetch should be made with invalid settings');
});

// ═══════════════════════════════════════════════════════════════════
// Valid settings are persisted
// ═══════════════════════════════════════════════════════════════════

test('saveFileBridgeSettings persists valid localhost settings', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = '127.0.0.1';
  harness.elements['file-bridge-port'].value = '8888';

  harness.context.saveFileBridgeSettings();

  assert.equal(harness.syncValues.fileBridgeHost, '127.0.0.1');
  assert.equal(harness.syncValues.fileBridgePort, 8888);
});

test('saveFileBridgeSettings persists valid ::1 settings', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = '[::1]';
  harness.elements['file-bridge-port'].value = '8964';

  harness.context.saveFileBridgeSettings();

  assert.equal(harness.syncValues.fileBridgeHost, '[::1]');
  assert.equal(harness.syncValues.fileBridgePort, 8964);
});

test('blank host is treated as localhost and persisted', () => {
  const harness = createPopupHarness();
  harness.elements['file-bridge-host'].value = '';
  harness.elements['file-bridge-port'].value = '8964';

  harness.context.saveFileBridgeSettings();

  assert.equal(harness.syncValues.fileBridgeHost, 'localhost');
  assert.equal(harness.syncValues.fileBridgePort, 8964);
});

// ═══════════════════════════════════════════════════════════════════
// ID names
// ═══════════════════════════════════════════════════════════════════

test('File Bridge host uses file-bridge-host ID (not filebridge-host)', () => {
  const harness = createPopupHarness();
  assert.ok(harness.elements['file-bridge-host'], 'file-bridge-host element should exist');
  assert.equal(
    harness.elements['file-bridge-host'].id,
    'file-bridge-host',
    'ID should be file-bridge-host',
  );
});

test('File Bridge port uses file-bridge-port ID (not filebridge-port)', () => {
  const harness = createPopupHarness();
  assert.ok(harness.elements['file-bridge-port'], 'file-bridge-port element should exist');
  assert.equal(
    harness.elements['file-bridge-port'].id,
    'file-bridge-port',
    'ID should be file-bridge-port',
  );
});

// ═══════════════════════════════════════════════════════════════════
// doTranslation sends translate:start with minimal payload
// ═══════════════════════════════════════════════════════════════════

test('doTranslation sends translate:start with only type, tabId, text, language', async () => {
  const harness = createPopupHarness();
  const transcriptText = 'Hello, world.';
  const targetLang = 'Chinese';

  // init() sets currentTabId from tabs.query (returns id:1 in harness)
  await harness.context.init();

  // Set source text and target language on the existing elements
  harness.elements['result'].value = transcriptText;
  harness.elements['tl2-language'].value = targetLang;

  // Clear any messages sent during init
  harness.runtimeMessages.length = 0;

  await harness.context.doTranslation();

  const startMsgs = harness.runtimeMessages.filter(m => m.type === 'translate:start');
  assert.equal(startMsgs.length, 1, 'exactly one translate:start message');
  const msg = startMsgs[0];
  assert.equal(msg.tabId, 1);
  assert.equal(msg.text, transcriptText);
  assert.equal(msg.language, targetLang);
  assert.equal(Object.keys(msg).includes('sourceUrl'), false, 'must not include sourceUrl');
  assert.equal(Object.keys(msg).includes('host'), false, 'must not include host');
  assert.equal(Object.keys(msg).includes('port'), false, 'must not include port');
});
