# YT2TXT Transformation Cache Consumer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate whole-chain Force refresh through YT2TXT, persist per-tab operation ownership for restart recovery, and reconcile worker/popup state without stale writes, provider calls, or effects.

**Architecture:** Two classic-worker helpers provide the deep seams: `operation_ownership.js` owns immutable root/stage generations, abort controllers, and closed-tab fencing; `storage_queue.js` owns per-tab serialization, snapshots, conditional stale-write rollback, and queue recovery. `background.js` becomes the sole owner of operation records, Force propagation, guarded publication, durable Stop acknowledgments, and reconciliation. `popup.js` consumes one generation-checked hydrated state response and uses existing retry controls without changing popup layout.

**Tech Stack:** Chromium Manifest V3 service worker, plain JavaScript, Node v24.16.0 `node:test` and `node:assert/strict`, VM-based fake Chrome APIs, deferred fake backends, and the existing Chromium harness. No new runtime dependency.

## Global Constraints

- TextKit must be implemented and committed first. The consumer prerequisite is the TextKit Task 4 endpoint contract: `POST /format` and `POST /translate` retain their existing required fields and JSON response shapes, accept optional Boolean `force` defaulting to false/omitted, and add only the successful-response `X-TextKit-Cache` header; non-success responses have no cache header.
- Ordinary YT2TXT requests omit `force` entirely, so they remain compatible with an older TextKit. A forced format or translation request includes `force: true`; if an older TextKit rejects it, surface that normal error and never retry silently without Force.
- Force is captured only as `msg.force === true` when a transcript root is accepted. It is inherited by automatic format and conditional automatic translation, never enables translation, never changes language, and is false for ordinary transcript, keyboard, standalone Format, and standalone Translate actions unless a dedicated persisted-record retry explicitly carries true provenance.
- Only `extension/background.js`, `extension/popup.js`, the optional classic-worker helper files named by a task, `README.md`, and repository-root `tests/*.test.js` files may change. Do not change popup layout, add popup controls, add a runtime package, call a provider during recovery, or perform paid calls.
- The popup delegates transcript, format, translation, save, Stop, and retry operations through the background worker. Existing direct path-autocomplete reads remain the only popup fetch exception. Popup code must not independently revive, write, or remove worker-owned result, operation, force, recovery, or activity keys.
- Existing keys remain in use: `transcript:<tabId>` stores `{text,url}`, `transcript_raw:<tabId>` stores the raw string, `fmtResult:<tabId>` stores formatted text, `translate:result:<tabId>` stores translation text, and `tl2Translating:<tabId>` is transient. Add `transcript_force:<tabId>`, `transcript_recovery:<tabId>`, and `transform:operation:<tabId>` exactly as specified.
- Operation IDs are UUID-like opaque strings and every versioned record has `version: 1`; valid records contain the specified root/stage IDs, tab ID, stage, status, exact source text, source URL, source kind, language, Force, and error fields. Unknown versions, malformed records, wrong tab IDs, unsupported languages, empty source text, and URL mismatches never trigger provider work.
- All background ownership and storage changes are sequential: Task 2 modifies `extension/background.js` after Task 1's helper commit, Task 3 modifies it after Task 2's commit, and popup Task 4 consumes the hydrated state contract produced by Task 3. No task may assume a later worker or popup interface without naming it in its Interfaces block.
- Every async continuation checks ownership after response parsing, endpoint/settings reads, storage awaits, copy/save setup, and before state publication, broadcasts, handoffs, notifications, clipboard dispatch, or save dispatch. A stale path must not create state through `getState`, resurrect activity, overwrite accepted persistence, or launch an effect.
- Stop invalidates ownership synchronously before its first await. Its response is delayed until queue rollback, terminal-marker persistence, operation/activity cleanup, and keepalive coverage complete; a storage failure returns `{ok:false,error}` and never claims durable Stop success. Tab close fences the tab for the worker lifetime and deletes all tab state/persistence through the authorized queue path.
- Recovery is read-only with respect to providers and effects: it may reconcile and expose retry descriptors, but it never calls TextKit, copies, saves, translates, or automatically retries. Saved results may remain visible beside a retryable record.
- Run JavaScript tests from the repository root with `node --test`; use the exact repository-root paths in the task commands, never `extension/tests/`. No task claims test success before its verification command has actually run.

