# Transcript SW Keepalive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension keepalive interval run if and only if at least one transcript, format, or translate operation is in flight, so long transcript extractions survive Chrome MV3 service-worker termination regardless of popup state.

**Architecture:** All production changes are in `extension/background.js`: a new `transcriptControllers` map and a `syncKeepAlive()` derivation function become the single keepalive-accounting authority, and every mutation of the transcript/format/translate controller maps is followed by an accounting call in the same synchronous block. `handleStart` registers its AbortController before its first `await` and cleans it up in an identity-guarded `finally`; the format and translate handlers replace their old two-map conditional stop with `syncKeepAlive()`. The tests extend the existing VM background harness in `tests/filebridge.test.js` with the new map, a live `__isKeepAliveRunning()` getter, and a real `tabs.onRemoved` event, then add nine deterministic deferred-fetch cases. The `ARCHITECTURE.md` keepalive deltas (D1–D10) are folded into this task because they document exactly the behavior this task changes; a reviewer cannot usefully approve the code while rejecting its documentation.

**Tech Stack:** Chrome MV3 extension (plain JavaScript, no build step), Node v24.15.0 with `node:test` + `node:assert/strict` and a `vm`-based background harness.

**Normative source:** `docs/superpowers/specs/2026-10-10-transcript-sw-keepalive-spec.md` (approved; referenced below as "the spec"). Every code block in this plan is copied from it verbatim. The spec's section 6 fixtures were materialized and verified at 52/52 on Node v24.15.0.

## Global Constraints

- Node v24.15.0 is the runtime; run JavaScript tests with `node --test tests/*.test.js` (bare `node --test` from the repo root also works). Do not use `node --test tests/`; it fails on Node v24.15.0 with `Cannot find module '<repo>/tests'`.
- Plain JavaScript only: no TypeScript, no new dependencies, no build step.
- Only `extension/background.js`, `tests/filebridge.test.js`, and `ARCHITECTURE.md` may change.
- Do not change `extension/popup.js`, the Python backend, TextKit, or File Bridge.
- The keepalive is the existing 20-second `chrome.runtime.getPlatformInfo` interval; `startKeepAlive()` and `stopKeepAlive()` bodies stay byte-identical.
- Tests must not depend on real timers: the harness stubs `setInterval` to return `1`, and keepalive assertions use the live `__isKeepAliveRunning()` getter (`keepAliveIntervalId !== null`), never timer firing.
- Out of scope: no offscreen-document migration, no timeout-constant changes, no endpoint/format/persistence changes, no new message types or storage keys, and the manual Save path (`handleSaveTranslation`) remains unaccounted.
- The full JavaScript suite must pass 52/52: 34 tests in `tests/filebridge.test.js` (25 existing + 9 new) and 18 in `tests/popup.test.js`.

## Task 1: Keepalive accounting across transcript, format, and translate

**Implementer tier:** Standard

**Files:**
- Modify: `extension/background.js:175-192` (P1: `transcriptControllers` + `syncKeepAlive()`)
- Modify: `extension/background.js:194-210` (P2: `chrome.tabs.onRemoved`)
- Modify: `extension/background.js:316-427` (P3: `handleStart`)
- Modify: `extension/background.js:430-446` (P4: `handleStop`)
- Modify: `extension/background.js:542-552` (P5: `handleTranslateStart` `finally`)
- Modify: `extension/background.js:557-575` (P6: `handleTranslateStop`)
- Modify: `extension/background.js:669-674` (P7: `handleFormatStart` `finally`)
- Modify: `extension/background.js:678-690` (P8: `handleFormatStop`)
- Modify: `tests/filebridge.test.js:45-45` (harness: add `onTabRemoved`)
- Modify: `tests/filebridge.test.js:75-75` (harness: `tabs.onRemoved` stub)
- Modify: `tests/filebridge.test.js:109-112` (harness: VM aliases + return object)
- Modify: `tests/filebridge.test.js:638-638` (append helpers and cases 1–9)
- Modify: `ARCHITECTURE.md:110-110` (D1)
- Modify: `ARCHITECTURE.md:129-132` (D2)
- Modify: `ARCHITECTURE.md:159-160` (D3; only line 160 changes)
- Modify: `ARCHITECTURE.md:172-172` (D4)
- Modify: `ARCHITECTURE.md:244-248` (D5)
- Modify: `ARCHITECTURE.md:308-313` (D6)
- Modify: `ARCHITECTURE.md:372-372` (D7 insertion point)
- Modify: `ARCHITECTURE.md:439-439` (D8)
- Modify: `ARCHITECTURE.md:623-623` (D9)
- Modify: `ARCHITECTURE.md:653-653` (D10)

