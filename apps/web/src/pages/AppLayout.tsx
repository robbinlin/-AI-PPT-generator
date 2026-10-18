import { NavLink, Outlet } from "react-router";
import { Clapperboard } from "lucide-react";
import { t } from "../i18n";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1 text-sm ${isActive ? "bg-neutral-800 text-neutral-50" : "text-neutral-400 hover:text-neutral-100"}`;

export function AppLayout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b border-neutral-800 bg-neutral-900 px-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <Clapperboard className="size-4 text-accent-400" aria-hidden />
          {t.app.name}
        </div>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={linkClass}>
            {t.app.navProjects}
          </NavLink>
          <NavLink to="/settings/providers" className={linkClass}>
            {t.app.navProviders}
          </NavLink>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
