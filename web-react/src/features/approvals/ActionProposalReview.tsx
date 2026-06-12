import type { ActionProposalQueueItem } from "@/api/runs";
import { GenericBadge } from "@/components/StatusBadge";
import { truncate } from "@/lib/format";
import {
  actionVerb,
  approvalSummary,
  collectedInputLabel,
  proposalUrl,
} from "./actionProposalPresentation";

export function ActionProposalReview({ item }: { item: ActionProposalQueueItem }) {
  const preparation = item.proposal.preparation;
  const session = item.preparationExecution?.preparedSession;
  const url = proposalUrl(item);
  const collectedInputs = preparation?.collectedInputs ?? [];
  const missingInputs = preparation?.missingInputs ?? [];
  const filledFields = session?.filledFields ?? [];
  const formFields = session?.formFields ?? [];
  const draft = session?.actionDraft;

  return (
    <div className="mt-3 rounded-md border border-app-accent/30 bg-app-bg p-3 text-[11px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-app-accent">What approval means</p>
          <p className="mt-1 text-app-text-muted">
            You approve the plan and allow safe preparation. This does not submit a
            booking, payment, message, or form.
          </p>
        </div>
        <GenericBadge tone={missingInputs.length ? "warn" : "ok"}>
          {missingInputs.length ? "needs details" : "ready to prepare"}
        </GenericBadge>
      </div>

      <dl className="mt-3 grid gap-2 md:grid-cols-2">
        <ReviewField label="Selected target">
          {item.proposal.target ?? "Not selected"}
        </ReviewField>
        <ReviewField label="External page">
          {url ?? "No URL captured"}
        </ReviewField>
        <ReviewField label="Action">
          {actionVerb(item)}
        </ReviewField>
        <ReviewField label="Current summary">
          {approvalSummary(item)}
        </ReviewField>
      </dl>

      {collectedInputs.length ? (
        <div className="mt-3">
          <p className="font-semibold">Data the platform currently has</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {collectedInputs.map((input, index) => (
              <ReviewField key={`${input.label}-${index}`} label={collectedInputLabel(input.label)}>
                {input.value}
              </ReviewField>
            ))}
          </div>
        </div>
      ) : null}

      {missingInputs.length ? (
        <p className="mt-3 rounded border border-app-warning/40 bg-app-warning-soft px-2 py-1 text-app-warning">
          Missing before final submit: {missingInputs.join(", ")}
        </p>
      ) : null}

      {preparation?.proofPlan.length ? (
        <div className="mt-3 rounded border border-app-border bg-app-surface p-2">
          <p className="font-semibold">Expected proof</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-app-text-muted">
            {preparation.proofPlan.map((proof, index) => (
              <li key={`${proof}-${index}`}>{proof}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {session ? (
        <div className="mt-3 rounded border border-app-border bg-app-surface p-2">
          <p className="font-semibold">Prepared browser state</p>
          {draft ? (
            <div className="mt-2 rounded border border-app-accent/30 bg-app-bg p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-app-accent">Prepared action draft</p>
                <GenericBadge tone={draft.status === "ready_for_operator_review" ? "ok" : "warn"}>
                  {draft.status.replace(/_/g, " ")}
                </GenericBadge>
              </div>
              <p className="mt-1 text-app-text-muted">
                {truncate(draft.operatorNextStep, 280)}
              </p>
              {draft.dataPreview.length ? (
                <p className="mt-2 text-app-text-muted">
                  Draft data:{" "}
                  {truncate(
                    draft.dataPreview
                      .map((field) => `${field.label} = ${field.value}`)
                      .join("; "),
                    360,
                  )}
                </p>
              ) : null}
              {draft.missingBeforeCommit.length ? (
                <p className="mt-2 text-app-warning">
                  Still missing: {truncate(draft.missingBeforeCommit.join(", "), 260)}
                </p>
              ) : null}
              <p className="mt-2 text-app-text-muted">
                After submit report must include:{" "}
                {truncate(draft.postCommitReportRequirements.join("; "), 360)}
              </p>
            </div>
          ) : null}
          {session.currentUrl ? (
            <p className="mt-1 break-all text-app-text-muted">
              Page opened: {truncate(session.currentUrl, 220)}
            </p>
          ) : null}
          {filledFields.length ? (
            <p className="mt-1 text-app-text-muted">
              Filled fields:{" "}
              {truncate(
                filledFields
                  .map((field) => `${field.label ?? field.selector ?? "field"} = ${field.valuePreview}`)
                  .join("; "),
                320,
              )}
            </p>
          ) : (
            <p className="mt-1 text-app-text-muted">
              No form fields have been filled yet. Use preparation before final submit.
            </p>
          )}
          {formFields.length ? (
            <p className="mt-1 text-app-text-muted">
              Detected form fields:{" "}
              {truncate(
                formFields
                  .map((field) => field.label ?? field.name ?? field.placeholder ?? "field")
                  .join(", "),
                260,
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {preparation?.commitBoundary ? (
        <p className="mt-3 rounded border border-app-border bg-app-surface px-2 py-1 text-app-text-muted">
          Boundary: {truncate(preparation.commitBoundary, 300)}
        </p>
      ) : null}
    </div>
  );
}

function ReviewField({ label, children }: { label: string; children: string }) {
  return (
    <div className="rounded border border-app-border bg-app-surface p-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-app-text-muted">
        {label}
      </dt>
      <dd className="mt-1 break-words text-app-text">{children}</dd>
    </div>
  );
}
