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

/** ↑/↓ change page, space plays/pauses — only while no text field has focus. */
export function useEditorKeyboard({ onPrev, onNext, onTogglePlay }: EditorKeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onNext();
      } else if (e.key === " " || e.code === "Space") {
        // Buttons would also "click" on space; take the shortcut instead.
        if (e.target instanceof HTMLButtonElement) e.target.blur();
        e.preventDefault();
        onTogglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext, onTogglePlay]);
}
