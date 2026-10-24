import { useEffect } from "react";

export interface EditorKeyHandlers {
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
}

/** True when keystrokes belong to a text field (or a control that uses arrows/space itself). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return false;
}

/** Widgets that own their keys (a menu's ↑↓, a dialog's Space…): editor shortcuts stay out. */
const OWNS_KEYS = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tablist],[role=radiogroup],[role=slider]";
/** Controls Space activates natively: it must click them, not start playback. */
const SPACE_ACTIVATES = "button,a[href],summary,input,select,[role=button],[role=tab],[role=menuitem],[role=option],[role=switch],[role=checkbox],[role=radio]";
/** Where Space means "play / pause": nothing focused, the page list, or the preview. */
const SPACE_PLAYS = "[data-page-button],[data-testid=video-frame]";
/** Controls whose arrow keys do something of their own. */
const ARROWS_OWNED = "input[type=radio],input[type=range],[role=slider],[role=radio],[role=option],[role=menuitem],[role=tab]";

/**
 * Whether an editor shortcut may take this key: never inside dialogs, menus or text fields, and
 * Space only where it does not already press a button (WCAG 2.1.1: keyboard users must be able
 * to operate every control with its usual keys).
 */
export function shortcutAllowed(target: EventTarget | null, key: string): boolean {
  if (isTypingTarget(target)) return false;
  if (typeof document !== "undefined" && document.querySelector("[role=dialog][aria-modal=true]")) return false;
  const el = target instanceof HTMLElement ? target : null;
  if (el?.closest(OWNS_KEYS)) return false;
  if (key === " ") {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (el.closest(SPACE_PLAYS)) return true;
    return !el.closest(SPACE_ACTIVATES);
  }
  return !el?.closest(ARROWS_OWNED);
}

/** ↑/↓ change page, space plays/pauses — only where those keys mean nothing else. */
export function useEditorKeyboard({ onPrev, onNext, onTogglePlay }: EditorKeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key === " " || e.code === "Space" ? " " : e.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== " ") return;
      if (!shortcutAllowed(e.target, key)) return;
      e.preventDefault();
      if (key === "ArrowUp") onPrev();
      else if (key === "ArrowDown") onNext();
      else onTogglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext, onTogglePlay]);
}