## Task 1: Add Operation Ownership and Per-Tab Storage Queue Seams

**Implementer tier:** Capable

**Files:**

- Create: `extension/operation_ownership.js`
- Create: `extension/storage_queue.js`
- Test: `tests/storage_queue.test.js`

**Interfaces:**

- Consumes: no production helper; the files are classic-worker scripts loaded later by `background.js` through `importScripts`, so they must not use ES-module imports or require a bundler.
- Produces: `createOperationOwnership()` with `claimRoot(tabId, details)`, `claimStage(root, stage)`, `isCurrent(context)`, `invalidate(tabId, reason)`, `invalidateStage(context)`, `markClosed(tabId)`, and `releaseStage(context)`.
- `claimRoot(tabId, details)` returns an immutable root context containing `tabId`, a new `rootId`, captured `url`, captured Boolean `force`, and generation data; `claimStage(root, stage)` returns an immutable operation context containing `tabId`, `rootId`, `url`, `force`, `stageId`, `stage`, `controller`, and `signal`.
- `isCurrent(context)` checks the live root generation, live stage generation/controller, `controller.signal.aborted`, and the closed-tab set without calling any state-creating getter. `invalidate` synchronously fences the current root and aborts its stages; `invalidateStage` invalidates the root owned by that active stage; `markClosed` permanently fences a tab for the worker lifetime; `releaseStage` removes only the exact stage/controller registration.
- Produces: `createStorageQueue(storageArea)` with `enqueue(tabId, job)`, `read(tabId, keys)`, `transact(tabId, spec)`, and `clear(tabId)`. `transact` snapshots all affected keys, performs a set/remove mutation, checks the supplied live-owner authorization after the storage await, and conditionally restores the snapshot only when the keys still contain the values written by that stale job. Authorized invalidation cleanup may delete after an abort but cannot touch a newer root. A rejected job is isolated so the next job in the same tab queue still runs.

- [ ] **Step 1: Build a fake storage area and write red ownership/queue tests**

Create `tests/storage_queue.test.js` with a VM loader for each classic-worker helper and a fake `chrome.storage.local` implementing asynchronous `get`, `set`, and `remove` with deferred barriers. Add tests named `test_claim_stage_and_release_only_exact_controller`, `test_invalidation_makes_old_context_not_current_without_creating_state`, `test_closed_tab_fence_survives_later_claim_attempts`, `test_queue_serializes_same_tab_but_allows_independent_tabs`, `test_stale_write_rolls_back_conditionally_after_barrier`, `test_newer_value_wins_over_stale_rollback`, `test_authorized_cleanup_runs_after_abort`, and `test_rejected_queue_job_does_not_poison_following_reconciliation`.

The stale-write test must suspend `set`, invalidate the owner, allow the write to finish, and assert the prior values are restored before the next queued operation starts. The newer-value test must place a replacement write behind the stale operation and assert conditional rollback does not erase that replacement. Assert that a closed tab cannot claim a new root and that stale ownership checks never invoke a state factory.

- [ ] **Step 2: Run the helper tests and confirm the red state**

Run:

```sh
node --test tests/storage_queue.test.js
```

Expected: FAIL during helper loading because `extension/operation_ownership.js` and `extension/storage_queue.js` do not yet exist.

- [ ] **Step 3: Implement the ownership helper**

Use private maps for root generations and stage registrations plus a closed-tab set. Generate independent root and stage IDs. Claiming a root must synchronously supersede the previous root for that tab and abort its stages; claiming a stage must register the new controller before any predecessor is released. `isCurrent` must compare object identity for the live root/stage and controller, inspect the abort signal, and reject every closed tab.

Return frozen context snapshots so URL, Force, root ID, stage ID, controller, and signal cannot be reread from mutable popup state. Make invalidation return the tab-generation authorization token needed by cleanup, while keeping the context non-current immediately. Ensure `releaseStage` cannot remove a replacement stage and that stale finalizers cannot stop another root's keepalive entry.

- [ ] **Step 4: Implement the queue helper with conditional stale rollback**

Maintain one promise tail per tab. `enqueue` must chain after the previous tail while swallowing the previous rejection for scheduling purposes, and it must remove an idle tail without affecting other tabs. `read` must run through the same tail as writes.

