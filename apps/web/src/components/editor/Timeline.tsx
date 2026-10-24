import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, SlidersHorizontal, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import { MAX_TAIL_PAUSE_SEC, type Scene, type Transition } from "@lvs/shared";
import { useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { formatDuration } from "../../lib/format";
import { buildTimeline, computePeaks, type TimelineBlock } from "../../lib/timelineModel";
import { editorStore, useEditor } from "../../store/editorStore";

const LABEL_W = 64;
const TRACK_H = { slides: 44, narration: 40, avatar: 14, subtitles: 18 } as const;

/**
 * Light timeline under the preview: one block per page across slide / narration waveform /
 * avatar / subtitle tracks, sized by narration + tail pause. Click to select a page, drag a
 * slide block to reorder, and use the page menu for tail pause, mute and transition.
 */
export function Timeline({ actions }: { actions: Pick<EditorActions, "reorder" | "updateScene"> }) {
  const detail = useEditor((s) => s.detail);
  const selectedSceneId = useEditor((s) => s.selectedSceneId);
  const currentTime = useEditor((s) => s.playback.currentTime);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [tipSeen, setTipSeen] = useState(() => readFlag(TIP_KEY));
  // Short laptop screens start folded (the preview needs the height); the choice is remembered.
  const [collapsed, setCollapsed] = useState(() => {
    const saved = readValue(COLLAPSE_KEY);
    return saved ? saved === "1" : typeof window !== "undefined" && window.innerHeight < 760;
  });
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      writeValue(COLLAPSE_KEY, v ? "0" : "1");
      return !v;
    });
  // Page length being dragged, or committed and still being saved.
  const [resize, setResize] = useState<ResizeState | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [collapsed]);

  const model = useMemo(
    () => (detail ? buildTimeline(detail.scenes, detail.slides, detail.scripts, resize ?? undefined) : { blocks: [], totalSec: 0 }),
    [detail, resize],
  );

  const commitTail = (sceneId: string, tail: number) => {
    const current = detail?.scenes.find((s) => s.id === sceneId)?.tailPauseSec;
    if (current !== undefined && Math.abs(current - tail) < 0.05) return setResize(null);
    setResize({ sceneId, tail });
    // The store holds the saved scene once this settles (or the old one if saving failed).
    void actions
      .updateScene(sceneId, { tailPauseSec: tail })
      .finally(() => setResize((r) => (r && !r.dragging && r.sceneId === sceneId && r.tail === tail ? null : r)));
  };
  const resizeProps = (b: TimelineBlock): ResizeHandleProps => ({
    block: b,
    pxPerSec,
    state: resize?.sceneId === b.scene.id ? resize : undefined,
    onDrag: (tail, limit) => setResize({ sceneId: b.scene.id, tail, dragging: true, ...(limit ? { limit } : {}) }),
    onCommit: (tail) => commitTail(b.scene.id, tail),
  });
  // Keep the scale fixed while an edge is dragged; refitting would slide the edge out from under the pointer.
  const scaleTotal = useRef(0);
  if (!resize?.dragging) scaleTotal.current = model.totalSec;
  const fitPx = scaleTotal.current > 0 ? Math.max(2, (width - LABEL_W - 16) / scaleTotal.current) : 20;
  // At least ~44 px per page on average, so label, menu button and length handle never pile up.
  const autoZoom = model.blocks.length > 0 ? Math.max(1, (44 * model.blocks.length) / Math.max(1, width - LABEL_W - 16)) : 1;
  const pxPerSec = fitPx * Math.max(zoom, autoZoom);
  const selected = model.blocks.find((b) => b.scene.id === selectedSceneId);
  const playhead = selected ? selected.start + Math.min(currentTime, selected.total) : 0;

  // Keep the selected block in view.
  useEffect(() => {
    if (!selected || !scroller.current) return;
    const el = scroller.current;
    const x = LABEL_W + selected.start * pxPerSec;
    if (x < el.scrollLeft + LABEL_W || x + selected.total * pxPerSec > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.max(0, x - LABEL_W - 24), behavior: "smooth" });
    }
  }, [selected, pxPerSec]);

  if (!detail || model.blocks.length === 0) return null;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = [...detail.slides].sort((a, b) => a.index - b.index).map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    void actions.reorder(arrayMove(ids, from, to));
  };
  const contentW = LABEL_W + model.totalSec * pxPerSec + 16;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900" data-testid="timeline">
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-1.5 text-xs text-neutral-400">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 font-semibold text-neutral-300 hover:bg-neutral-800"
          aria-expanded={!collapsed}
          title={collapsed ? t.timeline.expand : t.timeline.collapse}
          onClick={toggleCollapsed}
          data-testid="timeline-toggle"
        >
          {collapsed ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          {t.timeline.title}
        </button>
        {resize?.dragging ? (
          <ResizeReadout block={model.blocks.find((b) => b.scene.id === resize.sceneId)} state={resize} />
        ) : (
          <span className="tabular-nums">{totalDurationLabel(model)}</span>
        )}
        {collapsed ? (
          <button type="button" className="rounded px-1.5 text-accent-300 hover:bg-neutral-800" onClick={toggleCollapsed}>
            {t.timeline.expand}
          </button>
        ) : (
          <label className="flex items-center gap-1.5">
            <ZoomIn className="size-3.5" aria-hidden />
            <span className="sr-only">{t.timeline.zoom}</span>
            <input type="range" min={1} max={6} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-24 accent-accent-500" aria-label={t.timeline.zoom} />
          </label>
        )}
      </div>
      {collapsed ? null : (
        <>
      {!tipSeen && (
        <div className="flex items-center gap-2 border-b border-neutral-800 bg-accent-500/10 px-3 py-1.5 text-xs text-accent-100" role="note" data-testid="timeline-tip">
          <GripVertical className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{t.timeline.tip}</span>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-200 hover:bg-white/10"
            onClick={() => {
              writeFlag(TIP_KEY);
              setTipSeen(true);
            }}
          >
            <X className="size-3" aria-hidden /> {t.timeline.tipDismiss}
          </button>
        </div>
      )}
      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: contentW }}>
          <Ruler totalSec={model.totalSec} pxPerSec={pxPerSec} />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={model.blocks.map((b) => b.slide.id)} strategy={horizontalListSortingStrategy}>
              <TrackRow label={t.timeline.slides} height={TRACK_H.slides}>
                {model.blocks.map((b) => (
                  <SlideBlock
                    key={b.slide.id}
                    block={b}
                    projectId={detail.project.id}
                    pxPerSec={pxPerSec}
                    selected={b.scene.id === selectedSceneId}
                    onMenu={() => setMenuFor(menuFor === b.scene.id ? null : b.scene.id)}
                    resize={resizeProps(b)}
                  />
                ))}
              </TrackRow>
            </SortableContext>
          </DndContext>
          <TrackRow label={t.timeline.narration} height={TRACK_H.narration}>
            {model.blocks.map((b) => (
              <NarrationBlock
                key={b.scene.id}
                block={b}
                projectId={detail.project.id}
                pxPerSec={pxPerSec}
                selected={b.scene.id === selectedSceneId}
                resize={resizeProps(b)}
              />
            ))}
          </TrackRow>
          {detail.project.settings.avatar.enabled && (
            <TrackRow label={t.timeline.avatar} height={TRACK_H.avatar}>
              {model.blocks.map((b) => (
                <StatusBar key={b.scene.id} block={b} pxPerSec={pxPerSec} status={b.scene.avatar.status} />
              ))}
            </TrackRow>
          )}
          {detail.project.settings.subtitles.enabled && (
            <TrackRow label={t.timeline.subtitles} height={TRACK_H.subtitles}>
              {model.blocks.map((b) => (
                <CueBlock key={b.scene.id} block={b} pxPerSec={pxPerSec} />
              ))}
            </TrackRow>
          )}
          {selected && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-rose-400"
              style={{ left: LABEL_W + playhead * pxPerSec }}
              data-testid="timeline-playhead"
            >
              <span className="absolute -top-0.5 -left-1 size-2 rotate-45 bg-rose-400" />
            </div>
          )}
        </div>
      </div>
      {menuFor && (
        <PageMenu
          block={model.blocks.find((b) => b.scene.id === menuFor)}
          projectTransition={detail.project.settings.transition}
          onClose={() => setMenuFor(null)}
          onChange={(req) => void actions.updateScene(menuFor, req)}
        />
      )}
        </>
      )}
    </div>
  );
}