**Interfaces:**
- Consumes: existing `extension/background.js` internals — `states: Map<number, object>` (per-tab state), `translateControllers: Map<number, AbortController>`, `formatControllers: Map<number, AbortController>`, `keepAliveIntervalId: number | null`, `startKeepAlive(): void`, `stopKeepAlive(): void`, `getActiveTab(): Promise<{ id: number }>`, `getState(tabId): object`, `resetState(tabId): void`, `updateState(tabId, patch): void`, `broadcastState(tabId): void`, `fetchWithTimeout(url: string, options: object, signal: AbortSignal): Promise<Response>`, `TRANSCRIPT_TIMEOUT_MS: number`; existing `tests/filebridge.test.js` fixtures — `createBackgroundHarness(options: { syncValues?: object, localData?: object, fetch?: (url, options) => Promise<unknown> }): { context, fetchCalls, onStorageChanged, onTabRemoved, syncValues, localData, runtimeMessages }`, `createEvent(): { addListener, removeListener, emit }`, `waitFor(predicate: () => boolean, message: string, timeoutMs?: number): Promise<void>`.
- Produces: `transcriptControllers: Map<number, AbortController>`; `syncKeepAlive(): void` (starts the interval iff any of the three maps is non-empty, stops it otherwise; idempotent; never mutates a map); `handleStart(msg): Promise<{ ok: boolean, error?: string }>` (rejects duplicates via `state.active || transcriptControllers.has(tab.id)`, registers `transcriptControllers.set(tab.id, controller)` then `syncKeepAlive()`, and in `finally` deletes only when `transcriptControllers.get(tab.id) === controller` then calls `syncKeepAlive()` unconditionally); `handleStop(): Promise<{ ok: boolean }>` (aborts via `transcriptControllers.get(tab.id)`; does not delete or sync); `chrome.tabs.onRemoved` listener (aborts + deletes the transcript entry, then `syncKeepAlive()`); `handleTranslateStart(msg)` and `handleFormatStart(msg)` `finally` blocks call `syncKeepAlive()`; `handleTranslateStop(tabId): void` and `handleFormatStop(tabId): void` call `syncKeepAlive()` immediately after their identity-guarded delete; harness exports the live `__transcriptControllers` Map, the live `__isKeepAliveRunning(): boolean` getter, and the `onTabRemoved` event (emit with `tabId`); tests `keepalive case 1` through `keepalive case 9` in `tests/filebridge.test.js`; `ARCHITECTURE.md` deltas D1–D10.

- [ ] **Step 1: Add the `onTabRemoved` harness event in `tests/filebridge.test.js`**

Immediately after line 45 (`const onStorageChanged = createEvent();`), add:

```js
  const onTabRemoved = createEvent();
```

Then replace the `tabs` stub's `onRemoved` line (line 75) so tests can emit the real listener:

```js
    tabs: {
      onRemoved: onTabRemoved,
      query: async () => [{ id: 1, windowId: 10, active: true }]
    },
```

- [ ] **Step 2: Expose the new internals through VM aliases in `tests/filebridge.test.js`**

Replace the harness alias block and return statement (currently lines 109–112, starting at the comment `// Expose internal Maps via var aliases for tests.`):

Current:

```js
  // Expose internal Maps via var aliases for tests.
  vm.runInContext("var __states = states; var __translateControllers = translateControllers; var __formatControllers = formatControllers;", context);

  return { context, fetchCalls, onStorageChanged, syncValues, localData, runtimeMessages };
```

