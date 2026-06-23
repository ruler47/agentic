import { useMemo, useState } from "react";

import {
  useActionProposalCommit,
  useActionProposalDecision,
  useActionProposalExecutorBuild,
  useActionProposalPrepare,
  useActionProposalProfileHydrationApproval,
  useActionProposals,
  type ActionProposalQueueItem,
} from "@/api/runs";
import type { AgentRunRecord } from "@/api/types";
import { artifactDownloadUrl } from "@/components/ArtifactPreview";
import { GenericBadge } from "@/components/StatusBadge";
import { ActionProposalReview } from "@/features/approvals/ActionProposalReview";
import {
  humanActionDraftBlockers,
  humanSubmitBlockReason,
  isFixtureActionProposal,
  profileHydrationApprovalCandidates,
} from "@/features/approvals/actionProposalPresentation";
import { CommitReadinessPanel } from "@/features/approvals/CommitReadinessPanel";
import { buildCommitReadiness } from "@/features/approvals/commitReadiness";
import { buildExternalActionUxState } from "@/features/approvals/externalActionUxState";
import { buildActionApprovalPhase } from "@/features/run-workspace/actionApprovalPhase";
import { formatRelative, truncate } from "@/lib/format";

export function RunActionApprovalPanel({ run }: { run: AgentRunRecord }) {
  const proposals = useActionProposals();
  const items = useMemo(
    () => (proposals.data ?? []).filter((item) => item.run.id === run.id),
    [proposals.data, run.id],
  );
  const phase = buildActionApprovalPhase(items, run.status);

  if (!items.length) return null;

  return (
    <article className="rounded-[var(--radius-card)] border border-app-warning/40 bg-app-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-warning">
            External action approval
          </p>
          <h3 className="text-sm font-semibold">{phase.title}</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Approval, preparation, executor build, and commit stay linked to this run.
          </p>
        </div>
        <GenericBadge tone={phase.tone}>{phase.badge}</GenericBadge>
      </div>

      {proposals.isError ? (
        <p className="mt-3 text-xs text-app-danger">
          {proposals.error?.message ?? "Failed to load action proposals."}
        </p>
      ) : null}
      {proposals.isLoading && !items.length ? (
        <p className="mt-3 text-xs text-app-text-muted">Loading approval state…</p>
      ) : null}
      <div className="mt-4 grid gap-3">
        {items.map((item) => (
          <RunActionApprovalCard key={item.proposal.id} item={item} />
        ))}
      </div>
    </article>
  );
}

function RunActionApprovalCard({ item }: { item: ActionProposalQueueItem }) {
  const proposalDecision = useActionProposalDecision();
  const proposalPrepare = useActionProposalPrepare();
  const ux = buildExternalActionUxState(item);
  const canDecide =
    item.proposal.status === "proposed" &&
    item.proposal.approvalRequired &&
    ux.primaryAction.kind === "approve_proposal";
  const summary = ux.summary;

  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <strong className="block text-sm">{item.proposal.title}</strong>
          <p className="mt-1 font-mono text-[10px] text-app-text-muted">
            {item.proposal.actionType.replace(/_/g, " ")} · {formatRelative(item.proposal.createdAt)}
          </p>
        </div>
        <GenericBadge tone={ux.tone}>{ux.statusLabel}</GenericBadge>
      </header>

      <div className="mt-3 rounded-md border border-app-accent/30 bg-app-bg p-3 text-[11px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-app-accent">{ux.title}</p>
            <p className="mt-1 text-app-text-muted">{ux.description}</p>
          </div>
          <GenericBadge tone={ux.tone}>{ux.statusLabel}</GenericBadge>
        </div>
        <dl className="mt-3 grid gap-2 md:grid-cols-2">
          <CompactField label="Куда">{summary.target}</CompactField>
          <CompactField label="Действие">{summary.action}</CompactField>
          <CompactField label="Страница">{summary.url}</CompactField>
          <CompactField label="Данные">{summary.data}</CompactField>
        </dl>
      </div>

      <MainActionDraft item={item} />
      <ProfileHydrationReview item={item} />

      {canDecide ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              proposalDecision.mutate({ id: item.proposal.id, decision: "approve" })
            }
            disabled={proposalDecision.isPending}
            className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
          >
            {proposalDecision.isPending ? "Approving…" : ux.primaryAction.label}
          </button>
          <button
            type="button"
            onClick={() =>
              proposalDecision.mutate({ id: item.proposal.id, decision: "reject" })
            }
            disabled={proposalDecision.isPending}
            className="rounded-md border border-app-danger/40 bg-app-danger-soft px-2.5 py-1 text-[11px] text-app-danger disabled:opacity-50"
          >
            Reject and complete run
          </button>
          <span className="basis-full text-[11px] text-app-text-muted">
            {ux.primaryAction.effect}
          </span>
        </div>
      ) : null}

      {item.proposal.status === "approved" ? <RunCommitControls item={item} /> : null}

      <details className="mt-3 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
        <summary className="cursor-pointer text-app-text-muted">
          Advanced details: readiness, preparation, executor
        </summary>
        <div className="mt-2">
          <ActionProposalReview item={item} />
          <CommitReadinessPanel item={item} />
          <PreparationSnapshot item={item} />
          {item.executorBuild ? <ExecutorBuildSnapshot item={item.executorBuild} /> : null}
          {canDecide ? (
            <button
              type="button"
              onClick={() => proposalPrepare.mutate({ id: item.proposal.id })}
              disabled={proposalPrepare.isPending}
              className="mt-2 rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 text-[11px] disabled:opacity-50"
            >
              {proposalPrepare.isPending ? "Preparing…" : "Prepare / refresh proof without approving"}
            </button>
          ) : null}
        </div>
      </details>

      {proposalDecision.error ? (
        <p className="mt-2 text-[11px] text-app-danger">{proposalDecision.error.message}</p>
      ) : null}
      {proposalPrepare.error ? (
        <p className="mt-2 text-[11px] text-app-danger">{proposalPrepare.error.message}</p>
      ) : null}
    </section>
  );
}

