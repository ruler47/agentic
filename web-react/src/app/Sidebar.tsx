import { NavLink, useLocation } from "react-router-dom";
import { navigation } from "@/app/navigation";
import { useHealth } from "@/api/health";

// Routes that don't have their own sidebar item but should highlight a sibling.
const navAlias: Record<string, string> = {
  "/run": "/runs",
  "/conversation": "/conversations",
};

export function Sidebar() {
  const health = useHealth();
  const location = useLocation();
  const aliasedActive = Object.entries(navAlias).find(([prefix]) =>
    location.pathname.startsWith(`${prefix}/`),
  )?.[1];

  const healthLabel = health.isError
    ? "Backend unreachable"
    : health.data?.ok
      ? `Backend ready · ${health.data.persistence?.database.mode ?? "unknown"}`
      : "Checking backend...";
  const healthTone = health.isError
    ? "danger"
    : health.data?.persistence?.database.mode === "in-memory"
      ? "warn"
      : health.data?.ok
        ? "ok"
        : "muted";

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-app-border bg-app-surface">
      <header className="flex items-center gap-3 border-b border-app-border px-5 py-4">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-app-accent-soft text-base font-bold text-app-accent">
          A
        </div>
        <div className="flex min-w-0 flex-col">
          <strong className="truncate text-sm">Agentic</strong>
          <span className="truncate text-xs text-app-text-muted">Local Group Profile</span>
        </div>
      </header>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {navigation.map((group) => (
          <section key={group.group} className="mb-5">
            <h2 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
              {group.group}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      [
                        "flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors",
                        isActive || aliasedActive === item.path
                          ? "bg-app-accent-soft text-app-accent"
                          : "text-app-text hover:bg-app-surface-2",
                      ].join(" ")
                    }
                    title={item.description}
                  >
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <footer className="border-t border-app-border px-3 py-3">
        <div
          className={[
            "flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs",
            healthTone === "danger"
              ? "bg-app-danger-soft text-app-danger"
              : healthTone === "warn"
                ? "bg-app-warning-soft text-app-warning"
              : healthTone === "ok"
                ? "bg-app-accent-soft text-app-accent"
                : "bg-app-surface-2 text-app-text-muted",
          ].join(" ")}
        >
          <span>{healthLabel}</span>
          <span className="font-mono text-[10px] opacity-70">
            {health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toLocaleTimeString() : "—"}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 px-1 text-xs text-app-text-muted">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-app-surface-2 text-[11px]">A</span>
          <div className="flex min-w-0 flex-col leading-tight">
            <span>Admin</span>
            <span className="font-mono text-[10px] opacity-70">user-admin</span>
          </div>
        </div>
      </footer>
    </aside>
  );
}
