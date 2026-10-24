import { useCallback, useEffect, useRef, useState } from "react";
import type { ScriptRevision } from "@lvs/shared";
import { History } from "lucide-react";
import { useApi } from "../../api/context";
import { errorMessage } from "../../api/types";
import { fmt, t } from "../../i18n";
import { formatRelativeTime } from "../../lib/format";
import { toast } from "../../store/toastStore";
import { useMenuFocus } from "../../hooks/useMenuFocus";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Misc";

const SOURCE: Record<ScriptRevision["source"], string> = { ai: t.script.sourceAi, user: t.script.sourceUser, translation: t.script.sourceTranslation };

/**
 * Every saved version of a page's script, from the server: an AI rewrite can be undone even
 * after a reload (the editor's own undo only lives in this tab). Restoring saves that text as a
 * new version, so finished audio made from it reads as current again.
 */
export function ScriptHistory({
  projectId,
  sceneId,
  currentVersion,
  currentText,
  onRestore,
}: {
  projectId: string;
  sceneId: string;
  currentVersion: number | undefined;
  /** What the editor shows now (a draft included): identical versions cannot be "restored". */
  currentText: string;
  onRestore: (text: string) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ScriptRevision[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuFocus(open && !!list, menuRef, close);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setList(null);
    api.listScriptRevisions(projectId, sceneId).then(
      (revs) => alive && setList(revs),
      (err: unknown) => {
        if (!alive) return;
        toast(errorMessage(err), "error");
        setOpen(false);
      },
    );
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, api, projectId, sceneId]);

  if (!currentVersion || currentVersion < 2) return null;
  return (
    // Not `relative`: the menu spans the script header, so it never runs off the narrow panel.
    <div ref={ref}>
      <Button size="sm" variant="ghost" icon={History} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="script-history">
        {t.script.history}
      </Button>
      {open && (
        <div ref={menuRef} role="menu" className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
          {!list ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-400">
              <Spinner className="size-3.5" /> {t.app.loading}
            </div>
          ) : (
            list.map((rev) => {
              const same = rev.script === currentText;
              return (
              <button
                key={rev.id}
                type="button"
                role="menuitem"
                disabled={same}
                className="block w-full rounded px-3 py-2 text-left hover:bg-neutral-800 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                onClick={() => {
                  setOpen(false);
                  onRestore(rev.script);
                  toast(fmt(t.script.restored, { v: rev.version }), "success");
                }}
              >
                <div className="flex justify-between gap-2 text-xs text-neutral-300">
                  <span>
                    {fmt(t.script.historyItem, { v: rev.version, source: SOURCE[rev.source] })}
                    {rev.version === currentVersion ? (
                      <span className="ml-1 text-neutral-400">{t.script.historyCurrent}</span>
                    ) : same ? (
                      <span className="ml-1 text-neutral-400">{t.script.historySame}</span>
                    ) : null}
                  </span>
                  <span className="text-neutral-400">{formatRelativeTime(rev.createdAt)}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs text-neutral-400">{same ? rev.script : diffSnippet(rev.script, currentText)}</div>
              </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Where a version differs from the current text: 「…最後一句不同的地方」, so similar versions can be told apart. */
export function diffSnippet(version: string, current: string): string {
  const a = Array.from(version);
  const b = Array.from(current);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === 0) return version;
  const tail = a.slice(Math.max(0, i - 8)).join("");
  return i >= a.length ? `…${a.slice(Math.max(0, i - 12)).join("")}（${t.script.historyShorter}）` : `…${tail}`;
}
