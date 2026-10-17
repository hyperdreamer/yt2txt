const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function loadHelper(filename, name, globals = {}) {
  const path = resolve(__dirname, '..', 'extension', filename);
  const sandbox = { AbortController, crypto: webcrypto, structuredClone, ...globals };
  vm.runInNewContext(readFileSync(path, 'utf8'), sandbox, { filename: path });
  assert.equal(typeof sandbox[name], 'function');
  return sandbox[name];
}

function ownership(globals) {
  return loadHelper('operation_ownership.js', 'createOperationOwnership', globals)();
}

function storageQueue(storage) {
  return loadHelper('storage_queue.js', 'createStorageQueue')(storage);
}

function assertResult(result, expected) {
  assert.deepEqual(structuredClone(result), expected);
}

// Storage clones values at the API boundary. Barriers can pause either side of
// the mutation, so assertions do not depend on timers or microtask counts.
class FakeStorage {
  constructor(initial = {}) {
    this.values = structuredClone(initial);
    this.calls = [];
    this.controls = new Map();
  }

  pauseNext(method, phase = 'before') {
    const entered = deferred();
    const released = deferred();
    this.schedule(method, { phase, entered, released });
    return { entered: entered.promise, release: () => released.resolve() };
  }

  rejectNext(method, phase = 'before') {
    this.schedule(method, { phase, error: new Error('storage unavailable') });
  }

  schedule(method, control) {
    const controls = this.controls.get(method) || [];
    controls.push(control);
    this.controls.set(method, controls);
  }

  async run(method, argument, action) {
    this.calls.push({ method, argument: structuredClone(argument) });
    const control = this.controls.get(method)?.shift();
    const checkpoint = async phase => {
      if (control?.phase !== phase) return;
      if (control.error) throw control.error;
      control.entered.resolve();
      await control.released.promise;
    };
    await checkpoint('before');
    const result = action();
    await checkpoint('after');
    return result;
  }

  async get(keys) {
    return this.run('get', keys, () => {
      const result = {};
      for (const key of keys === null ? Object.keys(this.values) : [].concat(keys)) {
        if (Object.hasOwn(this.values, key)) result[key] = structuredClone(this.values[key]);
      }
      return result;
    });
  }

  async set(values) {
    const captured = structuredClone(values);
    return this.run('set', captured, () => { Object.assign(this.values, captured); });
  }

  async remove(keys) {
    const captured = [].concat(keys);
    return this.run('remove', captured, () => {
      for (const key of captured) delete this.values[key];
    });
  }
}

test('test_claim_stage_and_release_only_exact_controller', () => {
  const owners = ownership();
  const details = { url: 'https://example.test/video', force: true };
  const root = owners.claimRoot(1, details);
  details.url = 'https://example.test/other';
  details.force = false;
  const first = owners.claimStage(root, 'format');
  const replacement = owners.claimStage(root, 'format');
  const translation = owners.claimStage(root, 'translate');

  for (const context of [root, first, replacement, translation]) {
    assert.ok(Object.isFrozen(context));
    assert.equal(context.url, 'https://example.test/video');
    assert.equal(context.force, true);
    assert.equal(context.rootId, root.rootId);
  }
  assert.match(root.rootId, /^[0-9a-f-]{36}$/i);
  assert.match(replacement.stageId, /^[0-9a-f-]{36}$/i);
  assert.equal(new Set([root.rootId, first.stageId, replacement.stageId, translation.stageId]).size, 4);
  assert.equal(replacement.tabId, 1);
  assert.equal(replacement.stage, 'format');
  assert.equal(replacement.signal, replacement.controller.signal);
  assert.equal(first.signal.aborted, true);
  assert.equal(owners.isCurrent(first), false);
  assert.equal(owners.releaseStage(first), false);
  assert.equal(owners.releaseStage({ ...replacement, controller: new AbortController() }), false);
  assert.equal(owners.isCurrent({ ...replacement }), false);
  assert.equal(owners.isCurrent(replacement), true);
  assert.equal(owners.releaseStage(replacement), true);
  assert.equal(owners.isCurrent(replacement), false);
  assert.equal(owners.isCurrent(translation), true);
  assert.equal(owners.isCurrent(root), true);
  translation.controller.abort();
  assert.equal(owners.isCurrent(translation), false);
  assert.equal(owners.releaseStage(translation), true);
  assert.equal(owners.claimRoot(2, { force: 'true' }).force, false);
  assert.equal(owners.claimRoot(3, {}).force, false);
});

