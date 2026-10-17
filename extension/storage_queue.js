// Classic-worker script: importScripts('storage_queue.js').
function createStorageQueue(storageArea) {
  const tails = new Map();
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const rejected = reason => ({ status: 'rejected', reason });

  function enqueue(tabId, job) {
    const previous = tails.get(tabId) || Promise.resolve();
    const result = previous.catch(() => {}).then(job);
    tails.set(tabId, result);
    const release = () => {
      if (tails.get(tabId) === result) tails.delete(tabId);
    };
    result.then(release, release);
    return result;
  }

  function read(tabId, keys) {
    return enqueue(tabId, () => storageArea.get(keys));
  }

  function equal(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every(key => has(right, key) && equal(left[key], right[key]));
  }

  function cleanupCurrent(tabId, cleanup) {
    const token = cleanup.token;
    return token.tabId === tabId && token.rootId === cleanup.rootId && token.isCurrent() === true;
  }

  // Each write records its possible outcomes, since a storage rejection can
  // occur before or after mutation. Successful stale jobs compare only the
  // final outcome; failed jobs also consider intermediate set/remove values.
  async function restore(snapshot, writes, includeIntermediate = false) {
    if (!writes.size) return;
    const current = await storageArea.get([...writes.keys()]);
    const set = [];
    const remove = [];
    for (const [key, outcomes] of writes) {
      const candidates = includeIntermediate ? outcomes : outcomes.slice(-1);
      const matches = candidates.some(outcome => outcome.present === has(current, key) &&
        (!outcome.present || equal(current[key], outcome.value)));
      if (!matches) continue;
      if (has(snapshot, key)) set.push([key, snapshot[key]]);
      else remove.push(key);
    }
    // Even if one restoration fails, attempt the other group before settling.
    let failure;
    if (set.length) {
      try { await storageArea.set(Object.fromEntries(set)); } catch (error) { failure = error; }
    }
    if (remove.length) {
      try { await storageArea.remove(remove); } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }

  /**
   * spec: { keys, set?, remove?, owner? | cleanup?: { token, rootId } }
   * Cleanup tokens come directly from ownership.invalidate/markClosed; their
   * isCurrent() callback remains valid after abort and rejects newer generations.
   */
  function transact(tabId, spec) {
    return enqueue(tabId, async () => {
      if (!spec || !Array.isArray(spec.keys) || spec.keys.some(key => typeof key !== 'string') ||
          (spec.set !== undefined && (!spec.set || typeof spec.set !== 'object' || Array.isArray(spec.set))) ||
          (spec.remove !== undefined && (!Array.isArray(spec.remove) || spec.remove.some(key => typeof key !== 'string')))) {
        return rejected('keys');
      }
      const keys = [...new Set(spec.keys)];
      let set = spec.set || {};
      let remove = spec.remove || [];
      const allowed = new Set(keys);
      if (Object.keys(set).some(key => !allowed.has(key)) || remove.some(key => !allowed.has(key))) {
        return rejected('keys');
      }
      const hasOwner = has(spec, 'owner');
      const hasCleanup = has(spec, 'cleanup');
      if (hasOwner === hasCleanup || (hasOwner && typeof spec.owner !== 'function') ||
          (hasCleanup && (!spec.cleanup || !spec.cleanup.token ||
            typeof spec.cleanup.rootId !== 'string' || typeof spec.cleanup.token.isCurrent !== 'function'))) {
        return rejected('authorization');
      }

      const cleanup = spec.cleanup && { token: spec.cleanup.token, rootId: spec.cleanup.rootId };
      const owner = spec.owner;
      let snapshot;
      const writes = new Map();
      const record = (key, outcome) => {
        const outcomes = writes.get(key) || [];
        outcomes.push(outcome);
        writes.set(key, outcomes);
      };
      try {
        if (cleanup && !cleanupCurrent(tabId, cleanup)) return rejected('superseded');
        // Match storage's copied payload, even if the caller later mutates its
        // records while a storage request is pending.
        set = structuredClone(set);
        remove = [...remove];
        snapshot = await storageArea.get(keys);
        if (cleanup && !cleanupCurrent(tabId, cleanup)) return rejected('superseded');
        if (Object.keys(set).length) {
          for (const key of Object.keys(set)) record(key, { present: true, value: set[key] });
          await storageArea.set(set);
        }
        // A new root may have appeared while set was pending. Do not continue
        // its predecessor's cleanup with the removal half of the transaction.
        if (cleanup && !cleanupCurrent(tabId, cleanup)) {
          await restore(snapshot, writes);
          return rejected('superseded');
        }
        if (remove.length) {
          for (const key of remove) record(key, { present: false });
          await storageArea.remove(remove);
        }

        let authorized;
        let authorizationError = false;
        if (cleanup) authorized = cleanupCurrent(tabId, cleanup);
        else {
          try {
            authorized = owner();
            authorizationError = typeof authorized !== 'boolean';
          } catch {
            authorizationError = true;
          }
        }
        if (authorized === true && !authorizationError) {
          return { status: cleanup ? 'cleanup-applied' : 'committed' };
        }
        await restore(snapshot, writes);
        if (cleanup) return rejected('superseded');
        return authorizationError ? rejected('authorization') : { status: 'rolled-back' };
      } catch {
        if (snapshot) {
          try { await restore(snapshot, writes, true); } catch { /* Best effort; report storage failure below. */ }
        }
        return rejected('storage');
      }
    });
  }

  // Tab-owned persistence uses the existing '<name>:<tabId>' key convention.
  // Enumerate inside the tail so clear also includes preceding queued writes.
  function clear(tabId) {
    return enqueue(tabId, async () => {
      const values = await storageArea.get(null);
      const keys = Object.keys(values).filter(key => key.endsWith(`:${tabId}`));
      if (keys.length) await storageArea.remove(keys);
    });
  }

  return Object.freeze({ enqueue, read, transact, clear });
}
