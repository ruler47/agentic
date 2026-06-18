/**
 * Phase 16 Slice A: atomic reload of the in-memory tool registry.
 *
 * The original implementation in `runtime-workers.module.ts` held a
 * shared `Set<string>` of currently-loaded tool names and, on every
 * reload, called `registry.unregister(name)` for each entry BEFORE
 * triggering `loadGeneratedTools` to populate the new set. Two
 * problems with that flow:
 *
 *   1. There is a window between "unregister all" and "load
 *      finished" during which the registry is empty. Any concurrent
 *      `registry.get(name)` returns undefined and the caller raises
 *      "Tool not registered" against a tool that actually exists in
 *      the DB and on disk.
 *
 *   2. The `Set` was a shared mutable closure. Two concurrent
 *      reloads could race on it — reload A clears it, reload B
 *      reads the now-empty set, neither side unregisters the right
 *      tools, and the registry ends up with stale entries.
 *
 * This helper takes a `loader` (typically the bound
 * `loadGeneratedTools`-via-runners callback) and returns a reload
 * function that:
 *
 *   - serializes calls via a single in-flight promise chain so two
 *     concurrent callers never read or mutate state mid-pass;
 *   - loads FIRST, then unregisters anything that was loaded last
 *     pass but is not in the new desired set, so the registry never
 *     enters an empty state for a tool that is still active.
 *
 * The unit test in `tests/atomicReload.test.ts` covers parallel
 * invocations and ensures every reload sees the latest committed
 * state, even when loader work is asynchronous and interleaved.
 */
export type AtomicReloadDeps = {
  /**
   * Loads the desired set of tool names. Must register the loaded
   * tools into the underlying registry as a side effect. The
   * returned names are used by the reloader to compute what to
   * unregister at the end of the pass.
   */
  load: () => Promise<readonly string[]>;
  /**
   * Drops a tool by name from the underlying registry. Called only
   * for tools that were loaded on a previous pass but are absent
   * from the current `load()` result.
   */
  unregister: (name: string) => void;
  /**
   * Optional logger for the "Reloaded N tool(s)" line. Defaults to
   * a no-op so unit tests stay quiet.
   */
  log?: (message: string) => void;
};

export type AtomicReloader = (() => Promise<void>) & {
  /**
   * Exposed for tests only. Names that were loaded on the most
   * recent successfully-completed reload pass.
   */
  readonly _loadedNames: ReadonlySet<string>;
};

export function createAtomicReloader(deps: AtomicReloadDeps): AtomicReloader {
  let loadedNames: Set<string> = new Set();
  let inflight: Promise<void> = Promise.resolve();

  const performReload = async (): Promise<void> => {
    const desired = new Set(await deps.load());
    // Anything we registered last pass but is absent from the new
    // set has either been deactivated in the DB or failed to load
    // this pass. Drop it AFTER the new set is in place so we never
    // expose an empty interval to concurrent registry readers.
    for (const name of loadedNames) {
      if (!desired.has(name)) deps.unregister(name);
    }
    loadedNames = desired;
    if (desired.size > 0 && deps.log) {
      deps.log(`Reloaded ${desired.size} generated tool(s).`);
    }
  };

  const reload: AtomicReloader = (() => {
    const next = inflight.catch(() => undefined).then(() => performReload());
    inflight = next;
    return next;
  }) as AtomicReloader;

  Object.defineProperty(reload, "_loadedNames", {
    get: () => loadedNames,
  });

  return reload;
}
