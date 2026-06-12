import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolContextStore } from "../src/tools/toolContextStore.js";

test("tool context store keeps editable per-tool docs separate from versions", async () => {
  const store = new InMemoryToolContextStore();
  const created = await store.create({
    toolName: "crypto.aml.gl",
    kind: "openapi",
    title: "GL OpenAPI",
    content: "{\"openapi\":\"3.0.0\"}",
    source: "operator upload",
  });

  assert.equal(created.toolName, "crypto.aml.gl");
  assert.equal(created.kind, "openapi");
  assert.equal((await store.list({ toolName: "other.tool" })).length, 0);

  const updated = await store.update(created.id, {
    title: "Updated GL OpenAPI",
    content: "{\"openapi\":\"3.1.0\"}",
  });
  assert.equal(updated?.title, "Updated GL OpenAPI");
  assert.equal(updated?.content, "{\"openapi\":\"3.1.0\"}");

  assert.equal(await store.delete(created.id), true);
  assert.deepEqual(await store.list({ toolName: "crypto.aml.gl" }), []);
  assert.equal((await store.list({ toolName: "crypto.aml.gl", includeDeleted: true }))[0]?.deletedAt !== undefined, true);
});
