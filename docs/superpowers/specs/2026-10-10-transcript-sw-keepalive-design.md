# Transcript SW Keepalive — Design

- **Date:** 2026-10-10
- **Topic:** transcript-sw-keepalive
- **PM run:** pm-run-20261010-045034-eddb43d8
- **Status:** design approved by the user; independent design review pending

## 1. Background

yt2txt's extension service worker (MV3) performs transcript extraction, formatting, and translation.
Chrome terminates an extension service worker when any of these holds:

1. 30 seconds of inactivity (receiving an event or calling an extension API resets the timer).
2. A single request — an event or API call — takes longer than 5 minutes to process.
3. A `fetch()` response takes more than 30 seconds to arrive.

`handleStart()` (`extension/background.js:316` at base commit `11bf4c8`) handles the `popup:start`
message and is a single long-running event: it awaits `POST /transcript` (audio transcription can
take many minutes) and then the complete auto-format chain (`handleFormatStart`, auto-copy,
auto-save). The extension's keepalive — a 20-second `chrome.runtime.getPlatformInfo` interval
started by `startKeepAlive()` (`background.js:180`) — resets the termination timers, but it is
started only in `handleFormatStart()` (`:619`) and `handleTranslateStart()` (`:460`).
`handleStart()` never starts it.

Therefore any transcript extraction longer than the termination budget (≈5 minutes with the popup
open, ≈30 seconds once the popup has closed) is killed mid-flight: no `state:update` broadcast
reaches the popup, nothing is persisted to `chrome.storage.local`, and the backend request is
abandoned. The yt2txt backend itself is unaffected and caches the finished transcript. The
user-visible symptom: the popup textareas stay empty and the results appear only after clicking
"Get Transcript" again, which now hits the backend cache and completes quickly enough to survive
the worker's lifetime.

### Evidence (real headless Chromium 153, fake localhost backends, no video)

| Scenario | Result |
| --- | --- |
| 90 s transcript, popup open, DevTools detached | SW survives; all three textareas fill live |
| 90 s transcript, popup closed 1 s in | SW dies ~30 s later; storage empty; reopen empty; second click fills all three from cache |
| 390 s transcript, popup open, DevTools detached | SW dies ~360 s; all textareas empty; status bar shows `A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received` |
| 390 s transcript, popup open, with `startKeepAlive()` added to `handleStart` (mutation probe, /tmp copy) | SW survives the full 390 s; all three textareas fill |

The probes confirm both the defect and the fix direction: a periodic extension API call is
sufficient to defeat both the idle and single-request timers for the duration of the operation.
The E2E harness ran on Chromium 153; branded Chrome 155 does not accept `--load-extension` from
the command line, so it could not be driven directly, but the termination rules are engine-level.

## 2. Goals