test('test_invalidation_makes_old_context_not_current_without_creating_state', () => {
  let factoryCalls = 0;
  const getState = () => { factoryCalls += 1; throw new Error('state must not be created'); };
  const owners = ownership({ getState });
  const root = owners.claimRoot(1, { url: 'https://example.test/one' });
  const stage = owners.claimStage(root, 'transcript');
  const observations = [];
  stage.signal.addEventListener('abort', () => {
    observations.push(owners.isCurrent(stage), owners.isCurrent(root), owners.claimStage(root, 'format'));
  });
  const token = owners.invalidate(1, 'stop');
  assert.ok(Object.isFrozen(token));
  assert.equal(token.tabId, 1);
  assert.equal(token.rootId, root.rootId);
  assert.equal(stage.signal.aborted, true);
  assert.deepEqual(observations, [false, false, null]);
  assert.equal(owners.isCurrent(root), false);
  assert.equal(owners.isCurrent(stage), false);
  assert.equal(owners.isCurrent({ tabId: 999 }), false);
  assert.equal(owners.isCurrent(null), false);
  assert.equal(owners.claimStage(root, 'format'), null);

  const nextRoot = owners.claimRoot(1, { url: 'https://example.test/two' });
  const nextStage = owners.claimStage(nextRoot, 'format');
  assert.notEqual(nextRoot.rootId, root.rootId);
  assert.notEqual(nextRoot.generation, root.generation);
  assert.equal(owners.invalidateStage(stage), null);
  assert.equal(owners.releaseStage(stage), false);
  assert.equal(owners.isCurrent(nextStage), true);
  assert.equal(factoryCalls, 0);
});

test('test_closed_tab_fence_survives_later_claim_attempts', () => {
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const stage = owners.claimStage(root, 'format');
  const token = owners.markClosed(1);
  assert.ok(Object.isFrozen(token));
  assert.equal(token.closed, true);
  assert.equal(stage.signal.aborted, true);
  assert.equal(owners.isCurrent(root), false);
  assert.equal(owners.claimRoot(1, { force: true }), null);
  assert.equal(owners.claimStage(root, 'translate'), null);
  owners.invalidate(1, 'stop');
  assert.equal(owners.claimRoot(1, {}), null);
  assert.equal(owners.isCurrent(owners.claimRoot(2, {})), true);
  owners.markClosed(99);
  assert.equal(owners.claimRoot(99, {}), null);
});

test('test_new_root_aborts_all_predecessor_stages_before_handoffs', () => {
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const first = owners.claimStage(root, 'format');
  const second = owners.claimStage(root, 'translate');
  const observations = [];
  first.signal.addEventListener('abort', () => {
    observations.push(owners.isCurrent(root), owners.claimStage(root, 'translate'));
  });
  const next = owners.claimRoot(1, {});
  assert.deepEqual(observations, [false, null]);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(owners.isCurrent(next), true);
});

test('test_invalidate_stage_fences_only_its_active_root', () => {
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const old = owners.claimStage(root, 'format');
  const stage = owners.claimStage(root, 'format');
  const sibling = owners.claimStage(root, 'translate');
  assert.equal(owners.invalidateStage(old), null);
  assert.equal(owners.isCurrent(stage), true);
  const token = owners.invalidateStage(stage);
  assert.equal(token.rootId, root.rootId);
  assert.equal(stage.signal.aborted, true);
  assert.equal(sibling.signal.aborted, true);
  assert.equal(owners.isCurrent(root), false);
});

test('test_queue_serializes_same_tab_but_allows_independent_tabs', async () => {
  const queue = storageQueue(new FakeStorage());
  const gate = deferred();
  const started = deferred();
  const events = [];
  const first = queue.enqueue(1, async () => {
    events.push('first-start');
    started.resolve();
    await gate.promise;
    events.push('first-end');
    return 11;
  });
  await started.promise;
  const second = queue.enqueue(1, () => { events.push('second'); return 12; });
  const independent = queue.enqueue(2, () => { events.push('independent'); return 21; });
  assert.equal(await independent, 21);
  assert.deepEqual(events, ['first-start', 'independent']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [11, 12]);
  assert.deepEqual(events, ['first-start', 'independent', 'first-end', 'second']);
  assert.equal(await queue.enqueue(1, () => 13), 13);
});