For `transact`, snapshot all affected keys before mutation, apply one grouped `storage.local.set` and/or `remove`, then check the operation's live-owner callback. If the operation is stale and not authorized cleanup, read the affected keys and restore only keys whose current values still equal the values written by this transaction; restore absent values with `remove`. If cleanup is authorized by the invalidating tab generation, retain its intended terminal/deletion mutation but verify it does not name a newer root. Always settle the queue tail after rejection and return a typed status for committed, rolled-back, or authorized cleanup.

- [ ] **Step 5: Run the helper tests and a syntax check**

Run:

```sh
node --test tests/storage_queue.test.js
node --check extension/operation_ownership.js
node --check extension/storage_queue.js
```

Expected: PASS for the helper tests and no syntax errors. No Chrome API or DOM should be required to load either helper.

- [ ] **Step 6: Commit the isolated helper seams**

```sh
git add extension/operation_ownership.js extension/storage_queue.js tests/storage_queue.test.js
git commit -m "feat(extension): add operation ownership and storage queue seams"
```

## Task 2: Integrate Root Ownership, Stage Handoffs, and Force Propagation

**Implementer tier:** Capable

**Files:**

- Modify: `extension/background.js:worker helper loading, ownership maps, keepalive, tab-close listener, message routing, and operation handlers`
- Create: `tests/operation_lifecycle.test.js`
- Create: `tests/force_propagation.test.js`

**Interfaces:**

- Consumes: Task 1's `createOperationOwnership()` and `createStorageQueue(storageArea)`; existing `getState`, `updateState`, `resetState`, `broadcastState`, `getActiveTab`, `fetchWithTimeout`, `startKeepAlive`, `stopKeepAlive`, `syncKeepAlive`, `handleStart`, `handleStop`, `handleFormatStart`, `handleFormatStop`, `handleTranslateStart`, `handleTranslateStop`, `autoTranslate`, `autoCopyIfEnabled`, `autoSaveIfEnabled`, `fmtAutoCopyIfEnabled`, and `fmtAutoSaveIfEnabled`.
- Produces: worker-local immutable operation contexts with `{tabId, rootId, url, force, stageId, controller, signal}`; `claimRoot`, `claimStage`, `isCurrent`, `invalidate`, and `releaseStage` are the only ownership operations used by handlers. Worker helper scripts are loaded by the existing service worker with no manifest layout or runtime-dependency change.
- Produces: request-body builders that return `{url}` for an ordinary transcript, `{url, force: true}` for a forced transcript, `{text}` for ordinary format, `{text, force: true}` for forced format, `{text, language}` for ordinary translation, and `{text, language, force: true}` for forced translation. The builders never serialize `force: false` and never remove Force after an older backend rejects it.
- Produces: accepted transcript publication that groups transcript result, raw transcript, Boolean force, root-owned `transcript_recovery: {version: 1, rootId, terminal: "available"}`, and the initial running `transform:operation:<tabId>` record in one queued storage action; it clears obsolete downstream results/markers only at successful current publication.
- Produces: automatic transcript-to-format-to-translation handoffs that register the successor stage before releasing the predecessor and inherit root ID, URL, and Force. Standalone and keyboard-triggered ordinary actions claim a new root with Force false.

- [ ] **Step 1: Write red lifecycle and exact-body tests using the real worker source**

Create fake Chrome events, storage, settings, offscreen, notifications, and deferred `/transcript`, `/format`, and `/translate` responses. Load `extension/operation_ownership.js`, `extension/storage_queue.js`, and `extension/background.js` in the same VM order used by the existing worker harness. Add lifecycle tests named `test_new_root_supersedes_downstream_work`, `test_transcript_success_publishes_only_when_root_is_current`, `test_successful_transcript_clears_obsolete_downstream_results`, `test_transcript_failure_preserves_previous_completed_results`, `test_transcript_to_format_to_translate_keeps_one_root_and_successor_registration`, `test_tab_close_fences_preclose_continuations`, `test_stale_handler_cannot_create_state_or_broadcast`, `test_forced_transcript_body_is_exact`, and `test_ordinary_transcript_omits_force`.

Create `tests/force_propagation.test.js` with `test_forced_chain_sends_force_true_to_format_and_translate`, `test_forced_chain_does_not_enable_translation`, `test_keyboard_and_standalone_actions_omit_force`, `test_original_translation_does_not_receive_force_provider_work`, `test_forced_backend_validation_error_is_not_retried_without_force`, and `test_record_retry_body_uses_saved_force_provenance`. Assert exact parsed request bodies, not serialized string fragments, and assert a forced TextKit rejection produces one request and one surfaced error.