function ProfileHydrationReview({ item }: { item: ActionProposalQueueItem }) {
  const approval = useActionProposalProfileHydrationApproval();
  const readiness = buildCommitReadiness(item);
  const ux = buildExternalActionUxState(item);
  const session = item.preparationExecution?.preparedSession;
  if (!session || item.proposal.status !== "approved") return null;

  const candidates = profileHydrationApprovalCandidates(item);

  if (!candidates.length && readiness.missingReplayFields.length) {
    return (
      <div className="mt-3 rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-[11px] text-app-warning">
        Profile values are approved. Replay preparation is still required for:{" "}
        {readiness.missingReplayFields.join(", ")}.
      </div>
    );
  }
  if (!candidates.length) return null;

  return (
    <div className="mt-3 rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-[11px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-app-warning">
            {ux.primaryAction.kind === "approve_profile_values"
              ? ux.primaryAction.label
              : "Разрешить подставить данные в форму"}
          </p>
          <p className="mt-1 text-app-text-muted">
            {ux.primaryAction.kind === "approve_profile_values"
              ? ux.primaryAction.effect
              : "После нажатия система заново откроет страницу, заполнит эти поля, сделает proof-скриншот и снова остановится. Бронь/заявка еще не отправляется."}
          </p>
        </div>
        <GenericBadge tone="warn">fill approval</GenericBadge>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        {candidates.map((field) => (
          <CompactField key={field.fields.join("|")} label={field.label}>
            {`${field.valuePreview} · ${field.source}`}
          </CompactField>
        ))}
      </dl>
      <div className="mt-3 rounded border border-app-border bg-app-bg p-2 text-app-text-muted">
        <p className="font-semibold text-app-text">Что произойдет дальше</p>
        <ol className="mt-1 list-decimal space-y-1 pl-4">
          <li>Эти значения будут разрешены только для заполнения формы.</li>
          <li>Подготовка формы запустится еще раз и сохранит proof.</li>
          <li>Финальная отправка останется отдельной кнопкой после проверки.</li>
        </ol>
      </div>
      <button
        type="button"
        onClick={() =>
          approval.mutate({
            id: item.proposal.id,
            fields: candidates.flatMap((field) => field.fields),
            reason: "Operator approved profile values and replay preparation.",
          })
        }
        disabled={approval.isPending}
        className="mt-3 rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
      >
        {approval.isPending
          ? "Заполняю и готовлю proof…"
          : ux.primaryAction.kind === "approve_profile_values"
            ? ux.primaryAction.label
            : "Разрешить заполнение и подготовить proof"}
      </button>
      {approval.error ? (
        <p className="mt-2 text-[11px] text-app-danger">{approval.error.message}</p>
      ) : null}
    </div>
  );
}

