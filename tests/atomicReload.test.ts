import test from "node:test";
import assert from "node:assert/strict";
import { createAtomicReloader } from "../src/tools/atomicReload.js";

/**
 * Phase 16 Slice A regression coverage. The provider in
 * `src/server/workers/runtime-workers.module.ts` previously held a
 * shared `Set<string>` and reload pattern:
 *
 *   for (const name of loadedNames) registry.unregister(name);
 *   loadedNames.clear();
 *   await loadGeneratedTools(...);
 *   // repopulate loadedNames
 *
 * Two failure modes the new reloader must avoid:
 *
 *   - "Empty window": between unregister-all and reload-done, the
 *     registry holds nothing. A concurrent `registry.get(name)`
 *     during this window returns undefined even when the tool is
 *     valid in the DB.
 *
 *   - "Concurrent race": two reloads in flight. The first wipes
 *     `loadedNames`. The second now reads an empty set and its
 *     unregister loop is a no-op; whichever finishes last decides
 *     what stays in the registry.
 *
 * The tests below pin both behaviours.
 */

type FakeRegistry = {
  tools: Map<string, true>;
  unregistered: string[];
};

function makeRegistry(initial: readonly string[] = []): FakeRegistry {
  const tools = new Map<string, true>(initial.map((name) => [name, true]));
  return {
    tools,
    unregistered: [],
  };
}

test("atomicReload performs an initial load and registers nothing it didn't request", async () => {
  const registry = makeRegistry();
  let calls = 0;
  const reload = createAtomicReloader({
    load: async () => {
      calls += 1;
      registry.tools.set("file.append", true);
      registry.tools.set("chart.svg", true);
      return ["file.append", "chart.svg"];
    },
    unregister: (name) => {
      registry.tools.delete(name);
      registry.unregistered.push(name);
    },
  });

  await reload();

  assert.equal(calls, 1, "load should run exactly once");
  assert.deepEqual([...registry.tools.keys()].sort(), ["chart.svg", "file.append"]);
  assert.deepEqual(registry.unregistered, [], "nothing to unregister on a fresh reload");
});

test("atomicReload drops only the tools missing from the new desired set, after load completes", async () => {
  const registry = makeRegistry();
  let pass = 0;
  const reload = createAtomicReloader({
    load: async () => {
      pass += 1;
      if (pass === 1) {
        registry.tools.set("a", true);
        registry.tools.set("b", true);
        return ["a", "b"];
      }
      // Second pass: "b" is gone (e.g. disabled in DB / failed to
      // load), "c" appears.
      registry.tools.delete("b"); // loader would not re-register it
      registry.tools.set("a", true);
      registry.tools.set("c", true);
      return ["a", "c"];
    },
    unregister: (name) => {
      registry.tools.delete(name);
      registry.unregistered.push(name);
    },
  });

  await reload();
  assert.deepEqual([...registry.tools.keys()].sort(), ["a", "b"]);

  await reload();
  assert.deepEqual([...registry.tools.keys()].sort(), ["a", "c"]);
  assert.deepEqual(registry.unregistered, ["b"], "only the dropped tool is unregistered");
});

test("atomicReload never exposes an empty window: load completes BEFORE stale entries are dropped", async () => {
  // We pin the order of side effects: tool 'b' must remain in the
  // registry until after the loader has finished, otherwise a
  // concurrent reader could observe an empty registry for a tool
  // that is in fact still valid.
  const registry = makeRegistry();
  const observed: string[] = [];

  // Seed initial state via a first pass.
  let pass = 0;
  const reload = createAtomicReloader({
    load: async () => {
      pass += 1;
      if (pass === 1) {
        registry.tools.set("a", true);
        registry.tools.set("b", true);
        return ["a", "b"];
      }
      // Slow loader: while loading, an external observer checks
      // whether `b` is still in the registry. If we unregistered
      // before loading, this check would fail.
      await new Promise((r) => setImmediate(r));
      observed.push(registry.tools.has("b") ? "b-present" : "b-absent");
      // Second pass keeps only "a".
      registry.tools.set("a", true);
      return ["a"];
    },
    unregister: (name) => {
      registry.tools.delete(name);
    },
  });

  await reload();
  await reload();

  assert.deepEqual(observed, ["b-present"], "tool 'b' must be visible until the new set is loaded");
  assert.deepEqual([...registry.tools.keys()].sort(), ["a"]);
});

test("atomicReload serializes concurrent calls: no interleaved unregister-then-load", async () => {
  // Two reloads in flight at the same time. Without serialization,
  // reload A's unregister + load could interleave with reload B's,
  // and either could drop tools the other just registered.
  const registry = makeRegistry();
  const loadOrder: string[] = [];
  let loadCount = 0;

  const reload = createAtomicReloader({
    load: async () => {
      loadCount += 1;
      const id = loadCount;
      loadOrder.push(`load-${id}-start`);
      await new Promise((r) => setTimeout(r, 5));
      loadOrder.push(`load-${id}-end`);
      // Each pass declares the same desired set: "x". The point of
      // this test is the ORDER of operations, not the contents.
      registry.tools.set("x", true);
      return ["x"];
    },
    unregister: (name) => {
      registry.tools.delete(name);
      loadOrder.push(`unregister-${name}`);
    },
  });

  // Fire two reloads back-to-back without awaiting between.
  await Promise.all([reload(), reload()]);

  // The two loads must NOT overlap; load-2 cannot start before
  // load-1 ends. Otherwise we are back to the race we are fixing.
  assert.deepEqual(
    loadOrder,
    ["load-1-start", "load-1-end", "load-2-start", "load-2-end"],
    "loads must be serialized in call order",
  );
  assert.deepEqual([...registry.tools.keys()].sort(), ["x"]);
});

test("atomicReload survives a loader that throws; the next call still runs", async () => {
  const registry = makeRegistry();
  let pass = 0;
  const reload = createAtomicReloader({
    load: async () => {
      pass += 1;
      if (pass === 1) throw new Error("disk error");
      registry.tools.set("recovered", true);
      return ["recovered"];
    },
    unregister: (name) => {
      registry.tools.delete(name);
    },
  });

  await assert.rejects(reload(), /disk error/);
  // The next call must not be poisoned by the previous rejection.
  await reload();
  assert.deepEqual([...registry.tools.keys()], ["recovered"]);
});

test("atomicReload._loadedNames reflects the latest committed pass", async () => {
  const reload = createAtomicReloader({
    load: async () => ["a", "b"],
    unregister: () => undefined,
  });

  assert.equal(reload._loadedNames.size, 0, "starts empty");
  await reload();
  assert.deepEqual([...reload._loadedNames].sort(), ["a", "b"]);
});
