import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { t } from "../i18n";
import { saveTheme, savedTheme, type Theme } from "../lib/theme";

/** Dark / light switch in the top bar (light is easier to read in a bright classroom or office). */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
      aria-label={next === "light" ? t.app.themeLight : t.app.themeDark}
      title={next === "light" ? t.app.themeLight : t.app.themeDark}
      onClick={() => {
        saveTheme(next);
        setTheme(next);
      }}
      data-testid="theme-toggle"
    >
      {next === "light" ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
      {!compact && (next === "light" ? t.app.themeLightShort : t.app.themeDarkShort)}
    </button>
  );
}
