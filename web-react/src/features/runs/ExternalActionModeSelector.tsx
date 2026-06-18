import type { ExternalActionRunMode } from "@/features/runs/externalActionMode";

export function ExternalActionModeSelector({
  value,
  onChange,
  compact = false,
}: {
  value: ExternalActionRunMode;
  onChange: (value: ExternalActionRunMode) => void;
  compact?: boolean;
}) {
  return (
    <fieldset className="rounded-md border border-app-border bg-app-surface-2 p-2">
      <legend className="px-1 text-[10px] uppercase tracking-wider text-app-text-muted">
        Run mode
      </legend>
      <div className="flex flex-wrap gap-2">
        <ModeButton
          active={value === "approval"}
          label="Approval"
          description={
            compact
              ? "Pause before external commit."
              : "Pause before booking, sending, paying, or writing to an external system."
          }
          onClick={() => onChange("approval")}
        />
        <ModeButton
          active={value === "auto"}
          label="Automode"
          description={
            compact
              ? "Commit only with enough data, executor, confirmation, and proof."
              : "Allow commit only when the agent has enough data, executor, confirmation parser, and proof."
          }
          onClick={() => onChange("auto")}
        />
      </div>
    </fieldset>
  );
}

function ModeButton({
  active,
  label,
  description,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "min-w-[180px] flex-1 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-app-accent bg-app-accent-soft text-app-accent"
          : "border-app-border bg-app-bg text-app-text hover:border-app-accent/40",
      ].join(" ")}
      aria-pressed={active}
    >
      <span className="block text-xs font-semibold">{label}</span>
      <span className="mt-1 block text-[11px] text-app-text-muted">{description}</span>
    </button>
  );
}
