import { useEffect, useMemo, useRef } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Scene, Slide } from "@lvs/shared";
import { useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { sortByIndex } from "../../lib/scenes";
import { currentScript, useEditor } from "../../store/editorStore";
import { PageListItem } from "./PageListItem";
import { openEditorTab } from "./RightPanel";
import { StatusLegend } from "./StatusDots";

export interface PageListProps {
  actions: Pick<EditorActions, "reorder" | "setHidden" | "updateScene">;
}

export function PageList({ actions }: PageListProps) {
  const detail = useEditor((s) => s.detail);
  const drafts = useEditor((s) => s.drafts);
  const selectedSceneId = useEditor((s) => s.selectedSceneId);
  const select = useEditor((s) => s.select);

  const slides = useMemo(() => (detail ? sortByIndex(detail.slides) : []), [detail]);
  const sceneBySlide = useMemo(() => new Map((detail?.scenes ?? []).map((s) => [s.slideId, s])), [detail]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const listRef = useRef<HTMLElement>(null);
  // Keep the selected page in view when it changes from the keyboard; when focus is in the list,
  // move it along (roving focus: one Tab stop for the whole list).
  useEffect(() => {
    if (!selectedSceneId) return;
    const el = document.querySelector(`[data-scene-id="${selectedSceneId}"]`);
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest" });
    if (listRef.current?.contains(document.activeElement)) el?.querySelector<HTMLElement>("[data-page-button]")?.focus();
  }, [selectedSceneId]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = slides.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    void actions.reorder(arrayMove(ids, from, to));
  };

  return (
    <aside ref={listRef} className="flex min-h-0 flex-col border-r border-neutral-800 bg-neutral-900">
      {/* Keyboard users can jump past the page list straight to the script. */}
      <button
        type="button"
        className="sr-only focus:not-sr-only focus:m-2 focus:rounded focus:bg-accent-600 focus:px-2 focus:py-1 focus:text-xs focus:text-white"
        onClick={() => {
          openEditorTab("script");
          setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 50);
        }}
        data-testid="skip-to-script"
      >
        {t.pageList.skipToScript}
      </button>
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-xs font-semibold text-neutral-300">{t.pageList.title}</h2>
        <span className="text-xs text-neutral-400">
          {/* Hidden pages are not exported: say how many are in use. */}
          {slides.some((sl) => sl.hidden) ? fmt(t.pageList.activeCount, { active: slides.filter((sl) => !sl.hidden).length, n: slides.length }) : slides.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {slides.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-neutral-400">{t.editor.noScenes}</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={slides.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ol className="flex flex-col gap-1">
                {slides.map((slide, i) => {
                  const scene = sceneBySlide.get(slide.id);
                  return (
                    <SortablePage
                      key={slide.id}
                      projectId={slide.projectId}
                      slide={slide}
                      scene={scene}
                      position={i + 1}
                      scriptText={scene ? currentScript({ detail, drafts }, scene.id) : ""}
                      selected={scene !== undefined && scene.id === selectedSceneId}
                      onSelect={() => scene && select(scene.id)}
                      onToggleHidden={() => void actions.setHidden(slide.id, !slide.hidden)}
                      onToggleMuted={() => scene && void actions.updateScene(scene.id, { muted: !scene.muted })}
                    />
                  );
                })}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>
      {/* Folded on short laptop screens so more pages fit; one click shows it. */}
      <details className="group border-t border-neutral-800 px-3 py-1.5" open={typeof window === "undefined" || window.innerHeight >= 800} data-testid="status-legend">
        <summary className="cursor-pointer text-xs text-neutral-400 select-none hover:text-neutral-300">{t.pageList.legend}</summary>
        <div className="mt-1">
          <StatusLegend />
        </div>
      </details>
    </aside>
  );
}

interface SortablePageProps {
  projectId: string;
  slide: Slide;
  scene: Scene | undefined;
  position: number;
  scriptText: string;
  selected: boolean;
  onSelect: () => void;
  onToggleHidden: () => void;
  onToggleMuted: () => void;
}

function SortablePage({ projectId, ...rest }: SortablePageProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rest.slide.id });
  const thumbnailUrl = useAssetUrl(projectId, rest.slide.thumbnailAssetId ?? rest.slide.imageAssetId);
  return (
    <PageListItem
      {...rest}
      thumbnailUrl={thumbnailUrl}
      setNodeRef={setNodeRef}
      dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      dragAttributes={attributes}
      dragListeners={listeners}
    />
  );
}
