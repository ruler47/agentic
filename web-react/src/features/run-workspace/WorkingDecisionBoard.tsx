import type { ReactNode } from "react";
import type {
  AgentEvent,
  MemoryUseRecord,
  WorkingDecisionCandidate,
  WorkingDecisionFact,
  WorkingDecisionRejectedEvidence,
  WorkingDecisionSnapshot,
} from "@/api/types";
import { formatDuration } from "@/lib/format";

export function WorkingDecisionBoard({ events }: { events: AgentEvent[] }) {
  const snapshot = latestWorkingDecisionSnapshot(events);
  if (!snapshot) return null;

  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">
            Working / Decision Board
          </p>
          <h3 className="mt-1 break-words text-sm font-semibold">{snapshot.objective}</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            {phaseLabel(snapshot.phase)}
            {snapshot.taskMode ? ` · ${snapshot.taskMode}` : ""}
            {snapshot.metricsSummary ? ` · ${snapshot.metricsSummary.llmCalls} LLM · ${snapshot.metricsSummary.toolCalls} tools` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-app-border bg-app-surface-2 px-2 py-1 font-mono text-[10px] uppercase text-app-text-muted">
          rev {snapshot.revision}
        </span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DecisionBox title="Draft status">
          <p className="text-xs">
            <span className="font-semibold">{snapshot.draftStatus.status}</span>
            <span className="text-app-text-muted"> · {snapshot.draftStatus.summary}</span>
          </p>
        </DecisionBox>
        <DecisionBox title="Next action">
          {snapshot.nextAction ? (
            <>
              <p className="text-xs">{snapshot.nextAction.description}</p>
              {snapshot.nextAction.expectedEvidence ? (
                <p className="mt-1 text-[11px] text-app-text-muted">
                  expects: {snapshot.nextAction.expectedEvidence}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-app-text-muted">No next action.</p>
          )}
        </DecisionBox>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <ListSection
          title="Known facts"
          empty="No structured facts yet."
          items={snapshot.knownFacts}
          render={renderFact}
        />
        <ListSection
          title="Candidates"
          empty="No candidates yet."
          items={snapshot.candidates}
          render={renderCandidate}
        />
        <ListSection
          title="Rejected / blocked"
          empty="No rejected evidence yet."
          items={snapshot.rejectedEvidence}
          render={renderRejected}
        />
      </div>

      {snapshot.openQuestions.length ? (
        <details className="mt-3 rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
            Open questions / required evidence
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-app-text-muted">
            {snapshot.openQuestions.map((question, index) => (
              <li key={`${question}-${index}`}>{question}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {snapshot.memoryUse?.length ? (
        <details className="mt-3 rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-xs">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
            Memory source use
          </summary>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {snapshot.memoryUse.map((record, index) => (
              <li key={`${record.source}-${record.status}-${index}`} className="rounded border border-app-border bg-app-surface px-2 py-1.5">
                <p>
                  <span className="font-semibold">{record.source}</span>
                  <span className="text-app-text-muted"> · {record.status}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-app-text-muted">{record.reason}</p>
                <Refs recordIds={record.recordIds} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

export function latestWorkingDecisionSnapshot(events: AgentEvent[]): WorkingDecisionSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !isWorkingDecisionEvent(event)) continue;
    const snapshot = snapshotFromPayload(event.payload);
    if (snapshot) return snapshot;
  }
  return undefined;
}

function DecisionBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-app-border bg-app-surface-2 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ListSection<T>({
  title,
  empty,
  items,
  render,
}: {
  title: string;
  empty: string;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border border-app-border bg-app-surface-2 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</p>
      {items.length ? (
        <ul className="mt-2 space-y-2">{items.map((item, index) => <li key={index}>{render(item)}</li>)}</ul>
      ) : (
        <p className="mt-2 text-xs text-app-text-muted">{empty}</p>
      )}
    </div>
  );
}

function renderFact(fact: WorkingDecisionFact) {
  return (
    <div className="text-xs">
      <p>{fact.summary}</p>
      <SourceLinks urls={unique([fact.sourceUrl, ...(fact.sourceUrls ?? [])])} />
      <Refs artifactIds={fact.artifactIds} evidenceIds={fact.evidenceIds} />
    </div>
  );
}

function renderCandidate(candidate: WorkingDecisionCandidate) {
  return (
    <div className="text-xs">
      <p>
        <span className="font-semibold">{candidate.label}</span>
        <span className="text-app-text-muted"> · {candidate.status}</span>
      </p>
      {candidate.reason ? <p className="mt-0.5 text-[11px] text-app-text-muted">{candidate.reason}</p> : null}
      <ScoreChips scores={candidate.scores} />
      {candidate.uncertainties?.length ? (
        <p className="mt-1 text-[11px] text-app-text-muted">
          uncertainty: {candidate.uncertainties.slice(0, 3).join("; ")}
        </p>
      ) : null}
      <SourceLinks urls={unique([candidate.sourceUrl, ...(candidate.sourceUrls ?? [])])} />
      <Refs artifactIds={candidate.artifactIds} evidenceIds={candidate.evidenceIds} />
    </div>
  );
}

function renderRejected(rejected: WorkingDecisionRejectedEvidence) {
  return (
    <div className="text-xs">
      <p className="font-semibold">{rejected.summary}</p>
      <p className="mt-0.5 text-[11px] text-app-text-muted">{rejected.reason}</p>
      {rejected.sourceUrl ? <SourceLink url={rejected.sourceUrl} /> : null}
      <Refs artifactIds={rejected.artifactId ? [rejected.artifactId] : undefined} evidenceIds={rejected.evidenceId ? [rejected.evidenceId] : undefined} />
    </div>
  );
}

function SourceLinks({ urls }: { urls: Array<string | undefined> }) {
  const safeUrls = urls.filter((url): url is string => Boolean(url)).slice(0, 3);
  if (!safeUrls.length) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {safeUrls.map((url) => <SourceLink key={url} url={url} />)}
    </div>
  );
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-1 block truncate font-mono text-[10px] text-app-accent underline"
      title={url}
    >
      {url}
    </a>
  );
}

function ScoreChips({ scores }: { scores?: Record<string, number> }) {
  const entries = Object.entries(scores ?? {}).slice(0, 4);
  if (!entries.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span key={key} className="rounded-full border border-app-border px-1.5 py-0.5 font-mono text-[10px] text-app-text-muted">
          {key}: {Number(value).toFixed(2)}
        </span>
      ))}
    </div>
  );
}

function Refs({ artifactIds, evidenceIds, recordIds }: { artifactIds?: string[]; evidenceIds?: string[]; recordIds?: string[] }) {
  const refs = [
    ...(artifactIds ?? []).slice(0, 3).map((id) => `artifact:${id}`),
    ...(evidenceIds ?? []).slice(0, 3).map((id) => `evidence:${id}`),
    ...(recordIds ?? []).slice(0, 4),
  ];
  if (!refs.length) return null;
  return (
    <p className="mt-1 truncate font-mono text-[10px] text-app-text-muted" title={refs.join(", ")}>
      {refs.join(", ")}
    </p>
  );
}

function unique(values: Array<string | undefined>): Array<string | undefined> {
  return [...new Set(values.filter(Boolean))];
}

function isWorkingDecisionEvent(event: AgentEvent): boolean {
  return event.type === "working-decision-snapshot-created" ||
    event.type === "working-decision-snapshot-updated" ||
    event.type === "working-decision-phase-changed" ||
    event.type === "working-decision-update-rejected";
}

function snapshotFromPayload(payload: unknown): WorkingDecisionSnapshot | undefined {
  const candidate = recordAt(payload, "snapshot") ?? recordAt(payload, "output");
  if (!candidate || typeof candidate.revision !== "number" || typeof candidate.phase !== "string") return undefined;
  return candidate as WorkingDecisionSnapshot;
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function phaseLabel(phase: WorkingDecisionSnapshot["phase"]): string {
  return phase.replace(/_/g, " ");
}

export function workingDecisionEventDuration(events: AgentEvent[]): string | undefined {
  const snapshot = latestWorkingDecisionSnapshot(events);
  if (!snapshot?.metricsSummary) return undefined;
  const first = events.find((event) => event.type === "working-decision-snapshot-created");
  const last = events.findLast((event) => isWorkingDecisionEvent(event));
  if (!first || !last) return undefined;
  const started = Date.parse(first.timestamp);
  const ended = Date.parse(last.timestamp);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return formatDuration(ended - started);
}