- The keepalive runs if and only if at least one transcript/format/translate operation is in flight.
- Long transcript extractions survive regardless of popup state (open, closed, reopened).
- No interval leak on failure paths; no early stop while another operation (including another tab's) is active.
- Abort-and-replace semantics for format/translate remain correct.
- No behavior change outside keepalive accounting.

## 3. Non-goals

- No changes to `extension/popup.js`, the Python backend, TextKit, or File Bridge.
- No migration of the long fetch to an offscreen document.
- No changes to timeout constants (`TRANSCRIPT_TIMEOUT_MS`, `BACKEND_TIMEOUT_MS`).
- No changes to transcript/format/translate semantics, endpoints, or persistence formats.

## 4. Architecture

All production changes are in `extension/background.js`.

### 4.1 State

- New: `const transcriptControllers = new Map();` mapping `tabId -> AbortController`.
- Existing `formatControllers` and `translateControllers` are unchanged.
- Removed: `state.controller`. The per-tab state object no longer carries an AbortController; this
  also stops the controller from being serialized into every `state:update` broadcast
  (Chrome's JSON serialization currently turns it into `{}`).

### 4.2 Keepalive derivation

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

`startKeepAlive()` / `stopKeepAlive()` are unchanged (20 s `getPlatformInfo` interval,
idempotent start).

### 4.3 Handler changes

- `handleStart(msg)`
  - after creating the AbortController: `transcriptControllers.set(tab.id, controller); syncKeepAlive();`
  - in the existing `finally`: delete only when `transcriptControllers.get(tab.id) === controller`,
    then `syncKeepAlive()`.
- `handleFormatStart(msg)`
  - replace `if (translateControllers.size === 0 && formatControllers.size === 0) stopKeepAlive();`
    with `syncKeepAlive()`; the existing identity-guarded delete stays.
- `handleTranslateStart(msg)`
  - same replacement as `handleFormatStart`.
- `handleStop()`
  - abort via `const controller = transcriptControllers.get(tab.id); if (controller) controller.abort();`
    instead of `state.controller`.
- `chrome.tabs.onRemoved`
  - abort via `transcriptControllers.get(tabId)` and delete the map entry alongside the existing cleanup.

## 5. Data flow and error handling

- **Success:** the transcript operation ends in `handleStart`'s `finally`; `handleFormatStart`
  registers immediately afterwards. The keepalive may stop and restart within the same task
  sequence (well inside the 30 s idle budget), which is harmless.
- **Failure/timeout with no format:** `finally` removes the transcript entry; `syncKeepAlive()` sees
  no work and stops the interval. No leak (the naive one-line fix leaks here).
- **Popup closed mid-run:** the message port closes, but the interval keeps the worker alive until
  the operation ends; results are persisted by the existing code paths and restored on reopen.
- **Concurrent tabs:** the interval runs until the last operation on any tab ends.
- **Format/translate abort-and-replace:** the stale handler's `finally` finds
  `map.get(tabId) !== controller` and does not delete the newer entry; `syncKeepAlive()` keeps the
  interval because the map is non-empty.
- **Tab close mid-transcript:** `onRemoved` aborts the controller and deletes the entry; the
  handler's `finally` then runs `syncKeepAlive()` with the entry already gone.

## 6. Test strategy

Unit tests in `tests/filebridge.test.js` using the existing VM background harness
(`createBackgroundHarness`), extended to expose `__isKeepAliveRunning()` and
`__transcriptControllers` via `var` aliases (the same technique used for `__states`,
`__translateControllers`, `__formatControllers`). The harness's stubbed `setInterval` /
`clearInterval` remain; tests assert the accounting boolean, not timer firing.

Cases:

1. Transcript in flight (`handleStart` with a deferred `/transcript` fetch) → keepalive running.
2. Transcript done + auto-format in flight → keepalive running; after format completes
   (auto-translate disabled) → keepalive stopped.
3. Transcript fails with no format → keepalive stopped (regression test for the leak).
4. Transcript pending on tab 1 while a format on tab 2 completes → keepalive still running.
5. Translate replace on one tab: starting a second translate for the same tab, then letting the
   first handler unwind, leaves the keepalive running for the second.
6. `handleStop` aborts the transcript and stops the keepalive when nothing else is active.

All existing JavaScript (`node --test tests/`) and Python (`pytest tests/`) tests must continue to
pass.

## 7. Documentation

`ARCHITECTURE.md`:

- §2.2/§2.3 flow notes already say format/translate start keepAlive; add transcript.
- Per-tab state snippet (line ~247) drops `controller`.
- `onRemoved` snippet (line ~310) uses `transcriptControllers`.
- §8.6/§9.2 keepalive description covers all three operations.

## 8. Risks

- The `getPlatformInfo` keepalive is an unofficial mitigation; Chrome may change termination rules.
  Mitigation: it is already the extension's established pattern and is now applied uniformly.
- The keepalive may stop and restart during the transcript→format handoff; the gap is sub-millisecond
  and far inside the 30 s idle budget.
- Removing `state.controller` touches abort paths; covered by the existing stop test plus new case 6.
