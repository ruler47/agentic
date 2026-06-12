import { useState } from "react";

import { useCreateToolPackage } from "@/api/tools";

import {
  formatAdapterContract,
  parseBehaviorExamplesText,
  parseDependencyText,
} from "./toolsPageShared";
import { contextItemsFromDocsUrls, readToolContextFiles } from "./toolContextFiles";

export function CreateToolPackagePanel({ onCreated }: { onCreated: (name: string) => void }) {
  const create = useCreateToolPackage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [request, setRequest] = useState("");
  const [docsUrls, setDocsUrls] = useState("");
  const [docFiles, setDocFiles] = useState<File[]>([]);
  const [capabilities, setCapabilities] = useState("");
  const [dependencies, setDependencies] = useState("");
  const [credentials, setCredentials] = useState("");
  const [discoveryMode, setDiscoveryMode] = useState<"auto" | "disabled" | "npm">("auto");
  const [authoringMode, setAuthoringMode] = useState<"auto" | "scaffold" | "llm">("auto");
  const [activationPolicy, setActivationPolicy] = useState<"manual" | "available_on_success">("manual");
  const [behaviorExamples, setBehaviorExamples] = useState("");

  const submit = async () => {
    const capabilityList = capabilities
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const dependencyMap = parseDependencyText(dependencies);
    const credentialMap = parseCredentialText(credentials);
    const documentationChunks = await readToolContextFiles(docFiles);
    const documentationTexts = documentationChunks.map((chunk) => chunk.content);
    let parsedBehaviorExamples: NonNullable<ReturnType<typeof parseBehaviorExamplesText>>;
    try {
      parsedBehaviorExamples = behaviorExamples.trim()
        ? parseBehaviorExamplesText(behaviorExamples) ?? []
        : [];
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Invalid behavior QA examples JSON");
      return;
    }
    if (!name.trim() || !request.trim()) {
      window.alert("Name and task are required.");
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        version: "0.1.0",
        description: description.trim() || undefined,
        request: request.trim(),
        discoveryMode,
        authoringMode,
        activationPolicy,
        capabilities: capabilityList.length ? capabilityList : undefined,
        dependencies: Object.keys(dependencyMap).length > 0 ? dependencyMap : undefined,
        credentials: Object.keys(credentialMap).length > 0 ? credentialMap : undefined,
        docsUrls: parseListText(docsUrls),
        documentation: documentationTexts.length > 0 ? documentationTexts : undefined,
        contextItems: [
          ...contextItemsFromDocsUrls(parseListText(docsUrls)),
          ...documentationChunks,
        ],
        behaviorExamples: parsedBehaviorExamples.length > 0 ? parsedBehaviorExamples : undefined,
      },
      {
        onSuccess: (data) => {
          onCreated(data.tool.name);
        },
      },
    );
  };

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left font-semibold"
      >
        <span>Create source-bundle tool</span>
        <span className="text-app-text-muted">{open ? "Close" : "Open"}</span>
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="provider.capability"
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Description</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Checks wallet or transaction risk through the provider API."
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Task</span>
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              rows={4}
              placeholder="Create a tool for this API. It should accept the parameters I pass, call the documented endpoints correctly, and return a normalized answer with raw response data."
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 outline-none focus:border-app-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">API docs URLs</span>
            <textarea
              value={docsUrls}
              onChange={(event) => setDocsUrls(event.target.value)}
              rows={2}
              placeholder="https://example.com/docs/openapi.yaml"
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono outline-none focus:border-app-accent/60"
            />
          </label>
          <CredentialInput value={credentials} onChange={setCredentials} />
          <fieldset className="rounded-md border border-app-border bg-app-surface-2 p-2">
            <legend className="px-1 text-[10px] uppercase text-app-text-muted">Agent availability after QA</legend>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="flex cursor-pointer gap-2 rounded border border-app-border bg-app-surface px-2 py-2">
                <input
                  type="radio"
                  checked={activationPolicy === "manual"}
                  onChange={() => setActivationPolicy("manual")}
                />
                <span>
                  <span className="block font-semibold">Manual verification</span>
                  <span className="block text-[11px] text-app-text-muted">
                    Register disabled; use pinned manual runs before enabling agents.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer gap-2 rounded border border-app-border bg-app-surface px-2 py-2">
                <input
                  type="radio"
                  checked={activationPolicy === "available_on_success"}
                  onChange={() => setActivationPolicy("available_on_success")}
                />
                <span>
                  <span className="block font-semibold">Enable after successful QA</span>
                  <span className="block text-[11px] text-app-text-muted">
                    Mark available immediately if creation QA passes.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-app-text-muted">Documentation files</span>
            <input
              type="file"
              multiple
              accept=".yaml,.yml,.json,.md,.txt,.openapi"
              onChange={(event) => setDocFiles(Array.from(event.target.files ?? []))}
              className="rounded border border-app-border bg-app-surface-2 px-2 py-1 text-[11px] outline-none file:mr-2 file:rounded file:border-0 file:bg-app-accent file:px-2 file:py-1 file:text-app-bg"
            />
            <span className="text-[11px] text-app-text-muted">
              {docFiles.length > 0
                ? `${docFiles.length} file${docFiles.length === 1 ? "" : "s"} selected; contents are sent as documentation text.`
                : "Attach YAML, JSON, Markdown, and text docs here; files are read locally and sent with the create request."}
            </span>
          </label>
          <details className="rounded-md border border-app-border bg-app-surface-2 p-2">
            <summary className="cursor-pointer text-[10px] uppercase text-app-text-muted">
              Advanced builder controls
            </summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase text-app-text-muted">Capabilities</span>
                <input
                  value={capabilities}
                  onChange={(event) => setCapabilities(event.target.value)}
                  placeholder="api-client, crypto-risk"
                  className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase text-app-text-muted">Package dependencies</span>
                <input
                  value={dependencies}
                  onChange={(event) => setDependencies(event.target.value)}
                  placeholder="pdf-parse:^1.1.1, slugify:^1.6.6"
                  className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase text-app-text-muted">Discovery</span>
                <select
                  value={discoveryMode}
                  onChange={(event) => setDiscoveryMode(event.target.value as "auto" | "disabled" | "npm")}
                  className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
                >
                  <option value="auto">auto</option>
                  <option value="npm">npm registry</option>
                  <option value="disabled">docs only</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase text-app-text-muted">Authoring</span>
                <select
                  value={authoringMode}
                  onChange={(event) => setAuthoringMode(event.target.value as typeof authoringMode)}
                  className="rounded border border-app-border bg-app-surface px-2 py-1 outline-none focus:border-app-accent/60"
                >
                  <option value="auto">auto</option>
                  <option value="scaffold">scaffold</option>
                  <option value="llm">LLM authored</option>
                </select>
              </label>
            </div>
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-[10px] uppercase text-app-text-muted">Manual behavior QA JSON override</span>
              <textarea
                value={behaviorExamples}
                onChange={(event) => setBehaviorExamples(event.target.value)}
                rows={4}
                placeholder="Leave empty: builder derives QA from OpenAPI/docs/cURL/examples when possible."
                className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
              />
            </label>
          </details>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending}
            className="rounded bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create, QA, and register"}
          </button>
          {create.isError ? (
            <p className="text-[11px] text-app-danger">{create.error.message}</p>
          ) : null}
          {create.data ? (
            <div className="rounded border border-app-border bg-app-surface-2 p-2 text-[11px]">
              <p className="font-semibold">{create.data.qa.ok ? "QA passed" : "QA failed"}</p>
              <p className="mt-1 text-app-text-muted">{create.data.qa.summary}</p>
              {create.data.creation?.strategy ? (
                <>
                  <p className="mt-1 text-app-text-muted">
                    Strategy: {create.data.creation.strategy.kind} · {create.data.creation.strategy.confidence}
                  </p>
                  {create.data.creation.strategy.discoveryEvidence?.[0] ? (
                    <p className="mt-1 truncate text-app-text-muted">
                      Discovery: {create.data.creation.strategy.discoveryEvidence.map((item) => item.summary).join(" ")}
                    </p>
                  ) : null}
                  {create.data.creation.strategy.behaviorExamples?.length ? (
                    <p className="mt-1 text-app-text-muted">
                      Behavior QA: {create.data.creation.strategy.behaviorExamples.length} example(s)
                    </p>
                  ) : null}
                  {create.data.creation.strategy.adapterContract ? (
                    <p className="mt-1 truncate text-app-text-muted">
                      Adapter: {formatAdapterContract(create.data.creation.strategy.adapterContract)}
                    </p>
                  ) : null}
                </>
              ) : null}
              <RequiredSecretHandlesSummary handles={create.data.tool.requiredSecretHandles ?? []} />
              <p className="mt-1 font-mono text-app-text-muted">{create.data.package.manifestPath}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CredentialInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 md:col-span-2">
      <span className="text-[10px] uppercase text-app-text-muted">Credentials (optional)</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        placeholder="apiKey=..."
        className="rounded border border-app-border bg-app-surface px-2 py-1 font-mono outline-none focus:border-app-accent/60"
      />
      <span className="text-[11px] text-app-text-muted">
        Values are accepted only for onboarding: the server stores them as tool-scoped secret handles and redacts the request before builder traces/package authoring.
      </span>
    </label>
  );
}

function RequiredSecretHandlesSummary({ handles }: { handles: string[] }) {
  if (handles.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-app-border bg-app-surface-2 p-2">
      <p className="text-[10px] uppercase text-app-text-muted">Registered credential handles</p>
      <ul className="mt-1 flex flex-col gap-1">
        {handles.map((handle) => (
          <li key={handle} className="break-all font-mono text-[10px] text-app-accent">
            {handle}
          </li>
        ))}
      </ul>
    </div>
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
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}
