import { useEffect, useMemo, useState } from "react";
import type { GlossaryEntry } from "@lvs/shared";
import { ListTree, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { formatRelativeTime } from "../../lib/format";
import { formatTwdFirst } from "../../lib/format";
import { pageRanges, visibleScenes } from "../../lib/settingsImpact";
import { confirmDiscard, setUnsaved } from "../../lib/unsavedGuard";
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
        <span className="text-xs text-neutral-400">
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
              <div className="mt-0.5 text-xs text-neutral-400">
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
  const dirty = editing && JSON.stringify(rows) !== JSON.stringify(glossary);
  // Not autosaved like scripts: leaving the tab or the page asks first.
  useEffect(() => {
    setUnsaved("glossary", dirty ? t.unsaved.glossary : null);
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      setUnsaved("glossary", null);
    };
  }, [dirty]);

  const set = (i: number, patch: Partial<GlossaryEntry>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Removing is one click next to the inputs, so it can be taken back.
  const remove = (i: number) => {
    const entry = rows[i];
    if (!entry) return;
    setRows((list) => list.filter((_, j) => j !== i));
    toast(fmt(t.outline.removed, { term: entry.term || "—" }), "info", {
      label: t.impact.undo,
      run: () => setRows((list) => [...list.slice(0, i), entry, ...list.slice(i)]),
    });
  };
  const save = async () => {
    const detail = editorStore.getState().detail;
    if (!detail) return;
    // Like a settings change: pages that say a changed term need new narration, and their
    // finished (paid) avatars with it — say so, with the cost, before saving.
    const before = new Map(glossary.map((g) => [g.term, g.reading ?? ""]));
    const after = new Map(rows.filter((r) => r.term.trim()).map((r) => [r.term.trim(), r.reading?.trim() ?? ""]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((term) => (before.get(term) ?? "") !== (after.get(term) ?? ""));
    const settings = detail.project.settings;
    const affected = visibleScenes(detail).filter((s) => !s.muted && changed.some((term) => detail.scripts[s.id]?.script.includes(term)));
    const paid = settings.avatar.enabled ? affected.filter((s) => s.avatar.status === "ready") : [];
    if (paid.length > 0) {
      let cost = "";
      try {
        const est = await api.getEstimate(detail.project.id, "generate_avatar", { scope: "all", sceneIds: paid.map((s) => s.id) });
        cost = formatTwdFirst(est.total, est.currency);
      } catch {
        cost = "";
      }
      const ok = await confirmAction({
        title: t.outline.saveConfirmTitle,
        lines: [
          fmt(t.outline.saveConfirmPages, { pages: pageRanges(paid.map((s) => s.index + 1)) }),
          ...(cost ? [fmt(t.impact.redoCost, { cost })] : []),
        ],
        note: t.outline.saveConfirmNote,
        confirmLabel: t.outline.save,
        danger: true,
      });
      if (!ok) return;
    }
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

  const input = "min-w-0 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-accent-500 focus:outline-none";

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
      {editing ? (
        // One term per block: the reading gets the full panel width so it can be read back.
        <ol className="flex flex-col gap-2" data-testid="glossary-editor">
          {rows.map((g, i) => (
            <li key={i} className="rounded-md border border-neutral-800 p-2">
              <div className="flex items-center gap-1.5">
                <input
                  className={`${input} w-28 shrink-0 font-medium`}
                  data-testid="glossary-term"
                  value={g.term}
                  placeholder={t.outline.term}
                  aria-label={t.outline.term}
                  onChange={(e) => set(i, { term: e.target.value })}
                />
                <span className="text-neutral-400" aria-hidden>
                  →
                </span>
                <input
                  className={`${input} flex-1`}
                  data-testid="glossary-reading"
                  value={g.reading ?? ""}
                  placeholder={t.outline.readingPlaceholder}
                  aria-label={`${g.term} ${t.outline.reading}`}
                  onChange={(e) => set(i, { reading: e.target.value })}
                />
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  className={`${input} flex-1 text-neutral-400`}
                  value={g.definition ?? ""}
                  placeholder={t.outline.definition}
                  aria-label={`${g.term} ${t.outline.definition}`}
                  onChange={(e) => set(i, { definition: e.target.value })}
                />
                <IconButton icon={Trash2} label={fmt(t.outline.removeTerm, { term: g.term })} onClick={() => remove(i)} />
              </div>
              {/^[A-Za-z]{1,3}$/.test(g.term.trim()) && g.reading?.trim() && <p className="mt-1 text-xs text-amber-300">{t.outline.shortTermWarn}</p>}
            </li>
          ))}
        </ol>
      ) : glossary.length === 0 ? (
        <p className="text-xs text-neutral-400">{t.outline.noGlossary}</p>
      ) : (
        <table className="w-full table-fixed text-left text-xs">
          <thead className="text-neutral-400">
            <tr>
              <th className="w-[30%] border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.term}</th>
              <th className="w-[35%] border-b border-neutral-800 py-1.5 pr-2 font-medium">{t.outline.reading}</th>
              <th className="border-b border-neutral-800 py-1.5 font-medium">{t.outline.definition}</th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {glossary.map((g) => (
              <tr key={g.term} className="align-top">
                <td className="border-b border-neutral-800/60 py-1.5 pr-2 font-medium break-words text-neutral-100">{g.term}</td>
                <td className="border-b border-neutral-800/60 py-1.5 pr-2 break-words">{g.reading || t.outline.readingPlaceholder}</td>
                <td className="border-b border-neutral-800/60 py-1.5 break-words">{g.definition ?? t.common.none}</td>
              </tr>
            ))}
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
            onClick={async () => {
              if (dirty && !(await confirmDiscard())) return;
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
