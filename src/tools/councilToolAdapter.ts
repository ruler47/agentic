/**
 * Phase 14: `ToolBuildCouncilAdapter` implementation that wires the
 * agent council to real persistence + filesystem + registry. Kept
 * outside `src/agents/universalAgent.ts` so the agent class stays
 * dependency-light.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CodingCouncilStore } from "../settings/codingCouncilStore.js";
import type { ModelTierSettingsStore } from "../settings/modelTierSettings.js";
import type { ToolMetadataStore } from "./toolMetadataStore.js";
import type { Tool } from "./tool.js";
import type { ToolBuildCouncilAdapter } from "../agents/universalAgent.js";
import {
  COUNCIL_TOOL_BODY_PATH,
  extractToolBody,
  extractToolBodyImports,
  renderCouncilScaffold,
} from "../agents/councilScaffold.js";

export type CouncilToolAdapterDeps = {
  instanceId?: string;
  toolsRoot?: string;
  codingCouncilStore: CodingCouncilStore;
  modelTierSettings: ModelTierSettingsStore;
  metadataStore: ToolMetadataStore;
  /** Optional hot-reload hook (provided by runtime-workers). */
  reloadGeneratedTools?: () => Promise<void>;
  /** QA runner — usually `ToolsService.runToolManually`. */
  runToolManually: (
    toolName: string,
    body: { input: Record<string, unknown> },
  ) => Promise<{ result: { ok: boolean; content: string; data?: unknown } }>;
  /**
   * Returns the live Tool object for a registered name (or undefined).
   * Used after `reloadGeneratedTools` to backfill metadata fields the
   * adapter can't extract from the TS source — primarily inputSchema
   * and outputSchema, which the council embeds in the Tool definition
   * but the metadata row stays empty without this lookup.
   */
  getRegisteredTool?: (name: string) => Pick<Tool, "inputSchema" | "outputSchema" | "examples" | "requiredSecretHandles"> | undefined;
  /**
   * Fires after a successful council registration. RunsService uses
   * this to wake any parent tool-build runs that were waiting on a
   * capability the newly-registered tool provides (Phase 2:
   * auto-resume after a sub-build finishes its reader tool).
   */
  onToolRegistered?: (toolName: string, capabilities: readonly string[]) => Promise<void>;
};

export class CouncilToolAdapter implements ToolBuildCouncilAdapter {
  private readonly instanceId: string;
  private readonly toolsRoot: string;

  constructor(private readonly deps: CouncilToolAdapterDeps) {
    this.instanceId = deps.instanceId ?? "instance-local";
    this.toolsRoot = resolve(deps.toolsRoot ?? "tools");
  }

  async resolveConfig() {
    return this.deps.codingCouncilStore.get(this.instanceId);
  }

  async resolveCouncilModels(tier: string): Promise<string[]> {
    const rows = await this.deps.modelTierSettings.list();
    const row = rows.find((entry) => entry.tier === tier);
    return row?.models ?? [];
  }