const COLLAPSE_KEY = "lvs:timeline-collapsed";

function readValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

const TIP_KEY = "lvs:timeline-tip-seen";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: the tip shows again next time, which is harmless.
  }
}

/** "總長 2:47", or "總長約 2:47" while some pages still use the estimated narration length. */
export function totalDurationLabel(model: { blocks: { estimated: boolean }[]; totalSec: number }): string {
  const estimated = model.blocks.some((b) => b.estimated);
  return fmt(estimated ? t.timeline.totalEstimated : t.timeline.total, { time: formatDuration(model.totalSec) });
}

function Ruler({ totalSec, pxPerSec }: { totalSec: number; pxPerSec: number }) {
  // Tick every 5/10/30/60 s depending on zoom, labelled.
  const step = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pxPerSec >= 56) ?? 300;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSec + 0.001; s += step) ticks.push(s);
  return (
    <div className="relative h-5 border-b border-neutral-800 text-xs text-neutral-400" style={{ marginLeft: LABEL_W }}>
      {ticks.map((s) => (
        <span key={s} className="absolute top-0 h-full border-l border-neutral-700 pl-1" style={{ left: s * pxPerSec }}>
          {formatDuration(s)}
        </span>
      ))}
    </div>
  );
}

function TrackRow({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div className="flex border-b border-neutral-800/70" style={{ height }}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center bg-neutral-900 px-2 text-xs text-neutral-400" style={{ width: LABEL_W }}>
        {label}
      </div>
      <div className="relative flex-1">{children}</div>
    </div>
  );
}

