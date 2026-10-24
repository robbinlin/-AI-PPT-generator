import { useEffect } from "react";
import { t } from "../i18n";

/** 「整套流程測試｜簡報講課影片」: tabs, history entries and screen readers can tell pages apart. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title}｜${t.app.name}` : t.app.name;
    return () => {
      document.title = t.app.name;
    };
  }, [title]);
}