- [ ] **Step 2: Run the new worker tests and confirm the red state**

Run:

```sh
node --test tests/operation_lifecycle.test.js tests/force_propagation.test.js
```

Expected: FAIL because the existing worker has no root/stage ownership, no closed-tab fence, no grouped operation record, and still sends `force: false` for ordinary transcript requests while omitting inherited Force from format/translation.

- [ ] **Step 3: Load the helpers and establish worker ownership state**

Load the two classic helpers before the existing worker declarations. Create one ownership instance and one storage queue over `chrome.storage.local`. Keep the existing per-tab display state shape and existing public message payloads, but add private root/stage IDs to state broadcasts where needed for popup matching.

Update keepalive accounting so it remains active through a root handoff and any queued publication/cleanup needed by this task. A stage finalizer may release only its own context. The tab-removed listener must call `markClosed` before aborting/deleting controllers, delete state, and enqueue deletion of every existing and new tab key; no continuation after the listener may claim a root.

- [ ] **Step 4: Refactor transcript start/publication around an immutable root context**

Validate the URL and existing duplicate-transcript rule before accepting a root. Capture `force = msg.force === true`, claim the root and transcript stage before the backend request, and build the transcript body with the omission rules from the Interfaces block. Guard after endpoint resolution, response parsing, and every awaited storage operation.

On a successful response, require `isCurrent(context)` immediately before publication. Claim the successor format stage before queueing the grouped publication. The queued action must set `transcript:<tabId>`, `transcript_raw:<tabId>`, `transcript_force:<tabId>`, the root-owned available recovery marker, and the initial format operation record together; it must remove obsolete `fmtResult`, `translate:result`, and old activity/record markers only in this accepted publication path. If the grouped action fails or the root becomes stale, do not launch the format provider. On transcript error or Stop, preserve the previous completed text and results, publish no new raw/provenance/format record, and leave the operation idle with its error or stopped status.

- [ ] **Step 5: Refactor format/translation starts and automatic effects around stage contexts**

Give internal automatic format and translation handoffs an explicit root/stage context; give standalone starts a new root with Force false. Build format/translation bodies exactly as specified. Register successor translation before the format stage releases its controller. Keep the existing conditional translation and `Original` behavior without letting Force change it.

Pass the context through provider response parsing, result persistence, `autoTranslate`, copy, and save helpers. Guard before state/result broadcast, operation-record publication, settings access, clipboard/offscreen dispatch, save fetch, and automatic handoff. A stale catch/finally must not change the replacement root or notify the popup. Cache hits will use this same accepted publication path in the later TextKit consumer integration and must not receive a special local path.

- [ ] **Step 6: Run worker lifecycle and Force tests plus existing regression tests**

Run:

```sh
node --test tests/operation_lifecycle.test.js tests/force_propagation.test.js tests/background.test.js tests/filebridge.test.js
```

Expected: PASS for the new ownership/body assertions and the existing background/file-bridge regression suites. The old ordinary transcript body must remain compatible except that false Force is omitted.

- [ ] **Step 7: Run Force mutation probes**

Run:

```sh
node --test tests/force_propagation.test.js --test-name-pattern="forced|ordinary|backend|retry"
```

Expected: PASS. During development, temporarily serialize `force: false`, drop Force at the format handoff, or add a fallback retry without Force; the exact-body and one-request assertions must fail before the mutation is restored.

- [ ] **Step 8: Commit the ownership and propagation integration**

```sh
git add extension/background.js tests/operation_lifecycle.test.js tests/force_propagation.test.js
git commit -m "feat(extension): propagate refresh through owned transformation stages"
```

## Task 3: Add Versioned Records, Restart Reconciliation, and Durable Stop

**Implementer tier:** Capable

**Files:**

- Modify: `extension/background.js:operation records, storage transitions, stop handlers, popup:get-state reconciliation, guarded auto-effects`
- Create: `tests/storage_reconciliation.test.js`

**Interfaces:**

