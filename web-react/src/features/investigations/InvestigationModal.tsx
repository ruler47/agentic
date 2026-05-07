import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Modal } from "@/components/Modal";
import { useCreateInvestigation } from "@/api/investigations";
import { useInvestigationModal } from "@/features/investigations/store";
import { truncate } from "@/lib/format";
import type { ToolInvestigationContextBundle, ToolInvestigationRecord } from "@/api/types";

export function InvestigationModalRoot() {
  const open = useInvestigationModal((state) => state.open);
  const draft = useInvestigationModal((state) => state.draft);
  const close = useInvestigationModal((state) => state.close);

  return (
    <Modal open={open} onClose={close} ariaLabel="Tool Investigation Ticket">
      {draft ? <InvestigationModalContent /> : null}
    </Modal>
  );
}

function InvestigationModalContent() {
  const draft = useInvestigationModal((state) => state.draft);
  const close = useInvestigationModal((state) => state.close);
  const create = useCreateInvestigation();

  const [comment, setComment] = useState("");
  const [created, setCreated] = useState<ToolInvestigationRecord | undefined>();

  // Reset transient state whenever the modal target changes.
  useEffect(() => {
    setComment("");
    setCreated(undefined);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.spanId, draft?.runId]);

  if (!draft) return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (create.isPending || created) return;
    create.mutate(
      {
        source: draft.source,
        title: draft.title,
        operatorComment: comment.trim() || undefined,
        runId: draft.runId,
        spanId: draft.spanId,
        toolName: draft.matchedToolName,
        toolVersion: draft.matchedToolVersion,
        artifactIds: draft.artifactIds,
        contextBundle: draft.contextBundle,
      },
      {
        onSuccess: (data) => setCreated(data.investigation),
      },
    );
  };

  return (
    <div className="flex max-h-[calc(100vh-120px)] flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-app-border p-5">
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
            Tool Investigation Ticket
          </span>
          <h2 className="mt-0.5 break-words text-base font-semibold">{draft.title}</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            A durable ticket preserves the failure context. Promote it from Tool Builds when ready;
            sensitive keys (secret/token/password/apiKey/credential/authorization) are redacted
            server-side before storage.
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-xs text-app-text-muted hover:text-app-text"
        >
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-5">
        {draft.warnings.length > 0 ? (
          <section className="mb-4 rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-xs text-app-warning">
            <p className="font-semibold">Heads up</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {draft.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <ContextPreview draft={draft} />

        {created ? (
          <section className="mt-4 rounded-md border border-app-accent/30 bg-app-accent-soft p-3 text-xs text-app-accent">
            <p className="font-semibold">Investigation created</p>
            <p className="mt-1 font-mono">{created.id}</p>
            <p className="mt-1 text-app-text">
              Open Tool Builds to triage and promote it to a Tool Build / rework request when ready.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link
                to="/tool-builds"
                className="rounded-md border border-app-accent/40 bg-app-bg px-2.5 py-1 text-app-accent"
              >
                Open Tool Builds
              </Link>
              <button
                type="button"
                onClick={close}
                className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-app-text"
              >
                Done
              </button>
            </div>
          </section>
        ) : (
          <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-app-text-muted">Operator comment</span>
              <textarea
                rows={4}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Why this needs investigation, what was expected, what to verify before rebuilding the tool."
                className="resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
              />
            </label>
            {create.isError ? (
              <p className="text-xs text-app-danger">{create.error.message}</p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={create.isPending}
                className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
              >
                {create.isPending ? "Creating…" : "Create investigation"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ContextPreview({ draft }: { draft: { matchedToolName?: string; matchedToolDisplayName?: string; matchedToolVersion?: string; runId: string; spanId: string; source: string; contextBundle: ToolInvestigationContextBundle } }) {
  const bundle = draft.contextBundle;
  const matchedTool = draft.matchedToolName
    ? `${draft.matchedToolDisplayName ?? draft.matchedToolName}${draft.matchedToolVersion ? ` v${draft.matchedToolVersion}` : ""}`
    : undefined;
  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        Context that will be attached
      </h3>
      <dl className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
        <Field label="Source">{draft.source}</Field>
        <Field label="Run">{draft.runId || "—"}</Field>
        <Field label="Span">{draft.spanId || "—"}</Field>
        <Field label="Matched tool">{matchedTool ?? <span className="text-app-text-muted">none — manual investigation</span>}</Field>
        {bundle.actor ? <Field label="Actor">{bundle.actor}</Field> : null}
        {bundle.activity ? <Field label="Activity">{bundle.activity}</Field> : null}
        {bundle.status ? <Field label="Status">{bundle.status}</Field> : null}
        {bundle.caller ? <Field label="Caller">{bundle.caller}</Field> : null}
        {bundle.taskPrompt ? <Field label="Task">{truncate(bundle.taskPrompt, 200)}</Field> : null}
        {bundle.inputSummary ? <Field label="Input">{truncate(bundle.inputSummary, 240)}</Field> : null}
        {bundle.outputSummary ? <Field label="Output">{truncate(bundle.outputSummary, 320)}</Field> : null}
        {bundle.error ? <Field label="Error">{truncate(bundle.error, 320)}</Field> : null}
      </dl>
      {bundle.relatedArtifactRefs && bundle.relatedArtifactRefs.length > 0 ? (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-app-text-muted">
            Related artifacts ({bundle.relatedArtifactRefs.length})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {bundle.relatedArtifactRefs.map((ref, index) => (
              <li key={index}>
                <strong>{ref.filename ?? ref.id ?? "artifact"}</strong>
                <span className="ml-1 text-app-text-muted">{ref.mimeType}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="break-words font-mono text-[11px]">{children}</dd>
    </>
  );
}
