import { useEffect } from "react";
import { RECONNECTING_EVENT } from "../api/client";
import { t } from "../i18n";
import { toast } from "../store/toastStore";

/** A save that got no response is retried for a few seconds: say so instead of staying silent. */
export function useReconnectingToast(): void {
  useEffect(() => {
    let last = 0;
    const onReconnecting = () => {
      if (Date.now() - last < 10_000) return;
      last = Date.now();
      toast(t.actionFailed.reconnecting, "info");
    };
    window.addEventListener(RECONNECTING_EVENT, onReconnecting);
    return () => window.removeEventListener(RECONNECTING_EVENT, onReconnecting);
  }, []);
}
