import type { ReactNode } from "react";

type PlaceholderPageProps = {
  title: string;
  description: string;
  apiHints?: string[];
  children?: ReactNode;
};

/**
 * Used while a real page is not implemented yet. Shows what the page is meant
 * for and which endpoints it will hit, so unfinished areas are explicit.
 */
export function PlaceholderPage({ title, description, apiHints, children }: PlaceholderPageProps) {
  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-6">
      <header>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-app-text-muted">{description}</p>
      </header>

      <div className="rounded-md border border-dashed border-app-border bg-app-surface-2 px-4 py-3 text-sm text-app-text-muted">
        This product surface is planned, but not implemented in the React console yet.
      </div>

      {apiHints && apiHints.length > 0 ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-app-text-muted">
            Backed by
          </h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {apiHints.map((hint) => (
              <li
                key={hint}
                className="rounded-full border border-app-border bg-app-surface-2 px-2.5 py-1 font-mono text-[11px] text-app-text-muted"
              >
                {hint}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {children}
    </section>
  );
}
