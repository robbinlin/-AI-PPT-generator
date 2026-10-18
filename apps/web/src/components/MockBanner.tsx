import { FlaskConical } from "lucide-react";
import { useApiEnv } from "../api/context";
import { fmt, t } from "../i18n";

/** Visible notice whenever the in-memory mock API is serving data. */
export function MockBanner() {
  const { mockReason, baseUrl } = useApiEnv();
  if (!mockReason) return null;
  const text = mockReason === "unreachable" ? fmt(t.app.mockFallbackBanner, { url: baseUrl }) : t.app.mockBanner;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200"
    >
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
      {mockReason === "unreachable" && (
        <button type="button" className="ml-auto underline hover:text-amber-100" onClick={() => window.location.reload()}>
          {t.app.retry}
        </button>
      )}
    </div>
  );
}
