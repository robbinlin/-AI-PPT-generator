import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push(text: string, tone?: ToastTone, action?: ToastAction, durationMs?: number): void;
  dismiss(id: number): void;
  /** Hovered or focused: the countdown stops so the text can be read (WCAG 2.2.1). */
  pause(id: number): void;
  resume(id: number): void;
}

let nextId = 1;
const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>();

// One toast list per page even if this module is loaded twice (see editorStore).
const shared = globalThis as typeof globalThis & { __lvsToasts?: ReturnType<typeof makeToasts> };
export const useToasts = (shared.__lvsToasts ??= makeToasts());

function makeToasts() {
  return create<ToastState>()((set, get) => ({
  toasts: [],
  push(text, tone = "info", action, durationMs) {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, text, tone, ...(action ? { action } : {}) }].slice(-4) });
    // Toasts with an action (e.g. 復原) stay long enough to be used.
    // Errors stay longer: they usually need reading (what failed, what to do).
    const ms = durationMs ?? (action ? 10_000 : tone === "error" ? 15_000 : 3500);
    timers.set(id, { handle: setTimeout(() => get().dismiss(id), ms), remaining: ms, startedAt: Date.now() });
  },
  dismiss(id) {
    const timer = timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  pause(id) {
    const timer = timers.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    timers.set(id, { handle: null, remaining: Math.max(1000, timer.remaining - (Date.now() - timer.startedAt)), startedAt: 0 });
  },
  resume(id) {
    const timer = timers.get(id);
    if (!timer || timer.handle) return;
    timers.set(id, { handle: setTimeout(() => get().dismiss(id), timer.remaining), remaining: timer.remaining, startedAt: Date.now() });
  },
}));
}

export function toast(text: string, tone: ToastTone = "info", action?: ToastAction, durationMs?: number): void {
  useToasts.getState().push(text, tone, action, durationMs);
}
