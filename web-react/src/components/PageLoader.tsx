/** Lightweight skeleton shown while a route bundle is loading. */
export function PageLoader() {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="flex flex-col items-center gap-3 text-xs text-app-text-muted">
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-app-border border-t-app-accent"
          aria-hidden="true"
        />
        <p>Loading…</p>
      </div>
    </div>
  );
}
