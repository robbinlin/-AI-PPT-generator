import { create } from "zustand";

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface ToastState {
  toasts: Toast[];
  push(text: string, tone?: Toast["tone"]): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push(text, tone = "info") {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, text, tone }].slice(-4) });
    setTimeout(() => get().dismiss(id), tone === "error" ? 7000 : 3500);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toast(text: string, tone: Toast["tone"] = "info"): void {
  useToasts.getState().push(text, tone);
}
