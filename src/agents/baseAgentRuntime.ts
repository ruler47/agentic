import type { AgentEvent, AgentEventSink } from "../types.js";

export async function emit(
  sink: AgentEventSink | undefined,
  input: Omit<AgentEvent, "id" | "spanId" | "parentSpanId" | "timestamp" | "startedAt" | "completedAt"> & {
    spanId?: string;
    parentSpanId?: string;
    startedAt?: Date;
    completedAt?: Date;
  },
): Promise<void> {
  if (!sink) return;
  const now = new Date();
  const startedAt = input.startedAt ?? now;
  const completedAt = input.completedAt;
  await sink({
    id: `base-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: input.spanId ?? `base-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    parentSpanId: input.parentSpanId,
    type: input.type,
    actor: input.actor,
    activity: input.activity,
    status: input.status,
    title: input.title,
    detail: input.detail,
    durationMs: input.durationMs,
    payload: input.payload,
    timestamp: now.toISOString(),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt?.toISOString(),
  });
}

export async function runWithTimeout<T>(
  label: string,
  timeoutMs: number | undefined,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) throw new Error(`${label} cancelled by caller`);
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return run(parentSignal);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onAbort, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        const onAbortSignal = () => {
          const reason = controller.signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error(parentSignal?.aborted ? `${label} cancelled by caller` : `${label} aborted`),
          );
        };
        controller.signal.addEventListener("abort", onAbortSignal, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbortSignal);
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
    parentSignal?.removeEventListener("abort", onAbort);
  }
}