- Consumes: Task 2's worker contexts and exact body builders; Task 1's `createStorageQueue.transact/read`; existing storage keys and controller maps; `chrome.tabs.query`, `chrome.storage.local`, `chrome.storage.sync`, offscreen clipboard, notification, and File Bridge save APIs.
- Produces: `validateOperationRecord(value, tabId, currentUrl) -> ValidRecord | null`; `makeOperationRecord(context, stage, sourceText, sourceUrl, sourceKind, language, status, error) -> VersionedRecord`; `reconcileTabState(tabId) -> Promise<HydratedState>`; and queued transition helpers for available, failed, stopped, and completed root-owned recovery markers.
- Produces: operation record shape `{version:1, rootId, stageId, tabId, stage:"format"|"translate", status:"running"|"failed", sourceText, sourceUrl, sourceKind:"transcript"|"format"|"standalone", language:null|string, force:boolean, error:string}`; translation uses validated language and exact stage input; automatic format source kind is `transcript`, automatic translation is `format`, and standalone actions are `standalone`.
- Produces: reconciliation precedence: malformed/unknown record suppresses legacy fallback; matching-root `stopped`/`completed` tombstone suppresses retry and clears orphan record/activity; a valid record matching live ownership is active; an unmatched running/failed record is interrupted/failed and retryable; without a record, only absent or valid `available` markers permit legacy raw/force format recovery when no completed format result exists.
- Produces: asynchronous `popup:stop`, `format:stop`, and `translate:stop` responses that acknowledge `{ok:true}` only after durable queue repair/terminal marker/cleanup, or `{ok:false,error}` after a storage failure. An absent or stale stage is a no-op and cannot stop a replacement root.

- [ ] **Step 1: Write storage/restart red tests with barriers and fake worker restarts**

Create `tests/storage_reconciliation.test.js` with a fake persistent storage area that survives loading a fresh worker VM. Add `test_successful_transcript_groups_raw_and_force_with_available_record`, `test_stale_storage_write_rolls_back_before_recovery_read`, `test_stop_ack_waits_for_terminal_marker_and_cleanup`, `test_storage_failure_returns_failed_stop_ack_after_invalidation`, `test_matching_stopped_tombstone_beats_running_record_after_restart`, `test_matching_completed_tombstone_beats_record_cleanup_gap`, `test_newer_root_is_not_suppressed_by_older_terminal_marker`, `test_corrupt_record_suppresses_legacy_raw_recovery`, `test_stop_before_first_format_result_suppresses_legacy_retry`, `test_absent_marker_allows_legacy_raw_force_recovery`, `test_available_marker_allows_legacy_raw_recovery_without_completed_result`, `test_saved_source_retry_works_when_textarea_is_empty`, `test_orphan_activity_marker_is_cleared`, `test_record_url_mismatch_is_safe_and_nonretryable`, and `test_restart_between_terminal_write_and_record_removal_is_idempotent`.

Suspend storage `set`, `remove`, recovery reads, settings reads, response parsing, copy setup, and save response independently. Interleave Stop, replacement, close, and new work at each barrier. Assert stale writes cannot overwrite accepted values, terminal markers retain their owning root, a newer root remains retryable despite an older marker, and no reconciliation path increments provider, copy, save, or translation call counts.

- [ ] **Step 2: Run reconciliation tests and confirm the red state**

Run:

```sh
node --test tests/storage_reconciliation.test.js
```

Expected: FAIL because the current worker has no versioned operation record, no recovery discriminator, no conditional terminal tombstone handling, no grouped legacy raw/Force recovery, and synchronous Stop handlers that acknowledge before storage reconciliation.

- [ ] **Step 3: Implement record validation and all queued operation transitions**

Centralize key builders and record validation. Reject malformed versions, unsupported stage/status/source kind, wrong tab ID, empty source, invalid language, URL mismatch, non-Boolean Force, and inconsistent IDs before any provider or effect. Generate a matching `available` marker when a downstream root starts. Keep a record through provider success and automatic copy/save/handoff.

Implement queued transitions for accepted transcript publication, standalone start, explicit retry, provider failure, stage success, Stop, replacement, and tab close. Every affected mutation captures prior values and uses the Task 1 conditional rollback. A cleanup authorized by the invalidating tab generation may write a stopped/completed root-owned tombstone and remove active record/activity keys, but it must not touch a newer root. Write a completed marker after automatic effects and before final cleanup; write a stopped marker after invalidation and before cleanup. Preserve raw transcript data on Stop and remove all tab keys on close.

- [ ] **Step 4: Implement delayed Stop acknowledgments and closed-tab cleanup**