  async registerToolFromFiles(
    toolName: string,
    files: ReadonlyArray<{ path: string; content: string }>,
    metadata: {
      description: string;
      version?: string;
      secretHandle?: string;
      /**
       * Optional sample input — the QA-input-synthesizer's output for
       * this tool. Persisted as a metadata `example` so the Tools-page
       * Manual Run form shows it as a pre-filled JSON sample. Without
       * this the operator gets `{}` and has to guess what shape the
       * tool wants.
       */
      sampleInput?: Record<string, unknown>;
      /** Extra capability tags to advertise besides the defaults. */
      requiredCapabilities?: string[];
      /**
       * Phase 24 Slice B — model-emitted package.json patch.
       * The implement / repair prompts now invite the model to
       * declare its own dependencies + postinstall scripts;
       * `parsePackageJsonPatch` in universalAgent.ts lifts the
       * block out of the LLM response and threads it here.
       */
      modelPackageJson?: {
        dependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    },
  ): Promise<{ toolName: string; version: string; previousVersion?: string }> {
    const version = metadata.version ?? (await this.nextVersionFor(toolName));
    const sanitized = sanitizeName(toolName);
    const baseDir = join(this.toolsRoot, sanitized, version);

    // Phase 22 Slice E — when a version dir already exists from a
    // previous council attempt (e.g. nextVersionFor collided after
    // a partial-promotion rollback), nuke its `dist/` and
    // `node_modules/` so the bundle runner's auto-build hook is
    // forced to re-run tsc + npm install against the FRESH source
    // we are about to write. Without this the runner found a stale
    // dist/runtime/server.js, skipped the build, and started a
    // process whose compiled imports did not match the source on
    // disk (e.g. compiled `puppeteer-extra` while the new source
    // imports plain `puppeteer`). That mismatch surfaced as
    // ERR_MODULE_NOT_FOUND on the FIRST tool call — confusing
    // because the QA loop "saw" puppeteer in package.json.
    try {
      await rm(join(baseDir, "dist"), { recursive: true, force: true });
      await rm(join(baseDir, "node_modules"), { recursive: true, force: true });
    } catch {
      // Best effort — if the dir does not exist or can't be removed
      // the subsequent file writes / build will surface a clearer
      // error than this cleanup ever would.
    }

    // 1. Extract the model's Tool body and overlay it onto the canonical
    //    source-bundle scaffold (index.ts, runtime/server.ts, package.json,
    //    tsconfig.json, src/tools/tool.ts). The model only writes ONE file:
    //    the Tool definition itself — the runtime expects a precise layout
    //    that we own here instead of asking the model to reproduce.
    const toolBody = extractToolBody(files, sanitized);
    if (!toolBody) {
      throw new Error(
        `Council emitted no recognisable Tool body for ${toolName}. ` +
          `Expected ${COUNCIL_TOOL_BODY_PATH(sanitized)} or any .ts file with \`export const tool\`.`,
      );
    }

    // Phase 22 Slice E — collect runtime npm dependencies the tool
    // body actually imports (e.g. puppeteer, axios). Without this
    // the scaffold's package.json declared zero runtime deps, the
    // bundle runner's tsc build failed with TS2307 "Cannot find
    // module 'puppeteer'", and the registration was silently
    // marked `failed` while the older active version kept serving
    // user calls. Auto-extracting from the body itself catches
    // packages the model imported but forgot to declare in its
    // `proposal.packages` block.
    const importedPackages = extractToolBodyImports(toolBody);
    const dependencies: Record<string, string> = {};
    for (const pkg of importedPackages) {
      dependencies[pkg] = "latest";
    }

    // Phase 24 Slice B step 3 — pre-install npm-registry probe.
    // The model's `packageJson.dependencies` block (Phase 24 Slice B
    // step 1) plus auto-extracted imports can include names that
    // simply do NOT exist on the npm registry. We've seen the LLM
    // emit `@purgebugs/playwright-extra-plugin-stealth` (a scope
    // that doesn't exist) and `playwright-extra-plugin-stealth`
    // (a typosquatter stub). The former crashes `npm install` with
    // a 404 after ~3 s of registry chatter; the latter installs
    // fine but throws at module load. Catching the 404 case BEFORE
    // we run `npm install` saves install time AND gives the repair
    // loop a clean structured signal ("dependency 'X' does not
    // exist on the npm registry — pick a different name") instead
    // of a wall of npm error log lines.
    //
    // The probe is best-effort: a network outage skips it (we fall
    // through to the existing `npm install` path), and tests can
    // disable it entirely by setting
    // `COUNCIL_NPM_REGISTRY_PROBE_ENABLED=disabled`. Default is on.
    const allDepNames = Array.from(
      new Set([
        ...Object.keys(dependencies),
        ...Object.keys(metadata.modelPackageJson?.dependencies ?? {}),
      ]),
    ).filter((name) => name && !name.startsWith("node:"));
    if (
      allDepNames.length > 0 &&
      process.env.COUNCIL_NPM_REGISTRY_PROBE_ENABLED !== "disabled"
    ) {
      let probeOutcome: { missing: string[]; errored: Array<{ name: string; reason: string }> } | undefined;
      try {
        probeOutcome = await probeNpmRegistryExistence(allDepNames);
      } catch {
        // Network down, fetch missing, etc. — silently skip the
        // pre-probe. The existing `npm install` step will surface
        // any 404 the slow way, which is what we did before this
        // probe existed.
        probeOutcome = undefined;
      }
      if (probeOutcome && probeOutcome.missing.length > 0) {
        const missingList = probeOutcome.missing.map((n) => `"${n}"`).join(", ");
        throw new Error(
          `Pre-install npm-registry probe found ${probeOutcome.missing.length} declared ` +
            `dependency name(s) that do NOT exist on the public npm registry: ${missingList}. ` +
            `These names did not resolve at https://registry.npmjs.org/<name> — they are ` +
            `either typosquats, hallucinated scopes, deprecated stubs, or simply misspelled. ` +
            `Look up the canonical name for the functionality you need (use the research ` +
            `delegate if uncertain) and update BOTH the source import AND the ` +
            `packageJson.dependencies entry. Do not retry name variants without verifying ` +
            `first — each 404 wastes another repair cycle.`,
        );
      }
    }

    const scaffold = renderCouncilScaffold({
      toolName,
      sanitizedName: sanitized,
      version,
      toolBody,
      dependencies,
      modelPackageJson: metadata.modelPackageJson,
    });
    for (const file of scaffold) {
      const target = join(baseDir, sanitizeRelativePath(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }

    // 2. Register / replace metadata row. Use replacement when the tool
    //    already exists (rework / bugfix flow); otherwise register fresh.
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    // Phase 28 follow-up — auto-derive standard capabilities from tool
    // name + description + imports. Without this, every council-built
    // tool registered with just `[toolName, "council-built"]` and the
    // worker's `findByCapability("web-search" | "browser-screenshot" |
    // "market-timeseries" | "chart-generation")` lookup never matched
    // the council's own creations — so a planner that said "use
    // web-search" got back zero tools and the worker wrote prose
    // without any real evidence. The Bitcoin price run was the
    // canonical failure mode.
    //
    // Also: preserve any operator-set capabilities from the previous
    // active version. The previous code wiped them on every rework
    // (a PATCH was overwritten by the next council build). Now we
    // merge: derived + operator-preserved + request-requested.
    const derivedCapabilities = deriveStandardCapabilities(
      toolName,
      metadata.description,
      toolBody,
      importedPackages,
    );
    const preservedFromExisting = existing
      ? existing.capabilities.filter((c) => c !== toolName && c !== "council-built")
      : [];
    const capabilities = Array.from(
      new Set([
        toolName,
        "council-built",
        ...derivedCapabilities,
        ...preservedFromExisting,
        ...(metadata.requiredCapabilities ?? []),
      ]),
    );
    const baseInput = {
      name: toolName,
      version,
      description: metadata.description,
      capabilities,
      startupMode: "on-demand" as const,
      modulePath: join(baseDir, "index.ts"),
      requiredSecretHandles: metadata.secretHandle ? [metadata.secretHandle] : undefined,
      packageManifest: {
        schemaVersion: "agentic.tool-package.v1" as const,
        name: toolName,
        version,
        description: metadata.description,
        capabilities,
        startupMode: "on-demand" as const,
        package: { type: "source-bundle" as const, ref: `${sanitized}/${version}` },
      },
      changeSummary: `Council-built version ${version}.`,
    };
    // Phase 28 follow-up — track metadata/disk writes so we can
    // atomically roll them back on any throw inside this method.
    // Without atomic rollback, a failed `registerToolFromFiles`
    // (npm install 404, tsc compile fail, version-pin probe miss)
    // leaves an orphan tool_module_versions row + disk dir behind.
    // Build-fix loops then create N more orphans (one per attempt)
    // and the tools/<name>/ directory accumulates broken versions
    // that have no metadata pointer ever pointing at them.
    const priorActiveVersion = existing?.version;
    let metadataPromotedHere = false;
    try {
      if (existing) {
        await this.deps.metadataStore.promoteReplacement({
          ...baseInput,
          replacesVersion: existing.version,
        });
      } else {
        await this.deps.metadataStore.registerGenerated(baseInput);
      }
      metadataPromotedHere = true;

      // 3. Refresh the in-process registry so the tool is callable
      //    immediately (the QA loop calls it via `runToolManually` next).
      await this.deps.reloadGeneratedTools?.();

    // 3a. Phase 16 Slice B — fail fast when the new version did not
    //     load. Without this guard, `promoteReplacement` silently
    //     swapped the active version to one the runtime can't
    //     actually import (TS error, missing dep, partial scaffold
    //     write), the QA loop still tried to invoke it, and the
    //     user saw "Tool not registered: <name>" without any
    //     pointer to the real cause. We surface the loader error
    //     here so the run fails at the registration step with
    //     diagnostics, before QA wastes 5 repair attempts on a
    //     missing tool.
    //
    //     The guard only fires when both `reloadGeneratedTools` and
    //     `getRegisteredTool` are wired (i.e. inside the real Nest
    //     runtime). Stub adapters used in unit tests that exercise
    //     the schema-fallback path leave `reloadGeneratedTools`
    //     undefined and can keep returning `undefined` from
    //     `getRegisteredTool` without triggering the throw.
    if (this.deps.reloadGeneratedTools && this.deps.getRegisteredTool) {
      const probe = this.deps.getRegisteredTool(toolName);
      if (!probe) {
        const detail = await this.collectLoadFailureDetail(toolName);
        throw new Error(
          `Tool ${toolName} v${version} was promoted in metadata but the runtime ` +
            `could not import it. The new version is now the active row in ` +
            `tool_modules but is missing from the in-memory registry, so QA ` +
            `would fail with "Tool not registered". ` +
            (detail
              ? `Loader said: ${detail}`
              : `No loader detail is available — check the runtime logs for the ` +
                `most recent loadGeneratedTools error for ${toolName}.`),
        );
      }
      // Phase 28 — VERSION-PIN PROBE.
      //
      // The registry's `reloadGeneratedTools` is **lenient** by design:
      // when a NEW version's load throws (npm install 404, tsc compile
      // error, missing entrypoint), the loader leaves whatever it had
      // loaded LAST KNOWN GOOD in the in-memory registry — that's
      // usually a previous version of this same tool. So
      // `getRegisteredTool(toolName)` returns a non-null Tool that's
      // serving an OLDER version while metadata's `tool_modules`
      // already promoted the broken new version. Without this check
      // the council pipeline thinks register succeeded, the cold-start
      // probe spawns a subprocess for the OLD version (which has dist/
      // + maybe Chromium from a prior install), QA sees the OLD code
      // returning ok=false on something — and the operator chases a
      // ghost behaviour bug while the real issue is "new version
      // didn't compile at all".
      //
      // Explicit version-pin: the live tool MUST report the version
      // we just wrote. If it doesn't, the new version silently
      // failed to load and we surface that as a hard error with the
      // loader's diagnostic text. The build-fix loop above this can
      // then route the model into a real fix.
      const liveVersion = (probe as { version?: string }).version;
      if (liveVersion && liveVersion !== version) {
        const detail = await this.collectLoadFailureDetail(toolName);
        throw new Error(
          `Tool ${toolName} v${version} was promoted in metadata, but the in-memory ` +
            `registry is still serving v${liveVersion}. The runtime's loader rejected ` +
            `the new version (likely npm install / tsc / missing entrypoint failure) ` +
            `and silently kept the previous load active. Forcing a clean failure here ` +
            `so the build-fix loop sees the real error instead of QA-testing the ` +
            `wrong version. ` +
            (detail
              ? `Loader said: ${detail}`
              : `No loader detail available — check runtime logs for the most ` +
                `recent loadGeneratedTools error for ${toolName} v${version}.`),
        );
      }
    }
    } catch (error) {
      // Phase 28 follow-up — atomic rollback. Anything between the
      // metadata write and the version-pin probe failed: revert
      // metadata + delete disk dir + reload registry to a clean
      // state. Without this, every failed council attempt left a
      // dangling tool_module_versions row + a tools/<name>/<version>
      // dir, and the build-fix loop's nextVersionFor kept bumping
      // off the broken version (v1.0.3 → 1.0.4 → … → 1.0.8) while
      // none of them ever became active.
      if (metadataPromotedHere) {
        try {
          if (priorActiveVersion) {
            await this.deps.metadataStore.activateVersion(toolName, priorActiveVersion);
          } else if (this.deps.metadataStore.deleteGenerated) {
            await this.deps.metadataStore.deleteGenerated(toolName);
          }
        } catch {
          // Best-effort; the throw below carries the real diagnostic.
        }
        // Drop the failed version's row from tool_module_versions
        // entirely so it doesn't accumulate as a phantom in
        // listVersions output.
        if (this.deps.metadataStore.deleteVersion) {
          try {
            await this.deps.metadataStore.deleteVersion(toolName, version);
          } catch {
            // Best-effort.
          }
        }
        // Reload so the in-memory registry reflects the rolled-back
        // active version (back to existing) instead of the failed
        // one we just promoted.
        if (this.deps.reloadGeneratedTools) {
          try {
            await this.deps.reloadGeneratedTools();
          } catch {
            // Reload failure is logged inside the workers; the
            // primary error below is what the operator needs.
          }
        }
      }
      // Nuke the failed version's disk dir so the next build-fix
      // iteration starts fresh and pruneOldVersions can't carry
      // the orphan forward.
      try {
        await rm(baseDir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
      throw error;
    }

    // 4. Backfill metadata with the schemas declared inside the Tool
    //    body. registerGenerated above only saw scaffold-level fields
    //    (name, version, description); the inputSchema / outputSchema /
    //    examples live inside the LLM-emitted TS file and surface only
    //    once the runtime imports it. We also persist the QA-synthesized
    //    sample input as an example so the Tools-page Manual Run form
    //    pre-fills it for the operator.
    const live = this.deps.getRegisteredTool?.(toolName);
    // Always-on backfill paths so the Tools page is useful even when
    // the tool failed to load (TS error, missing dep, etc.):
    //   - inputSchema falls back to regex-parsed schema from the body
    //   - examples falls back to the QA sampleInput if any
    const fallbackInputSchema = extractInputSchemaFromSource(toolBody);
    const fallbackOutputSchema = extractOutputSchemaFromSource(toolBody);
    const exampleFromSample = metadata.sampleInput
      ? [{ title: "Synthesized QA input", input: metadata.sampleInput }]
      : undefined;
    const enriched = {
      ...baseInput,
      inputSchema: (live?.inputSchema ?? coerceInputSchema(fallbackInputSchema)),
      // Phase 28 follow-up — outputSchema fallback. HTTP process
      // runners read outputSchema from the metadata row (the runner
      // never imports the tool body — it proxies HTTP /run), so on
      // first register `live?.outputSchema` is undefined. Use the
      // model's source-declared outputSchema as a fallback.
      outputSchema: live?.outputSchema ?? coerceInputSchema(fallbackOutputSchema),
      examples:
        live?.examples && live.examples.length > 0
          ? live.examples
          : exampleFromSample,
      requiredSecretHandles:
        live?.requiredSecretHandles && live.requiredSecretHandles.length > 0
          ? live.requiredSecretHandles
          : baseInput.requiredSecretHandles,
    };
    // Same-version re-register is an in-place update on the metadata
    // store; promoteReplacement bumps versions and would loop.
    await this.deps.metadataStore.registerGenerated(enriched);

    // 5. Notify RunsService so it can wake any parent tool-build runs
    //    that were waiting on a capability this tool now provides
    //    (Phase 2 auto-resume). Best-effort — a failed callback must
    //    not retroactively fail the registration that just succeeded.
    if (this.deps.onToolRegistered) {
      try {
        await this.deps.onToolRegistered(toolName, capabilities);
      } catch {
        // ignore; the operator can manually resume from the Tool Builds page
      }
    }

    // 6. Sweep older versions on disk. Keep the last KEEP_VERSIONS
    //    for rollback; drop everything older so the tools directory
    //    doesn't accumulate (every QA-failed repair attempt was
    //    leaving a v1.0.X dir behind, ~30+ on busy tools).
    await this.pruneOldVersions(sanitized, version);

    return { toolName, version, previousVersion: existing?.version };
  }

  /**
   * Phase 16 Slice F: undo a just-finished registration whose QA
   * never passed. Two cases:
   *
   *   - Rework (previousVersion present): call `activateVersion` to
   *     flip the active row in `tool_modules` back to the prior
   *     version, then reload so the registry picks it up. The DB
   *     keeps the failed version's row in `tool_module_versions`
   *     for forensic inspection, but the runtime no longer routes
   *     calls to it.
   *
   *   - Fresh build (previousVersion absent): drop the just-created
   *     metadata row outright via `deleteGenerated`. There is nothing
   *     to fall back to, so the right answer is "pretend this never
   *     happened" instead of leaving a broken active tool around.
   *
   * Best-effort: if the rollback itself errors (DB write failed,
   * loader misbehaves), we surface a console warning but do NOT
   * throw — the caller has already emitted a registration-aborted
   * event and the operator's incident is "QA failed", not "rollback
   * crashed".
   */
  /**
   * Phase 16 Slice G: promote the just-registered version's
   * metadata status from "disabled" (the initial state after
   * `promoteReplacement` / `registerGenerated`) to "available" so
   * the Tools page chip matches reality. Called by the council
   * pipeline only after QA passes — never on failure paths, which
   * are handled by `rollbackRegistration` instead.
   *
   * Best-effort: a failed metadata write is logged but does not
   * abort the run. The in-memory registry already has the tool, so
   * the operator's runtime experience is unaffected; only the UI
   * label is.
   */
  async markActive(toolName: string, version: string): Promise<void> {
    try {
      await this.deps.metadataStore.markAvailable(toolName, version);
    } catch (error) {
      console.warn(
        `Council markActive for ${toolName}@${version} failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `The tool runs fine but the Tools-page status chip may stay 'disabled' until the next reload.`,
      );
    }
  }

  async rollbackRegistration(toolName: string, previousVersion: string | undefined): Promise<void> {
    try {
      if (previousVersion) {
        await this.deps.metadataStore.activateVersion(toolName, previousVersion);
      } else if (this.deps.metadataStore.deleteGenerated) {
        await this.deps.metadataStore.deleteGenerated(toolName);
      }
      await this.deps.reloadGeneratedTools?.();
    } catch (error) {
      console.warn(
        `Council rollback for ${toolName} failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `The metadata store may still point at the broken just-built version; run a manual /api/tools/${toolName}/activate to fix.`,
      );
    }
  }

  /**
   * Phase 16 Slice B: after a failed reload, the loader has typically
   * written its diagnostic into `tool_modules.last_health_detail`
   * (e.g. "Source-bundle index.ts is missing", "Compile failed: ...").
   * Surface that text in the error message so the run trace shows the
   * actual cause instead of a generic "Tool not registered" further
   * downstream.
   */
  private async collectLoadFailureDetail(toolName: string): Promise<string | undefined> {
    try {
      const row = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
      if (!row) return undefined;
      if (row.lastHealthOk === false && row.lastHealthDetail) return row.lastHealthDetail;
      return row.lastHealthDetail;
    } catch {
      return undefined;
    }
  }

  private async pruneOldVersions(sanitizedName: string, activeVersion: string): Promise<void> {
    const KEEP_VERSIONS = 5;
    const toolDir = join(this.toolsRoot, sanitizedName);
    let dirents: string[];
    try {
      dirents = await readdir(toolDir);
    } catch {
      return;
    }
    const versions = dirents
      .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
      .sort((a, b) => compareSemver(b, a)); // newest first

    // Phase 16 Slice F follow-up: protect any version the metadata
    // store still tracks for this tool. Without this guard, repeated
    // failed reworks would push the original known-working version
    // off the end of the KEEP_VERSIONS=5 window (rework #6 promoted
    // v1.0.7, prune kept 1.0.3-1.0.7, the working v1.0.2 disk dir
    // was deleted — so when Slice F rolled the active row back to
    // v1.0.2 the loader could not find it and the registry stayed
    // pointing at the broken v1.0.7). Anything still recorded in
    // tool_module_versions is a potential rollback target and must
    // survive the prune.
    const dbKnownVersions = new Set<string>();
    try {
      const original = await this.deps.metadataStore.list();
      const fromActiveRow = original.find(
        (m) => sanitizeName(m.name) === sanitizedName,
      );
      if (fromActiveRow) {
        const summaries = await this.deps.metadataStore.listVersions(fromActiveRow.name);
        for (const summary of summaries) dbKnownVersions.add(summary.version);
      }
    } catch {
      // If the metadata store can't enumerate versions, fall back to
      // the activeVersion-only protection rather than failing the
      // prune entirely.
    }

    // Always keep the just-promoted active version; then layer on
    // every DB-tracked version (protects rollback targets); then
    // top up with on-disk newest versions until we hit
    // KEEP_VERSIONS or run out.
    const kept = new Set<string>([activeVersion, ...dbKnownVersions]);
    for (const v of versions) {
      if (kept.size >= KEEP_VERSIONS) break;
      kept.add(v);
    }
    const toDelete = versions.filter((v) => !kept.has(v));
    await Promise.all(
      toDelete.map((v) =>
        rm(join(toolDir, v), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  }

  async reconcileToolsDirectory(): Promise<{ removedTools: string[]; prunedVersions: number }> {
    const knownVersions = new Map<string, string>();
    for (const meta of await this.deps.metadataStore.list()) {
      knownVersions.set(sanitizeName(meta.name), meta.version);
    }
    return reconcileToolsDirectory(this.toolsRoot, knownVersions);
  }

  async updateDescription(toolName: string, version: string, description: string): Promise<void> {
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing || existing.version !== version) return;
    await this.deps.metadataStore.registerGenerated({
      name: existing.name,
      displayName: existing.displayName,
      version: existing.version,
      description,
      capabilities: [...existing.capabilities],
      startupMode: existing.startupMode,
      inputSchema: existing.inputSchema,
      outputSchema: existing.outputSchema,
      modulePath: existing.modulePath,
      testPath: existing.testPath,
      requiredConfigurationKeys: existing.requiredConfigurationKeys,
      requiredSecretHandles: existing.requiredSecretHandles,
      settingsSchema: existing.settingsSchema,
      storage: existing.storage,
      docsMarkdown: existing.docsMarkdown,
      examples: existing.examples,
      packageManifest: existing.packageManifest,
      changeSummary: existing.changeSummary,
    });
  }

  async updateChangeSummary(toolName: string, version: string, changeSummary: string): Promise<void> {
    // Same-version registerGenerated is an in-place update — preserve
    // every field on the existing row and only swap `changeSummary`.
    // If the tool isn't in metadata anymore (operator deleted it
    // mid-run, etc.), silently drop.
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing || existing.version !== version) return;
    await this.deps.metadataStore.registerGenerated({
      name: existing.name,
      displayName: existing.displayName,
      version: existing.version,
      description: existing.description,
      capabilities: [...existing.capabilities],
      startupMode: existing.startupMode,
      inputSchema: existing.inputSchema,
      outputSchema: existing.outputSchema,
      modulePath: existing.modulePath,
      testPath: existing.testPath,
      requiredConfigurationKeys: existing.requiredConfigurationKeys,
      requiredSecretHandles: existing.requiredSecretHandles,
      settingsSchema: existing.settingsSchema,
      storage: existing.storage,
      docsMarkdown: existing.docsMarkdown,
      examples: existing.examples,
      packageManifest: existing.packageManifest,
      changeSummary,
    });
  }

  /**
   * Read the active version's Tool body from disk so the council can
   * apply a rework as an EDIT on top of the existing code instead of
   * regenerating from scratch (which has been silently dropping prior
   * fixes across rework chains).
   */
  async readCurrentToolSource(toolName: string, version?: string): Promise<string | undefined> {
    const sanitized = sanitizeName(toolName);
    // Phase 16 Slice I: when the caller pins a specific version,
    // read THAT version's source from disk. Falls back to the
    // currently-active version when version is undefined (legacy).
    let resolvedVersion: string | undefined = version;
    if (!resolvedVersion) {
      const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
      if (!existing) return undefined;
      resolvedVersion = existing.version;
    }
    const candidatePath = join(this.toolsRoot, sanitized, resolvedVersion, "src", "tools", "generated", `${sanitized}Tool.ts`);
    try {
      const { readFile } = await import("node:fs/promises");
      return await readFile(candidatePath, "utf8");
    } catch {
      return undefined;
    }
  }

  async runToolForQa(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string; data?: unknown }> {
    const response = await this.deps.runToolManually(toolName, { input });
    return response.result;
  }

  /**
   * Phase 24 Slice B step 2 — install-probe.
   *
   * Force a cold-start of the freshly-registered tool to verify that
   * `npm install` + `tsc build` produced a SUBPROCESS THAT CAN ACTUALLY
   * LOAD. Catches the class of bugs where:
   *   - the model emitted a typosquatter / placeholder package that
   *     `throw`s at module-evaluation time (e.g. the real
   *     `playwright-extra-plugin-stealth@0.0.1` is a stub that does
   *     `throw new Error('Wrong package, please see this: …')` from its
   *     index.js top level);
   *   - a postinstall hook silently failed to fetch a browser binary;
   *   - the bundle compiled but a runtime-only `await import()` resolves
   *     to a broken module on the first request.
   *
   * The runner's HTTP process runtime ALREADY catches the "exited before
   * healthcheck" case and surfaces it as `result.content`. This probe
   * just makes that signal EXPLICIT (one extra cold-start before QA so
   * we route the failure into the repair loop with a clean structured
   * message, instead of relying on QA attempt 1 to accidentally exhibit
   * the same boot crash).
   *
   * Input is `{}` (empty) — we don't care if zod / type validation
   * rejects it. We only care whether the subprocess SURVIVED long
   * enough to respond at all. ok=false + any content other than
   * "Source-bundle HTTP runtime exited before healthcheck …" is treated
   * as PROBE PASS.
   */
  async probeRegisteredTool(toolName: string): Promise<{
    ok: boolean;
    kind?: "subprocess-exit" | "subprocess-error" | "module-load-error" | "dep-import-error";
    detail?: string;
    brokenDeps?: Array<{ name: string; error: string }>;
  }> {
    let response: Awaited<ReturnType<CouncilToolAdapterDeps["runToolManually"]>>;
    try {
      // Magic input `{__probe: true}` — the scaffold's server.ts
      // intercepts this before invoking the tool body and runs a
      // per-dependency dynamic-import probe instead, reporting
      // which packages failed to load. The probe payload comes back
      // through the normal /run response so the existing runner
      // doesn't need any new HTTP plumbing.
      response = await this.deps.runToolManually(toolName, { input: { __probe: true } });
    } catch (error) {
      return {
        ok: false,
        kind: "subprocess-error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const content = (response.result.content ?? "").trim();
    // Layer 1 — subprocess died at module-evaluation time (top-level
    // throw, missing CJS require, postinstall failure). The runner
    // emits this exact phrase from `startSourceBundleHttpRuntime`.
    if (/Source-bundle HTTP runtime exited before healthcheck/i.test(content)) {
      return { ok: false, kind: "subprocess-exit", detail: content };
    }
    // Layer 2 — subprocess started, /run handled, but module-not-found
    // surfaced (ESM loader crash, ERR_MODULE_NOT_FOUND, native binding
    // mismatch). These show up as "Tool threw: …" wrapper text.
    if (/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND|node-gyp|NODE_MODULE_VERSION/i.test(content)) {
      return { ok: false, kind: "module-load-error", detail: content };
    }
    // Layer 3 — per-dep probe came back. data.broken[] tells us
    // exactly which dep failed to dynamic-import. This is the most
    // surgical signal: the model can swap one specific package
    // without guessing from stderr.
    const data = (response.result as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const broken = (data as { broken?: Array<{ name: string; error: string }> }).broken;
      if (Array.isArray(broken) && broken.length > 0) {
        return {
          ok: false,
          kind: "dep-import-error",
          detail: content || `${broken.length} declared dep(s) failed to import`,
          brokenDeps: broken,
        };
      }
    }
    // All probe layers green — subprocess started, every declared
    // dep imported cleanly. Probe pass.
    return { ok: true };
  }

  /** Pick the next semver bump for an existing tool, or `1.0.0` for a fresh one. */
  private async nextVersionFor(toolName: string): Promise<string> {
    const existing = (await this.deps.metadataStore.list()).find((m) => m.name === toolName);
    if (!existing) return "1.0.0";
    const [maj, min, patch] = existing.version.split(".").map((segment) => Number.parseInt(segment, 10));
    const safeMaj = Number.isFinite(maj!) ? maj! : 1;
    const safeMin = Number.isFinite(min!) ? min! : 0;
    const safePatch = Number.isFinite(patch!) ? patch! : 0;
    return `${safeMaj}.${safeMin}.${safePatch + 1}`;
  }
}

/**
 * Standalone reconciler: align the on-disk tools/ tree with the
 * supplied registry. Removes top-level dirs that have no metadata
 * row (orphans), prunes each still-registered tool to the last 5
 * versions. Safe to run on bootstrap and after every promote.
 *
 * `knownVersions` maps sanitized-name → active version. Pass an
 * empty Map to remove every council-built dir (e.g. test mode).
 */
export async function reconcileToolsDirectory(
  toolsRoot: string,
  knownVersions: ReadonlyMap<string, string>,
): Promise<{ removedTools: string[]; prunedVersions: number }> {
  const KEEP_VERSIONS = 5;
  // Utility dirs the runtime owns and which are never council tools.
  const RESERVED = new Set(["sdk"]);
  let topLevel: string[];
  try {
    topLevel = await readdir(toolsRoot);
  } catch {
    return { removedTools: [], prunedVersions: 0 };
  }
  const removedTools: string[] = [];
  let prunedVersions = 0;
  for (const entry of topLevel) {
    if (RESERVED.has(entry)) continue;
    if (entry.endsWith("-service")) continue; // docker compose build contexts
    const entryPath = join(toolsRoot, entry);
    const active = knownVersions.get(entry);
    if (!active) {
      await rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
      removedTools.push(entry);
      continue;
    }
    const versions = await readdir(entryPath).catch(() => []);
    const semverDirs = versions
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => compareSemver(b, a));
    const kept = new Set<string>([active]);
    for (const v of semverDirs) {
      if (kept.size >= KEEP_VERSIONS) break;
      kept.add(v);
    }
    const toDelete = semverDirs.filter((v) => !kept.has(v));
    await Promise.all(
      toDelete.map((v) =>
        rm(join(entryPath, v), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
    prunedVersions += toDelete.length;
  }
  return { removedTools, prunedVersions };
}

/** Numeric semver compare: `1.0.10` > `1.0.2`. Returns negative when
 *  `a < b`, positive when `a > b`, 0 when equal. Inputs that don't
 *  match `X.Y.Z` sort to the end. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split(".").map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
  const av = parse(a);
  const bv = parse(b);
  if (av.length === 0 && bv.length === 0) return 0;
  if (av.length === 0) return 1;
  if (bv.length === 0) return -1;
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    const ai = av[i] ?? 0;
    const bi = bv[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "council_tool";
}

/**
 * Phase 28 follow-up — auto-derive the standard runtime capabilities
 * a council-built tool should advertise based on observable signals
 * from name / description / tool body. Without this, council-built
 * tools registered with only `[name, "council-built"]` and the agent's
 * `findByCapability("web-search" | "browser-screenshot" | …)` lookup
 * silently returned zero — so the planner's `requiredTools: ["web-search"]`
 * was unfulfillable even though we'd just built a working
 * `web.duckduckgo.search`.
 *
 * Capability inference is conservative — we only add a tag when the
 * evidence is unambiguous. Operators can always layer more via
 * `PATCH /api/tools/generated-modules/:name`, and those overlays now
 * survive reworks (see `preservedFromExisting` in `registerToolFromFiles`).
 *
 * Signals checked:
 *   - Name token: "search", "screenshot", "chart", "ohlc"/"timeseries"
 *   - Description text (case-insensitive)
 *   - npm imports: playwright/puppeteer → browser-* capabilities,
 *     ws/axios/openai-style libs hint at api-http-json, etc.
 */
export function deriveStandardCapabilities(
  toolName: string,
  description: string,
  toolBody: string,
  importedPackages: string[],
): string[] {
  const blob = `${toolName} ${description} ${importedPackages.join(" ")}`.toLowerCase();
  const imports = importedPackages.map((p) => p.toLowerCase());
  const out = new Set<string>();

  const has = (...needles: string[]) => needles.some((n) => blob.includes(n));
  const importsAny = (...names: string[]) =>
    names.some((n) => imports.some((i) => i === n || i.startsWith(`${n}/`) || i.startsWith(`${n}-`)));

  // web-search — anything that says "search", uses a search engine
  // (DuckDuckGo, Google, Bing, Brave, Kagi), or scrapes a SERP page.
  if (
    has("search", "duckduckgo", "google search", "bing search", "kagi", "brave search", "serpapi") ||
    importsAny("serpapi", "duck-duck-scrape")
  ) {
    out.add("web-search");
  }

  // browser-screenshot — anything that captures a page screenshot,
  // including the canonical `screenshot.url` tool and any playwright
  // / puppeteer-using tool that calls `.screenshot()`.
  if (
    has("screenshot", "snapshot", "page capture") ||
    /\.screenshot\s*\(/.test(toolBody)
  ) {
    out.add("browser-screenshot");
  }

  // browser-automation — anything that automates a real browser
  // (playwright / puppeteer / selenium-style page navigation).
  if (
    importsAny("playwright", "playwright-extra", "playwright-core", "puppeteer", "puppeteer-extra", "selenium-webdriver") ||
    /(playwright|puppeteer|chromium)\.launch\s*\(/.test(toolBody)
  ) {
    out.add("browser-automation");
  }

  // chart-generation — charts / plots / svg renderers.
  if (
    has("chart", "plot", "graph render", "render svg") ||
    importsAny("chart.js", "chartjs", "d3", "vega", "plotly")
  ) {
    out.add("chart-generation");
  }

  // market-timeseries — explicit market / OHLC / candles / quotes.
  if (has("ohlc", "candles", "candlestick", "market data", "timeseries", "ticker", "quote feed")) {
    out.add("market-timeseries");
  }

  // file-append / file IO.
  if (toolName.startsWith("file.") || has("append to file", "write file", "file.append")) {
    out.add("file-io");
  }

  // api-http-json — generic outbound JSON HTTP. We only add this when
  // there's a fetch/axios import AND the description suggests it's the
  // primary purpose (otherwise EVERY tool would get it).
  if (importsAny("axios", "got", "undici") && has("api", "http", "endpoint", "rest")) {
    out.add("api-http-json");
  }

  return Array.from(out).sort();
}

/**
 * Best-effort regex parse of the Tool body to extract the `inputSchema`
 * literal. Used as a fallback when the runtime fails to load the tool
 * (TS error, missing dep) — without this the Tools page shows
 * "(no declared properties)" and the operator can't even tell what the
 * tool's input shape is supposed to be. Returns undefined when the
 * literal can't be found or parsed.
 */
/**
 * Coerce a free-form JSON object into the strict ToolSchema shape that
 * the metadata store requires (`{ type: "object", properties, required? }`).
 * Returns undefined if the input isn't shaped like a JSON Schema object.
 */
function coerceInputSchema(value: Record<string, unknown> | undefined): import("./tool.js").ToolSchema | undefined {
  if (!value || typeof value !== "object") return undefined;
  const type = value.type;
  const properties = value.properties;
  if (type !== "object" || !properties || typeof properties !== "object") {
    return undefined;
  }
  const out: import("./tool.js").ToolSchema = {
    type: "object",
    properties: properties as Record<string, unknown>,
  };
  if (Array.isArray(value.required)) {
    out.required = (value.required as unknown[]).filter((entry): entry is string => typeof entry === "string");
  }
  return out;
}

/**
 * Phase 24 Slice B step 3 — pre-install npm-registry probe.
 *
 * For each declared dependency name, do a lightweight GET against
 * https://registry.npmjs.org/<name>. 404 → the package literally does
 * not exist (typosquat, wrong scope, hallucinated name). 200 → name
 * resolves; we don't care about version selection here, only existence.
 *
 * Scoped names (`@scope/pkg`) are URL-encoded with `%2F` between the
 * scope and the package — the registry rejects raw `/` in scoped GETs.
 *
 * Probes run in parallel with a per-request timeout so a slow registry
 * doesn't block tool registration. Network failures bubble up as
 * `errored[]` entries; the caller treats them as "could not verify"
 * (skip the gate, fall through to `npm install`). Only confirmed 404s
 * trigger a fail-fast throw.
 *
 * Tests opt out via `COUNCIL_NPM_REGISTRY_PROBE_ENABLED=disabled`.
 */
export async function probeNpmRegistryExistence(
  names: readonly string[],
): Promise<{
  missing: string[];
  errored: Array<{ name: string; reason: string }>;
}> {
  const missing: string[] = [];
  const errored: Array<{ name: string; reason: string }> = [];
  const timeoutMs = 5_000;
  await Promise.all(
    names.map(async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // Encode scoped names: `@scope/pkg` → `@scope%2Fpkg`.
      const encoded = trimmed.startsWith("@")
        ? trimmed.replace("/", "%2F")
        : trimmed.replace(/\//g, "%2F");
      const url = `https://registry.npmjs.org/${encoded}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // GET (not HEAD) — npm registry returns 200 only on GET for
        // some scoped names, and HEAD is occasionally proxied to
        // 405 by mirrors. The response body is ignored (we don't
        // read it), so the cost is just the TCP round-trip + a few
        // bytes of headers in practice.
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        // Drain body to release the connection.
        await response.text().catch(() => "");
        if (response.status === 404) {
          missing.push(trimmed);
        } else if (!response.ok) {
          errored.push({
            name: trimmed,
            reason: `registry returned HTTP ${response.status}`,
          });
        }
      } catch (err) {
        errored.push({
          name: trimmed,
          reason: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { missing, errored };
}

function extractInputSchemaFromSource(source: string): Record<string, unknown> | undefined {
  return extractSchemaFromSource(source, "inputSchema");
}

/**
 * Phase 28 follow-up — outputSchema fallback.
 *
 * The HTTP process runner exposes inputSchema/outputSchema by reading
 * them from the metadata row (it never imports the tool body, only
 * proxies HTTP /run calls). So at `registerToolFromFiles` time the
 * live tool object's `outputSchema` is whatever the metadata HAS,
 * which on first register is undefined — chicken-and-egg. We
 * regex-parse the literal from the model's source as a fallback so
 * the Tools page + every consumer agent sees a real shape.
 */
function extractOutputSchemaFromSource(source: string): Record<string, unknown> | undefined {
  return extractSchemaFromSource(source, "outputSchema");
}

function extractSchemaFromSource(
  source: string,
  fieldName: "inputSchema" | "outputSchema",
): Record<string, unknown> | undefined {
  // Find an inline `<fieldName>: { ... }`. If the LLM used a separate
  // `const <fieldName> = { ... }` declaration and then shorthand'd it
  // (`<fieldName>,`) inside the Tool literal — which both gemma and
  // qwen do regularly — fall back to that pattern.
  const inline = new RegExp(`${fieldName}\\s*:\\s*\\{`).exec(source);
  const decl = new RegExp(`(?:const|let|var)\\s+${fieldName}\\s*[:=][^{]*\\{`).exec(source);
  const marker = inline ?? decl;
  if (!marker || marker.index === undefined) return undefined;
  // Locate the `{` that starts the schema literal.
  const matchedText = marker[0];
  const braceOffsetInMatch = matchedText.lastIndexOf("{");
  if (braceOffsetInMatch < 0) return undefined;
  const start = marker.index + braceOffsetInMatch;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(start, i + 1);
        // Convert simple TS object literal → JSON. Two heuristics that
        // cover what LLMs emit in practice:
        //   - quote unquoted keys: `{ text: { type: "string" } }` → `{"text":{"type":"string"}}`
        //   - strip trailing commas before } or ]
        const jsonish = literal
          .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
          .replace(/,(\s*[}\]])/g, "$1")
          // Single-quoted strings → double-quoted.
          .replace(/'([^'\\]*)'/g, '"$1"');
        try {
          return JSON.parse(jsonish) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function sanitizeRelativePath(value: string): string {
  // Disallow absolute paths and `..` segments — the writeFile must stay
  // inside the tool's directory.
  const normalized = value.replace(/^[/\\]+/, "");
  const parts = normalized.split(/[/\\]+/).filter((segment) => segment && segment !== "..");
  return parts.join("/") || "file.txt";
}