function blockStyle(b: TimelineBlock, pxPerSec: number) {
  return { left: b.start * pxPerSec, width: Math.max(4, b.total * pxPerSec - 2) };
}

function SlideBlock({
  block,
  projectId,
  pxPerSec,
  selected,
  onMenu,
  resize,
}: {
  block: TimelineBlock;
  projectId: string;
  pxPerSec: number;
  selected: boolean;
  onMenu: () => void;
  resize: ResizeHandleProps;
}) {
  const thumb = useAssetUrl(projectId, block.slide.thumbnailAssetId ?? block.slide.imageAssetId);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: block.slide.id });
  const style = {
    ...blockStyle(block, pxPerSec),
    transform: CSS.Translate.toString(transform),
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="timeline-slide"
      data-scene-id={block.scene.id}
      className={`group absolute top-1 bottom-1 flex cursor-pointer items-center gap-1 overflow-hidden rounded border bg-neutral-800 ${
        selected ? "border-accent-400 ring-1 ring-accent-400" : "border-neutral-700 hover:border-neutral-500"
      } ${isDragging ? "opacity-80 shadow-lg" : ""}`}
      onClick={() => editorStore.getState().select(block.scene.id)}
    >
      {/* Reorder only from the thumbnail + page number, so a drag near the edge can't move the page by accident. */}
      <span
        {...attributes}
        {...listeners}
        aria-label={fmt(t.timeline.reorderHandle, { n: block.index + 1 })}
        aria-roledescription={t.timeline.sortable}
        title={t.timeline.dragToReorder}
        data-testid="timeline-reorder"
        className="flex h-full shrink-0 cursor-grab items-center gap-1 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none active:cursor-grabbing"
      >
        {thumb && <img src={thumb} alt="" className="h-full shrink-0 object-cover" draggable={false} />}
        <span className="shrink-0 px-1 text-xs font-semibold text-neutral-200">P{block.index + 1}</span>
      </span>
      {block.scene.muted && <VolumeX className="size-3 shrink-0 text-amber-300" aria-label={t.timeline.mute} />}
      <button
        type="button"
        aria-label={fmt(t.timeline.pageMenu, { n: block.index + 1 })}
        className="mr-5 ml-auto shrink-0 rounded bg-black/50 p-0.5 text-neutral-200 opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-400"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          editorStore.getState().select(block.scene.id);
          onMenu();
        }}
      >
        <SlidersHorizontal className="size-3" aria-hidden />
      </button>
      <ResizeHandle {...resize} />
    </div>
  );
}

