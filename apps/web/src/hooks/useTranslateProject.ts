import { useNavigate } from "react-router";
import type { CostEstimate } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { fmt, t } from "../i18n";
import { formatTwdFirst } from "../lib/format";
import { confirmAction } from "../store/confirmStore";
import { toast } from "../store/toastStore";

/**
 * 「建立英文版」: explains what the copy holds and what it costs, then creates the translated
 * project (deck copied, scripts translated by a job) and opens it. The original is untouched.
 */
export function useTranslateProject(): (project: { id: string; name: string }) => Promise<void> {
  const api = useApi();
  const navigate = useNavigate();
  return async (project) => {
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
      title: fmt(t.translate.title, { name: project.name }),
      lines: [
        estimate ? fmt(t.translate.pages, { n: estimate.sceneCount ?? 0 }) : t.translate.pagesUnknown,
        fmt(t.translate.cost, { cost: estimate ? formatTwdFirst(estimate.total, estimate.currency) : t.translate.costUnknown }),
        t.translate.voice,
        t.translate.avatar,
        t.translate.slides,
      ],
      note: t.translate.note,
      confirmLabel: t.translate.confirm,
    });
    if (!ok) return;
    try {
      const { project: created } = await api.createTranslation(project.id, { language: "en" });
      toast(fmt(t.translate.created, { name: created.name }), "success");
      navigate(`/projects/${created.id}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
}
