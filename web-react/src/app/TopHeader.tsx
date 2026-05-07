import { useLocation } from "react-router-dom";
import { allNavItems } from "@/app/navigation";

export function TopHeader() {
  const location = useLocation();
  const active =
    allNavItems.find((item) => item.path === location.pathname) ??
    allNavItems.find((item) => item.path !== "/" && location.pathname.startsWith(item.path));

  return (
    <header className="flex items-center justify-between border-b border-app-border bg-app-surface px-6 py-4">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">{active?.label ?? "Agentic"}</h1>
        <p className="mt-0.5 truncate text-xs text-app-text-muted">
          {active?.description ?? "Universal agent console"}
        </p>
      </div>
      <div className="flex items-center gap-3 text-xs text-app-text-muted">
        <span className="rounded-md border border-app-border px-2 py-1 font-mono">
          instance-local · Europe/Madrid
        </span>
        <span className="rounded-md bg-app-warning-soft px-2 py-1 text-app-warning">
          React preview · port 3001
        </span>
      </div>
    </header>
  );
}