Change message routing for `popup:stop`, `format:stop`, and `translate:stop` to return `true` and await the matching asynchronous handler. Invalidate the owned root or stage synchronously before the first await, abort controllers, and retain keepalive coverage through queue repair and terminal cleanup. Treat absent/stale stage IDs as no-op success only after confirming no replacement is owned; they must not abort or clean the replacement. If any required queue action fails, return `{ok:false,error}` while leaving ownership invalidated and preserving a later reconciliation path.

For tab close, call `markClosed` first, invalidate/abort, and enqueue authorized deletion of state, transcript/raw/Force, recovery, operation, result, and activity keys. A pre-close continuation must fail `isCurrent` and cannot recreate state or launch a provider/effect.

- [ ] **Step 5: Implement restart reconciliation without provider or effect work**

Have `popup:get-state` query the live active tab, check the closed fence, then read all record, raw, Force, result, recovery, URL, and activity keys through the same per-tab queue. Preserve live transcript extraction activity in memory even though it has no downstream record. Recheck ownership after the tab query and each queue await.

Apply the exact precedence from the Interfaces block. For a valid unmatched running record, produce an idle interrupted/failed state with its saved source, language, Force, URL, and retry descriptor; failed records remain retryable. Clear orphan `tl2Translating` markers. For legacy raw recovery, read raw and Force together, treat absent Force as false, suppress recovery when a stopped/completed/unknown marker is present, and suppress format retry when a completed format result exists. Return a fully hydrated state including `format.retry`, `translate.retry`, and active root/stage IDs so popup code needs no independent storage reads.

- [ ] **Step 6: Guard automatic copy, save, and translation effects**

Change `autoCopyIfEnabled`, `autoSaveIfEnabled`, `fmtAutoCopyIfEnabled`, `fmtAutoSaveIfEnabled`, and `autoTranslate` to accept the operation context. `autoTranslate` must read its enabled flag and language in one sync-storage call, check ownership after that await, and check again immediately before starting inherited translation. Copy/save helpers must check before settings, after settings, immediately before offscreen/save dispatch, and after the save response; use the stage signal for save fetch where possible. Suppress late completion/error notifications after invalidation. A dispatched effect cannot be undone, but invalidated work cannot issue a later effect.

- [ ] **Step 7: Run the focused worker/reconciliation suites**

Run:

```sh
node --test tests/storage_reconciliation.test.js tests/operation_lifecycle.test.js tests/force_propagation.test.js tests/background.test.js tests/filebridge.test.js
```

Expected: PASS for durable Stop, terminal precedence, stale rollback, closed-tab fencing, no-effect recovery, exact Force propagation, keepalive handoffs, and existing worker regressions.

- [ ] **Step 8: Run stale-write and recovery mutation probes**

Run:

```sh
node --test tests/storage_reconciliation.test.js --test-name-pattern="stale|tombstone|marker|corrupt|retry|provider|effect|Stop"
```

Expected: PASS. During development, remove conditional rollback, let an older tombstone suppress a newer root, allow corrupt records to fall through to raw recovery, acknowledge Stop before queue completion, or call a provider from reconciliation; the corresponding barrier test must fail before restoration.

- [ ] **Step 9: Commit worker records and recovery behavior**

```sh
git add extension/background.js tests/storage_reconciliation.test.js
git commit -m "feat(extension): reconcile owned transformation operations after restart"
```

## Task 4: Hydrate Popup State and Manual Retry Without Restoration Races

**Implementer tier:** Advanced

**Files:**

- Modify: `extension/popup.js:message listeners, initialization, rendering, start/stop/retry handlers`
- Create: `tests/popup_recovery.test.js`
- Modify: `tests/popup.test.js:existing popup harness expectations for hydrated state and ownership IDs`

**Interfaces:**

