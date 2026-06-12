import { useState } from "react";

import {
  useCreateSecretHandle,
  useDeleteSecretHandle,
  type SecretHandleStatus,
} from "@/api/secretHandles";
import { GenericBadge } from "@/components/StatusBadge";

export function ToolSecretHandlePanel({
  toolName,
  handles,
  statuses,
  isLoading,
  error,
}: {
  toolName: string;
  handles: string[];
  statuses: SecretHandleStatus[];
  isLoading: boolean;
  error?: string;
}) {
  const create = useCreateSecretHandle();
  const remove = useDeleteSecretHandle();
  const [values, setValues] = useState<Record<string, string>>({});
  const statusByHandle = new Map(statuses.map((status) => [status.handle, status]));
  const missing = handles.filter((handle) => !statusByHandle.get(handle)?.resolvable);

  const save = (handle: string) => {
    const secretRef = values[handle]?.trim();
    if (!secretRef || create.isPending) return;
    create.mutate(
      {
        handle,
        label: `${toolName} credential`,
        provider: "inline",
        secretRef,
        scopes: ["instance-local", `tool:${toolName}`],
      },
      {
        onSuccess: () => {
          setValues((previous) => ({ ...previous, [handle]: "" }));
        },
      },
    );
  };

  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-app-text-muted">
            Values are stored as scoped secret handles. Saving a value with the same handle
            replaces the previous token without creating a new tool version.
          </p>
          <p className="mt-1 text-[11px] text-app-text-muted">
            {isLoading
              ? "Checking secret handles..."
              : missing.length === 0
                ? "All required handles are registered and resolvable."
                : `${missing.length} handle${missing.length === 1 ? "" : "s"} need attention.`}
          </p>
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {handles.map((handle) => {
          const status = statusByHandle.get(handle);
          const tone = !status
            ? "warn"
            : status.resolvable
              ? "ok"
              : status.registered
                ? "warn"
                : "danger";
          const label = !status
            ? "checking"
            : status.resolvable
              ? "resolved"
              : status.registered
                ? "registered, unresolved"
                : "missing";
          return (
            <li
              key={handle}
              className="rounded-md border border-app-border bg-app-surface px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="break-all font-mono text-[11px]">{handle}</span>
                <GenericBadge tone={tone}>{label}</GenericBadge>
              </div>
              {status?.registered ? (
                <p className="mt-1 text-[10px] text-app-text-muted">
                  {status.provider} · {status.secretRef ?? "secret ref hidden"}
                  {status.scopes?.length ? ` · ${status.scopes.join(", ")}` : ""}
                </p>
              ) : (
                <p className="mt-1 text-[10px] text-app-text-muted">
                  Create this handle before live runs can use the tool.
                </p>
              )}
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <input
                  type="password"
                  value={values[handle] ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({ ...previous, [handle]: event.target.value }))
                  }
                  placeholder={status?.registered ? "new token replaces current value" : "paste token"}
                  className="min-w-0 rounded border border-app-border bg-app-surface-2 px-2 py-1 font-mono text-[11px]"
                />
                <button
                  type="button"
                  disabled={create.isPending || !values[handle]?.trim()}
                  onClick={() => save(handle)}
                  className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                >
                  {status?.registered ? "Replace" : "Save"}
                </button>
                <button
                  type="button"
                  disabled={remove.isPending || !status?.registered}
                  onClick={() => {
                    if (window.confirm(`Delete secret handle ${handle}?`)) {
                      remove.mutate(handle);
                    }
                  }}
                  className="rounded-md border border-app-danger/60 bg-app-surface px-2.5 py-1 text-[11px] font-medium text-app-danger disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {create.isError ? <p className="mt-2 text-[11px] text-app-danger">{create.error.message}</p> : null}
      {remove.isError ? <p className="mt-2 text-[11px] text-app-danger">{remove.error.message}</p> : null}
      {error ? <p className="mt-2 text-[11px] text-app-danger">{error}</p> : null}
    </div>
  );
}
