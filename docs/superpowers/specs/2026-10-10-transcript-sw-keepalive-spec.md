# Transcript SW Keepalive — Technical Specification

- **Date:** 2026-10-10
- **Topic:** transcript-sw-keepalive
- **PM run:** pm-run-20261010-045034-eddb43d8
- **Design input:** `docs/superpowers/specs/2026-10-10-transcript-sw-keepalive-design.md` (approved; design-reviewed with 0 blockers)
- **Base commit for all quoted current code:** `11bf4c8` (`extension/background.js` is unchanged in this worktree)
- **Status:** ready for implementation
- **Deliverable of this document:** exactly one new file; no existing file is modified by the drafter, nothing is committed.

Normative words **MUST**, **MUST NOT**, **SHOULD** are used in the RFC 2119 sense.

---

## 0. How to read this spec

All production changes are confined to `extension/background.js`. Test changes are confined to `tests/filebridge.test.js`. Documentation changes are confined to `ARCHITECTURE.md`.

Notation used below:

| Symbol | Meaning |
| --- | --- |
| `T` | `transcriptControllers` |
| `F` | `formatControllers` |
| `X` | `translateControllers` |
| `KA` | keepalive interval running, i.e. `keepAliveIntervalId !== null` |
| `∅` | the corresponding map is empty |
| `tab.id` / `tabId` | numeric Chrome tab id |

The proposed production code in §1 and the proposed tests in §6 were materialized in a throwaway copy of this repo and executed on Node v24.15.0: the complete JS suite passes (52/52) and targeted mutations of the fix make the new tests fail (see §10). The code blocks below are the verified text; implementers SHOULD use them verbatim except where clearly marked as explanatory.

---

## 1. Scope of production changes

| Ref | File | Region (base-commit lines) | Change summary |
| --- | --- | --- | --- |
| P1 | `extension/background.js` | 175–192 (`Translation / Format controllers` section) | add `const transcriptControllers = new Map();`; add `syncKeepAlive()` |
| P2 | `extension/background.js` | 194–210 (`chrome.tabs.onRemoved`) | abort/delete via `transcriptControllers`; call `syncKeepAlive()`; drop `state.controller` |
| P3 | `extension/background.js` | 316–427 (`handleStart`) | add `transcriptControllers.has(tab.id)` reject; register controller + `syncKeepAlive()`; move body into `try`; `finally` does identity-guarded delete + unconditional `syncKeepAlive()`; drop `state.controller` |
| P4 | `extension/background.js` | 430–446 (`handleStop`) | abort from `transcriptControllers.get(tab.id)` instead of `state.controller` |
| P5 | `extension/background.js` | 542–552 (`handleTranslateStart` `finally`) | replace `if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();` with `syncKeepAlive();` |
| P6 | `extension/background.js` | 557–575 (`handleTranslateStop`) | call `syncKeepAlive()` after the abort + map delete |
| P7 | `extension/background.js` | 669–674 (`handleFormatStart` `finally`) | replace the same conditional stop with `syncKeepAlive();` |
| P8 | `extension/background.js` | 678–690 (`handleFormatStop`) | call `syncKeepAlive()` after the abort + map delete |

Nothing else in `background.js` changes. In particular the registration-time `startKeepAlive()` calls in `handleFormatStart` and `handleTranslateStart` stay (see Interpretation I-1), `startKeepAlive()` / `stopKeepAlive()` themselves stay byte-identical, and the auto-format tail of `handleStart` stays byte-identical.

### P1. New declarations and `syncKeepAlive()`

**Current** (`extension/background.js:175–192`):

```js
// ── Translation / Format controllers ────────────────────────────
const translateControllers = new Map();
const formatControllers = new Map();
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
```

**Replacement:**

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

Placement is normative: `transcriptControllers` is declared in this section, which is evaluated before `chrome.tabs.onRemoved.addListener(...)` is registered and before any handler can run, so the closures in P2/P3/P4 always see an initialized binding. The section comment may be left as-is; changing it is cosmetic and optional (Interpretation I-8).

### P2. `chrome.tabs.onRemoved`

**Current** (`extension/background.js:194–210`):

```js
// ── Clean up on tab close ───────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) {
    state.controller.abort();
  }
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
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

**Replacement** (only the listener head changes; the storage-remove tail is unchanged):

```js
// ── Clean up on tab close ───────────────────────────────────────
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

Ordering note: the abort and the `transcriptControllers.delete(tabId)` happen synchronously before the stop helpers, so by the time `syncKeepAlive()` runs the transcript account for the tab is already gone. `handleTranslateStop` / `handleFormatStop` now each call `syncKeepAlive()` too, making the explicit call idempotent (Interpretation I-4).

### P3. `handleStart`

**Current** (`extension/background.js:316–427`):