Replacement:

```js
  // Expose internal Maps and keepalive state via var aliases for tests.
  vm.runInContext(
    "var __states = states;" +
      "var __translateControllers = translateControllers;" +
      "var __formatControllers = formatControllers;" +
      "var __transcriptControllers = transcriptControllers;" +
      "var __isKeepAliveRunning = () => keepAliveIntervalId !== null;",
    context
  );

  return { context, fetchCalls, onStorageChanged, onTabRemoved, syncValues, localData, runtimeMessages };
```

`__isKeepAliveRunning` MUST stay a live arrow getter that re-reads `keepAliveIntervalId`; do not capture a boolean. `__transcriptControllers` MUST be the live Map reference.

- [ ] **Step 3: Append the deferred-fetch helpers to `tests/filebridge.test.js`**

After the last line of the file (line 638), append:

```js
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function deferredFetchQueue() {
  const queues = new Map(); // path -> [{ promise, resolve, reject }]

  function enqueue(path) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = { promise, resolve, reject };
    if (!queues.has(path)) queues.set(path, []);
    queues.get(path).push(entry);
    return entry;
  }

  const entries = (path) => queues.get(path) || [];

  const fetch = (url, options = {}) => {
    const text = String(url);
    const path = ['/transcript', '/format', '/translate', '/save'].find((candidate) => text.includes(candidate));
    if (!path) return Promise.reject(new Error(`unrouted fetch: ${text}`));
    const entry = enqueue(path);
    const abort = () => entry.reject(new DOMException('Aborted', 'AbortError'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    return entry.promise;
  };

  return {
    fetch,
    count: (path) => entries(path).length,
    resolve: (path, value, index = 0) => entries(path)[index].resolve(value),
  };
}
```

Why this wiring: `fetch` never settles until the test resolves the matching deferred; each call on a path gets its own index-addressed deferred (needed by the abort-and-replace cases 5 and 7); when the caller's `signal` aborts, the pending fetch rejects with `new DOMException('Aborted', 'AbortError')`, reproducing the browser behavior the handlers' `catch (e)` blocks depend on.

- [ ] **Step 4: Append keepalive cases 1–3 to `tests/filebridge.test.js`**

Case 1 — transcript in flight → keepalive running:

