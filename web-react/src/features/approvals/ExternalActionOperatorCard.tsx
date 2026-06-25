import { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Hammer,
  RotateCcw,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  useActionProposalCommit,
  useActionProposalDecision,
  useActionProposalExecutorBuild,
  useActionProposalPrepare,
  useActionProposalProfileHydrationApproval,
  type ActionProposalQueueItem,
} from "@/api/runs";
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
import {
  buildApprovalSteps,
  externalWorldLabel,
  externalWorldTone,
  type StepState,
} from "@/features/approvals/externalActionOperatorState";
import { formatRelative, truncate } from "@/lib/format";

type OperatorCardProps = {
  item: ActionProposalQueueItem;
  showRunLink?: boolean;
};

export function ExternalActionOperatorCard({
  item,
  showRunLink = false,
}: OperatorCardProps) {
  const ux = buildExternalActionUxState(item);
  const readiness = buildCommitReadiness(item);
  const steps = buildApprovalSteps(item);

  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-4 text-xs">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-warning">
            External action
          </p>
          <h4 className="mt-1 text-base font-semibold">{item.proposal.title}</h4>
          <p className="mt-1 font-mono text-[10px] text-app-text-muted">
            {item.proposal.actionType.replace(/_/g, " ")} · {formatRelative(item.proposal.createdAt)}
            {item.decision?.decidedAt ? ` · approved ${formatRelative(item.decision.decidedAt)}` : ""}
          </p>
        </div>
        <GenericBadge tone={ux.tone}>{ux.statusLabel}</GenericBadge>
      </header>

      <ApprovalProgress steps={steps} />

      <div className="mt-4 rounded-md border border-app-accent/30 bg-app-bg p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-app-accent">{ux.title}</p>
            <p className="mt-1 text-app-text-muted">{ux.description}</p>
          </div>
          <GenericBadge tone={externalWorldTone(item)}>
            {externalWorldLabel(item)}
          </GenericBadge>
        </div>
        <SummaryGrid item={item} />
      </div>

      <OperatorGuidance item={item} />
      <MainActionDraft item={item} />
      <ProfileHydrationReview item={item} />
      <PrimaryControls item={item} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {showRunLink ? (
          <Link
            to={`/run/${encodeURIComponent(item.run.id)}`}
            className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open run
          </Link>
        ) : null}
        {item.proposal.status === "approved" && readiness.status !== "ready_to_commit" ? (
          <span className="text-[11px] text-app-text-muted">
            Nothing has been submitted. You can leave this proposal paused or continue with
            corrected details in the thread.
          </span>
        ) : null}
      </div>

      <details className="mt-3 rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
        <summary className="cursor-pointer text-app-text-muted">
          Advanced diagnostics: readiness, preparation, executor, raw proposal
        </summary>
        <div className="mt-2 grid gap-2">
          <ActionProposalReview item={item} />
          <CommitReadinessPanel item={item} />
          <PreparationSnapshot item={item} />
          {item.executorBuild ? <ExecutorBuildSnapshot item={item.executorBuild} /> : null}
        </div>
      </details>
    </section>
  );
}