```js
async function handleStart(msg) {
  const tab = await getActiveTab();

  if (!msg.url || !msg.url.trim()) {
    return { ok: false, error: 'URL is required.' };
  }

  const state = getState(tab.id);
  if (state.active) {
    return { ok: false, error: 'A transcript extraction is already in progress.' };
  }

  // Create AbortController
  const controller = new AbortController();
  state.controller = controller;

  resetState(tab.id);
  updateState(tab.id, {
    active: true,
    status: 'Processing',
    progress: 'Checking for subtitles...',
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSCRIPT_TIMEOUT_MS);

  let resultText = '';
  try {
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
    state.controller = null;
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

**Replacement (normative, complete function):**

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

Semantics of each delta:

1. **Early return, invalid URL** — unchanged; it returns before any controller or map mutation.
2. **Early return, already active** — now `state.active || transcriptControllers.has(tab.id)`. Both checks are synchronous and adjacent to the registration below, so two concurrent `handleStart` calls cannot both register: the first registers before its first `await`, the second observes `state.active === true` and/or a non-empty `T`.
3. **Registration** — `transcriptControllers.set(tab.id, controller); syncKeepAlive();` replaces `state.controller = controller;`. No `await` occurs between the duplicate-start check, the `set`, and the `syncKeepAlive()`, so the accounting transition is atomic with respect to other event-loop turns.
4. **`try` starts immediately after registration** — `resetState`, `updateState`, the `setTimeout`, and the whole request path are inside the `try`, so the `finally` runs for every throw after registration. `let timedOut` / `let timeoutId = null` / `let resultText = ''` sit between `syncKeepAlive()` and `try`; they are inert declarations that cannot throw (Interpretation I-2). `clearTimeout(null)` is a no-op if the `setTimeout` call itself never executed.
5. **`finally`** — `clearTimeout(timeoutId)` unchanged; `state.controller = null;` replaced by the identity-guarded delete plus unconditional `syncKeepAlive()`. The `syncKeepAlive()` call MUST NOT be nested inside the `if`, so an entry replaced by a newer registration still results in a correct accounting pass.
6. **Auto-format tail** — byte-identical. It runs after the transcript entry has already been deleted and `syncKeepAlive()` has already run; this is the documented stop/restart handoff (see §4 and Interpretation I-2).

### P4. `handleStop`

**Current** (`extension/background.js:430–446`):

```js
async function handleStop() {
  const tab = await getActiveTab();
  const state = getState(tab.id);

  state.stopRequested = true;
  if (state.controller) {
    state.controller.abort();
  }
  handleTranslateStop(tab.id);
  handleFormatStop(tab.id);

  updateState(tab.id, {
    progress: 'Stopping...',
  });

  return { ok: true };
}
```

**Replacement** (only the abort lookup changes):

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

`handleStop` MUST NOT delete the transcript map entry and MUST NOT call `syncKeepAlive()` itself. The aborted `handleStart` unwinds into its own `finally`, which performs the identity-guarded delete and the accounting pass. `handleStop` therefore returns before the interval actually stops when only a transcript was active (Interpretation I-3; this timing is asserted by test case 6).

### P5. `handleTranslateStart` `finally`

**Current** (`extension/background.js:542–552`, the `finally` block only):

```js
  } finally {
    if (translateControllers.get(tabId) === controller) {
      translateControllers.delete(tabId);
      chrome.storage.local.remove(`tl2Translating:${tabId}`);
      chrome.runtime
        .sendMessage({ type: 'tl2:translating', tabId, value: false })
        .catch(() => {});
    }
    if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }
