import { useEffect, type RefObject } from "react";

/**
 * Keyboard behaviour of a `role="menu"` popup (WAI-ARIA menu button pattern): opening moves focus
 * to the first item, ↑／↓／Home／End move between items, Esc closes and returns focus to the
 * button that opened it, Tab closes. Items are found by `[role=menuitem]:not([disabled])`.
 */
export function useMenuFocus(
  open: boolean,
  menu: RefObject<HTMLElement | null>,
  onClose: () => void,
  trigger?: RefObject<HTMLElement | null>,
  /** Preferred first item (e.g. a harmless one), else the first enabled item. */
  initial?: string,
): void {
  useEffect(() => {
    if (!open) return;
    const returnTo = (trigger?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)) as HTMLElement | null;
    const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    // The menu may render its items a moment later (e.g. after loading).
    const focusFirst = () => {
      if (menu.current?.contains(document.activeElement)) return;
      const preferred = initial ? menu.current?.querySelector<HTMLElement>(initial) : null;
      (preferred ?? items()[0])?.focus();
    };
    const timer = setTimeout(focusFirst, 0);
    const observer = new MutationObserver(focusFirst);
    if (menu.current) observer.observe(menu.current, { childList: true, subtree: true });

    const onKey = (e: KeyboardEvent) => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const go = (n: number) => {
        e.preventDefault();
        e.stopPropagation();
        list[(n + list.length) % list.length]?.focus();
      };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i <= 0 ? list.length - 1 : i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(list.length - 1);
      else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        returnTo?.focus();
      } else if (e.key === "Tab") onClose();
    };
    const el = menu.current;
    el?.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      el?.removeEventListener("keydown", onKey);
    };
  }, [open, menu, onClose, trigger, initial]);
}