test('test_stale_write_rolls_back_conditionally_after_barrier', async () => {
  const initial = { 'fmtResult:1': 'accepted', 'transcript:1': { text: 'raw', url: 'video' } };
  const storage = new FakeStorage(initial);
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const stage = owners.claimStage(root, 'format');
  const gate = storage.pauseNext('set');
  let checks = 0;
  const pending = queue.transact(1, {
    keys: ['fmtResult:1', 'transcript_raw:1', 'transcript:1'],
    set: { 'fmtResult:1': 'stale', 'transcript_raw:1': 'new raw' },
    remove: ['transcript:1'],
    owner: () => {
      checks += 1;
      assert.deepEqual(storage.values, { 'fmtResult:1': 'stale', 'transcript_raw:1': 'new raw' });
      return owners.isCurrent(stage);
    },
  });
  await gate.entered;
  assert.equal(checks, 0);
  owners.invalidate(1, 'stop');
  const next = queue.enqueue(1, () => assert.deepEqual(storage.values, initial));
  const read = queue.read(1, ['fmtResult:1', 'transcript_raw:1', 'transcript:1']);
  gate.release();
  assertResult(await pending, { status: 'rolled-back' });
  await next;
  assert.deepEqual(await read, initial);
  assert.equal(checks, 1);
});

test('test_newer_value_wins_over_stale_rollback', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'prior' });
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const gate = storage.pauseNext('set', 'after');
  const stale = queue.transact(1, {
    keys: ['fmtResult:1'], set: { 'fmtResult:1': 'stale' }, owner: () => owners.isCurrent(root),
  });
  await gate.entered;
  owners.invalidate(1, 'stop');
  const nextRoot = owners.claimRoot(1, {});
  await storage.set({ 'fmtResult:1': 'newer accepted' });
  const replacement = queue.enqueue(1, async () => {
    assert.deepEqual(storage.values, { 'fmtResult:1': 'newer accepted' });
    assert.equal(owners.isCurrent(nextRoot), true);
    await storage.set({ 'fmtResult:1': 'replacement queued behind stale write' });
  });
  gate.release();
  assertResult(await stale, { status: 'rolled-back' });
  await replacement;
  assert.deepEqual(await queue.read(1, ['fmtResult:1']), {
    'fmtResult:1': 'replacement queued behind stale write',
  });
});

test('test_stale_rollback_compares_the_value_sent_to_storage', async () => {
  const storage = new FakeStorage({ 'transform:operation:1': { status: 'accepted' } });
  const queue = storageQueue(storage);
  const record = { status: 'running', source: { text: 'captured source' } };
  const gate = storage.pauseNext('set');
  const pending = queue.transact(1, {
    keys: ['transform:operation:1'],
    set: { 'transform:operation:1': record },
    owner: () => false,
  });
  await gate.entered;
  record.source.text = 'caller changed the object after storage copied it';
  gate.release();
  assertResult(await pending, { status: 'rolled-back' });
  assert.deepEqual(storage.values, { 'transform:operation:1': { status: 'accepted' } });
});

test('test_authorized_cleanup_runs_after_abort', async () => {
  const storage = new FakeStorage({ 'tl2Translating:1': true, 'fmtResult:1': 'accepted' });
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const stage = owners.claimStage(root, 'translate');
  const token = owners.invalidate(1, 'stop');
  assert.equal(stage.signal.aborted, true);
  assertResult(await queue.transact(1, {
    keys: ['tl2Translating:1', 'transform:operation:1'],
    set: { 'transform:operation:1': { rootId: root.rootId, status: 'stopped' } },
    remove: ['tl2Translating:1'],
    cleanup: { token, rootId: root.rootId },
  }), { status: 'cleanup-applied' });
  assert.deepEqual(storage.values, {
    'fmtResult:1': 'accepted',
    'transform:operation:1': { rootId: root.rootId, status: 'stopped' },
  });
});

test('test_rejected_queue_job_does_not_poison_following_reconciliation', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'accepted' });
  const queue = storageQueue(storage);
  const failed = queue.enqueue(1, () => { throw new Error('job failed'); });
  const read = queue.read(1, ['fmtResult:1']);
  await assert.rejects(failed, /job failed/);
  assert.deepEqual(await read, { 'fmtResult:1': 'accepted' });
});

test('test_transact_rejects_missing_keys_entry', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'accepted' });
  const queue = storageQueue(storage);
  for (const mutation of [
    { set: { 'fmtResult:1': 'stale' } },
    { remove: ['fmtResult:1'] },
  ]) {
    assertResult(await queue.transact(1, { keys: [], ...mutation, owner: () => true }), {
      status: 'rejected', reason: 'keys',
    });
  }
  assert.equal(storage.calls.length, 0);
  assert.deepEqual(storage.values, { 'fmtResult:1': 'accepted' });
});

