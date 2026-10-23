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
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push(text, tone = "info", action, durationMs) {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, text, tone, ...(action ? { action } : {}) }].slice(-4) });
    // Toasts with an action (e.g. 復原) stay long enough to be used.
    const ms = durationMs ?? (action ? 10_000 : tone === "error" ? 7000 : 3500);
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toast(text: string, tone: ToastTone = "info", action?: ToastAction, durationMs?: number): void {
  useToasts.getState().push(text, tone, action, durationMs);
}