interface ResizeState {
  sceneId: string;
  tail: number;
  dragging?: boolean;
  /** Set while the drag is pinned at the shortest / longest allowed length. */
  limit?: "min" | "max";
}

interface ResizeHandleProps {
  block: TimelineBlock;
  pxPerSec: number;
  state: ResizeState | undefined;
  onDrag: (tail: number, limit?: "min" | "max") => void;
  onCommit: (tail: number) => void;
  /** False for the duplicate handle on the narration track (one tab stop per page). */
  keyboard?: boolean;
}

const roundTail = (v: number) => Math.round(v * 10) / 10;

/** Tail pause after dragging the page's right edge by `dxPx`, clamped to 0…MAX_TAIL_PAUSE_SEC. */
export function tailAfterDrag(startTail: number, dxPx: number, pxPerSec: number): { tail: number; limit?: "min" | "max" } {
  const raw = startTail + dxPx / pxPerSec;
  if (raw <= 0) return { tail: 0, limit: "min" };
  if (raw >= MAX_TAIL_PAUSE_SEC) return { tail: MAX_TAIL_PAUSE_SEC, limit: "max" };
  return { tail: roundTail(raw) };
}

export function pageLengthLabel(b: TimelineBlock): string {
  const source = b.scene.muted ? t.timeline.sourceHold : b.estimated ? t.timeline.sourceEstimate : t.timeline.sourceVoice;
  return fmt(t.timeline.length, { total: b.total.toFixed(1), source, narration: b.narration.toFixed(1), tail: b.tail.toFixed(1) });
}

/**
 * The page's right edge: drag it to make the page longer or shorter. The narration can't be cut,
 * so the length moves between "narration only" and narration + MAX_TAIL_PAUSE_SEC of hold.
 */
function ResizeHandle({ block, pxPerSec, state, onDrag, onCommit, keyboard = true }: ResizeHandleProps) {
  const start = useRef<{ x: number; tail: number; pxPerSec: number } | null>(null);
  const tail = state?.tail ?? block.tail;
  const dragging = !!state?.dragging;
  const end = (e: React.PointerEvent) => {
    if (!start.current) return;
    const { tail: next } = tailAfterDrag(start.current.tail, e.clientX - start.current.x, start.current.pxPerSec);
    start.current = null;
    onCommit(next);
  };
  return (
    <>
      <div
        role="slider"
        tabIndex={keyboard ? 0 : -1}
        aria-hidden={keyboard ? undefined : true}
        aria-label={fmt(t.timeline.resize, { n: block.index + 1 })}
        aria-valuemin={roundTail(block.narration)}
        aria-valuemax={roundTail(block.narration + MAX_TAIL_PAUSE_SEC)}
        aria-valuenow={roundTail(block.narration + tail)}
        aria-valuetext={pageLengthLabel(block)}
        title={`${pageLengthLabel(block)}\n${t.timeline.resizeHint}`}
        data-testid="timeline-resize"
        className={`absolute inset-y-0 right-0 z-10 flex w-4 cursor-ew-resize touch-none items-center justify-center rounded-r border-l border-neutral-600/60 hover:bg-accent-400/40 focus-visible:bg-accent-400/50 focus-visible:outline-none ${
          dragging ? "bg-accent-400/40" : "bg-neutral-700/70"
        }`}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { x: e.clientX, tail: block.tail, pxPerSec };
          onDrag(block.tail);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const r = tailAfterDrag(start.current.tail, e.clientX - start.current.x, start.current.pxPerSec);
          onDrag(r.tail, r.limit);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const step = (e.shiftKey ? 0.1 : 0.5) * (e.key === "ArrowLeft" ? -1 : 1);
          onCommit(roundTail(Math.min(MAX_TAIL_PAUSE_SEC, Math.max(0, block.tail + step))));
        }}
      >
        <GripVertical className={`size-3.5 ${dragging ? "text-accent-100" : "text-neutral-300"}`} aria-hidden />
      </div>
    </>
  );
}

