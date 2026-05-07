import type { ReactNode } from "react";

type PlaceholderPageProps = {
  title: string;
  description: string;
  apiHints?: string[];
  children?: ReactNode;
};

/**
 * Used while a real page is not ported yet. Shows what the page is meant for
 * and which endpoints it will hit, so the legacy/v2 comparison is honest:
 * an empty React page should not look like the legacy one is broken.
 */
export function PlaceholderPage({ title, description, apiHints, children }: PlaceholderPageProps) {
  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-6">
      <header>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-app-text-muted">{description}</p>
      </header>

      <div className="rounded-md border border-dashed border-app-border bg-app-surface-2 px-4 py-3 text-sm text-app-text-muted">
        Not ported to React yet. Open the legacy console at
        {" "}
        <a className="text-app-accent underline" href="http://127.0.0.1:3000" target="_blank" rel="noreferrer">
          http://127.0.0.1:3000
        </a>
        {" "}for the same screen.
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
