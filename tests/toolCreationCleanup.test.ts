import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { ToolsService } from "../src/server/modules/tools/tools.service.js";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemorySecretHandleStore } from "../src/secrets/secretHandleStore.js";
import { InMemoryToolCreationStore } from "../src/tools/toolCreationStore.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import { ToolRegistry } from "../src/tools/registry.js";

class FakeAudit {
  events: unknown[] = [];
  async record(event: unknown) {
    this.events.push(event);
  }
}

test("ToolsService.deleteFailedToolCreation removes failed attempt data and package workspace", async () => {
  const workspaceRoot = `.tmp-tool-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const registry = new ToolRegistry();
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const runs = new InMemoryRunStore();
  const secrets = new InMemorySecretHandleStore();
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    audit as never,
    creations,
    undefined,
    runs,
    secrets,
  );

  try {
    const run = await runs.create("Create tool package: cleanup.tool");
    const creation = await creations.create({
      source: "operator",
      toolName: "cleanup.tool",
      toolVersion: "0.1.0",
      kind: "http-json",
      request: "Create failed cleanup tool",
      description: "Temporary failed tool",
      runId: run.id,
    });
    await creations.update(creation.id, {
      status: "qa_failed",
      packageRef: "cleanup.tool/0.1.0",
      manifestPath: `${workspaceRoot}/cleanup.tool/0.1.0/tool.package.json`,
      files: [`${workspaceRoot}/cleanup.tool/0.1.0/tool.package.json`],
      error: "QA failed",
    });
    await secrets.create({
      handle: "secret.tool.cleanup.tool.api-key",
      label: "cleanup key",
      provider: "inline",
      secretRef: "secret-value",
    });
    await mkdir(`${workspaceRoot}/cleanup.tool/0.1.0`, { recursive: true });
    await writeFile(`${workspaceRoot}/cleanup.tool/0.1.0/tool.package.json`, "{}", "utf8");

    const deleted = await service.deleteFailedToolCreation(creation.id);

    assert.equal(deleted.deleted, true);
    assert.equal(deleted.packageDeleted, true);
    assert.equal(deleted.creationRunDeleted, true);
    assert.deepEqual(deleted.secretHandlesDeleted, ["secret.tool.cleanup.tool.api-key"]);
    assert.equal(await creations.get(creation.id), undefined);
    assert.equal(await runs.get(run.id), undefined);
    assert.equal(await secrets.get("secret.tool.cleanup.tool.api-key"), undefined);
    await assert.rejects(access(`${workspaceRoot}/cleanup.tool/0.1.0`));
    assert.equal(audit.events.some((event) =>
      (event as { action?: string }).action === "tool.creation_deleted"
    ), true);
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.deleteFailedToolCreation preserves secrets used by registered versions", async () => {
  const workspaceRoot = `.tmp-tool-cleanup-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const registry = new ToolRegistry();
  const metadata = new InMemoryToolMetadataStore();
  const creations = new InMemoryToolCreationStore();
  const runs = new InMemoryRunStore();
  const secrets = new InMemorySecretHandleStore();
  const audit = new FakeAudit();
  const service = new ToolsService(
    registry,
    metadata,
    undefined,
    undefined,
    undefined,
    audit as never,
    creations,
    undefined,
    runs,
    secrets,
  );

  try {
    await metadata.registerGenerated({
      name: "cleanup.tool",
      version: "0.1.0",
      description: "Registered tool",
      capabilities: ["api-client"],
      requiredSecretHandles: ["secret.tool.cleanup.tool.api-key"],
    });
    const creation = await creations.create({
      source: "operator",
      toolName: "cleanup.tool",
      toolVersion: "0.1.1",
      kind: "http-json-edit",
      request: "Failed edit",
      description: "Temporary failed edit",
    });
    await creations.update(creation.id, {
      status: "qa_failed",
      packageRef: "cleanup.tool/0.1.1",
      manifestPath: `${workspaceRoot}/cleanup.tool/0.1.1/tool.package.json`,
      files: [`${workspaceRoot}/cleanup.tool/0.1.1/tool.package.json`],
      error: "QA failed",
    });
    await secrets.create({
      handle: "secret.tool.cleanup.tool.api-key",
      label: "shared cleanup key",
      provider: "inline",
      secretRef: "shared-secret-value",
    });
    await mkdir(`${workspaceRoot}/cleanup.tool/0.1.1`, { recursive: true });
    await writeFile(`${workspaceRoot}/cleanup.tool/0.1.1/tool.package.json`, "{}", "utf8");

    const deleted = await service.deleteFailedToolCreation(creation.id);

    assert.deepEqual(deleted.secretHandlesDeleted, []);
    assert.ok(await secrets.get("secret.tool.cleanup.tool.api-key"));
    await assert.rejects(access(`${workspaceRoot}/cleanup.tool/0.1.1`));
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ToolsService.deleteFailedToolCreation removes orphaned registered creation records", async () => {
  const workspaceRoot = `.tmp-tool-cleanup-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const previousRoot = process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
  process.env.TOOL_PACKAGE_WORKSPACE_ROOT = workspaceRoot;
  const creations = new InMemoryToolCreationStore();
  const runs = new InMemoryRunStore();
  const service = new ToolsService(
    new ToolRegistry(),
    new InMemoryToolMetadataStore(),
    undefined,
    undefined,
    undefined,
    new FakeAudit() as never,
    creations,
    undefined,
    runs,
    new InMemorySecretHandleStore(),
  );

  try {
    const run = await runs.create("orphaned registered creation");
    const creation = await creations.create({
      source: "agent",
      toolName: "external.action.appointment.old.target.commit",
      toolVersion: "0.1.0",
      kind: "external-action-commit",
      runId: run.id,
    });
    await creations.update(creation.id, {
      status: "registered",
      packageRef: "external.action.appointment.old.target.commit/0.1.0",
      manifestPath: `${workspaceRoot}/external.action.appointment.old.target.commit/0.1.0/tool.package.json`,
    });
    await mkdir(`${workspaceRoot}/external.action.appointment.old.target.commit/0.1.0`, { recursive: true });
    await writeFile(`${workspaceRoot}/external.action.appointment.old.target.commit/0.1.0/tool.package.json`, "{}", "utf8");

    const deleted = await service.deleteFailedToolCreation(creation.id);

    assert.equal(deleted.deleted, true);
    assert.equal(deleted.packageDeleted, true);
    assert.equal(deleted.creationRunDeleted, true);
    assert.equal(await creations.get(creation.id), undefined);
    assert.equal(await runs.get(run.id), undefined);
    await assert.rejects(access(`${workspaceRoot}/external.action.appointment.old.target.commit/0.1.0`));
  } finally {
    if (previousRoot === undefined) delete process.env.TOOL_PACKAGE_WORKSPACE_ROOT;
    else process.env.TOOL_PACKAGE_WORKSPACE_ROOT = previousRoot;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
