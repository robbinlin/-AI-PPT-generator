import { useMemo, useState } from "react";
import type { GlossaryEntry } from "@lvs/shared";
import { ListTree, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { formatRelativeTime } from "../../lib/format";
import { pageRanges } from "../../lib/settingsImpact";
import { confirmAction } from "../../store/confirmStore";
import { editorStore, useEditor } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { Button, IconButton } from "../ui/Button";
import { SectionTitle } from "../ui/Misc";

/** The latest outline: objectives and sections (read-only) and a glossary whose readings can be corrected. */
export function OutlinePanel({ actions }: { actions: Pick<EditorActions, "enqueue"> }) {
  const outline = useEditor((s) => s.detail?.outline);
  const slides = useEditor((s) => s.detail?.slides);
  const hasSlides = (slides?.length ?? 0) > 0;
  const generating = useEditor((s) => s.detail?.activeJobs.some((j) => j.type === "generate_outline") ?? false);
  const positionOf = useMemo(() => new Map((slides ?? []).map((s) => [s.id, s.index + 1])), [slides]);

  const generate = async () => {
    // Regenerating replaces the glossary too, including readings the user corrected.
    if (outline) {
      const ok = await confirmAction({
        title: t.outline.regenerateTitle,
        lines: [t.outline.regenerateBody],
        note: t.outline.regenerateNote,
        confirmLabel: t.outline.regenerateConfirm,
        danger: true,
      });
      if (!ok) return;
    }
    void actions.enqueue({ type: "generate_outline", force: outline !== undefined });
  };

  if (!outline) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <ListTree className="size-8 text-neutral-600" aria-hidden />
        <p className="text-sm text-neutral-400">{t.outline.empty}</p>
        <Button variant="primary" size="sm" disabled={!hasSlides || generating} onClick={() => void generate()}>
          {t.outline.generate}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-500">
          {fmt(t.outline.version, { v: outline.version, time: formatRelativeTime(outline.createdAt) })}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={generating} onClick={() => void generate()}>
          {t.outline.regenerate}
        </Button>
      </div>

      <Glossary key={outline.id} glossary={outline.glossary} />

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
              <div className="mt-0.5 text-xs text-neutral-500">
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
    </div>
  );
}

function Glossary({ glossary }: { glossary: GlossaryEntry[] }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<GlossaryEntry[]>(glossary);
  const [saving, setSaving] = useState(false);

  const set = (i: number, patch: Partial<GlossaryEntry>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    const detail = editorStore.getState().detail;
    if (!detail) return;
    setSaving(true);
    try {
      const res = await api.updateGlossary(detail.project.id, { glossary: rows.filter((r) => r.term.trim()) });
      const pages = res.affectedSceneIds.map((id) => (detail.scenes.find((s) => s.id === id)?.index ?? 0) + 1).sort((a, b) => a - b);
      // The server publishes outline/script/scene events; a snapshot keeps every badge exact.
      editorStore.getState().load(await api.getProject(detail.project.id));
      toast(pages.length ? fmt(t.outline.savedAffected, { pages: pageRanges(pages) }) : t.outline.saved, pages.length ? "info" : "success");
      setEditing(false);
    } catch (err) {
      toast(fmt(t.outline.saveFailed, { message: errorMessage(err) }), "error");
    } finally {
      setSaving(false);
    }
  };

  const input = "w-full rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-accent-500 focus:outline-none";

  return (
    <section data-testid="glossary">
      <div className="flex items-center justify-between">
        <SectionTitle>{t.outline.glossary}</SectionTitle>
        {!editing && (
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)} data-testid="glossary-edit">
            {t.outline.edit}
          </Button>
        )}
      </div>
      <p className="mb-2 text-xs leading-relaxed text-neutral-400">{t.outline.glossaryHint}</p>
      {!editing && glossary.length === 0 ? (
        <p className="text-xs text-neutral-500">{t.outline.noGlossary}</p>
      ) : (
        <table className="w-full table-fixed text-left text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="w-[30%] border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.term}</th>
              <th className="w-[35%] border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.reading}</th>
              <th className="border-b border-neutral-800 py-1.5 font-medium">{t.outline.definition}</th>
              {editing && <th className="w-7 border-b border-neutral-800" />}
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {(editing ? rows : glossary).map((g, i) =>
              editing ? (
                <tr key={i} className="align-top">
                  <td className="py-1 pr-1.5">
                    <input className={input} value={g.term} aria-label={t.outline.term} onChange={(e) => set(i, { term: e.target.value })} />
                  </td>
                  <td className="py-1 pr-1.5">
                    <input
                      className={input}
                      value={g.reading ?? ""}
                      placeholder={t.outline.readingPlaceholder}
                      aria-label={`${g.term} ${t.outline.reading}`}
                      onChange={(e) => set(i, { reading: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-1">
                    <input className={input} value={g.definition ?? ""} aria-label={t.outline.definition} onChange={(e) => set(i, { definition: e.target.value })} />
                  </td>
                  <td className="py-1">
                    <IconButton icon={Trash2} label={fmt(t.outline.removeTerm, { term: g.term })} onClick={() => setRows((list) => list.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ) : (
                <tr key={g.term} className="align-top">
                  <td className="border-b border-neutral-800/60 py-1.5 pr-2 font-medium break-words text-neutral-100">{g.term}</td>
                  <td className="border-b border-neutral-800/60 py-1.5 pr-2 break-words">{g.reading || t.outline.readingPlaceholder}</td>
                  <td className="border-b border-neutral-800/60 py-1.5 break-words">{g.definition ?? t.common.none}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => setRows((list) => [...list, { term: "" }])}>
            {t.outline.addTerm}
          </Button>
          <span className="ml-auto" />
          <Button
            size="sm"
            onClick={() => {
              setRows(glossary);
              setEditing(false);
            }}
          >
            {t.common.cancel}
          </Button>
          <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()} data-testid="glossary-save">
            {t.outline.save}
          </Button>
        </div>
      )}
    </section>
  );
}
