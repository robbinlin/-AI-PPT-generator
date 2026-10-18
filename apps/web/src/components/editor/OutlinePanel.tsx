import { useMemo } from "react";
import { ListTree, RefreshCw } from "lucide-react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { formatRelativeTime } from "../../lib/format";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";
import { SectionTitle } from "../ui/Misc";

/** Read-only view of the latest outline: objectives, sections and glossary. */
export function OutlinePanel({ actions }: { actions: Pick<EditorActions, "enqueue"> }) {
  const outline = useEditor((s) => s.detail?.outline);
  const slides = useEditor((s) => s.detail?.slides);
  const hasSlides = (slides?.length ?? 0) > 0;
  const generating = useEditor((s) => s.detail?.activeJobs.some((j) => j.type === "generate_outline") ?? false);
  const positionOf = useMemo(() => new Map((slides ?? []).map((s) => [s.id, s.index + 1])), [slides]);

  const generate = () => void actions.enqueue({ type: "generate_outline", force: outline !== undefined });

  if (!outline) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <ListTree className="size-8 text-neutral-600" aria-hidden />
        <p className="text-sm text-neutral-400">{t.outline.empty}</p>
        <Button variant="primary" size="sm" disabled={!hasSlides || generating} onClick={generate}>
          {t.outline.generate}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-neutral-500">
          {fmt(t.outline.version, { v: outline.version, time: formatRelativeTime(outline.createdAt) })}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={generating} onClick={generate}>
          {t.outline.regenerate}
        </Button>
      </div>

      {outline.summary && (
        <section>
          <SectionTitle>{t.outline.summary}</SectionTitle>
          <p className="text-sm leading-relaxed text-neutral-300">{outline.summary}</p>
        </section>
      )}

      <section>
        <SectionTitle>{t.outline.objectives}</SectionTitle>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-neutral-300">
          {outline.objectives.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ol>
      </section>

      <section>
        <SectionTitle>{t.outline.sections}</SectionTitle>
        <ol className="space-y-3">
          {outline.sections.map((sec, i) => (
            <li key={`${i}-${sec.title}`} className="rounded-md border border-neutral-800 p-3">
              <div className="text-sm font-medium text-neutral-100">{sec.title}</div>
              <div className="mt-0.5 text-[11px] text-neutral-500">
                {fmt(t.outline.slides, {
                  list: sec.slideIds.map((id) => (positionOf.has(id) ? `P${positionOf.get(id)}` : "?")).join("、"),
                })}
              </div>
              {sec.keyPoints.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-neutral-300">
                  {sec.keyPoints.map((k) => (
                    <li key={k}>{k}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <SectionTitle>{t.outline.glossary}</SectionTitle>
        {outline.glossary.length === 0 ? (
          <p className="text-xs text-neutral-500">{t.outline.noGlossary}</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.term}</th>
                <th className="border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.reading}</th>
                <th className="border-b border-neutral-800 py-1.5 font-medium">{t.outline.definition}</th>
              </tr>
            </thead>
            <tbody className="text-neutral-300">
              {outline.glossary.map((g) => (
                <tr key={g.term} className="align-top">
                  <td className="border-b border-neutral-800/60 py-1.5 pr-2 font-medium text-neutral-100">{g.term}</td>
                  <td className="border-b border-neutral-800/60 py-1.5 pr-2">{g.reading ?? t.common.none}</td>
                  <td className="border-b border-neutral-800/60 py-1.5">{g.definition ?? t.common.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-neutral-600">{t.outline.readOnlyHint}</p>
      </section>
    </div>
  );
}
