import { useNavigate } from "react-router";
import type { CostEstimate, Language } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { fmt, t } from "../i18n";
import { formatTwdFirst } from "../lib/format";
import { confirmAction } from "../store/confirmStore";
import { toast } from "../store/toastStore";

/** An English project translates into Chinese, anything else into English. */
export function translationTarget(language: Language): Language {
  return language === "en" ? "zh-TW" : "en";
}

/** 「英文」/「中文」 for the labels of a translation out of `language`. */
export function targetLanguageName(language: Language): string {
  return t.translate.langName[translationTarget(language)];
}

/**
 * 建立英文版／中文版: explains what the copy holds and what it costs, then creates the translated
 * project (deck copied, scripts translated by a job) and opens it. The original is untouched.
 */
export function useTranslateProject(): (project: { id: string; name: string; settings: { language: Language } }) => Promise<void> {
  const api = useApi();
  const navigate = useNavigate();
  return async (project) => {
    const target = translationTarget(project.settings.language);
    const lang = t.translate.langName[target];
    let estimate: CostEstimate | undefined;
    try {
      estimate = await api.getEstimate(project.id, "translate_script");
    } catch {
      estimate = undefined;
    }
    if (estimate && (estimate.sceneCount ?? 0) === 0) {
      toast(t.translate.noScripts, "info");
      return;
    }
    const ok = await confirmAction({
      title: fmt(t.translate.title, { name: project.name, lang }),
      lines: [
        estimate ? fmt(t.translate.pages, { n: estimate.sceneCount ?? 0 }) : t.translate.pagesUnknown,
        fmt(t.translate.cost, { cost: estimate ? formatTwdFirst(estimate.total, estimate.currency) : t.translate.costUnknown }),
        fmt(t.translate.voice, { lang }),
        fmt(t.translate.avatar, { lang }),
        t.translate.slides,
      ],
      note: fmt(t.translate.note, { lang }),
      confirmLabel: fmt(t.translate.confirm, { lang }),
    });
    if (!ok) return;
    try {
      const { project: created } = await api.createTranslation(project.id, { language: target });
      toast(fmt(t.translate.created, { name: created.name }), "success");
      navigate(`/projects/${created.id}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
}