test('test_transact_requires_exactly_one_authorization', async () => {
  const storage = new FakeStorage();
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const token = owners.invalidate(1, 'stop');
  for (const authorization of [
    {},
    { owner: () => true, cleanup: { token, rootId: root.rootId } },
    { owner: true },
    { cleanup: null },
  ]) {
    assertResult(await queue.transact(1, {
      keys: ['fmtResult:1'], set: { 'fmtResult:1': 'stale' }, ...authorization,
    }), { status: 'rejected', reason: 'authorization' });
  }
  assert.equal(storage.calls.length, 0);
});

test('test_transact_snapshot_restores_only_unmodified_keys', async () => {
  const storage = new FakeStorage({
    'fmtResult:1': 'old format',
    'transform:operation:1': { status: 'old' },
    'transcript:1': { text: 'old raw', url: 'video' },
    'extra:1': 'untouched',
  });
  const queue = storageQueue(storage);
  const gate = storage.pauseNext('remove', 'after');
  const pending = queue.transact(1, {
    keys: ['fmtResult:1', 'transform:operation:1', 'transcript:1', 'transcript_raw:1', 'extra:1'],
    set: {
      'fmtResult:1': 'stale format',
      'transform:operation:1': { status: 'running', nested: { values: [1, 2] } },
      'transcript_raw:1': 'stale raw',
    },
    remove: ['transcript:1'],
    owner: () => false,
  });
  await gate.entered;
  await storage.set({
    'fmtResult:1': 'new format',
    'transform:operation:1': { nested: { values: [1, 2] }, status: 'running' },
    'extra:1': 'new untouched value',
  });
  gate.release();
  assertResult(await pending, { status: 'rolled-back' });
  assert.deepEqual(storage.values, {
    'fmtResult:1': 'new format',
    'transform:operation:1': { status: 'old' },
    'transcript:1': { text: 'old raw', url: 'video' },
    'extra:1': 'new untouched value',
  });
});

test('test_cleanup_after_tab_close_applies_despite_fence', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'saved', 'tl2Translating:1': true, 'fmtResult:2': 'other' });
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const token = owners.markClosed(1);
  assertResult(await queue.transact(1, {
    keys: ['fmtResult:1', 'tl2Translating:1'],
    remove: ['fmtResult:1', 'tl2Translating:1'],
    cleanup: { token, rootId: root.rootId },
  }), { status: 'cleanup-applied' });
  assert.deepEqual(storage.values, { 'fmtResult:2': 'other' });
  assert.equal(owners.claimRoot(1, {}), null);
});

test('test_cleanup_rejects_when_newer_root_exists', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'new root result' });
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const token = owners.invalidate(1, 'stop');
  const blocker = deferred();
  const first = queue.enqueue(1, () => blocker.promise);
  const cleanup = queue.transact(1, {
    keys: ['fmtResult:1'], remove: ['fmtResult:1'], cleanup: { token, rootId: root.rootId },
  });
  const next = owners.claimRoot(1, {});
  blocker.resolve();
  await first;
  assertResult(await cleanup, { status: 'rejected', reason: 'superseded' });
  assert.equal(owners.isCurrent(next), true);
  assert.deepEqual(storage.values, { 'fmtResult:1': 'new root result' });
  assert.equal(storage.calls.length, 0);
});

test('test_cleanup_checks_tab_and_root_identity', async () => {
  const storage = new FakeStorage({ 'fmtResult:1': 'saved' });
  const queue = storageQueue(storage);
  const owners = ownership();
  const root = owners.claimRoot(1, {});
  const token = owners.invalidate(1, 'stop');
  for (const [tabId, rootId] of [[2, root.rootId], [1, 'a-different-root']]) {
    assertResult(await queue.transact(tabId, {
      keys: ['fmtResult:1'], remove: ['fmtResult:1'], cleanup: { token, rootId },
    }), { status: 'rejected', reason: 'superseded' });
  }
  assert.equal(storage.calls.length, 0);
  assert.deepEqual(storage.values, { 'fmtResult:1': 'saved' });
});

