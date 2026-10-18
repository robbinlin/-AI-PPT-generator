import { useState } from "react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { t } from "../../i18n";
import { OutlinePanel } from "./OutlinePanel";
import { ScriptPanel } from "./ScriptPanel";
import { SettingsPanel } from "./SettingsPanel";

type Tab = "script" | "settings" | "outline";
const TABS: Tab[] = ["script", "settings", "outline"];
const TAB_KEY = "lvs.editor.tab";

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === "script" || saved === "settings" || saved === "outline") return saved;
  } catch {
    /* storage unavailable */
  }
  return "script";
}

export function RightPanel({ actions }: { actions: EditorActions }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };

  return (
    <aside className="flex min-h-0 flex-col border-l border-neutral-800 bg-neutral-900">
      <div role="tablist" className="flex shrink-0 border-b border-neutral-800 px-2">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => choose(id)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm transition-colors ${
              tab === id ? "border-accent-500 text-neutral-50" : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t.tabs[id]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "script" && <ScriptPanel actions={actions} />}
        {tab === "settings" && <SettingsPanel actions={actions} />}
        {tab === "outline" && <OutlinePanel actions={actions} />}
      </div>
    </aside>
  );
}