- Consumes: Task 3's `popup:get-state` response `{ok:true, tabId, state}` where `state` is fully hydrated and contains transcript, format, translation, activity, root/stage ownership IDs, `format.retry`, and `translate.retry`; retry descriptors are `null`, `{kind:"record", rootId, stageId, language?}`, or `{kind:"legacy"}`.
- Consumes: full `state:update` messages carrying `tabId` and current root/stage IDs, partial translation/activity messages carrying the same ownership IDs, and Stop responses that validate the displayed stage IDs.
- Produces: a popup-local generation counter that advances for every relevant background event and every local start/stop/retry command; initialization captures the counter and current tab before awaiting the worker snapshot and discards or refreshes a snapshot if either changes.
- Produces: listeners registered before the initial `popup:get-state` request; one hydrated render path that restores text, status, buttons, retry descriptors, and activity without reading worker-owned keys directly; `format:retry` and `translate:retry` messages carrying the displayed descriptor; ordinary `format:start` and `translate:start` payloads remain unchanged and do not include Force.
- The existing Format Transcript retry row and Translation action button are the only retry controls. Do not add layout elements, change popup HTML, or reconstruct saved source/language/Force from current textarea/settings when a descriptor is available.

- [ ] **Step 1: Write popup race and recovery tests before changing popup code**

Create `tests/popup_recovery.test.js` with the existing fake DOM/chrome harness pattern. Add `test_initial_hydration_restores_all_saved_results_from_one_worker_state`, `test_live_worker_state_is_not_labeled_interrupted_on_popup_reopen`, `test_interrupted_format_record_exposes_retry_with_saved_source`, `test_interrupted_translation_record_exposes_saved_language_and_force`, `test_legacy_raw_recovery_uses_available_marker_and_absent_force`, `test_stopped_or_completed_marker_suppresses_legacy_recovery`, `test_corrupt_record_is_safe_idle_without_retry`, `test_retry_uses_saved_source_when_textarea_is_empty`, `test_translation_retry_uses_saved_language_not_current_setting`, `test_ordinary_start_does_not_include_force`, `test_stop_message_contains_displayed_stage_ids`, `test_delayed_initial_snapshot_cannot_overwrite_newer_state_event`, `test_delayed_snapshot_after_local_retry_is_discarded`, `test_partial_result_for_old_root_is_ignored`, and `test_popup_never_reads_or_removes_worker_owned_activity_keys`.

Use deferred `chrome.runtime.sendMessage` responses and event emitters. Count storage reads/writes/removes and assert initialization performs only the worker snapshot request, never independent result/activity reads or marker cleanup. Assert the retry request body/message uses the saved source, URL, language, and Force even when the corresponding textarea is empty or settings changed.

- [ ] **Step 2: Run popup tests and confirm the red state**

Run:

```sh
node --test tests/popup_recovery.test.js tests/popup.test.js
```

Expected: FAIL because current initialization reads multiple local keys, an orphan `tl2Translating` flag can revive the UI, there is no popup-local generation guard, and retry handlers rebuild work from current textarea/settings.

- [ ] **Step 3: Register listeners before initialization and add generation guards**

Move listener registration ahead of the initial active-tab/state request. Maintain a monotonically increasing local generation on every full/partial relevant background message and every local start/stop/retry command. Capture `{generation, tabId}` before awaiting `popup:get-state`; after the await, discard the response if either changed and request a fresh snapshot only when the current view still needs restoration.

Apply full updates only to the current tab and replace the rendered view when the root is newer. Apply partial result/activity messages only when their root/stage IDs match the latest full state. Ignore a late old-root partial message even if it arrives after a newer full update. Ensure tab switches advance the generation and cannot apply a previous tab's snapshot.

- [ ] **Step 4: Replace independent storage hydration with one reconciled state render**

Remove popup reads/writes/removes for `transcript:<tabId>`, raw transcript, Force, result, operation, recovery, and `tl2Translating` during initialization and message handling. Use the worker's fully hydrated response to populate transcript, format, translation, statuses, activity flags, and saved results. Keep current direct path-autocomplete reads unchanged because they are unrelated read-only suggestions.

Render existing Stop controls using active ownership IDs, render the existing format retry row from `format.retry`, and render the existing Translation action as retry when `translate.retry` is present. Do not alter popup HTML or layout. Preserve user-editable textarea behavior while ensuring saved source and result restoration comes from reconciled state rather than an orphan marker.

- [ ] **Step 5: Route explicit retries through validated worker descriptors**

Make the format retry handler send `{type:"format:retry", descriptor}` and the translation action send `{type:"translate:retry", descriptor}` when the hydrated state exposes a record or legacy descriptor. Do not use the current textarea as the source for a record retry. Do not use the current language selector or auto-translate setting as the saved provenance. Ordinary Format/Translate starts continue using their existing text/settings and no Force field.