test('test_cleanup_rechecks_generation_after_storage_awaits', async t => {
  for (const method of ['get', 'set', 'remove']) {
    await t.test(method, async () => {
      const initial = { 'fmtResult:1': 'accepted', 'tl2Translating:1': true };
      const storage = new FakeStorage(initial);
      const queue = storageQueue(storage);
      const owners = ownership();
      const root = owners.claimRoot(1, {});
      const token = owners.invalidate(1, 'stop');
      const gate = storage.pauseNext(method);
      const pending = queue.transact(1, {
        keys: ['fmtResult:1', 'tl2Translating:1'],
        set: { 'fmtResult:1': 'terminal' },
        remove: ['tl2Translating:1'],
        cleanup: { token, rootId: root.rootId },
      });
      await gate.entered;
      owners.claimRoot(1, {});
      gate.release();
      assertResult(await pending, { status: 'rejected', reason: 'superseded' });
      assert.deepEqual(storage.values, initial);
    });
  }
});

test('test_transact_groups_mutations_and_checks_owner_after_all_awaits', async () => {
  const storage = new FakeStorage({ 'same:1': 'old', 'removed:1': 'old' });
  const queue = storageQueue(storage);
  const setGate = storage.pauseNext('set');
  const removeGate = storage.pauseNext('remove');
  let checks = 0;
  const pending = queue.transact(1, {
    keys: ['same:1', 'removed:1', 'new:1', 'extra:1'],
    set: { 'same:1': 'temporary', 'new:1': { items: ['result'] } },
    remove: ['same:1', 'removed:1'],
    owner: () => {
      checks += 1;
      assert.deepEqual(storage.values, { 'new:1': { items: ['result'] } });
      return true;
    },
  });
  await setGate.entered;
  assert.equal(checks, 0);
  setGate.release();
  await removeGate.entered;
  assert.equal(checks, 0);
  removeGate.release();
  assertResult(await pending, { status: 'committed' });
  assert.equal(checks, 1);
  assert.deepEqual(storage.calls.map(call => call.method), ['get', 'set', 'remove']);
});

test('test_non_boolean_or_throwing_owner_is_rejected_and_rolled_back', async () => {
  for (const owner of [() => 'true', () => { throw new Error('bad owner'); }]) {
    const storage = new FakeStorage({ 'fmtResult:1': 'accepted' });
    const queue = storageQueue(storage);
    assertResult(await queue.transact(1, {
      keys: ['fmtResult:1'], set: { 'fmtResult:1': 'stale' }, owner,
    }), { status: 'rejected', reason: 'authorization' });
    assert.deepEqual(storage.values, { 'fmtResult:1': 'accepted' });
  }
});

test('test_storage_rejection_keeps_queue_healthy', async t => {
  for (const [method, phase] of [['get', 'before'], ['set', 'before'], ['set', 'after'], ['remove', 'before'], ['remove', 'after']]) {
    await t.test(`${method}-${phase}`, async () => {
      const initial = { 'fmtResult:1': 'accepted', 'transcript:1': 'raw' };
      const storage = new FakeStorage(initial);
      const queue = storageQueue(storage);
      storage.rejectNext(method, phase);
      const pending = queue.transact(1, {
        keys: ['fmtResult:1', 'transcript:1', 'transcript_raw:1'],
        set: { 'fmtResult:1': 'stale', 'transcript_raw:1': 'new raw' },
        remove: ['fmtResult:1', 'transcript:1'],
        owner: () => true,
      });
      const next = queue.read(1, ['fmtResult:1', 'transcript:1', 'transcript_raw:1']);
      assertResult(await pending, { status: 'rejected', reason: 'storage' });
      assert.deepEqual(await next, initial);
      assert.deepEqual(storage.values, initial);
    });
  }
});

test('test_read_and_clear_follow_the_tab_queue_and_preserve_other_tabs', async () => {
  const storage = new FakeStorage({
    'transcript_force:1': { force: true },
    'transcript_recovery:1': { status: 'interrupted' },
    'transform:operation:1': { status: 'interrupted' },
    'fmtResult:11': 'another tab',
    settings: 'keep',
  });
  const queue = storageQueue(storage);
  const gate = storage.pauseNext('set');
  const write = queue.transact(1, {
    keys: ['fmtResult:1'], set: { 'fmtResult:1': 'accepted' }, owner: () => true,
  });
  await gate.entered;
  const read = queue.read(1, ['fmtResult:1']);
  const clear = queue.clear(1);
  gate.release();
  assertResult(await write, { status: 'committed' });
  assert.deepEqual(await read, { 'fmtResult:1': 'accepted' });
  await clear;
  assert.deepEqual(storage.values, { 'fmtResult:11': 'another tab', settings: 'keep' });
  assert.deepEqual(await queue.read(1, ['fmtResult:1']), {});
});
