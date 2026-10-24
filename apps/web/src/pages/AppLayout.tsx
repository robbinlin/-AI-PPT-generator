import { NavLink, Outlet } from "react-router";
import { Clapperboard, Settings } from "lucide-react";
import { ThemeToggle } from "../components/ThemeToggle";
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
        <nav className="flex flex-1 items-center gap-1">
          <NavLink to="/" end className={linkClass}>
            {t.app.navProjects}
          </NavLink>
          {/* API keys are an administrator's concern: kept out of the main path, at the far end. */}
          <span className="flex-1" />
          <NavLink to="/settings/providers" className={(s) => `${linkClass(s)} flex items-center gap-1.5 text-xs`}>
            <Settings className="size-3.5" aria-hidden />
            {t.app.navProviders}
          </NavLink>
          <ThemeToggle />
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
