import { useEffect, useRef, useState } from "react";
import { confirmDiscard } from "../../lib/unsavedGuard";
import type { EditorActions } from "../../hooks/useEditorActions";
import { t } from "../../i18n";
import { OutlinePanel } from "./OutlinePanel";
import { ScriptPanel } from "./ScriptPanel";
import { SettingsPanel } from "./SettingsPanel";
import { StudioPanel } from "./StudioPanel";

export type Tab = "script" | "studio" | "settings" | "outline";
/** Work order: plan the outline, write the scripts, pick voice/avatar, fine-tune. */
const TABS: Tab[] = ["outline", "script", "studio", "settings"];
const TAB_KEY = "lvs.editor.tab";
export const OPEN_TAB_EVENT = "lvs:open-tab";

/** Lets other parts of the editor (the step bar) switch the right panel's tab. */
export function openEditorTab(tab: Tab): void {
  window.dispatchEvent(new CustomEvent<Tab>(OPEN_TAB_EVENT, { detail: tab }));
}

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved && (TABS as string[]).includes(saved)) return saved as Tab;
  } catch {
    /* storage unavailable */
  }
  return "script";
}

export function RightPanel({ actions }: { actions: EditorActions }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabRef = useRef(tab);
  const panelRef = useRef<HTMLDivElement>(null);
  // Each tab opens at its top (the same scroll container is reused between tabs).
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [tab]);
  const choose = async (next: Tab) => {
    // Switching tabs unmounts the panel: unsaved glossary edits would vanish silently.
    if (next !== tabRef.current && !(await confirmDiscard())) return;
    tabRef.current = next;
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const onOpen = (e: Event) => {
      const next = (e as CustomEvent<Tab>).detail;
      if ((TABS as string[]).includes(next)) void choose(next);
    };
    window.addEventListener(OPEN_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TAB_EVENT, onOpen);
  }, []);

  return (
    <aside className="flex min-h-0 flex-col border-l border-neutral-800 bg-neutral-900">
      <div
        role="tablist"
        className="flex shrink-0 border-b border-neutral-800 px-2"
        // Tabs pattern: ←／→／Home／End move between tabs (one Tab stop for the row).
        onKeyDown={(e) => {
          const i = TABS.indexOf(tab);
          const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : undefined;
          if (!next) return;
          e.preventDefault();
          void choose(next).then(() => document.getElementById(`tab-${tabRef.current}`)?.focus());
        }}
      >
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            aria-controls={`panel-${id}`}
            onClick={() => void choose(id)}
            className={`-mb-px border-b-2 px-2.5 py-2.5 text-sm whitespace-nowrap transition-colors ${
              tab === id ? "border-accent-500 text-neutral-50" : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t.tabs[id]}
          </button>
        ))}
      </div>
      <div ref={panelRef} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "script" && <ScriptPanel actions={actions} />}
        {tab === "studio" && <StudioPanel actions={actions} />}
        {tab === "settings" && <SettingsPanel actions={actions} />}
        {tab === "outline" && <OutlinePanel actions={actions} />}
      </div>
    </aside>
  );
}
