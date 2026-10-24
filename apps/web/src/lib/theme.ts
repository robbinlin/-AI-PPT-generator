export type Theme = "dark" | "light";

const KEY = "lvs:theme";

/** Saved choice; dark (the original look) until the user picks light. */
export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Applies the theme to <html data-theme>; index.css mirrors the palettes for "light". */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the theme lasts until reload.
  }
}