Include displayed `rootId` and `stageId` in Stop messages. After each local command response, advance/check the generation and let a fresh worker state win over a stale local render. Preserve current copy/download behavior and never start copy/save/translation from popup recovery itself.

- [ ] **Step 6: Run popup recovery and regression suites**

Run:

```sh
node --test tests/popup_recovery.test.js tests/popup.test.js tests/content.test.js
```

Expected: PASS for hydration, delayed response races, partial-message ownership, retry provenance, legacy recovery, saved results, and existing popup/content behavior. The popup layout and manifest permissions remain unchanged.

- [ ] **Step 7: Run popup mutation probes**

Run:

```sh
node --test tests/popup_recovery.test.js --test-name-pattern="hydration|retry|marker|textarea|delayed|partial|force|storage"
```

Expected: PASS. During development, reintroduce an independent activity read, apply a snapshot after a newer event, accept a partial message without IDs, or derive retry input from the textarea/current language; the corresponding test must fail before restoring the guarded implementation.

- [ ] **Step 8: Commit generation-guarded popup hydration**

```sh
git add extension/popup.js tests/popup_recovery.test.js tests/popup.test.js
git commit -m "feat(extension): hydrate popup from reconciled operation state"
```

## Task 5: Document Deployment Order and Run the Complete Consumer Verification

**Implementer tier:** Standard

**Files:**

- Modify: `README.md:Force refresh, recovery, backend compatibility, and storage behavior`

**Interfaces:**

- Consumes: Task 3's persisted operation/recovery contract and Task 4's hydrated retry descriptors; TextKit's committed optional `force` request field and additive `X-TextKit-Cache` response header.
- Produces: README guidance for whole-chain Force, ordinary request compatibility, forced old-backend errors, manual retry after worker restart, saved-source retry with empty textareas, root/stage ownership, delayed durable Stop, local storage retention, and deployment order of TextKit before YT2TXT.
- Produces: verification commands covering the exact worker, storage, Force, popup, existing background, and popup test files. No source code or popup layout changes are part of this task.

- [ ] **Step 1: Write documentation checks before editing README**

Run this repository-root check:

```sh
python - <<'PY'
from pathlib import Path
text = Path("README.md").read_text()
for token in (
    "force",
    "X-TextKit-Cache",
    "manual retry",
    "TextKit first",
    "saved source",
    "service worker",
    "Stop",
):
    assert token.lower() in text.lower(), token
PY
```

Expected: FAIL until the new operational contract is documented.

- [ ] **Step 2: Document the consumer contract and recovery workflow**

Add a concise README section explaining that a forced transcript refresh carries through automatic format and conditional translation, while standalone and ordinary actions remain cacheable ordinary requests. State that false Force is omitted, true Force is sent only to the updated TextKit, and an older backend's rejection is surfaced without a fallback request.

Document that TextKit is deployed first, that successful format/translation responses may include the additive `X-TextKit-Cache` header without changing JSON, and that the extension still runs auto-copy, auto-save, and conditional translation on accepted cache hits. Explain that restart recovery is explicit through existing controls, uses saved source/language/Force provenance, does not call providers or effects automatically, and may delay Stop acknowledgment until durable storage reconciliation completes. Mention closed-tab cleanup and local retention of saved text without exposing credentials.

- [ ] **Step 3: Run documentation, syntax, and complete Node verification**

Run:

```sh
python - <<'PY'
from pathlib import Path
text = Path("README.md").read_text()
for token in (
    "force",
    "X-TextKit-Cache",
    "manual retry",
    "TextKit first",
    "saved source",
    "service worker",
    "Stop",
):
    assert token.lower() in text.lower(), token
PY
node --check extension/operation_ownership.js
node --check extension/storage_queue.js
node --check extension/background.js
node --check extension/popup.js
node --test tests/background.test.js tests/popup.test.js tests/content.test.js tests/filebridge.test.js tests/storage_queue.test.js tests/operation_lifecycle.test.js tests/storage_reconciliation.test.js tests/popup_recovery.test.js tests/force_propagation.test.js
```

Expected: all syntax checks and the complete listed Node test command finish without failures. The optional Chromium E2E test may skip only when its existing environment prerequisite is unavailable; it must not be replaced by a claim that it ran.

- [ ] **Step 4: Commit the documented consumer/deployment contract**

```sh
git add README.md
git commit -m "docs(extension): document force refresh and restart recovery"
```
