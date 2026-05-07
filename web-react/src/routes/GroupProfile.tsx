import { useEffect, useState } from "react";
import { useGroupProfile, useUpdateGroupProfile } from "@/api/queries";

export function GroupProfilePage() {
  const profile = useGroupProfile();
  const update = useUpdateGroupProfile();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preferences, setPreferences] = useState("{}");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!profile.data) return;
    setName(profile.data.name);
    setDescription(profile.data.description ?? "");
    setPreferences(JSON.stringify(profile.data.preferences ?? {}, null, 2));
  }, [profile.data]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    let prefs: Record<string, unknown> = {};
    if (preferences.trim()) {
      try {
        const parsed = JSON.parse(preferences);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          prefs = parsed as Record<string, unknown>;
        } else {
          throw new Error("Preferences must be a JSON object.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    update.mutate({
      name: name.trim() || undefined,
      description: description.trim(),
      preferences: prefs,
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3">
          <h2 className="text-base font-semibold">Group Profile</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Shared context for the one group this instance serves. Edits are audited.
          </p>
        </header>
        {profile.isLoading ? (
          <p className="text-xs text-app-text-muted">Loading…</p>
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
              />
            </Field>
            <Field label="Description">
              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="w-full resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
              />
            </Field>
            <Field label="Preferences (JSON object)">
              <textarea
                rows={6}
                value={preferences}
                onChange={(event) => setPreferences(event.target.value)}
                spellCheck={false}
                className="w-full resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 font-mono text-[11px] outline-none focus:border-app-accent/60"
              />
            </Field>
            <p className="text-[11px] text-app-text-muted">
              ID: <code>{profile.data?.id}</code> · instance:{" "}
              <code>{profile.data?.instanceId}</code>
            </p>
            {error ? <p className="text-[11px] text-app-danger">{error}</p> : null}
            {update.isError ? (
              <p className="text-[11px] text-app-danger">{update.error.message}</p>
            ) : null}
            {update.isSuccess ? (
              <p className="text-[11px] text-app-accent">Saved.</p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={update.isPending}
                className="rounded-md bg-app-accent px-3 py-1.5 text-xs font-semibold text-app-bg disabled:opacity-50"
              >
                {update.isPending ? "Saving…" : "Save group profile"}
              </button>
            </div>
          </form>
        )}
      </article>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</span>
      {children}
    </label>
  );
}
