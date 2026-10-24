import { t } from "../i18n";
import { confirmAction } from "../store/confirmStore";

/**
 * Panels with edits that are not saved automatically (the glossary editor) register here, so
 * switching tabs or closing the window asks before throwing them away.
 */
// Kept on globalThis: the guard must be one register even if the module is loaded twice
// (a dev-server reload can leave the panel and the editor page holding different copies).
const store = globalThis as typeof globalThis & { __lvsUnsaved?: Map<string, string> };
const unsaved = (store.__lvsUnsaved ??= new Map<string, string>());

/** `message` names what would be lost; null clears it. */
export function setUnsaved(key: string, message: string | null): void {
  if (message) unsaved.set(key, message);
  else unsaved.delete(key);
}

export function hasUnsaved(): boolean {
  return unsaved.size > 0;
}

/** Resolves true when there is nothing unsaved or the user agrees to discard it. */
export async function confirmDiscard(): Promise<boolean> {
  if (unsaved.size === 0) return true;
  const ok = await confirmAction({
    title: t.unsaved.title,
    lines: [...unsaved.values()],
    confirmLabel: t.unsaved.discard,
    danger: true,
  });
  if (ok) unsaved.clear();
  return ok;
}
