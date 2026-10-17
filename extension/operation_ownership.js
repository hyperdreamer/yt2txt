// Classic-worker script: importScripts('operation_ownership.js').
function createOperationOwnership() {
  const generations = new Map();
  const closedTabs = new Set();

  function abortStages(entry) {
    if (!entry) return;
    for (const context of entry.stages.values()) context.controller.abort();
    entry.stages.clear();
  }

  function isCurrent(context) {
    if (!context || closedTabs.has(context.tabId)) return false;
    const entry = generations.get(context.tabId);
    if (!entry?.root || context.generation !== entry.generation) return false;
    if (context === entry.root) return true;
    const registered = entry.stages.get(context.stage);
    return registered === context && context.rootId === entry.root.rootId &&
      registered.controller === context.controller &&
      registered.signal === context.controller.signal && !context.signal.aborted;
  }

  function claimRoot(tabId, details = {}) {
    if (closedTabs.has(tabId)) return null;
    const previous = generations.get(tabId);
    const generation = (previous?.generation || 0) + 1;
    const root = Object.freeze({
      tabId,
      rootId: crypto.randomUUID(),
      url: details.url,
      force: details.force === true,
      generation,
    });
    // Publish the replacement before abort events can attempt an old handoff.
    generations.set(tabId, { generation, root, rootId: root.rootId, stages: new Map(), stageGeneration: 0 });
    abortStages(previous);
    return root;
  }

  function claimStage(root, stage) {
    const entry = root && generations.get(root.tabId);
    if (!entry || entry.root !== root || !isCurrent(root)) return null;
    const controller = new AbortController();
    const context = Object.freeze({
      tabId: root.tabId,
      rootId: root.rootId,
      url: root.url,
      force: root.force,
      generation: root.generation,
      stageGeneration: ++entry.stageGeneration,
      stageId: crypto.randomUUID(),
      stage,
      controller,
      signal: controller.signal,
    });
    const previous = entry.stages.get(stage);
    entry.stages.set(stage, context);
    if (previous) previous.controller.abort();
    return context;
  }

  function invalidate(tabId, reason) {
    const previous = generations.get(tabId);
    const entry = {
      generation: (previous?.generation || 0) + 1,
      root: null,
      rootId: previous?.rootId || crypto.randomUUID(),
      stages: new Map(),
      stageGeneration: 0,
    };
    generations.set(tabId, entry);
    // The callback is deliberately live; a frozen generation number alone
    // cannot tell a separately loaded queue that another root has been claimed.
    const token = Object.freeze({
      tabId,
      generation: entry.generation,
      rootId: entry.rootId,
      closed: closedTabs.has(tabId),
      reason,
      isCurrent: () => generations.get(tabId) === entry,
    });
    abortStages(previous);
    return token;
  }

  function invalidateStage(context) {
    const entry = context && generations.get(context.tabId);
    if (!entry || entry.stages.get(context.stage) !== context || !isCurrent(context)) return null;
    return invalidate(context.tabId, 'stage');
  }

  function markClosed(tabId) {
    closedTabs.add(tabId);
    return invalidate(tabId, 'closed');
  }

  function releaseStage(context) {
    const entry = context && generations.get(context.tabId);
    if (!entry || entry.stages.get(context.stage) !== context ||
        entry.stages.get(context.stage).controller !== context.controller) return false;
    entry.stages.delete(context.stage);
    return true;
  }

  return Object.freeze({ claimRoot, claimStage, isCurrent, invalidate, invalidateStage, markClosed, releaseStage });
}