```js
test('keepalive case 1: transcript in flight keeps the interval running', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => harness.context.__transcriptControllers.has(1), 'transcript controller was not registered');

  assert.equal(harness.context.__isKeepAliveRunning(), true);
  assert.equal(router.count('/transcript'), 1);

  await harness.context.handleStop();
  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

Case 2 — transcript done + auto-format in flight → running; after format (auto-translate off) → stopped:

```js
test('keepalive case 2: keepalive survives transcript→format handoff, stops after format when auto-translate is off', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({
    syncValues: { yt2txtAutoTranslate: false },
    fetch: router.fetch,
  });

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  router.resolve('/transcript', jsonResponse({ text: 'TRANSCRIPT', source: 'subtitles' }));
  await waitFor(() => router.count('/format') === 1, 'auto-format fetch did not start');

  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.context.__formatControllers.has(1), true);
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  router.resolve('/format', jsonResponse({ text: 'FORMATTED' }));
  await operation;

  assert.equal(harness.context.__formatControllers.has(1), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

Case 3 — transcript fails with no format → keepalive stopped (leak regression):

```js
test('keepalive case 3: transcript failure with no format stops the interval (leak regression)', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  router.resolve('/transcript', jsonResponse({ error: 'backend exploded' }, { ok: false, status: 500 }));
  const result = await operation;

  assert.equal(result.ok, true);
  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
  assert.match(harness.context.__states.get(1).error, /backend exploded/);
});
```

- [ ] **Step 5: Append keepalive cases 4–6 to `tests/filebridge.test.js`**

Case 4 — transcript pending on tab 1 while a format on tab 2 completes. The harness's active tab is always id 1, so the transcript is tab 1 and the independent format uses the explicit `tabId: 2`:

```js
test('keepalive case 4: transcript on tab 1 keeps running while a format on tab 2 completes', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({
    syncValues: { yt2txtAutoTranslate: false },
    fetch: router.fetch,
  });

  const transcriptOp = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  const formatOp = harness.context.handleFormatStart({ tabId: 2, text: 'other tab' });
  await waitFor(() => router.count('/format') === 1, 'format fetch did not start');
  assert.equal(harness.context.__formatControllers.has(2), true);
  assert.equal(harness.context.__transcriptControllers.has(1), true);

  router.resolve('/format', jsonResponse({ text: 'FORMATTED' }));
  await formatOp;

  assert.equal(harness.context.__formatControllers.has(2), false);
  assert.equal(harness.context.__transcriptControllers.has(1), true);
  assert.equal(harness.context.__isKeepAliveRunning(), true, 'transcript on tab 1 must keep the interval running');

  await harness.context.handleStop();
  await transcriptOp;
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

Case 5 — translate abort-and-replace keeps the newer controller alive. `/translate` deferred index `1` is the second request's response:

```js
test('keepalive case 5: translate abort-and-replace keeps the interval for the newer controller', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const first = harness.context.handleTranslateStart({ tabId: 7, text: 'one', language: 'French' });
  await waitFor(() => router.count('/translate') === 1, 'first translate fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);
  const firstController = harness.context.__translateControllers.get(7);

  const second = harness.context.handleTranslateStart({ tabId: 7, text: 'two', language: 'German' });
  await waitFor(() => router.count('/translate') === 2, 'second translate fetch did not start');
  assert.equal(firstController.signal.aborted, true);
  assert.equal(harness.context.__translateControllers.has(7), true);

  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(harness.context.__translateControllers.has(7), true, 'stale finally must not delete the newer controller');
  assert.equal(harness.context.__isKeepAliveRunning(), true, 'stale finally must not stop the interval');

  router.resolve('/translate', jsonResponse({ text: 'ZWEI' }), 1);
  const secondResult = await second;
  assert.equal(secondResult.ok, true);
  assert.equal(harness.context.__translateControllers.has(7), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

Case 6 — `handleStop` aborts the transcript and stops keepalive once the handler unwinds. `handleStop` is awaited, but the stopping happens when the aborted `handleStart` unwinds, so the test awaits `operation` before asserting:

```js
test('keepalive case 6: handleStop aborts the transcript and stops the interval once the handler unwinds', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  await harness.context.handleStop();
  const result = await operation;

  assert.equal(result.ok, true);
  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
  const state = harness.context.__states.get(1);
  assert.equal(state.status, 'Error');
  assert.match(state.error, /Stopped by user/);
});
```

- [ ] **Step 6: Append keepalive cases 7–9 to `tests/filebridge.test.js`**

Case 7 — format abort-and-replace keeps the newer controller alive (mirrors case 5 for `formatControllers`):

```js
test('keepalive case 7: format abort-and-replace keeps the interval for the newer controller', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const first = harness.context.handleFormatStart({ tabId: 3, text: 'first' });
  await waitFor(() => router.count('/format') === 1, 'first format fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);
  const firstController = harness.context.__formatControllers.get(3);

  const second = harness.context.handleFormatStart({ tabId: 3, text: 'second' });
  await waitFor(() => router.count('/format') === 2, 'second format fetch did not start');
  assert.equal(firstController.signal.aborted, true);

  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(harness.context.__formatControllers.has(3), true, 'stale finally must not delete the newer controller');
  assert.equal(harness.context.__isKeepAliveRunning(), true, 'stale finally must not stop the interval');

  router.resolve('/format', jsonResponse({ text: 'SECOND' }), 1);
  const secondResult = await second;
  assert.equal(secondResult.ok, true);
  assert.equal(harness.context.__formatControllers.has(3), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

Case 8 — auto-translate chain has no gap across the format→translate handoff. The fixture wraps `clearInterval` to count actual stops, because a boolean snapshot cannot distinguish "never stopped" from "stopped and restarted". One stop is expected at the transcript→format handoff; no second stop may happen during the format→translate window:

```js
test('keepalive case 8: auto-translate chain has no keepalive gap across the format→translate handoff', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({
    syncValues: { yt2txtAutoTranslate: true, tl2Language: 'French' },
    fetch: router.fetch,
  });

  // Count actual stops: stopKeepAlive only calls clearInterval while the interval is running.
  let stopCount = 0;
  const realClearInterval = harness.context.clearInterval;
  harness.context.clearInterval = (id) => {
    stopCount += 1;
    return realClearInterval(id);
  };

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  router.resolve('/transcript', jsonResponse({ text: 'TRANSCRIPT', source: 'subtitles' }));

  await waitFor(() => router.count('/format') === 1, 'auto-format fetch did not start');
  router.resolve('/format', jsonResponse({ text: 'FORMATTED' }));

  await waitFor(() => router.count('/translate') === 1, 'auto-translate fetch did not start');
  // Translate is registered synchronously inside autoTranslate, before format's finally
  // runs; that ordering is asserted through stopCount below (format's finally sync must
  // not be the one that stops the interval).
  assert.equal(harness.context.__translateControllers.has(1), true);
  assert.equal(harness.context.__isKeepAliveRunning(), true);
  // One stop is expected earlier: transcript→format handoff (transcript entry deleted
  // before the format controller registers). No *second* stop may happen here.
  assert.equal(stopCount, 1, 'keepalive must not stop during the format→translate handoff');

  await operation;
  assert.equal(harness.context.__isKeepAliveRunning(), true, 'translate must still keep the interval running');
  assert.equal(stopCount, 1);

  router.resolve('/translate', jsonResponse({ text: 'TRADUIT' }));
  await waitFor(
    () => !harness.context.__isKeepAliveRunning() && !harness.context.__translateControllers.has(1),
    'keepalive did not stop after auto-translate completed'
  );
  assert.equal(stopCount, 2, 'exactly one stop per idle transition (transcript→format, translate→idle)');
});
```

Case 9 — tab close mid-transcript aborts, cleans up, and stops (requires the Step 1 harness change):

```js
test('keepalive case 9: tab close mid-transcript aborts, cleans up, and stops the interval', async () => {
  const router = deferredFetchQueue();
  const harness = createBackgroundHarness({ fetch: router.fetch });

  const operation = harness.context.handleStart({ url: 'https://example.com/v' });
  await waitFor(() => router.count('/transcript') === 1, 'transcript fetch did not start');
  assert.equal(harness.context.__isKeepAliveRunning(), true);

  harness.onTabRemoved.emit(1);

  assert.equal(harness.context.__transcriptControllers.has(1), false);
  assert.equal(harness.context.__isKeepAliveRunning(), false);

  const result = await operation;
  assert.equal(result.ok, true);
  assert.equal(harness.context.__transcriptControllers.has(1), false);
  // The aborted handler's finally re-syncs; must stay stopped (idempotent).
  assert.equal(harness.context.__isKeepAliveRunning(), false);
});
```

- [ ] **Step 7: Run the suite and confirm the red state**

Run: `node --test tests/filebridge.test.js`
Expected: FAIL. Every test that calls `createBackgroundHarness` fails while constructing the harness, with `ReferenceError: transcriptControllers is not defined` thrown by the new alias line, because production still has no `transcriptControllers` binding. The 25 pre-existing tests fail for the same reason; this is the expected pre-implementation state and proves the fixtures are wired to the new production binding.

- [ ] **Step 8: Apply P1–P2 to `extension/background.js`**

Replace lines 175–191 (the `// ── Translation / Format controllers ──` comment through the end of `stopKeepAlive()`) with:

```js
// ── Translation / Format controllers ────────────────────────────
const translateControllers = new Map();
const formatControllers = new Map();
const transcriptControllers = new Map();
let keepAliveIntervalId = null;

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
  const hasWork =
    transcriptControllers.size > 0 ||
    formatControllers.size > 0 ||
    translateControllers.size > 0;
  if (hasWork) startKeepAlive();
  else stopKeepAlive();
}
```

Then replace the `chrome.tabs.onRemoved` listener (lines 194–210, under the unchanged `// ── Clean up on tab close ──` comment) with:

```js
chrome.tabs.onRemoved.addListener((tabId) => {
  const transcriptController = transcriptControllers.get(tabId);
  if (transcriptController) {
    transcriptController.abort();
  }
  transcriptControllers.delete(tabId);
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
  syncKeepAlive();
  chrome.storage.local
    .remove([
      `transcript:${tabId}`,
      `transcript_raw:${tabId}`,
      `tl2Translating:${tabId}`,
      `fmtResult:${tabId}`,
      `translate:result:${tabId}`,
    ])
    .catch(() => {});
});
```

- [ ] **Step 9: Apply P3–P4 to `extension/background.js`**

Replace the entire `handleStart` function (lines 316–427) with:

```js
async function handleStart(msg) {
  const tab = await getActiveTab();

  if (!msg.url || !msg.url.trim()) {
    return { ok: false, error: 'URL is required.' };
  }

  const state = getState(tab.id);
  if (state.active || transcriptControllers.has(tab.id)) {
    return { ok: false, error: 'A transcript extraction is already in progress.' };
  }

  // Create AbortController
  const controller = new AbortController();
  transcriptControllers.set(tab.id, controller);
  syncKeepAlive();

  let timedOut = false;
  let timeoutId = null;
  let resultText = '';
  try {
    resetState(tab.id);
    updateState(tab.id, {
      active: true,
      status: 'Processing',
      progress: 'Checking for subtitles...',
    });

    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRANSCRIPT_TIMEOUT_MS);

    const baseUrl = await getYt2txtEndpoint('/transcript');
    const url = `${baseUrl}?_=${Date.now()}`;

    updateState(tab.id, { progress: 'Sending request to backend...' });

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url, force: msg.force || false }),
      },
      controller.signal
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || payload.detail || `HTTP ${response.status}`);
    }

    const payload = await response.json();

    if (payload.error) {
      throw new Error(payload.error);
    }

    resultText = payload.text || '';

    // Persist result (keyed by tabId, URL-checked on load)
    await chrome.storage.local.set({
      [`transcript:${tab.id}`]: { text: resultText, url: msg.url },
    });

    updateState(tab.id, {
      active: false,
      status: 'Complete',
      progress: `Transcript ready (source: ${payload.source}).`,
      transcript: resultText,
      error: '',
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const errorMsg = timedOut
        ? "Request timed out after 15 minutes."
        : 'Stopped by user.';
      updateState(tab.id, {
        active: false,
        status: 'Error',
        progress: errorMsg,
        error: errorMsg,
      });
    } else {
      const errorMsg = e.message || 'Unknown error';
      updateState(tab.id, {
        active: false,
        status: 'Error',
        progress: errorMsg,
        error: errorMsg,
      });
    }
  } finally {
    clearTimeout(timeoutId);
    if (transcriptControllers.get(tab.id) === controller) {
      transcriptControllers.delete(tab.id);
    }
    syncKeepAlive();
    // Don't clear transcript on error — keep whatever was collected
  }

  // Fire auto-actions after a successful transcript extraction.
  // Chain: Transcript → Format → Translate (sequential).
  // Format fires first; format completion triggers autoTranslate.
  if (resultText) {
    // Cache original transcript before formatting (for retry on format failure)
    await chrome.storage.local.set({ [`transcript_raw:${tab.id}`]: resultText });
    try {
      await handleFormatStart({ tabId: tab.id, text: resultText });
    } catch (e) {
      console.error('auto-format failed:', e);
    }
  }

  return { ok: true };
}
```

The `syncKeepAlive()` in the `finally` MUST be unconditional, never nested inside the identity guard. The auto-format tail stays byte-identical.

Then replace the entire `handleStop` function (lines 430–446) with:

```js
async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);

  state.stopRequested = true;
  const controller = transcriptControllers.get(tab.id);
  if (controller) {
    controller.abort();
  }
  handleTranslateStop(tab.id);
  handleFormatStop(tab.id);

  updateState(tab.id, {
    progress: 'Stopping...',
  });

  return { ok: true };
}
```

`handleStop` MUST NOT delete the transcript map entry and MUST NOT call `syncKeepAlive()`; the aborted `handleStart` performs both when it unwinds.

- [ ] **Step 10: Apply P5–P8 to `extension/background.js`**

Replace the whole `finally` block of `handleTranslateStart` (lines 542–552) with:

```js
  } finally {
    if (translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      chrome.storage.local.remove(`tl2Translating:${tabId}`);
      chrome.runtime
        .sendMessage({ type: 'tl2:translating', tabId, value: false })
        .catch(() => {});
    }
    syncKeepAlive();
  }
```

Replace the entire `handleTranslateStop` function (lines 557–575) with:

```js
function handleTranslateStop(tabId) {
  const controller = translateControllers.get(tabId);
  if (controller) {
    controller.abort();
    translateControllers.delete(tabId);
  }
  syncKeepAlive();
  chrome.storage.local.remove(`tl2Translating:${tabId}`);
  chrome.runtime
    .sendMessage({ type: 'tl2:translating', tabId, value: false })
    .catch(() => {});
  const state = states.get(tabId);
  if (state?.translate?.active) {
    state.translate.active = false;
    state.translate.status = 'Translation stopped.';
    state.translate.error = '';
    broadcastState(tabId);
  }
}
```

Replace the whole `finally` block of `handleFormatStart` (lines 669–674) with:

```js
  } finally {
    if (formatControllers.get(tabId) === controller) {
      formatControllers.delete(tabId);
    }
    syncKeepAlive();
  }
```

Replace the entire `handleFormatStop` function (lines 678–690) with:

```js
function handleFormatStop(tabId) {
  const controller = formatControllers.get(tabId);
  if (controller) {
    controller.abort();
    formatControllers.delete(tabId);
  }
  syncKeepAlive();
  const state = states.get(tabId);
  if (state?.format?.active) {
    state.format.active = false;
    state.format.status = 'Formatting stopped.';
    broadcastState(tabId);
  }
}
```

The registration-time `startKeepAlive()` calls in `handleFormatStart` and `handleTranslateStart`, and the `startKeepAlive()` / `stopKeepAlive()` bodies themselves, stay byte-identical.

- [ ] **Step 11: Run the suite and confirm the green state**

Run: `node --test tests/*.test.js`
Expected: PASS 52/52 — 34 passing in `tests/filebridge.test.js` (25 pre-existing + 9 new keepalive cases) and 18 in `tests/popup.test.js`. No test may be skipped.

- [ ] **Step 12: Apply `ARCHITECTURE.md` deltas D1–D5**

D1 — §2.1 Translate step 4 (`ARCHITECTURE.md:110`). Replace:

```text
    4. Start keepAlive (prevent SW termination)
```

with:

```text
    4. Start keepAlive (idempotent; the interval runs while any of transcriptControllers, formatControllers, translateControllers is non-empty)
```

D2 — §2.1 Translate step 13 (`ARCHITECTURE.md:129-132`). Replace:

```text
        - Remove controller from translateControllers
        - Remove tl2Translating:{tabId}
        - Broadcast { type: 'tl2:translating', tabId, value: false }
        - If no controllers active: stopKeepAlive
```

with:

```text
        - Remove controller from translateControllers (identity-guarded)
        - Remove tl2Translating:{tabId}
        - Broadcast { type: 'tl2:translating', tabId, value: false }
        - syncKeepAlive() — stops the interval only when transcriptControllers, formatControllers, and translateControllers are all empty
```

D3 — §2.2 Format step 4 (`ARCHITECTURE.md:159-160`). Keep line 159 (`    3. Create new AbortController → formatControllers.set(tabId, controller)`) exactly as it is; only the following line 160 changes. The pair below is the unique anchor:

```text
    3. Create new AbortController → formatControllers.set(tabId, controller)
    4. Start keepAlive
```

Replace only that step-4 line with:

```text
    4. Start keepAlive (idempotent; the interval runs while any of transcriptControllers, formatControllers, translateControllers is non-empty)
```

D4 — §2.2 Format step 11 (`ARCHITECTURE.md:172`). Replace:

```text
    11. Finally: remove controller, stopKeepAlive if idle
```

with:

```text
    11. Finally: remove controller (identity-guarded); syncKeepAlive()
```

D5 — §3.1 per-tab state snippet (`ARCHITECTURE.md:244-248`). Replace:

```text
  transcript: '',         // last transcript result
  error: '',
  stopRequested: false,
  controller: null,       // AbortController for transcript fetch
}
```

with:

```text
  transcript: '',         // last transcript result
  error: '',
  stopRequested: false,
}
```

- [ ] **Step 13: Apply `ARCHITECTURE.md` deltas D6–D10**

D6 — §3.5 `onRemoved` snippet (`ARCHITECTURE.md:308-313`). Replace:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) state.controller.abort();
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
```

with:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  const transcriptController = transcriptControllers.get(tabId);
  if (transcriptController) transcriptController.abort();
  transcriptControllers.delete(tabId);
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
  syncKeepAlive();
```

D7 — §5.1, new keepalive paragraph (`ARCHITECTURE.md:372`). Immediately after the closing fence of the §5.1 code block (line 372, before the blank line and `### 5.2`), insert:

```text
**Keepalive:** `handleStart()` registers its transcript AbortController in
`transcriptControllers` and calls `syncKeepAlive()` for the duration of the
`POST /transcript` fetch. The entry is removed in the handler's `finally`
(identity-guarded) and `syncKeepAlive()` is called again, so the interval runs
exactly while at least one of `transcriptControllers` / `formatControllers` /
`translateControllers` is non-empty. Because auto-format starts after that
`finally`, the interval may stop and restart across the transcript→format
handoff (one storage round-trip; harmless). The format→translate handoff is
gap-free when auto-translate is enabled because the translate entry is
registered synchronously before format's `finally`.
```

D8 — §5.5 (`ARCHITECTURE.md:439`). Replace:

```text
`handleFormatStart` resolves the TextKit host/port internally via `getTextkitEndpoint('/format')`.
```

with:

```text
`handleFormatStart` resolves the TextKit host/port internally via `getTextkitEndpoint('/format')`.
Keepalive accounting matches the other operations: `handleStart`'s `finally`
deletes its `transcriptControllers` entry (identity-guarded) and calls
`syncKeepAlive()`; `handleFormatStart` registers its format controller and
calls `startKeepAlive()` before awaiting the request. See §5.1 for the
handoff semantics.
```

D9 — §8.6 (`ARCHITECTURE.md:623`). Replace:

```text
- `keepAliveIntervalId` prevents SW termination while any operation is in-flight
```

with:

```text
- `keepAliveIntervalId` prevents SW termination while any of `transcriptControllers`, `formatControllers`, or `translateControllers` is non-empty (kept in sync by `syncKeepAlive()`)
```

D10 — §9.2 state-management table (`ARCHITECTURE.md:653`). Replace:

```text
| `translateControllers` / `formatControllers` Maps: separate AbortController per tab per operation
```

with:

```text
| `transcriptControllers` / `translateControllers` / `formatControllers` Maps: separate AbortController per tab per operation (the interval runs while any is non-empty; `syncKeepAlive()` maintains the accounting)
```

- [ ] **Step 14: Run the acceptance checks**

Run: `grep -n "state\.controller" extension/background.js`
Expected: no output (grep exits 1); all four production references (`state.controller = controller`, `state.controller = null`, `if (state.controller)`, `if (state?.controller)`) are gone.

Run: `node --test tests/*.test.js`
Expected: PASS 52/52 (34 in `tests/filebridge.test.js`, 18 in `tests/popup.test.js`).

Run: `git diff --name-only`
Expected exactly:

```text
ARCHITECTURE.md
extension/background.js
tests/filebridge.test.js
```

No popup, backend, TextKit, or File Bridge file may appear in the diff.

- [ ] **Step 15: Commit**

```bash
git add extension/background.js tests/filebridge.test.js ARCHITECTURE.md
git commit -m "fix(extension): keep SW alive while any transcript/format/translate operation is in flight"
```
