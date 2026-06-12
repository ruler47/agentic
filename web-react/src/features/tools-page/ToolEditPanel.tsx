import { useEffect, useMemo, useState } from "react";

import { useCreateToolVersion, useToolVersions, type ToolVersionSummary } from "@/api/tools";
import type { ToolModuleMetadata } from "@/api/types";

import {
  defaultBehaviorExamplesText,
  inferCreationKindFromTool,
  nextPatchVersion,
  parseBehaviorExamplesText,
  parseDependencyText,
} from "./toolsPageShared";
import { contextItemsFromDocsUrls, readToolContextFiles } from "./toolContextFiles";

type EditKind = "echo" | "http-json" | "npm-default-function" | "browser-screenshot" | "browser-operate" | "web-read" | "service-adapter" | "external-action-prepare" | "external-action-commit";

export function ToolEditPanel({ tool }: { tool: ToolModuleMetadata }) {
  const createVersion = useCreateToolVersion();
  const versions = useToolVersions(tool.name);
  const versionOptions = useMemo(
    () => versions.data?.length ? versions.data : [activeSummary(tool)],
    [tool, versions.data],
  );
  const activeVersion = versionOptions.find((version) => version.active)?.version ?? tool.version;
  const [baseVersion, setBaseVersion] = useState(activeVersion);
  const base = versionOptions.find((version) => version.version === baseVersion) ?? activeSummary(tool);
  const kindFromBase = inferCreationKindFromVersion(tool, base);
  const initialScreenshotQaUrl = "https://example.com";
  const [version, setVersion] = useState(nextPatchVersion(base.version));
  const [customLabel, setCustomLabel] = useState("");
  const [changeDescription, setChangeDescription] = useState("");
  const [request, setRequest] = useState("");
  const [docsUrls, setDocsUrls] = useState("");
  const [docFiles, setDocFiles] = useState<File[]>([]);
  const [credentials, setCredentials] = useState("");
  const [kind, setKind] = useState<EditKind>(kindFromBase);
  const [toolDescription, setToolDescription] = useState(base.description ?? tool.description);
  const [capabilities, setCapabilities] = useState((base.capabilities ?? tool.capabilities ?? []).join(", "));
  const [dependencies, setDependencies] = useState("");
  const [authoringMode, setAuthoringMode] = useState<"auto" | "scaffold" | "llm">("auto");
  const [screenshotQaUrl, setScreenshotQaUrl] = useState(initialScreenshotQaUrl);
  const [behaviorExamples, setBehaviorExamples] = useState("");

  useEffect(() => {
    const nextBase = versionOptions.find((item) => item.active)?.version ?? tool.version;
    setBaseVersion(nextBase);
  }, [tool.name, tool.version, versionOptions]);

  useEffect(() => {
    const selected = versionOptions.find((item) => item.version === baseVersion) ?? activeSummary(tool);
    const nextKind = inferCreationKindFromVersion(tool, selected);
    setVersion(nextPatchVersion(selected.version));
    setKind(nextKind);
    setToolDescription(selected.description ?? tool.description);
    setCapabilities((selected.capabilities ?? tool.capabilities ?? []).join(", "));
    setDependencies("");
    setCredentials("");
    setDocsUrls("");
    setDocFiles([]);
    setCustomLabel("");
    setChangeDescription("");
    setRequest("");
    setAuthoringMode("auto");
    setScreenshotQaUrl(initialScreenshotQaUrl);
    setBehaviorExamples("");
  }, [baseVersion, tool.name]);

  const updateKind = (nextKind: EditKind) => {
    const currentDefault = defaultBehaviorExamplesText(kind, screenshotQaUrl);
    setKind(nextKind);
    if (behaviorExamples === currentDefault) setBehaviorExamples(defaultBehaviorExamplesText(nextKind, screenshotQaUrl));
  };

  const updateScreenshotQaUrl = (url: string) => {
    const previousDefault = defaultBehaviorExamplesText(kind, screenshotQaUrl);
    setScreenshotQaUrl(url);
    if (kind === "browser-screenshot" && behaviorExamples === previousDefault) {
      setBehaviorExamples(defaultBehaviorExamplesText(kind, url));
    }
  };

  const submit = async () => {
    if (!request.trim()) {
      window.alert("Edit task is required.");
      return;
    }
    let parsedBehaviorExamples: ReturnType<typeof parseBehaviorExamplesText> | undefined;
    try {
      parsedBehaviorExamples = behaviorExamples.trim()
        ? parseBehaviorExamplesText(behaviorExamples)
        : undefined;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Invalid behavior QA examples JSON");
      return;
    }
    const documentationChunks = await readToolContextFiles(docFiles);
    const documentationTexts = documentationChunks.map((chunk) => chunk.content);
    const dependencyMap = parseDependencyText(dependencies);
    const credentialMap = parseCredentialText(credentials);
    createVersion.mutate({
      name: tool.name,
      baseVersion,
      version,
      customLabel: customLabel.trim() || undefined,
      changeDescription: changeDescription.trim() || undefined,
      request: request.trim(),
      description: toolDescription.trim() || undefined,
      kind,
      authoringMode,
      capabilities: capabilities.split(",").map((item) => item.trim()).filter(Boolean),
      dependencies: Object.keys(dependencyMap).length > 0 ? dependencyMap : undefined,
      credentials: Object.keys(credentialMap).length > 0 ? credentialMap : undefined,
      docsUrls: parseListText(docsUrls),
      documentation: documentationTexts.length > 0 ? documentationTexts : undefined,
      contextItems: [
        ...contextItemsFromDocsUrls(parseListText(docsUrls)),
        ...documentationChunks,
      ],
      behaviorExamples: parsedBehaviorExamples,
    });
  };

  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="grid gap-2 md:grid-cols-[180px_160px_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">Base version</span>
          <select
            value={baseVersion}
            onChange={(event) => setBaseVersion(event.target.value)}
            className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
          >
            {versionOptions.map((item) => (
              <option key={item.version} value={item.version}>
                v{item.version}{item.active ? " active" : ""} · {item.status}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">New version</span>
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">Custom label</span>
          <input
            value={customLabel}
            onChange={(event) => setCustomLabel(event.target.value)}
            placeholder="experiment 1"
            className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
          />
        </label>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-[10px] uppercase text-app-text-muted">Edit task</span>
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            rows={4}
            placeholder="Describe what should change. The builder will reuse the base version package, docs, examples, schemas, and secret handles as context."
            className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">Short edit description</span>
          <input
            value={changeDescription}
            onChange={(event) => setChangeDescription(event.target.value)}
            placeholder="Tighten AML primary-field output semantics."
            className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">New docs URL</span>
          <input
            value={docsUrls}
            onChange={(event) => setDocsUrls(event.target.value)}
            placeholder="https://example.com/docs/openapi.yaml"
            className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
          />
        </label>
        <CredentialInput
          value={credentials}
          onChange={setCredentials}
          existingHandles={base.requiredSecretHandles ?? tool.requiredSecretHandles ?? []}
        />
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-[10px] uppercase text-app-text-muted">Additional documentation files</span>
          <input
            type="file"
            multiple
            accept=".yaml,.yml,.json,.md,.txt,.openapi"
            onChange={(event) => setDocFiles(Array.from(event.target.files ?? []))}
            className="rounded border border-app-border bg-app-surface px-2 py-1 text-[11px] outline-none file:mr-2 file:rounded file:border-0 file:bg-app-accent file:px-2 file:py-1 file:text-app-bg"
          />
          <span className="text-[11px] text-app-text-muted">
            {docFiles.length > 0
              ? `${docFiles.length} file${docFiles.length === 1 ? "" : "s"} selected; contents are added to the inherited build context.`
              : "Optional delta only. Existing package docs/examples/schemas and previous source bundle context remain available to the builder."}
          </span>
        </label>
      </div>
      <details className="mt-2 rounded-md border border-app-border bg-app-surface p-2">
        <summary className="cursor-pointer text-[10px] uppercase text-app-text-muted">
          Advanced builder controls
        </summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Candidate tool description</span>
            <input
              value={toolDescription}
              onChange={(event) => setToolDescription(event.target.value)}
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Strategy hint</span>
            <select
              value={kind}
              onChange={(event) => updateKind(event.target.value as EditKind)}
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
            >
              <option value="echo">custom/echo scaffold</option>
              <option value="http-json">HTTP JSON</option>
              <option value="npm-default-function">npm adapter</option>
              <option value="browser-screenshot">browser screenshot</option>
              <option value="browser-operate">browser operate</option>
              <option value="external-action-prepare">external action prepare</option>
              <option value="external-action-commit">external action commit</option>
              <option value="web-read">web read/extract</option>
              <option value="service-adapter">always-on service adapter</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Capabilities</span>
            <input
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Extra dependencies</span>
            <input
              value={dependencies}
              onChange={(event) => setDependencies(event.target.value)}
              placeholder="package:^1.2.3"
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Authoring</span>
            <select
              value={authoringMode}
              onChange={(event) => setAuthoringMode(event.target.value as typeof authoringMode)}
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
            >
              <option value="auto">auto</option>
              <option value="scaffold">scaffold</option>
              <option value="llm">LLM authored</option>
            </select>
          </label>
          {kind === "browser-screenshot" ? (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">Screenshot QA URL</span>
              <input
                value={screenshotQaUrl}
                onChange={(event) => updateScreenshotQaUrl(event.target.value)}
                placeholder="https://example.com"
                className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
              />
            </label>
          ) : null}
        </div>
        <label className="mt-2 flex flex-col gap-1">
          <span className="text-[10px] uppercase text-app-text-muted">Manual behavior QA JSON override</span>
          <textarea
            value={behaviorExamples}
            onChange={(event) => setBehaviorExamples(event.target.value)}
            rows={3}
            placeholder="Leave empty: builder reuses inherited examples and derives new QA from docs/request when possible."
            className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
          />
        </label>
      </details>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={createVersion.isPending}
          className="rounded bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
        >
          {createVersion.isPending ? "Creating version…" : "Create edited version"}
        </button>
        <span className="text-[11px] text-app-text-muted">
          Builds from v{base.version}; old credentials stay unless new credential values are provided.
        </span>
      </div>
      {createVersion.isError ? (
        <p className="mt-2 text-[11px] text-app-danger">{createVersion.error.message}</p>
      ) : null}
      {createVersion.data ? (
        <div className="mt-2 rounded border border-app-border bg-app-surface px-2 py-1.5 text-[11px]">
          <p className="font-semibold">
            Created v{createVersion.data.tool.version} · {createVersion.data.tool.status}
          </p>
          <p className="mt-1 text-app-text-muted">{createVersion.data.qa.summary}</p>
          {createVersion.data.runId ? (
            <a href={`/run/${encodeURIComponent(createVersion.data.runId)}`} className="mt-1 inline-flex font-medium text-app-accent hover:underline">
              Open edit run
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function activeSummary(tool: ToolModuleMetadata): ToolVersionSummary {
  return {
    version: tool.version,
    active: true,
    status: tool.status,
    displayName: tool.displayName,
    description: tool.description,
    capabilities: tool.capabilities,
    requiredSecretHandles: tool.requiredSecretHandles,
    packageManifest: tool.packageManifest,
    updatedAt: tool.updatedAt,
  };
}

function inferCreationKindFromVersion(tool: ToolModuleMetadata, version: ToolVersionSummary): EditKind {
  return inferCreationKindFromTool({
    ...tool,
    startupMode: version.packageManifest?.startupMode ?? tool.startupMode,
    packageManifest: version.packageManifest ?? tool.packageManifest,
    description: version.description ?? tool.description,
    capabilities: version.capabilities ?? tool.capabilities,
  });
}

function CredentialInput({
  value,
  onChange,
  existingHandles,
}: {
  value: string;
  onChange: (value: string) => void;
  existingHandles: string[];
}) {
  return (
    <label className="flex flex-col gap-1 md:col-span-2">
      <span className="text-[10px] uppercase text-app-text-muted">Credentials delta (optional)</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        placeholder="apiKey=..."
        className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
      />
      <span className="text-[11px] text-app-text-muted">
        Leave empty to keep existing handles{existingHandles.length ? ` (${existingHandles.join(", ")})` : ""}.
        Provided values replace or add tool-scoped secret handles and are redacted before build traces.
      </span>
    </label>
  );
}

function parseCredentialText(value: string): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n|,/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.includes("=") ? "=" : ":";
    const index = line.indexOf(separator);
    if (index === -1) {
      credentials.apiKey = line;
      continue;
    }
    const key = line.slice(0, index).trim();
    const secret = line.slice(index + 1).trim();
    if (key && secret) credentials[key] = secret;
  }
  return credentials;
}

function parseListText(value: string): string[] | undefined {
  const items = value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
