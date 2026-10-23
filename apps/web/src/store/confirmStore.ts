import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  /** Short facts, one per line (pages, cost, wait). */
  lines: string[];
  /** Extra explanation under the facts. */
  note?: string;
  confirmLabel: string;
  danger?: boolean;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolve: ((ok: boolean) => void) | null;
  ask(request: ConfirmRequest): Promise<boolean>;
  answer(ok: boolean): void;
}

/** One app-wide confirmation dialog (rendered by ConfirmHost); `ask` resolves with the choice. */
export const useConfirm = create<ConfirmState>()((set, get) => ({
  request: null,
  resolve: null,
  ask(request) {
    get().resolve?.(false);
    return new Promise<boolean>((resolve) => set({ request, resolve }));
  },
  answer(ok) {
    get().resolve?.(ok);
    set({ request: null, resolve: null });
  },
}));

export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return useConfirm.getState().ask(request);
}
