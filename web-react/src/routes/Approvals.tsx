import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useActionProposalCommit,
  useActionProposalDecision,
  useActionProposalExecutorBuild,
  useActionProposalPrepare,
  useActionProposalProfileHydrationApproval,
  useActionProposals,
  useCreateFixtureActionProposal,
} from "@/api/runs";
import type { ActionProposalQueueItem } from "@/api/runs";
import type { ExternalActionPreparedSession } from "@/api/types";
import { useToolServiceAction, useToolServices } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { ActionProposalReview } from "@/features/approvals/ActionProposalReview";
import {
  isFixtureActionProposal,
  profileHydrationApprovalCandidates,
} from "@/features/approvals/actionProposalPresentation";
import { CommitReadinessPanel } from "@/features/approvals/CommitReadinessPanel";
import { buildCommitReadiness } from "@/features/approvals/commitReadiness";
import { buildExternalActionUxState } from "@/features/approvals/externalActionUxState";
import { formatRelative, truncate } from "@/lib/format";

export function ApprovalsPage() {
  const services = useToolServices();
  const action = useToolServiceAction();
  const proposals = useActionProposals();
  const proposalDecision = useActionProposalDecision();
  const createFixture = useCreateFixtureActionProposal();

  const pending = (services.data ?? []).filter((service) => service.pendingRestartApproval);
  const actionProposals = proposals.data ?? [];
  const pendingActions = actionProposals.filter(
    (item) => item.proposal.status === "proposed" && item.proposal.approvalRequired,
  );
  const approvedActions = actionProposals
    .filter((item) => item.proposal.status === "approved")
    .slice(0, 8);
  const decidedActions = actionProposals
    .filter((item) => item.proposal.status !== "proposed" && item.proposal.status !== "approved")
    .slice(0, 8);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Approvals</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Operator decisions waiting on human confirmation. External actions are prepared
              as proposals first; approval prepares proof, and final external submit remains
              an explicit separate action unless automode has enough proof and policy clearance.
            </p>
          </div>
          <button
            type="button"
            onClick={() => createFixture.mutate()}
            disabled={createFixture.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            {createFixture.isPending ? "Creating fixture…" : "Create fixture proposal"}
          </button>
        </div>
        {createFixture.error ? (
          <p className="mt-2 text-xs text-app-danger">{createFixture.error.message}</p>
        ) : null}
      </header>
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Pending action proposals</h3>
        {pendingActions.length === 0 ? (
          <p className="mt-2 text-xs text-app-text-muted">
            Nothing waiting. Booking, purchase, outbound message, and API-write proposals
            appear here after a run prepares them.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {pendingActions.map((item) => {
              const ux = buildExternalActionUxState(item);
              return (
              <li
                key={item.proposal.id}
                className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs"
              >
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <strong className="block text-sm">{item.proposal.title}</strong>
                    <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                      {item.proposal.actionType.replace(/_/g, " ")} · {formatRelative(item.proposal.createdAt)}
                    </p>
                  </div>
                  <GenericBadge tone="warn">awaits decision</GenericBadge>
                </header>
                <ActionDecisionSummary item={item} />
                <details className="mt-3 rounded-md border border-app-border bg-app-surface p-2">
                  <summary className="cursor-pointer text-[11px] text-app-text-muted">
                    Advanced details: proposal, preparation, readiness
                  </summary>
                  <ActionProposalReview item={item} />
                  <PreparationSummary item={item} />
                  <CommitReadinessPanel item={item} />
                </details>
                {item.proposal.prohibitedWithoutApproval.length ? (
                  <p className="mt-2 text-[11px] text-app-warning">
                    Blocked without approval: {truncate(item.proposal.prohibitedWithoutApproval.join("; "), 260)}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
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
                    Reject
                  </button>
                  <Link
                    to={`/run/${encodeURIComponent(item.run.id)}`}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
                  >
                    Open run
                  </Link>
                  {ux.primaryAction.effect ? (
                    <span className="basis-full text-[11px] text-app-text-muted">
                      {ux.primaryAction.effect}
                    </span>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </article>
      {approvedActions.length ? (
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Approved action proposals</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            These are allowed by the operator but still need a commit executor before the
            platform can change an external system.
          </p>
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {approvedActions.map((item) => (
              <li
                key={item.proposal.id}
                className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs"
              >
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <strong className="block text-sm">{item.proposal.title}</strong>
                    <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                      {item.proposal.actionType.replace(/_/g, " ")} · approved {formatRelative(item.decision?.decidedAt)}
                    </p>
                  </div>
                  <GenericBadge tone={item.execution?.status === "blocked" ? "warn" : "ok"}>
                    {item.execution?.status === "blocked" ? "commit blocked" : "approved"}
                  </GenericBadge>
                </header>
                <ActionDecisionSummary item={item} />
                {item.execution?.toolName ? (
                  <p className="mt-2 font-mono text-[10px] text-app-text-muted">
                    Last commit tool: {item.execution.toolName}
                    {item.execution.toolVersion ? `@${item.execution.toolVersion}` : ""}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link
                    to={`/run/${encodeURIComponent(item.run.id)}`}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
                  >
                    Open run
                  </Link>
                </div>
                <CommitControls item={item} />
                <details className="mt-3 rounded-md border border-app-border bg-app-surface p-2">
                  <summary className="cursor-pointer text-[11px] text-app-text-muted">
                    Advanced details: proposal, preparation, readiness, executor
                  </summary>
                  <ActionProposalReview item={item} />
                  <PreparationSummary item={item} />
                  <CommitReadinessPanel item={item} />
                  {item.executorBuild ? (
                    <ExecutorBuildSummary item={item.executorBuild} />
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Pending service restarts</h3>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-app-text-muted">
            Nothing waiting. A service appears here when it failed a heartbeat under a
            restart policy that requires approval.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {pending.map((service) => (
              <li
                key={service.toolName}
                className="rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-xs"
              >
                <header className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm">{service.displayName ?? service.toolName}</strong>
                  <GenericBadge tone="warn">awaits approval</GenericBadge>
                </header>
                <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                  {service.toolName} · last failure {formatRelative(service.lastFailureAt)}
                </p>
                <p className="mt-1 text-[11px]">
                  {truncate(service.lastRestartReason ?? service.detail ?? "", 220)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => action.mutate({ name: service.toolName, action: "restart" })}
                    disabled={action.isPending}
                    className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                  >
                    {action.isPending ? "Approving…" : "Approve restart"}
                  </button>
                  <button
                    type="button"
                    onClick={() => action.mutate({ name: service.toolName, action: "stop" })}
                    disabled={action.isPending}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
                  >
                    Reject (stop)
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>
      {decidedActions.length ? (
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Recent action decisions</h3>
          <ul className="mt-3 grid gap-2">
            {decidedActions.map((item) => (
              <li
                key={item.proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-app-border bg-app-surface-2 p-2 text-xs"
              >
                <div>
                  <strong>{item.proposal.title}</strong>
                  <p className="mt-0.5 text-[11px] text-app-text-muted">
                    {item.execution?.contentPreview ??
                      item.execution?.reason ??
                      item.decision?.reason ??
                      "Decision recorded."}
                  </p>
                </div>
                <GenericBadge tone={item.proposal.status === "committed" ? "ok" : item.proposal.status === "approved" ? "ok" : "danger"}>
                  {item.proposal.status}
                </GenericBadge>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function ActionDecisionSummary({ item }: { item: ActionProposalQueueItem }) {
  const ux = buildExternalActionUxState(item);
  const summary = ux.summary;
  return (
    <div className="mt-3 rounded-md border border-app-accent/30 bg-app-bg p-3 text-[11px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-app-accent">{ux.title}</p>
          <p className="mt-1 text-app-text-muted">{ux.description}</p>
        </div>
        <GenericBadge tone={ux.tone}>{ux.statusLabel}</GenericBadge>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        <CompactField label="Target">{summary.target}</CompactField>
        <CompactField label="Action">{summary.action}</CompactField>
        <CompactField label="Page">{summary.url}</CompactField>
        <CompactField label="Data">{summary.data}</CompactField>
      </dl>
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

function PreparationSummary({ item }: { item: ActionProposalQueueItem }) {
  const { proposal, preparationExecution } = item;
  const preparation = proposal.preparation;
  const session = preparationExecution?.preparedSession;
  if (!preparation && !preparationExecution) return null;
  return (
    <div className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Prepare boundary
        </span>
        <GenericBadge
          tone={
            preparationExecution?.status === "failed"
              ? "danger"
              : preparationExecution?.status === "completed" ||
                  preparation?.stage === "ready_to_commit"
                ? "ok"
                : "warn"
          }
        >
          {preparationExecution?.status ??
            preparation?.stage.replace(/_/g, " ") ??
            "not prepared"}
        </GenericBadge>
      </div>
      {preparationExecution?.contentPreview || preparationExecution?.reason ? (
        <p className="mt-1 text-app-text-muted">
          {truncate(preparationExecution.contentPreview ?? preparationExecution.reason ?? "", 260)}
        </p>
      ) : null}
      {preparationExecution?.artifactIds?.length ? (
        <p className="mt-1 font-mono text-[10px] text-app-text-muted">
          Artifacts: {preparationExecution.artifactIds.join(", ")}
        </p>
      ) : null}
      {session ? (
        <div className="mt-2 rounded border border-app-border bg-app-surface-2 p-2">
          <p className="font-mono text-[10px] text-app-text-muted">
            Prepared session · {session.toolName}
            {session.toolVersion ? `@${session.toolVersion}` : ""} · replay{" "}
            {session.replaySteps.length} step(s)
          </p>
          {session.currentUrl ? (
            <p className="mt-1 break-all text-app-text-muted">
              URL: {truncate(session.currentUrl, 180)}
            </p>
          ) : null}
          {session.pageTitle ? (
            <p className="mt-1 text-app-text-muted">
              Page: {truncate(session.pageTitle, 160)}
            </p>
          ) : null}
          {session.filledFields.length ? (
            <p className="mt-1 text-app-text-muted">
              Filled: {truncate(session.filledFields.map((field) => field.label ?? field.selector ?? "field").join(", "), 180)}
            </p>
          ) : null}
          {session.formFields?.length ? (
            <p className="mt-1 text-app-text-muted">
              Form fields: {truncate(session.formFields.map((field) => field.label ?? field.name ?? field.placeholder ?? "field").join(", "), 220)}
            </p>
          ) : null}
          {session.formFieldGaps?.length ? (
            <p className="mt-1 text-app-warning">
              Required gaps: {truncate(session.formFieldGaps.map(formatFormGap).join("; "), 260)}
            </p>
          ) : null}
          <ProfileHydrationControls item={item} session={session} />
          {session.availableProfileFields?.length ? (
            <p className="mt-1 text-app-text-muted">
              Profile available: {truncate(session.availableProfileFields.map((field) => `${field.field} (${field.source})`).join(", "), 220)}
            </p>
          ) : null}
          {item.profileHydration?.fields.length ? (
            <p className="mt-1 text-app-text-muted">
              Approved profile values: {truncate(item.profileHydration.fields.map((field) => `${field.label ?? field.field} (${field.valuePreview})`).join(", "), 220)}
            </p>
          ) : null}
          {session.commitCandidates.length ? (
            <p className="mt-1 text-app-warning">
              Commit boundary: {truncate(session.commitCandidates.map((candidate) => candidate.label ?? candidate.selector ?? candidate.reason).join("; "), 220)}
            </p>
          ) : null}
          {session.textPreview ? (
            <p className="mt-1 text-app-text-muted">{truncate(session.textPreview, 260)}</p>
          ) : null}
        </div>
      ) : null}
      {preparation?.commitBoundary ? (
        <p className="mt-1 text-app-text-muted">{truncate(preparation.commitBoundary, 260)}</p>
      ) : null}
      {preparation?.missingInputs.length ? (
        <p className="mt-1 text-app-warning">
          Missing: {truncate(preparation.missingInputs.join("; "), 180)}
        </p>
      ) : null}
      {preparation?.operatorChecklist.length ? (
        <p className="mt-1 text-app-text-muted">
          Checklist: {truncate(preparation.operatorChecklist.join(" "), 260)}
        </p>
      ) : null}
    </div>
  );
}

function ProfileHydrationControls({
  item,
  session,
}: {
  item: ActionProposalQueueItem;
  session: ExternalActionPreparedSession;
}) {
  const approval = useActionProposalProfileHydrationApproval();
  const candidates = profileHydrationApprovalCandidates(item);
  const hasProfileGaps = session.formFieldGaps?.some(
    (gap) => gap.profileAvailable && gap.field,
  );
  if (!hasProfileGaps) return null;
  if (!candidates.length) {
    return (
      <p className="mt-1 text-app-text-muted">
        Profile hydration approved. Preparation replay is handled by the platform.
      </p>
    );
  }
  return (
    <div className="mt-2 rounded border border-app-warning/40 bg-app-warning-soft p-2">
      <p className="text-[11px] text-app-warning">
        Allow these profile values to be inserted into the form. This prepares proof
        again and still stops before the real external submit:{" "}
        {truncate(
          candidates
            .map((gap) => `${gap.label}: ${gap.valuePreview}`)
            .join(", "),
          220,
        )}
      </p>
      <button
        type="button"
        onClick={() =>
          approval.mutate({
            id: item.proposal.id,
            fields: candidates.flatMap((candidate) => candidate.fields),
            reason: "Operator approved profile values and replay preparation.",
          })
        }
        disabled={approval.isPending}
        className="mt-2 rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
      >
        {approval.isPending
          ? "Filling and preparing proof…"
          : "Allow form fill and prepare proof"}
      </button>
      {approval.error ? (
        <p className="mt-1 text-app-danger">{approval.error.message}</p>
      ) : null}
    </div>
  );
}

function formatFormGap(
  gap: NonNullable<ExternalActionPreparedSession["formFieldGaps"]>[number],
): string {
  const label = gap.label ?? gap.name ?? gap.field ?? "field";
  if (gap.profileAvailable) {
    return `${label}: available from ${gap.profileSource ?? "profile"}, needs approval`;
  }
  return `${label}: missing`;
}

function ExecutorBuildSummary({ item }: { item: NonNullable<ActionProposalQueueItem["executorBuild"]> }) {
  const tone = item.status === "failed" ? "danger" : item.status === "registered" || item.status === "attached" ? "ok" : "warn";
  return (
    <div className="mt-2 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Executor build
        </span>
        <GenericBadge tone={tone}>{item.status}</GenericBadge>
      </div>
      <p className="mt-1 font-mono text-[10px] text-app-text-muted">
        {item.toolName}@{item.toolVersion}
      </p>
      <p className="mt-1 text-app-text-muted">{truncate(item.reason ?? item.request, 220)}</p>
      {item.runId ? (
        <Link
          to={`/run/${encodeURIComponent(item.runId)}`}
          className="mt-2 inline-flex rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-[11px]"
        >
          Open build run
        </Link>
      ) : null}
    </div>
  );
}

function CommitControls({ item }: { item: ActionProposalQueueItem }) {
  const proposalCommit = useActionProposalCommit();
  const proposalExecutorBuild = useActionProposalExecutorBuild();
  const proposalPrepare = useActionProposalPrepare();
  const isFixture = isFixtureActionProposal(item);
  const [fixtureConfirmation, setFixtureConfirmation] = useState("");
  const [jsonInput, setJsonInput] = useState("");
  const [jsonError, setJsonError] = useState<string>();
  const readiness = buildCommitReadiness(item);
  const ux = buildExternalActionUxState(item);
  const canBuild = readiness.canBuildExecutor;
  const hasOperatorCommitInput = Boolean(fixtureConfirmation.trim() || jsonInput.trim());
  const canCommitWithOperatorInput =
    item.proposal.status === "approved" &&
    Boolean(item.proposal.commitExecutor?.ready) &&
    !readiness.missingReplayFields.length &&
    readiness.status === "blocked" &&
    readiness.missingFields.length > 0 &&
    hasOperatorCommitInput;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Final external submit
        </span>
        <GenericBadge tone={readiness.tone}>{readiness.label}</GenericBadge>
      </div>
      <p className="mt-1 text-app-text-muted">
        {truncate(ux.description, 300)}
      </p>
      {ux.primaryAction.effect ? (
        <p className="mt-2 rounded border border-app-border bg-app-bg px-2 py-1 text-app-text-muted">
          Next action effect: {ux.primaryAction.effect}
        </p>
      ) : null}
      {!readiness.canCommit && primaryKind === "none" ? (
        <p className="mt-2 rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-app-warning">
          External submit is not available yet. {ux.description}
        </p>
      ) : null}
      {isFixture ? (
        <details className="mt-2 rounded border border-app-border bg-app-bg p-2">
          <summary className="cursor-pointer text-[11px] text-app-text-muted">
            Fixture/manual test input
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
                Fixture confirmation
              </span>
              <input
                value={fixtureConfirmation}
                onChange={(event) => setFixtureConfirmation(event.target.value)}
                placeholder="fixture-confirmed-1"
                className="rounded border border-app-border bg-app-bg px-2 py-1 font-mono text-[11px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
                JSON input
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
