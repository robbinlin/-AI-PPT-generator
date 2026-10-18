import { useCallback, useEffect, useRef } from "react";

export const AUTOSAVE_DELAY_MS = 800;

export type SaveScript = (sceneId: string, text: string) => Promise<void> | void;

interface Pending {
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Debounced autosave for script drafts. Each scene has its own timer: a change restarts that
 * scene's timer, and `delayMs` after the last change `save(sceneId, text)` runs once with the
 * latest text. Pending saves are flushed on unmount (e.g. leaving the editor).
 */
export function useScriptAutosave(
  drafts: Readonly<Record<string, string>>,
  save: SaveScript,
  delayMs: number = AUTOSAVE_DELAY_MS,
): { flush: () => void } {
  const pending = useRef(new Map<string, Pending>());
  /** Text most recently handed to `save` per scene, so an unchanged draft is not re-sent. */
  const sent = useRef(new Map<string, string>());
  const saveRef = useRef(save);
  saveRef.current = save;

  const fire = useCallback((sceneId: string) => {
    const p = pending.current.get(sceneId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(sceneId);
    sent.current.set(sceneId, p.text);
    void saveRef.current(sceneId, p.text);
  }, []);

  useEffect(() => {
    const map = pending.current;
    for (const [sceneId, text] of Object.entries(drafts)) {
      const p = map.get(sceneId);
      if (p && p.text === text) continue;
      if (p) clearTimeout(p.timer);
      if (!p && sent.current.get(sceneId) === text) continue;
      map.set(sceneId, { text, timer: setTimeout(() => fire(sceneId), delayMs) });
    }
    // A draft that disappeared (saved, or undone back to the saved text) needs no save.
    for (const [sceneId, p] of map) {
      if (!(sceneId in drafts)) {
        clearTimeout(p.timer);
        map.delete(sceneId);
      }
    }
    for (const sceneId of [...sent.current.keys()]) {
      if (!(sceneId in drafts)) sent.current.delete(sceneId);
    }
  }, [drafts, delayMs, fire]);

  const flush = useCallback(() => {
    for (const sceneId of [...pending.current.keys()]) fire(sceneId);
  }, [fire]);

  useEffect(() => flush, [flush]);

  return { flush };
}