/** Live readout in the timeline header while a page edge is being dragged. */
function ResizeReadout({ block, state }: { block: TimelineBlock | undefined; state: ResizeState }) {
  if (!block) return null;
  return (
    <span className="min-w-0 truncate text-accent-200" role="status" data-testid="timeline-resize-readout">
      {pageLengthLabel(block)}
      {state.limit === "min" && <span className="ml-2 text-amber-300">{t.timeline.atMinimum}</span>}
      {state.limit === "max" && <span className="ml-2 text-amber-300">{fmt(t.timeline.atMaximum, { max: MAX_TAIL_PAUSE_SEC })}</span>}
    </span>
  );
}

const peaksCache = new Map<string, Promise<number[]>>();

function usePeaks(url: string | undefined, buckets: number): number[] | undefined {
  const [peaks, setPeaks] = useState<number[]>();
  useEffect(() => {
    if (!url) return setPeaks(undefined);
    let alive = true;
    const key = `${url}#${buckets}`;
    let p = peaksCache.get(key);
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then(async (buf) => {
          const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const ctx = new AC();
          try {
            const audio = await ctx.decodeAudioData(buf);
            return computePeaks(audio.getChannelData(0), buckets);
          } finally {
            void ctx.close();
          }
        });
      peaksCache.set(key, p);
      p.catch(() => peaksCache.delete(key));
    }
    p.then((v) => alive && setPeaks(v)).catch(() => alive && setPeaks(undefined));
    return () => {
      alive = false;
    };
  }, [url, buckets]);
  return peaks;
}

function NarrationBlock({
  block,
  projectId,
  pxPerSec,
  selected,
  resize,
}: {
  block: TimelineBlock;
  projectId: string;
  pxPerSec: number;
  selected: boolean;
  resize: ResizeHandleProps;
}) {
  const ready = !block.scene.muted && block.scene.audio.status !== "missing" ? block.scene.audio.assetId : undefined;
  const url = useAssetUrl(projectId, ready);
  const narrW = Math.max(2, block.narration * pxPerSec);
  const buckets = Math.min(400, Math.max(16, Math.round(narrW / 3)));
  const peaks = usePeaks(url, buckets);
  const stale = block.scene.audio.status === "stale";
  return (
    <div
      className="absolute top-1 bottom-1 flex overflow-hidden rounded"
      style={blockStyle(block, pxPerSec)}
      onClick={() => editorStore.getState().select(block.scene.id)}
      title={block.estimated ? `${t.timeline.estimated} ${formatDuration(block.narration)}` : formatDuration(block.narration)}
    >
      <div
        className={`relative h-full ${block.estimated ? "border border-dashed border-neutral-600 bg-neutral-800/40" : stale ? "bg-amber-500/15" : "bg-emerald-500/15"} ${
          selected ? "ring-1 ring-accent-400/70" : ""
        }`}
        style={{ width: narrW }}
      >
        {peaks ? (
          <svg className="absolute inset-0 size-full" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" aria-hidden>
            {peaks.map((v, i) => (
              <rect key={i} x={i + 0.15} width={0.7} y={50 - v * 46} height={Math.max(1, v * 92)} className={stale ? "fill-amber-300/80" : "fill-emerald-300/80"} />
            ))}
          </svg>
        ) : (
          <span className="absolute inset-0 flex items-center px-1 text-xs text-neutral-400">{block.scene.muted ? t.player.mutedScene : t.timeline.noAudio}</span>
        )}
      </div>
      {block.tail > 0 && (
        <div
          className="h-full shrink-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(255,255,255,0.06)_3px,rgba(255,255,255,0.06)_6px)]"
          style={{ width: Math.max(0, block.tail * pxPerSec - 2) }}
          title={`${t.timeline.tailPause} ${block.tail.toFixed(1)}s`}
        />
      )}
      {/* Same edge as the slide block above; only that one is a keyboard stop. */}
      <ResizeHandle {...resize} keyboard={false} />
    </div>
  );
}

function StatusBar({ block, pxPerSec, status }: { block: TimelineBlock; pxPerSec: number; status: Scene["avatar"]["status"] }) {
  const color =
    status === "ready" ? "bg-sky-500/70" : status === "stale" ? "bg-amber-400/70" : status === "failed" ? "bg-rose-500/70" : status === "missing" ? "bg-neutral-700/60" : "bg-sky-300/40";
  return <div className={`absolute top-0.5 bottom-0.5 rounded-sm ${color}`} style={{ left: block.start * pxPerSec, width: Math.max(2, block.narration * pxPerSec - 2) }} />;
}