function ApprovalProgress({
  steps,
}: {
  steps: ReturnType<typeof buildApprovalSteps>;
}) {
  return (
    <ol className="mt-4 grid gap-2 md:grid-cols-4">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={[
            "rounded-md border p-2",
            step.state === "done"
              ? "border-app-accent/30 bg-app-accent-soft/50"
              : step.state === "active"
                ? "border-app-warning/40 bg-app-warning-soft"
                : step.state === "blocked"
                  ? "border-app-danger/40 bg-app-danger-soft"
                  : "border-app-border bg-app-surface",
          ].join(" ")}
        >
          <div className="flex items-center gap-2">
            <StepIcon state={step.state} />
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
              {index + 1}
            </span>
            <span className="font-semibold">{step.label}</span>
          </div>
          <p className="mt-1 text-[11px] text-app-text-muted">{step.detail}</p>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-app-accent" />;
  if (state === "blocked") return <AlertTriangle className="h-3.5 w-3.5 text-app-danger" />;
  if (state === "active") return <ClipboardCheck className="h-3.5 w-3.5 text-app-warning" />;
  return <span className="h-3.5 w-3.5 rounded-full border border-app-border" />;
}

function SummaryGrid({ item }: { item: ActionProposalQueueItem }) {
  const ux = buildExternalActionUxState(item);
  const summary = ux.summary;
  return (
    <dl className="mt-3 grid gap-2 md:grid-cols-2">
      <CompactField label="Where">{summary.target}</CompactField>
      <CompactField label="Action">{summary.action}</CompactField>
      <CompactField label="Provider page">{summary.url}</CompactField>
      <CompactField label="Data to use">{summary.data}</CompactField>
    </dl>
  );
}

function OperatorGuidance({ item }: { item: ActionProposalQueueItem }) {
  const ux = buildExternalActionUxState(item);
  const readiness = buildCommitReadiness(item);
  const missing = ux.summary.missing;
  const actionLabel = ux.primaryAction.kind === "none" ? "No safe primary action" : ux.primaryAction.label;

  return (
    <div className="mt-3 rounded-md border border-app-border bg-app-surface p-3 text-[11px]">
      <p className="font-semibold">What you are deciding now</p>
      <p className="mt-1 text-app-text-muted">
        {ux.primaryAction.effect ||
          "There is no safe automatic next step. Use the run thread to provide corrected details or choose another target."}
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <CompactField label="Current button">{actionLabel}</CompactField>
        <CompactField label="External state">{externalWorldLabel(item)}</CompactField>
        <CompactField label="Run status">{item.run.status.replace(/_/g, " ")}</CompactField>
      </div>
      {missing.length ? (
        <p className="mt-2 rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-app-warning">
          Missing or unresolved before final submit: {truncate(missing.join("; "), 320)}
        </p>
      ) : null}
      {readiness.reason && readiness.status !== "ready_to_commit" ? (
        <p className="mt-2 text-app-text-muted">
          Current blocker: {truncate(humanSubmitBlockReason(readiness.reason), 360)}
        </p>
      ) : null}
      {item.proposal.status === "proposed" ? (
        <p className="mt-2 text-app-text-muted">
          Need changes? Reject this proposal or reply in the run thread with corrected
          details. Approval only prepares proof and still stops before submit.
        </p>
      ) : null}
    </div>
  );
}

function PrimaryControls({ item }: { item: ActionProposalQueueItem }) {
  if (item.proposal.status === "proposed") {
    return <DecisionControls item={item} />;
  }
  if (item.proposal.status === "approved") {
    return (
      <>
        <CommitControls item={item} />
        <CancelApprovedAction item={item} />
      </>
    );
  }
  return null;
}

function DecisionControls({ item }: { item: ActionProposalQueueItem }) {
  const proposalDecision = useActionProposalDecision();
  const [decisionReason, setDecisionReason] = useState("");
  const ux = buildExternalActionUxState(item);
  const canApprove = ux.primaryAction.kind === "approve_proposal";

  return (
    <div className="mt-3 rounded-md border border-app-border bg-app-surface p-3 text-[11px]">
      <label className="block text-app-text-muted">
        Optional note
        <textarea
          value={decisionReason}
          onChange={(event) => setDecisionReason(event.target.value)}
          placeholder="Example: target and data look correct; prepare proof only, do not submit"
          className="mt-1 min-h-14 w-full resize-y rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-app-text outline-none focus:border-app-accent/60"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        {canApprove ? (
          <button
            type="button"
            onClick={() =>
              proposalDecision.mutate({
                id: item.proposal.id,
                decision: "approve",
                reason: decisionReason.trim() || undefined,
              })
            }
            disabled={proposalDecision.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {proposalDecision.isPending ? "Approving…" : ux.primaryAction.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            proposalDecision.mutate({
              id: item.proposal.id,
              decision: "reject",
              reason: decisionReason.trim() || undefined,
            })
          }
          disabled={proposalDecision.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-app-danger/40 bg-app-danger-soft px-3 py-1.5 text-app-danger disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" />
          Reject proposal
        </button>
      </div>
      {proposalDecision.error ? (
        <p className="mt-2 text-app-danger">{proposalDecision.error.message}</p>
      ) : null}
    </div>
  );
}

function CancelApprovedAction({ item }: { item: ActionProposalQueueItem }) {
  const proposalDecision = useActionProposalDecision();
  const [reason, setReason] = useState("");
  if (item.execution?.status === "committed") return null;

  return (
    <div className="mt-3 rounded-md border border-app-danger/30 bg-app-danger-soft/40 p-3 text-[11px]">
      <p className="font-semibold text-app-danger">Stop this external action</p>
      <p className="mt-1 text-app-text-muted">
        Use this when the target, data, or proof is wrong. It closes the paused action
        without submitting anything to the external provider.
      </p>
      <label className="mt-2 block text-app-text-muted">
        Cancellation note
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Example: wrong provider or wrong data; I will restart with corrected details"
          className="mt-1 min-h-14 w-full resize-y rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-app-text outline-none focus:border-app-danger/50"
        />
      </label>
      <button
        type="button"
        onClick={() =>
          proposalDecision.mutate({
            id: item.proposal.id,
            decision: "reject",
            reason: reason.trim() || "Cancelled by operator before external submit.",
          })
        }
        disabled={proposalDecision.isPending}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-app-danger/40 bg-app-danger-soft px-3 py-1.5 font-semibold text-app-danger disabled:opacity-50"
      >
        <XCircle className="h-3.5 w-3.5" />
        {proposalDecision.isPending ? "Stopping…" : "Cancel without submitting"}
      </button>
      {proposalDecision.error ? (
        <p className="mt-2 text-app-danger">{proposalDecision.error.message}</p>
      ) : null}
    </div>
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
          <p className="font-semibold text-app-warning">Approve saved data for this form</p>
          <p className="mt-1 text-app-text-muted">
            This allows only the shown profile values, reruns preparation, captures proof,
            and still stops before final submit.
          </p>
        </div>
        <GenericBadge tone="warn">data approval</GenericBadge>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        {candidates.map((field) => (
          <CompactField key={field.fields.join("|")} label={field.label}>
            {`${field.valuePreview} · ${field.source}`}
          </CompactField>
        ))}
      </dl>
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
        className="mt-3 inline-flex items-center gap-1 rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {approval.isPending ? "Preparing…" : ux.primaryAction.label}
      </button>
      {approval.error ? <p className="mt-2 text-app-danger">{approval.error.message}</p> : null}
    </div>
  );
}

function MainActionDraft({ item }: { item: ActionProposalQueueItem }) {
  const session = item.preparationExecution?.preparedSession;
  const draft = session?.actionDraft;
  const warnings = session?.warnings ?? [];
  const requiredInputs = session?.requiredOperatorInputs ?? draft?.requiredOperatorInputs ?? [];
  if (!draft && !session) return null;

  const visibleBlockers = humanActionDraftBlockers(draft?.missingBeforeCommit ?? []);
  const diagnosticArtifactIds = uniqueStrings([
    ...(item.preparationExecution?.artifactIds ?? []),
    ...(session?.artifactIds ?? []),
  ]);
  const proofArtifactIds = uniqueStrings([
    ...(session?.proofArtifactIds ?? []),
    ...(draft?.proofArtifactIds ?? []),
  ]);
  const dataPreview = draft?.dataPreview ?? [];

  return (
    <div className="mt-3 rounded-md border border-app-accent/30 bg-app-bg p-3 text-[11px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-app-accent">Prepared draft, not submitted</p>
          <p className="mt-1 text-app-text-muted">
            {visibleBlockers.length
              ? `Resolve before final submit: ${truncate(visibleBlockers.join(", "), 260)}.`
              : draft
                ? truncate(draft.operatorNextStep, 280)
                : "Preparation has not produced a form draft yet."}
          </p>
        </div>
        <GenericBadge tone={visibleBlockers.length ? "warn" : "ok"}>
          {draft?.status?.replace(/_/g, " ") ?? item.preparationExecution?.status ?? "not prepared"}
        </GenericBadge>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        <CompactField label="Will do">
          {draft ? truncate(draft.action, 240) : "Prepare provider page before submit"}
        </CompactField>
        <CompactField label="Provider page">
          {draft?.pageUrl ?? session?.currentUrl
            ? truncate(draft?.pageUrl ?? session?.currentUrl ?? "", 240)
            : "No prepared page yet"}
        </CompactField>
        <CompactField label="Filled / draft data">
          {dataPreview.length
            ? truncate(
                dataPreview.map((field) => `${field.label} = ${field.value}`).join("; "),
                380,
              )
            : "No form data prepared yet"}
        </CompactField>
        <CompactField label="Before final submit">
          {visibleBlockers.length
            ? truncate(visibleBlockers.join(", "), 240)
            : "Ready for operator review"}
        </CompactField>
      </dl>
      {requiredInputs.length ? (
        <div className="mt-3 rounded border border-app-warning/40 bg-app-warning-soft p-2 text-app-warning">
          <p className="font-semibold">Needed from operator</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {requiredInputs.slice(0, 5).map((input) => (
              <li key={input.id}>
                {input.label}{" "}
                <span className="text-app-text-muted">
                  ({input.kind.replace(/_/g, " ")}, {input.resumable ? "resumable" : "manual boundary"})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
              : "Visible for diagnostics only. No artifact passed proof QA yet."
          }
        />
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
  const canBuildPrimary = primaryKind === "build_executor" && readiness.canBuildExecutor;
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
    <div className="mt-3 rounded-md border border-app-border bg-app-surface p-3 text-[11px]">
      <p className="font-semibold">Available next action</p>
      <p className="mt-1 text-app-text-muted">
        {ux.primaryAction.effect ||
          "No safe automated next action is available from the current proposal state."}
      </p>
      {!readiness.canCommit && primaryKind === "none" ? (
        <p className="mt-2 rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-app-warning">
          External submit is not available yet. {ux.description}
        </p>
      ) : null}
      {isFixture ? (
        <details className="mt-2 rounded border border-app-border bg-app-bg p-2">
          <summary className="cursor-pointer text-app-text-muted">
            Fixture/manual test input
          </summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
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
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
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
      <div className="mt-3 flex flex-wrap gap-2">
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
            className="inline-flex items-center gap-1 rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
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
            className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Advanced replay
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
            className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 disabled:opacity-50"
          >
            <Hammer className="h-3.5 w-3.5" />
            {proposalExecutorBuild.isPending ? "Attaching…" : ux.primaryAction.label}
          </button>
        ) : null}
        {canCommitPrimary ? (
          <button
            type="button"
            onClick={commit}
            disabled={proposalCommit.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-app-accent px-3 py-1.5 font-semibold text-app-bg disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            {proposalCommit.isPending
              ? "Submitting…"
              : canCommitWithOperatorInput
                ? "Submit with supplied input"
                : ux.primaryAction.label}
          </button>
        ) : null}
      </div>
      {jsonError ? <p className="mt-2 text-app-danger">{jsonError}</p> : null}
      {proposalCommit.error ? <p className="mt-2 text-app-danger">{proposalCommit.error.message}</p> : null}
      {proposalExecutorBuild.error ? (
        <p className="mt-2 text-app-danger">{proposalExecutorBuild.error.message}</p>
      ) : null}
      {proposalPrepare.error ? <p className="mt-2 text-app-danger">{proposalPrepare.error.message}</p> : null}
    </div>
  );
}

function PreparationSnapshot({ item }: { item: ActionProposalQueueItem }) {
  const session = item.preparationExecution?.preparedSession;
  const preparation = item.proposal.preparation;
  if (!session && !preparation && !item.preparationExecution) return null;

  return (
    <div className="rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Preparation snapshot
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
          {truncate(item.preparationExecution.contentPreview ?? item.preparationExecution.reason ?? "", 320)}
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
              ? truncate(session.filledFields.map((field) => field.label ?? field.selector ?? "field").join(", "), 220)
              : "none"}
          </CompactField>
          <CompactField label="Commit boundary">
            {session.commitCandidates.length
              ? truncate(session.commitCandidates.map((candidate) => candidate.label ?? candidate.selector ?? candidate.reason).join("; "), 220)
              : "none detected"}
          </CompactField>
        </dl>
      ) : null}
    </div>
  );
}

function ExecutorBuildSnapshot({
  item,
}: {
  item: NonNullable<ActionProposalQueueItem["executorBuild"]>;
}) {
  const tone =
    item.status === "failed"
      ? "danger"
      : item.status === "registered" || item.status === "attached"
        ? "ok"
        : "warn";
  return (
    <div className="rounded-md border border-app-border bg-app-surface p-2 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
          Executor
        </span>
        <GenericBadge tone={tone}>{item.status}</GenericBadge>
      </div>
      <p className="mt-1 font-mono text-[10px] text-app-text-muted">
        {item.toolName}@{item.toolVersion}
      </p>
      <p className="mt-1 text-app-text-muted">{truncate(item.reason ?? item.request, 300)}</p>
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
    <div className="mt-3 rounded border border-app-border bg-app-surface p-2">
      <p className="font-semibold">{title}</p>
      {warning ? <p className="mt-1 text-app-warning">{warning}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {artifactIds.map((artifactId) => {
          const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
          return (
            <span
              key={artifactId}
              className="inline-flex items-center gap-2 rounded border border-app-border bg-app-bg px-2 py-1"
            >
              <span className="max-w-[18rem] truncate font-mono text-[10px]">{artifactId}</span>
              <a className="text-app-accent underline" href={url} target="_blank" rel="noreferrer">
                Preview
              </a>
              <a className="text-app-accent underline" href={artifactDownloadUrl(url)}>
                Download
              </a>
            </span>
          );
        })}
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
  const merged = confirmation ? { ...input, fixtureConfirmation: confirmation } : input;
  return Object.keys(merged).length > 0 ? { ok: true, input: merged } : { ok: true };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