```

**Replacement** (only the last statement changes):

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

The identity-guarded delete and the storage/message cleanup stay exactly as they are. The registration-time `translateControllers.set(tabId, controller); startKeepAlive();` at the top of the function also stays (Interpretation I-1).

### P6. `handleTranslateStop`

**Current** (`extension/background.js:557–575`):

```js
function handleTranslateStop(tabId) {
  const controller = translateControllers.get(tabId);
  if (controller) {
    controller.abort();
    translateControllers.delete(tabId);
  }
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

**Replacement** (insert one line immediately after the delete block):

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

### P7. `handleFormatStart` `finally`

**Current** (`extension/background.js:669–674`, the `finally` block only):

```js
  } finally {
    if (formatControllers.get(tabId) === controller) {
      formatControllers.delete(tabId);
    }
    if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();
  }
```

**Replacement** (only the last statement changes):

```js
  } finally {
    if (formatControllers.get(tabId) === controller) {
      formatControllers.delete(tabId);
    }
    syncKeepAlive();
  }
```

The registration-time `formatControllers.set(tabId, controller); startKeepAlive();` and the `existing.abort()` abort-and-replace prologue stay exactly as they are (Interpretation I-1).

**Pre-existing limitation (out of scope):** the registration-time `set`/`startKeepAlive()` precedes this `try {`; a synchronous throw in the statements between (the `state.format.*` writes and `broadcastState`, which swallows promise rejections) would leak the entry. This predates the change and is unchanged by the design. It is recorded here so the leak claim in the design's risks section is read as applying to `handleStart`.

### P8. `handleFormatStop`

**Current** (`extension/background.js:678–690`):

```js
function handleFormatStop(tabId) {
  const controller = formatControllers.get(tabId);
  if (controller) {
    controller.abort();
    formatControllers.delete(tabId);
  }
  const state = states.get(tabId);
  if (state?.format?.active) {
    state.format.active = false;
    state.format.status = 'Formatting stopped.';
    broadcastState(tabId);
  }
}
```

**Replacement** (insert one line immediately after the delete block):

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

---

## 2. Contracts

### 2.1 `transcriptControllers`

| Aspect | Contract |
| --- | --- |
| Type | `Map<number, AbortController>` |
| Key | Chrome tab id: `tab.id` from `getActiveTab()` in `handleStart`; the `tabId` argument in `chrome.tabs.onRemoved` |
| Value | The `AbortController` whose `signal` is passed to `fetchWithTimeout(url, options, controller.signal)` for that tab's `POST /transcript` |
| Ownership | Owned solely by `background.js`. Never stored in `chrome.storage`, never sent in a message, never exposed to the popup |
| When set | `handleStart`, exactly once per invocation, after the URL/duplicate-start early returns, before the `try`; immediately followed by `syncKeepAlive()` in the same synchronous block |
| When deleted (1) | `handleStart` `finally`, only if `transcriptControllers.get(tab.id) === controller` (identity guard). A stale handler whose entry was replaced MUST NOT delete the current entry |
| When deleted (2) | `chrome.tabs.onRemoved(tabId)` unconditionally, by key, immediately after aborting it (if present) |
| Not deleted by | `handleStop` and the 15-minute timeout callback; both only call `.abort()`. Deletion is always completed by the owning handler's `finally` (or by tab close) |
| Lifetime invariant | At most one entry per tab. A second `handleStart` for the same tab is rejected while an entry exists, so replacement of a `T` entry cannot happen in normal operation; the identity guard remains as defense in depth |

Exact identity-guard block (normative):

```js
    if (transcriptControllers.get(tab.id) === controller) {
      transcriptControllers.delete(tab.id);
    }
```

### 2.2 `syncKeepAlive()`

Exact body (normative; also in P1):

```js
function syncKeepAlive() {
  const hasWork =
    transcriptControllers.size > 0 ||
    formatControllers.size > 0 ||
    translateControllers.size > 0;
  if (hasWork) startKeepAlive();
  else stopKeepAlive();
}
```

| Aspect | Contract |
| --- | --- |
| Purpose | Derive the keepalive state from the three operation maps; it is the single accounting authority after this change |
| Reads | `size` of `T`, `F`, `X` only. It MUST NOT mutate any map |
| Effect | `startKeepAlive()` if any map is non-empty, otherwise `stopKeepAlive()` |
| Idempotent | Yes. `startKeepAlive()` is a no-op when `keepAliveIntervalId` is truthy; `stopKeepAlive()` is a no-op when it is `null`. Repeated `syncKeepAlive()` calls with unchanged maps produce zero additional state transitions |
| Call sites (normative) | `handleStart` after `T.set` and in `finally`; `handleTranslateStart` `finally`; `handleTranslateStop` after delete; `handleFormatStart` `finally`; `handleFormatStop` after delete; `chrome.tabs.onRemoved` after cleanup. `handleFormatStart`/`handleTranslateStart` registration keep `startKeepAlive()` (equivalent because the map was just made non-empty) |
| Never called by | `handleStop` itself (see Interpretation I-3) |

### 2.3 `state.controller` removal

`state.controller` was never part of the object literal created by `getState()`; it was attached dynamically by `handleStart` and read in two places. All references MUST be removed:

| Reference | Base location | Disposition |
| --- | --- | --- |
| `state.controller = controller;` | `background.js:330` | deleted (replaced by `transcriptControllers.set(...)`) |
| `state.controller = null;` | `background.js:409` | deleted (replaced by identity-guarded map delete + `syncKeepAlive()`) |
| `if (state.controller) { state.controller.abort(); }` | `background.js:435–436` (`handleStop`) | replaced by `transcriptControllers.get(tab.id)` |
| `if (state?.controller) { state.controller.abort(); }` | `background.js:196–197` (`chrome.tabs.onRemoved`) | replaced by `transcriptControllers.get(tabId)` + delete |
| `controller: null,       // AbortController for transcript fetch` | `ARCHITECTURE.md:247` | deleted from the documented state shape (§7) |

No external consumers exist. Evidence: `extension/popup.js` and `tests/popup.test.js` contain zero occurrences of `controller`; the only production references were the five above; the only doc references are the two in `ARCHITECTURE.md` addressed in §7. The popup receives state only through the `state:update` / `popup:get-state` payloads, which are the raw `getState(tabId)` object (see §5).

---

## 3. Error behavior matrix

Assumptions for the table: no other tab has any operation in flight unless the row says so; `F`/`X` refer to the same tab as the transcript unless stated otherwise. "after unwind" means after the owning async handler's `finally` has run. The table states the steady state; transient states inside a synchronous block are covered in §4.

| # | Exit path | Trigger / condition | `T` | `F` | `X` | Keepalive | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Early return — invalid URL | `!msg.url || !msg.url.trim()` | unchanged (∅) | unchanged | unchanged | unchanged (off) | Returns `{ok:false,error:'URL is required.'}` before `getState`/registration |
| 2 | Early return — already active | `state.active \|\| T.has(tab.id)` | unchanged (non-empty) | unchanged | unchanged | unchanged (on) | Returns `{ok:false,error:'A transcript extraction is already in progress.'}`; no registration, no timer |
| 3 | Success — non-empty transcript, auto-format succeeds, auto-translate off | `/transcript` HTTP 2xx + non-empty `payload.text` | ∅ after unwind | ∅ after format unwind | ∅ | on while transcript runs; off/on across the handoff; off after format unwind | `handleStart` `finally` deletes `T` and syncs (brief stop), then `handleFormatStart` registers and starts the interval; format `finally` deletes and syncs → off |
| 4 | Success — empty transcript | `/transcript` HTTP 2xx + empty/falsy `payload.text` | ∅ after unwind | ∅ | ∅ | off after unwind | `resultText` is falsy so the auto-format tail does not run; state status `Complete` |
| 5 | Generic fetch error | non-2xx response, `payload.error`, or network rejection (non-`AbortError`) | ∅ after unwind | ∅ | ∅ | off after unwind | Catch sets `state.status='Error'`; no auto-format because `resultText` stayed `''` |
| 6 | `AbortError` — user stop | `handleStop()` aborts via `T.get(tab.id)`; also calls `handleTranslateStop(tab.id)` + `handleFormatStop(tab.id)` | ∅ after the aborted handler's `finally` | ∅ (aborted + deleted by `handleFormatStop`) | ∅ (aborted + deleted by `handleTranslateStop`) | stays on between `handleStop` return and the handler `finally`; off afterwards | `handleStop` returns before the aborted `handleStart` unwinds. The stop helpers' `syncKeepAlive()` sees `T` still non-empty, so nothing stops early. State error `Stopped by user.` |
| 7 | `AbortError` — 15-minute timeout | `setTimeout(..., TRANSCRIPT_TIMEOUT_MS)` fires `controller.abort()` with `timedOut = true` | ∅ after unwind | unchanged (timeout does not touch `F`) | unchanged (timeout does not touch `X`) | off if `F`/`X` empty; on if another operation is active | No `handleTranslateStop`/`handleFormatStop` call, so same-tab format/translate survive the timeout. State error `Request timed out after 15 minutes.` |
| 8 | Format abort-and-replace | second `handleFormatStart(tabId)` while first in flight | unchanged | new controller (stale `finally` fails identity guard) | unchanged | stays on | New `set` happens before the stale handler unwinds; stale `finally`'s `syncKeepAlive()` sees non-empty `F` |
| 9 | Translate abort-and-replace | second `handleTranslateStart(tabId)` while first in flight | unchanged | unchanged | new controller (stale `finally` fails identity guard) | on, with a synchronous stop/start inside the second start (see §4) | `handleTranslateStop` at the top of the second call deletes the old entry and syncs (may stop); the new `set` + `startKeepAlive()` restarts in the same synchronous block. The first handler's stale `finally` syncs and keeps it on |
| 10 | Tab close mid-transcript | `chrome.tabs.onRemoved(tabId)` | entry aborted + deleted synchronously; stale `finally` then finds no match | tab's entry aborted + deleted by `handleFormatStop` | tab's entry aborted + deleted by `handleTranslateStop` | off if no other tab has work; on otherwise | Explicit `syncKeepAlive()` in the listener; the aborted handler's later `finally` syncs again (idempotent) |
| 11 | Manual format stop with transcript active | `handleFormatStop(tabId)` | non-empty | ∅ after delete | unchanged | stays on | Sync accounting no longer waits for the aborted format handler to unwind |
| 12 | Manual translate stop with format active | `handleTranslateStop(tabId)` | unchanged | non-empty | ∅ after delete | stays on | Same as row 11 |
| 13 | Tab close with no in-flight operations | `chrome.tabs.onRemoved(tabId)` | ∅ | ∅ | ∅ | off | Stop helpers and explicit sync are all no-ops for the timer |

---

## 4. State invariant and transitions

### 4.1 Invariant

At every quiescent point (after a handler has run to completion or suspended at an `await`), the following holds:

```
keepAliveIntervalId !== null   ⇔
    transcriptControllers.size > 0
    ∨ formatControllers.size > 0
    ∨ translateControllers.size > 0
```

Equivalently: the interval runs **iff** at least one transcript, format, or translate operation is in flight on any tab.

`syncKeepAlive()` is the only function that derives `keepAliveIntervalId` from the maps, and `startKeepAlive()` / `stopKeepAlive()` are its only writers. Therefore the invariant is preserved if and only if every map mutation is followed, in the same synchronous block, by a call to `syncKeepAlive()` (or, at registration time, `startKeepAlive()`, which is the correct derived action because the map was just made non-empty).

### 4.2 Transitions

| Event | Mutation | Accounting call (same synchronous block) | Derived state |
| --- | --- | --- | --- |
| `handleStart` passes validation | `T.set(tabId, controller)` | `syncKeepAlive()` | on |
| `handleStart` exits (success, error, abort, timeout) | `T.delete` if identity matches | `syncKeepAlive()` in `finally` (unconditional) | on iff `F ∪ X` non-empty |
| `handleStart` stale entry (entry no longer matches) | none | `syncKeepAlive()` in `finally` | unchanged; on iff `F ∪ X` non-empty |
| `handleFormatStart` passes validation | `F.set(tabId, controller)` | `startKeepAlive()` (equivalent to `syncKeepAlive()` here) | on |
| `handleFormatStart` exits | `F.delete` if identity matches | `syncKeepAlive()` in `finally` | on iff `T ∪ X` non-empty |
| `handleFormatStop(tabId)` | `F.delete` | `syncKeepAlive()` after delete | on iff `T ∪ X` non-empty |
| `handleTranslateStart` passes validation | `X.set(tabId, controller)` | `startKeepAlive()` | on |
| `handleTranslateStart` exits | `X.delete` if identity matches (+ storage/message cleanup) | `syncKeepAlive()` in `finally` | on iff `T ∪ F` non-empty |
| `handleTranslateStop(tabId)` | `X.delete` | `syncKeepAlive()` after delete | on iff `T ∪ F` non-empty |
| `chrome.tabs.onRemoved(tabId)` | `T.delete`; `handleTranslateStop` deletes `X`; `handleFormatStop` deletes `F` | each helper syncs; explicit `syncKeepAlive()` after `states.delete` | on iff remaining tabs' `T ∪ F ∪ X` non-empty |
| Any `syncKeepAlive()` with unchanged maps | none | idempotent | unchanged |

### 4.3 Transient deviations permitted by the design

- **Transcript→format handoff:** `handleStart`'s `finally` deletes `T` and syncs while `F` is still empty, so the interval stops; `handleFormatStart` registers `F` and starts it again in the same event-loop turn's continuation. The gap is one `chrome.storage.local.set` round-trip, four-plus orders of magnitude inside the 30 s idle budget. This is expected and asserted as exactly one actual stop in test case 8.
- **Translate replacement:** the second `handleTranslateStart` calls `handleTranslateStop` first, which deletes the old `X` and may stop the interval, then registers the new controller and restarts it. The whole sequence is synchronous (no `await` between the stop and the restart), so no termination timer can observe the gap.
- **Within a synchronous mutation block**, the invariant may be false between a `set`/`delete` and its adjacent accounting call. This window never spans an `await`, so Chrome cannot terminate the worker in it and no other listener can observe it.

---

## 5. Interfaces

### 5.1 Message interfaces — no change

All message types, directions, payloads, and responses are unchanged:

- Popup→background: `popup:start`, `popup:stop`, `popup:get-state`, `format:start`, `format:stop`, `translate:start`, `translate:stop`, `save:translation`.
- Background→popup/offscreen: `state:update`, `translation:update`, `tl2:translating`, `offscreen:copy`.

No new message type is introduced. `transcriptControllers` and `syncKeepAlive` are module-scope internals and are never exposed through messaging.

### 5.2 Storage interfaces — no change

No new `chrome.storage.sync` or `chrome.storage.local` key is added, removed, or renamed. The per-tab keys (`transcript:${tabId}`, `transcript_raw:${tabId}`, `translate:result:${tabId}`, `tl2Translating:${tabId}`, `fmtResult:${tabId}`) and all sync settings keys keep their current names, types, and defaults. `transcriptControllers` is in-memory only.

### 5.3 HTTP endpoints — no change

The extension still calls exactly: YT2TXT `POST /transcript` (and `/health` out of band), TextKit `POST /format` and `POST /translate`, File Bridge `POST /save` and `GET /paths`. Timeout constants `TRANSCRIPT_TIMEOUT_MS` (15 min) and `BACKEND_TIMEOUT_MS` (12 min) are unchanged.

### 5.4 Popup-visible state shape

The popup-visible state is the raw `getState(tabId)` object delivered by `state:update` and `popup:get-state`. After this change the only shape delta is the removal of the dynamically-attached `controller` property.

- Before: while a transcript was active, `state.controller` held the `AbortController`; `chrome.runtime.sendMessage` serialized it to `{}` inside every `state:update` payload.
- After: no `controller` key is ever present. No other field is added, removed, or renamed.
- Consumers: `extension/popup.js` reads only `active`, `status`, `progress`, `transcript`, `error`, `stopRequested`, `format.*`, and `translate.*`; it never reads `controller`. `tests/popup.test.js` never references it. Removing the key is therefore safe and is explicitly required by the design.

---

## 6. Test fixtures

All tests live in `tests/filebridge.test.js` (append after the existing tests), use `node:test`/`node:assert/strict` exactly like the existing tests, and use the existing `createBackgroundHarness` VM harness. `node:test` style is preserved: no TypeScript, no new dependencies.

### 6.1 Harness changes (required before the new tests run)

**(a)+(b) aliases** — current text:

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

- `__isKeepAliveRunning` MUST be a live arrow getter (`() => keepAliveIntervalId !== null`), not a captured boolean. `keepAliveIntervalId` is a top-level `let`, and the arrow re-reads it on every call (verified in the VM).
- `__transcriptControllers` is the live `Map` reference.

**(c) `tabs.onRemoved` event** — current `createBackgroundHarness` body:

```js
  const onStorageChanged = createEvent();
```

becomes:

```js
  const onStorageChanged = createEvent();
  const onTabRemoved = createEvent();
```

and the chrome stub:

```js
    tabs: {
      onRemoved: { addListener() {} },
      query: async () => [{ id: 1, windowId: 10, active: true }]
    },
```

becomes:

```js
    tabs: {
      onRemoved: onTabRemoved,
      query: async () => [{ id: 1, windowId: 10, active: true }]
    },
```

`onTabRemoved` is returned to tests as shown in the replacement return object above; tests trigger the listener with `harness.onTabRemoved.emit(tabId)`.

Harness facts the fixtures rely on (unchanged by this spec):

- `setInterval` is stubbed to return `1`; `clearInterval` is the Node built-in, for which `clearInterval(1)` is a no-op. Therefore "running" is exactly `keepAliveIntervalId !== null`, and `__isKeepAliveRunning()` is the assertion for every case.
- `chrome.tabs.query` always resolves the active tab id `1`, so `handleStart` (which calls `getActiveTab()`) always operates on tab 1. Operations that accept an explicit `tabId` (format/translate) can use any id.
- All other stubs (`storage`, `runtime`, `offscreen`, `notifications`, `commands`) are unchanged.

### 6.2 New test helpers

Append these two helpers immediately before the new tests (function declarations hoist, so placement inside the appended block is fine):

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

Why this wiring: `fetch` never settles until the test resolves or rejects the matching deferred; each call on a path gets its own deferred (index-addressed), which is what abort-and-replace cases 5 and 7 need; when the caller's `signal` aborts, the pending fetch rejects with `new DOMException('Aborted', 'AbortError')`, reproducing the browser behavior the handlers' `catch (e)` blocks depend on.

### 6.3 Cases 1–9

#### Case 1 — transcript in flight → keepalive running

Harness: default (`syncValues` empty, auto-translate default `false`). Router: `deferredFetchQueue()`.

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

Exact assertions: `T.has(1)` true; `KA` true; exactly one `/transcript` fetch; after `handleStop` + `await operation`, `T` empty and `KA` false.

#### Case 2 — transcript done + auto-format in flight → running; after format (auto-translate off) → stopped

Harness: `syncValues: { yt2txtAutoTranslate: false }`. Router: `deferredFetchQueue()`.

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

Exact assertions: once `/format` is pending, `T` no longer has the entry, `F` does, `KA` true; after the format response and `await operation` (which awaits the whole auto-format chain), `F` empty and `KA` false.

#### Case 3 — transcript fails with no format → keepalive stopped (leak regression)

Harness: default. Router: `deferredFetchQueue()`.

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

Exact assertions: before resolution `KA` true; after the HTTP error response, `T` empty, `KA` false, `state.error` matches the backend message. This is the regression test for the naive one-line fix.

#### Case 4 — transcript pending on tab 1 while a format on tab 2 completes

Harness: `syncValues: { yt2txtAutoTranslate: false }`. Router: `deferredFetchQueue()`. Note the harness's active tab is always id 1, so the transcript is tab 1 and the independent format uses the explicit `tabId: 2`.

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

Exact assertions: after format completes on tab 2, `F` is empty but `T` on tab 1 is still present and `KA` true; after stopping tab 1 and awaiting the transcript handler, `KA` false.

#### Case 5 — translate abort-and-replace keeps the newer controller alive

Harness: default. Router: `deferredFetchQueue()`.

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

Exact assertions: first controller's signal aborted; after the stale first handler unwinds, `X.has(7)` still true and `KA` true; after the second response, `X` empty and `KA` false. `/translate` deferred index `1` is the second request's response.

#### Case 6 — `handleStop` aborts transcript and stops keepalive after unwind

Harness: default. Router: `deferredFetchQueue()`.

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

Exact assertions: `handleStop` is awaited, but the stopping happens when the aborted `handleStart` unwinds, so the test awaits `operation` before asserting `T` empty and `KA` false. State status `Error` with `Stopped by user.` message. (The router's abort listener rejects the pending fetch when `handleStop` aborts.)

#### Case 7 — format abort-and-replace keeps the newer controller alive

Harness: default. Router: `deferredFetchQueue()`.

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

Exact assertions mirror case 5 for `F`.

#### Case 8 — auto-translate chain has no gap across the format→translate handoff

Harness: `syncValues: { yt2txtAutoTranslate: true, tl2Language: 'French' }`. Router: `deferredFetchQueue()`. The fixture additionally wraps `clearInterval` to count **actual** stops (`stopKeepAlive()` calls `clearInterval` only while the interval is running), because a boolean snapshot cannot distinguish "never stopped" from "stopped and restarted".

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

Exact assertions: when `/translate` is pending, `X.has(1)` true, `KA` true, and `stopCount === 1` (the transcript→format handoff stop; a second stop here would mean a real gap). After `await operation` (transcript+format done), `KA` still true and `stopCount` still `1`. After the translate response, `KA` false and `stopCount === 2`.

#### Case 9 — tab close mid-transcript aborts, cleans up, stops

Harness: default. Router: `deferredFetchQueue()`. Requires harness change (c).

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

Exact assertions: immediately after the synchronous `onRemoved` emit, `T.has(1)` false and `KA` false; after the aborted handler unwinds, still false. `result.ok === true`.

### 6.4 Verification commands and falsifiability evidence

- Run: `node --test tests/*.test.js` (or bare `node --test` from the repo root). **Environment note:** the design's literal command `node --test tests/` fails on Node v24.15.0 with `Cannot find module '<repo>/tests'`; use the glob or bare `node --test` (Interpretation I-7).
- Expected on the implemented change: the complete JS suite passes — 34 tests in `tests/filebridge.test.js` (25 pre-existing + 9 new) and 52 tests overall including `tests/popup.test.js`; all pre-existing Python tests (`pytest tests/`) are unaffected because no Python file changes. Verified on Node v24.15.0.
- When investigating a failing run, use `node --test --test-force-exit tests/filebridge.test.js`: a failure that occurs before the test awaits the operation leaves `handleStart`'s real 15-minute `TRANSCRIPT_TIMEOUT_MS` timer pending, so the runner does not exit until it fires. (Alternatively, pass a tracking `setTimeout` stub through the harness's existing `options.setTimeout`.)
- Falsifiability (run in the throwaway verification copy): removing `syncKeepAlive()` after `transcriptControllers.set(...)` in `handleStart` makes cases 1–4, 6, 8, 9 fail; removing the `syncKeepAlive()` in `handleStart`'s `finally` makes cases 1, 3, 4, 6, 8 fail. The fixtures are not vacuous.

---

## 7. Documentation deltas (`ARCHITECTURE.md`)

All edits below are exact old-text → new-text replacements. Line numbers refer to the base commit.

### D1 — §2.1 Translate step 4 (line ~110)

Old:

```
    4. Start keepAlive (prevent SW termination)
```

New:

```
    4. Start keepAlive (idempotent; the interval runs while any of transcriptControllers, formatControllers, translateControllers is non-empty)
```

### D2 — §2.1 Translate step 13 (lines ~129, ~132)

Old:

```
        - Remove controller from translateControllers
        - Remove tl2Translating:{tabId}
        - Broadcast { type: 'tl2:translating', tabId, value: false }
        - If no controllers active: stopKeepAlive
```

New:

```
        - Remove controller from translateControllers (identity-guarded)
        - Remove tl2Translating:{tabId}
        - Broadcast { type: 'tl2:translating', tabId, value: false }
        - syncKeepAlive() — stops the interval only when transcriptControllers, formatControllers, and translateControllers are all empty
```

(The `(identity-guarded)` clarification is a documentation-clarity addition on the same block; the normative change is the last bullet.)

### D3 — §2.2 Format step 4 (line ~160)

Old (the step-3 line is included because `    4. Start keepAlive` alone also matches the
translate flow at D1; the combined block is unique):

```
    3. Create new AbortController → formatControllers.set(tabId, controller)
    4. Start keepAlive
```

New:

```
    3. Create new AbortController → formatControllers.set(tabId, controller)
    4. Start keepAlive (idempotent; the interval runs while any of transcriptControllers, formatControllers, translateControllers is non-empty)
```

### D4 — §2.2 Format step 11 (line ~172)

Old:

```
    11. Finally: remove controller, stopKeepAlive if idle
```

New:

```
    11. Finally: remove controller (identity-guarded); syncKeepAlive()
```

### D5 — §3.1 per-tab state snippet (lines ~244–247)

Old:

```
  transcript: '',         // last transcript result
  error: '',
  stopRequested: false,
  controller: null,       // AbortController for transcript fetch
}
```

New:

```
  transcript: '',         // last transcript result
  error: '',
  stopRequested: false,
}
```

### D6 — §3.5 `onRemoved` snippet (line ~310)

Old:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  const state = states.get(tabId);
  if (state?.controller) state.controller.abort();
  handleTranslateStop(tabId);
  handleFormatStop(tabId);
  states.delete(tabId);
```

New:

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

### D7 — §5.1 Trigger: Transcript completes (after the code block, line ~374)

Add a new paragraph immediately after the closing fence of the §5.1 code block:

```
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

### D8 — §5.5 Auto-format (after the closing sentence, line ~440)

Old:

```
`handleFormatStart` resolves the TextKit host/port internally via `getTextkitEndpoint('/format')`.
```

New:

```
`handleFormatStart` resolves the TextKit host/port internally via `getTextkitEndpoint('/format')`.
Keepalive accounting matches the other operations: `handleStart`'s `finally`
deletes its `transcriptControllers` entry (identity-guarded) and calls
`syncKeepAlive()`; `handleFormatStart` registers its format controller and
calls `startKeepAlive()` before awaiting the request. See §5.1 for the
handoff semantics.
```

### D9 — §8.6 SW termination during operation (line ~623)

Old:

```
- `keepAliveIntervalId` prevents SW termination while any operation is in-flight
```

New:

```
- `keepAliveIntervalId` prevents SW termination while any of `transcriptControllers`, `formatControllers`, or `translateControllers` is non-empty (kept in sync by `syncKeepAlive()`)
```

### D10 — §9.2 background.js state-management table (line ~653)

Old:

```
| `translateControllers` / `formatControllers` Maps: separate AbortController per tab per operation
```

New:

```
| `transcriptControllers` / `translateControllers` / `formatControllers` Maps: separate AbortController per tab per operation (the interval runs while any is non-empty; `syncKeepAlive()` maintains the accounting)
```

---

## 8. Out of scope

Copied from the approved design §3; implementation MUST NOT creep into any of these:

- No changes to `extension/popup.js`, the Python backend, TextKit, or File Bridge.
- No migration of the long transcript fetch to an offscreen document.
- No changes to timeout constants (`TRANSCRIPT_TIMEOUT_MS`, `BACKEND_TIMEOUT_MS`).
- No changes to transcript/format/translate semantics, endpoints, or persistence formats.
- The manual Save path (`handleSaveTranslation`) uses `fetchWithTimeout`'s internal controller and remains unaccounted: a >30 s manual save with the popup closed can still be killed by worker termination. This is a recorded scope decision, intentionally out of scope for this fix.
- No new message types, storage keys, or popup-visible fields (other than dropping `controller` from the state payload, §5.4).
- No changes to the `startKeepAlive()` / `stopKeepAlive()` implementations themselves.

---

## 9. Interpretations flagged for review

Each item below is a point where the approved design does not dictate a single mechanical edit; the chosen interpretation is the one that best preserves the §4.1 invariant. The materialized-and-tested reference implementation follows these interpretations.

- **Interpretation I-1 — Registration-time `startKeepAlive()` stays.** Design §4.3 only replaces the conditional stop in `handleFormatStart` / `handleTranslateStart` `finally` blocks; it does not say to change the `startKeepAlive()` calls that immediately follow `formatControllers.set(...)` / `translateControllers.set(...)`. Those calls are kept. They are behaviorally identical to `syncKeepAlive()` at that point (the map was just made non-empty), and keeping them minimizes the diff.
- **Interpretation I-2 — Exact `handleStart` `try` boundary.** "Begin the `try` immediately" is implemented as: `set` + `syncKeepAlive()`, then the three inert `let` declarations (`timedOut`, `timeoutId = null`, `resultText = ''`), then `try {`. `timeoutId` becomes `let` initialized to `null`, and `resetState` / `updateState` / `setTimeout` move inside the `try`. The `let` declarations cannot throw, so every throw-capable statement after registration is covered by the `finally`. `clearTimeout(null)` is safe if `setTimeout` never ran.
- **Interpretation I-3 — `handleStop` does not delete or sync.** Design §4.3 only replaces the `state.controller` lookup with `transcriptControllers.get(tab.id)`. `handleStop` therefore does not delete the map entry and does not call `syncKeepAlive()`; the aborted handler's `finally` does both. This is why test case 6 must await the aborted `handleStart` before asserting the interval stopped.
- **Interpretation I-4 — `onRemoved` ordering.** Chosen order: abort transcript controller → `transcriptControllers.delete(tabId)` → `handleTranslateStop(tabId)` → `handleFormatStop(tabId)` → `states.delete(tabId)` → `syncKeepAlive()` → storage cleanup. Since P6/P8 make the stop helpers sync too, the explicit `syncKeepAlive()` is redundant but harmless and idempotent; it is kept because the design explicitly asks for it in `onRemoved`.
- **Interpretation I-5 — Case 4 tab identity.** The existing harness always resolves active tab id `1`, so the pending transcript is necessarily on tab 1 and the independent format uses explicit `tabId: 2`. This is the only way to express the design's "transcript on tab 1 while a format on tab 2 completes" with the existing `tabs.query` stub.
- **Interpretation I-6 — Case 8 gap detection.** The design's "keepalive never stops across the handoff" is asserted by counting actual `clearInterval` invocations (via a wrapper installed on the harness context) rather than by sampling `__isKeepAliveRunning()`, because a stop/restart is invisible to a boolean snapshot. One actual stop is expected at the transcript→format handoff (before auto-translate is involved); a second stop during the format→translate window would be the defect. The test asserts `stopCount === 1` while `/translate` is pending and `=== 2` after the chain drains.
- **Interpretation I-7 — Test runner invocation.** The design's `node --test tests/` does not work on Node v24.15.0; verified working commands are `node --test tests/*.test.js` and bare `node --test` from the repo root.
- **Interpretation I-8 — `transcriptControllers` declaration site / section comment.** The map is declared in the existing "Translation / Format controllers" section (after `formatControllers`, before `keepAliveIntervalId`) because that section precedes the `onRemoved` registration and both handlers. The section comment is left unchanged; changing it is cosmetic.

---

## 10. Acceptance checklist

Implementation is complete when all of the following hold:

1. Production diff in `extension/background.js` is exactly P1–P8 (§1); `git diff` shows no other production edits.
2. `grep -n "state\.controller" extension/background.js` returns no matches (the four production references are gone).
3. Harness changes (a), (b), (c) and tests 1–9 from §6 are present in `tests/filebridge.test.js`.
4. `node --test tests/*.test.js` passes 52/52 (all existing tests plus 9 new); `pytest tests/` is unaffected.
5. `ARCHITECTURE.md` deltas D1–D10 are applied.
6. Only the intended files changed: `extension/background.js`, `tests/filebridge.test.js`, `ARCHITECTURE.md`, plus this spec file. No commit is made by the implementer; the PM commits after review.
