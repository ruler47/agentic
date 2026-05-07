import { Outlet } from "react-router-dom";
import { Sidebar } from "@/app/Sidebar";
import { TopHeader } from "@/app/TopHeader";
import { InvestigationModalRoot } from "@/features/investigations/InvestigationModal";

export function AppShell() {
  return (
    <div className="flex h-full min-h-screen w-full bg-app-bg text-app-text">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopHeader />
        <main className="flex-1 overflow-auto px-6 py-5">
          <Outlet />
        </main>
      </div>
      <InvestigationModalRoot />
    </div>
  );
}