function CueBlock({ block, pxPerSec }: { block: TimelineBlock; pxPerSec: number }) {
  const cues = block.scene.subtitle.cues ?? [];
  return (
    <>
      {cues.map((c) => (
        <div
          key={c.index}
          title={c.text}
          className="absolute top-0.5 bottom-0.5 truncate rounded-sm bg-violet-500/30 px-0.5 text-[10px] leading-[14px] text-violet-50"
          style={{ left: (block.start + c.startSec) * pxPerSec, width: Math.max(2, (c.endSec - c.startSec) * pxPerSec - 1) }}
        >
          {c.text}
        </div>
      ))}
    </>
  );
}

/** Page length in seconds; anything below the narration snaps back to it. */
function PageLengthInput({ block, onCommit }: { block: TimelineBlock; onCommit: (total: number) => void }) {
  const [value, setValue] = useState(block.total.toFixed(1));
  const min = roundTail(block.narration);
  const commit = () => {
    const n = Number(value);
    if (!Number.isFinite(n)) return setValue(block.total.toFixed(1));
    const total = Math.max(min, n);
    setValue(total.toFixed(1));
    if (Math.abs(total - block.total) >= 0.05) onCommit(total);
  };
  return (
    <label className="flex items-center gap-1" title={`${pageLengthLabel(block)}\n${t.timeline.atMinimum}`}>
      {t.timeline.pageLength}
      <input
        type="number"
        min={min}
        max={roundTail(block.narration + MAX_TAIL_PAUSE_SEC)}
        step={0.5}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-16 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-right tabular-nums"
        data-testid="timeline-page-length"
      />
      <span className="text-neutral-500">{t.timeline.seconds}</span>
    </label>
  );
}

function PageMenu({
  block,
  projectTransition,
  onClose,
  onChange,
}: {
  block: TimelineBlock | undefined;
  projectTransition: Transition;
  onClose: () => void;
  onChange: (req: { tailPauseSec?: number; muted?: boolean; transitionIn?: Transition | null }) => void;
}) {
  if (!block) return null;
  const s = block.scene;
  const tail = s.tailPauseSec ?? 0.5;
  const setTail = (v: number) => onChange({ tailPauseSec: roundTail(Math.min(MAX_TAIL_PAUSE_SEC, Math.max(0, v))) });
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-neutral-800 px-3 py-2 text-xs text-neutral-300" data-testid="timeline-page-menu">
      <span className="font-semibold">{fmt(t.timeline.pageMenu, { n: block.index + 1 })}</span>
      <PageLengthInput key={`${s.id}:${block.total}`} block={block} onCommit={(total) => setTail(total - block.narration)} />
      <label className="flex items-center gap-1">
        {t.timeline.tailPause}
        <button type="button" className="rounded border border-neutral-700 px-1.5" onClick={() => setTail(tail - 0.5)} aria-label="-0.5s">
          −
        </button>
        <span className="w-10 text-center tabular-nums">{tail.toFixed(1)}s</span>
        <button type="button" className="rounded border border-neutral-700 px-1.5" onClick={() => setTail(tail + 0.5)} aria-label="+0.5s">
          +
        </button>
      </label>
      <button type="button" className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 hover:border-neutral-500" onClick={() => onChange({ muted: !s.muted })}>
        {s.muted ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
        {s.muted ? t.timeline.unmute : t.timeline.mute}
      </button>
      <label className="flex items-center gap-1">
        {t.timeline.transition}
        <select
          className="rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5"
          value={s.transitionIn ?? ""}
          onChange={(e) => onChange({ transitionIn: e.target.value === "" ? null : (e.target.value as Transition) })}
        >
          <option value="">{`${t.options.transition[projectTransition]}（全片設定）`}</option>
          <option value="none">{t.options.transition.none}</option>
          <option value="fade">{t.options.transition.fade}</option>
        </select>
      </label>
      <button type="button" className="ml-auto text-neutral-500 hover:text-neutral-200" onClick={onClose}>
        {t.common.close}
      </button>
    </div>
  );
}
