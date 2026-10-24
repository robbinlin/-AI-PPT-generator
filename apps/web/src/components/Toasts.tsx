import { X } from "lucide-react";
import { t } from "../i18n";
import { useToasts, type ToastTone } from "../store/toastStore";

const toneClass: Record<ToastTone, string> = {
  error: "border-rose-500/40 bg-rose-950 text-rose-100",
  success: "border-emerald-500/40 bg-emerald-950 text-emerald-100",
  info: "border-neutral-700 bg-neutral-800 text-neutral-100",
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const pause = useToasts((s) => s.pause);
  const resume = useToasts((s) => s.resume);
  if (toasts.length === 0) return null;
  return (
    <div
      // Bottom-left, over the page list's legend: not over the preview, player or timeline clips.
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex max-w-xs flex-col items-start gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 text-sm shadow-lg ${toneClass[toast.tone]}`}
          onMouseEnter={() => pause(toast.id)}
          onMouseLeave={() => resume(toast.id)}
          onFocus={() => pause(toast.id)}
          onBlur={() => resume(toast.id)}
        >
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="rounded px-2 py-0.5 text-sm font-semibold text-accent-300 hover:bg-white/10"
              onClick={() => {
                toast.action!.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label={t.common.close}
            className="text-neutral-400 hover:text-neutral-100"
            onClick={() => dismiss(toast.id)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