function MainActionDraft({ item }: { item: ActionProposalQueueItem }) {
  const session = item.preparationExecution?.preparedSession;
  const draft = session?.actionDraft;
  const warnings = session?.warnings ?? [];
  if (!draft) return null;
  const visibleBlockers = humanActionDraftBlockers(draft.missingBeforeCommit);
  const diagnosticArtifactIds = uniqueStrings([
    ...(item.preparationExecution?.artifactIds ?? []),
    ...(session?.artifactIds ?? []),
  ]);
  const proofArtifactIds = uniqueStrings([
    ...(session?.proofArtifactIds ?? []),
    ...(draft.proofArtifactIds ?? []),
  ]);
  return (
    <div className="mt-3 rounded-md border border-app-accent/30 bg-app-bg p-3 text-[11px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-app-accent">Черновик действия, без отправки</p>
          <p className="mt-1 text-app-text-muted">
            {visibleBlockers.length
              ? `The platform must continue preparation before submit: ${truncate(visibleBlockers.join(", "), 220)}.`
              : truncate(draft.operatorNextStep, 260)}
          </p>
        </div>
        <GenericBadge tone={draft.status === "ready_for_operator_review" ? "ok" : "warn"}>
          {draft.status.replace(/_/g, " ")}
        </GenericBadge>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        <CompactField label="Will do">{truncate(draft.action, 220)}</CompactField>
        <CompactField label="Provider page">
          {draft.pageUrl ? truncate(draft.pageUrl, 220) : "No prepared page yet"}
        </CompactField>
        <CompactField label="Draft data">
          {draft.dataPreview.length
            ? truncate(
                draft.dataPreview
                  .map((field) => `${field.label} = ${field.value}`)
                  .join("; "),
                320,
              )
            : "No form data prepared yet"}
        </CompactField>
        <CompactField label="Before submit">
          {visibleBlockers.length
            ? truncate(visibleBlockers.join(", "), 220)
            : "Ready for final operator review"}
        </CompactField>
      </dl>
      <p className="mt-2 text-app-text-muted">
        Required final report:{" "}
        {truncate(draft.postCommitReportRequirements.join("; "), 320)}
      </p>
      {warnings.length ? (
        <div className="mt-3 rounded border border-app-warning/40 bg-app-warning-soft p-2 text-app-warning">
          <p className="font-semibold">Preparation warning</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {warnings.slice(0, 3).map((warning) => (
              <li key={warning}>{truncate(humanSubmitBlockReason(warning), 260)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {diagnosticArtifactIds.length ? (
        <ArtifactIdLinks
          runId={item.run.id}
          artifactIds={diagnosticArtifactIds}
          title={proofArtifactIds.length ? "Proof artifacts" : "Diagnostic artifacts"}
          warning={
            proofArtifactIds.length
              ? undefined
              : "Captured artifacts are visible for review, but none passed proof QA yet."
          }
        />
      ) : null}
    </div>
  );
}

function PreparationSnapshot({ item }: { item: ActionProposalQueueItem }) {
  const session = item.preparationExecution?.preparedSession;
  const preparation = item.proposal.preparation;
  const diagnosticArtifactIds = uniqueStrings([
    ...(item.proposal.artifactIds ?? []),
    ...(item.preparationExecution?.artifactIds ?? []),
    ...(session?.artifactIds ?? []),
  ]);
  const proofArtifactIds = uniqueStrings([
    ...(session?.proofArtifactIds ?? []),
    ...(session?.actionDraft?.proofArtifactIds ?? []),
  ]);
  if (!session && !preparation && !item.preparationExecution) return null;

  return (
    <div className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Preparation
        </span>
        <GenericBadge
          tone={
            item.preparationExecution?.status === "failed"
              ? "danger"
              : session
                ? "ok"
                : "warn"
          }
        >
          {item.preparationExecution?.status ?? preparation?.stage ?? "not prepared"}
        </GenericBadge>
      </div>
      {item.preparationExecution?.contentPreview || item.preparationExecution?.reason ? (
        <p className="mt-1 text-app-text-muted">
          {truncate(item.preparationExecution.contentPreview ?? item.preparationExecution.reason ?? "", 260)}
        </p>
      ) : null}
      {session ? (
        <dl className="mt-2 grid gap-2 md:grid-cols-2">
          <CompactField label="Session">
            {`${session.toolName}${session.toolVersion ? `@${session.toolVersion}` : ""}`}
          </CompactField>
          <CompactField label="Replay steps">{String(session.replaySteps.length)}</CompactField>
          <CompactField label="Filled">
            {session.filledFields.length
              ? truncate(session.filledFields.map((field) => field.label ?? field.selector ?? "field").join(", "), 180)
              : "none"}
          </CompactField>
          <CompactField label="Commit boundary">
            {session.commitCandidates.length
              ? truncate(session.commitCandidates.map((candidate) => candidate.label ?? candidate.selector ?? candidate.reason).join("; "), 180)
              : "none detected"}
          </CompactField>
        </dl>
      ) : null}
      {preparation?.missingInputs.length ? (
        <p className="mt-2 text-app-warning">
          Missing: {truncate(preparation.missingInputs.join("; "), 220)}
        </p>
      ) : null}
      {diagnosticArtifactIds.length ? (
        <ArtifactIdLinks
          runId={item.run.id}
          artifactIds={diagnosticArtifactIds}
          title={proofArtifactIds.length ? "Proof artifacts" : "Diagnostic artifacts"}
          warning={
            proofArtifactIds.length
              ? undefined
              : "Captured artifacts are visible for review, but none passed proof QA yet."
          }
        />
      ) : null}
    </div>
  );
}

function ArtifactIdLinks({
  runId,
  artifactIds,
  title,
  warning,
}: {
  runId: string;
  artifactIds: string[];
  title: string;
  warning?: string;
}) {
  return (
    <div className="mt-2 rounded border border-app-border bg-app-bg p-2">
      <p className="font-semibold">{title}</p>
      {warning ? <p className="mt-1 text-app-warning">{warning}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {artifactIds.map((artifactId) => {
          const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
          return (
            <span key={artifactId} className="inline-flex items-center gap-2 rounded border border-app-border bg-app-surface px-2 py-1">
              <span className="max-w-[18rem] truncate font-mono text-[10px]">{artifactId}</span>
              <a className="text-app-accent underline" href={url} target="_blank" rel="noreferrer">Preview</a>
              <a className="text-app-accent underline" href={artifactDownloadUrl(url)}>Download</a>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function ExecutorBuildSnapshot({ item }: { item: NonNullable<ActionProposalQueueItem["executorBuild"]> }) {
  const tone =
    item.status === "failed"
      ? "danger"
      : item.status === "registered" || item.status === "attached"
        ? "ok"
        : "warn";
  return (
    <div className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Executor
        </span>
        <GenericBadge tone={tone}>{item.status}</GenericBadge>
      </div>
      <p className="mt-1 font-mono text-[10px] text-app-text-muted">
        {item.toolName}@{item.toolVersion}
      </p>
      <p className="mt-1 text-app-text-muted">{truncate(item.reason ?? item.request, 240)}</p>
    </div>
  );
}

function RunCommitControls({ item }: { item: ActionProposalQueueItem }) {
  const proposalCommit = useActionProposalCommit();
  const proposalExecutorBuild = useActionProposalExecutorBuild();
  const proposalPrepare = useActionProposalPrepare();
  const isFixture = isFixtureActionProposal(item);
  const [fixtureConfirmation, setFixtureConfirmation] = useState("");
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState<string>();
  const readiness = buildCommitReadiness(item);
  const ux = buildExternalActionUxState(item);
  const hasOperatorCommitInput = Boolean(fixtureConfirmation.trim() || jsonInput.trim());
  const canCommitWithOperatorInput =
    item.proposal.status === "approved" &&
    Boolean(item.proposal.commitExecutor?.ready) &&
    !readiness.missingReplayFields.length &&
    readiness.status === "blocked" &&
    readiness.missingFields.length > 0 &&
    hasOperatorCommitInput;
  const canBuild = readiness.canBuildExecutor;
  const primaryKind = ux.primaryAction.kind;
  const canPreparePrimary = primaryKind === "prepare" || primaryKind === "replay";
  const canBuildPrimary = primaryKind === "build_executor" && canBuild;
  const canCommitPrimary = primaryKind === "submit" || canCommitWithOperatorInput;

  const commit = () => {
    const parsed = parseOperatorCommitInput(jsonInput, fixtureConfirmation);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }
    setJsonError(undefined);
    proposalCommit.mutate({
      id: item.proposal.id,
      reason: fixtureConfirmation ? "Operator supplied fixture confirmation." : undefined,
      input: parsed.input,
    });
  };

  return (
    <div className="mt-3 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <p className="mb-2 rounded border border-app-border bg-app-bg px-2 py-1 text-app-text-muted">
        Current step: <span className="text-app-text">{ux.title}</span>. {ux.description}
      </p>
      {ux.primaryAction.effect ? (
        <p className="mb-2 rounded border border-app-border bg-app-bg px-2 py-1 text-app-text-muted">
          Next action effect: {ux.primaryAction.effect}
        </p>
      ) : null}
      {!readiness.canCommit && primaryKind === "none" ? (
        <p className="mb-2 rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-app-warning">
          External submit is not available yet. {ux.description}
        </p>
      ) : null}
      {isFixture ? (
        <details className="mb-2 rounded border border-app-border bg-app-bg p-2">
          <summary className="cursor-pointer text-[11px] text-app-text-muted">
            Fixture/manual test input
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
                Fixture confirmation
              </span>
              <input
                value={fixtureConfirmation}
                onChange={(event) => setFixtureConfirmation(event.target.value)}
                placeholder="manual-confirmed-1"
                className="rounded border border-app-border bg-app-bg px-2 py-1 font-mono text-[11px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
                Commit JSON input
              </span>
              <textarea
                value={jsonInput}
                onChange={(event) => setJsonInput(event.target.value)}
                placeholder='{"provider":"fixture"}'
                rows={2}
                className="resize-y rounded border border-app-border bg-app-bg px-2 py-1 font-mono text-[11px]"
              />
            </label>
          </div>
        </details>
      ) : null}
      {jsonError ? <p className="mt-1 text-app-danger">{jsonError}</p> : null}
      {proposalCommit.error ? (
        <p className="mt-1 text-app-danger">{proposalCommit.error.message}</p>
      ) : null}
      {proposalExecutorBuild.error ? (
        <p className="mt-1 text-app-danger">{proposalExecutorBuild.error.message}</p>
      ) : null}
      {proposalPrepare.error ? (
        <p className="mt-1 text-app-danger">{proposalPrepare.error.message}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {canPreparePrimary ? (
          <button
            type="button"
            onClick={() =>
              proposalPrepare.mutate({
                id: item.proposal.id,
                mode: primaryKind === "replay" ? "replay" : undefined,
              })
            }
            disabled={proposalPrepare.isPending}
            className="rounded-md bg-app-accent px-2.5 py-1 font-semibold text-app-bg disabled:opacity-50"
          >
            {proposalPrepare.isPending ? "Preparing…" : ux.primaryAction.label}
          </button>
        ) : null}
        {readiness.canReplay &&
        !readiness.canCommit &&
        primaryKind !== "replay" &&
        item.preparationExecution?.preparedSession ? (
          <button
            type="button"
            onClick={() => proposalPrepare.mutate({ id: item.proposal.id, mode: "replay" })}
            disabled={proposalPrepare.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 disabled:opacity-50"
          >
            Replay exact browser steps (advanced)
          </button>
        ) : null}
        {canBuildPrimary ? (
          <button
            type="button"
            onClick={() =>
              proposalExecutorBuild.mutate({
                id: item.proposal.id,
                mode: "create",
                authoringMode: "scaffold",
                activateOnSuccess: true,
              })
            }
            disabled={proposalExecutorBuild.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-2.5 py-1 disabled:opacity-50"
          >
            {proposalExecutorBuild.isPending ? "Building…" : ux.primaryAction.label}
          </button>
        ) : null}
        {canCommitPrimary ? (
          <button
            type="button"
            onClick={commit}
            disabled={proposalCommit.isPending}
            className="rounded-md bg-app-accent px-2.5 py-1 font-semibold text-app-bg disabled:opacity-50"
          >
            {proposalCommit.isPending
              ? "Submitting…"
              : canCommitWithOperatorInput
                ? "Submit externally with supplied input"
                : ux.primaryAction.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CompactField({ label, children }: { label: string; children: string }) {
  return (
    <div className="rounded border border-app-border bg-app-surface-2 p-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
        {label}
      </dt>
      <dd className="mt-1 break-words text-app-text">{children}</dd>
    </div>
  );
}

function parseOperatorCommitInput(
  jsonInput: string,
  fixtureConfirmation: string,
): { ok: true; input?: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = jsonInput.trim();
  let input: Record<string, unknown> = {};
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "JSON input must be an object." };
      }
      input = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid JSON input.",
      };
    }
  }
  const confirmation = fixtureConfirmation.trim();
  const merged = confirmation
    ? { ...input, fixtureConfirmation: confirmation }
    : input;
  return Object.keys(merged).length > 0 ? { ok: true, input: merged } : { ok: true };
}
