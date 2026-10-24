import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import type { Scene, Slide } from "@lvs/shared";
import { Eye, EyeOff, GripVertical, ImageOff, MoreHorizontal, Volume2, VolumeX } from "lucide-react";
import { fmt, t } from "../../i18n";
import { firstLine } from "../../lib/scenes";
import { StatusDots, StatusSummary } from "./StatusDots";

export interface PageListItemProps {
  slide: Slide;
  scene: Scene | undefined;
  /** Display position, 1-based. */
  position: number;
  scriptText: string;
  thumbnailUrl: string | undefined;
  selected: boolean;
  onSelect: () => void;
  onToggleHidden: () => void;
  onToggleMuted: () => void;
  /** Sortable wiring from dnd-kit; omitted in static renders. */
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  style?: CSSProperties;
  setNodeRef?: (el: HTMLElement | null) => void;
  dragging?: boolean;
}

export function PageListItem(props: PageListItemProps) {
  const { slide, scene, position, scriptText, thumbnailUrl, selected, dragging = false } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const line = firstLine(scriptText);
  const muted = scene?.muted ?? false;

  return (
    <li
      ref={props.setNodeRef}
      style={props.style}
      data-scene-id={scene?.id}
      aria-current={selected ? "true" : undefined}
      className={`group relative rounded-lg border p-2 transition-colors ${
        selected ? "border-accent-500 bg-accent-500/10" : "border-transparent hover:bg-neutral-800/60"
      } ${dragging ? "z-10 opacity-80 shadow-xl" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={props.onSelect}
        aria-label={fmt(t.editor.pageOf, { n: position })}
      >
        <div className={`relative aspect-video overflow-hidden rounded-md bg-neutral-800 ${slide.hidden ? "opacity-40" : ""}`}>
          {thumbnailUrl ? (
            <img src={thumbnailUrl} alt="" className="size-full object-cover" draggable={false} />
          ) : (
            <div className="flex size-full items-center justify-center">
              <ImageOff className="size-5 text-neutral-600" aria-hidden />
            </div>
          )}
          <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white">
            P{position}
          </span>
          <span className="absolute top-1 right-1 flex gap-1">
            {slide.hidden && (
              <span title={t.pageList.hidden} className="rounded bg-black/70 p-0.5">
                <EyeOff className="size-3 text-neutral-200" aria-label={t.pageList.hidden} />
              </span>
            )}
            {muted && (
              <span title={t.pageList.muted} className="rounded bg-black/70 p-0.5">
                <VolumeX className="size-3 text-neutral-200" aria-label={t.pageList.muted} />
              </span>
            )}
          </span>
        </div>
        <p className={`mt-1.5 line-clamp-2 text-xs leading-snug [@media(max-height:800px)]:line-clamp-1 ${line ? "text-neutral-300" : "text-neutral-500 italic"}`}>
          {line || t.pageList.noScript}
        </p>
        {scene && <StatusSummary scene={scene} />}
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        {scene ? <StatusDots scene={scene} /> : <span />}
        <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
          <button
            type="button"
            aria-label={t.pageList.actions}
            title={t.pageList.actions}
            className="rounded p-0.5 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.pageList.dragHandle}
            title={t.pageList.dragHandle}
            className="cursor-grab touch-none rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100 active:cursor-grabbing"
            {...props.dragAttributes}
            {...props.dragListeners}
          >
            <GripVertical className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      {menuOpen && (
        <PageMenu
          hidden={slide.hidden}
          muted={muted}
          canMute={scene !== undefined}
          onClose={() => setMenuOpen(false)}
          onToggleHidden={props.onToggleHidden}
          onToggleMuted={props.onToggleMuted}
        />
      )}
    </li>
  );
}

interface PageMenuProps {
  hidden: boolean;
  muted: boolean;
  canMute: boolean;
  onClose: () => void;
  onToggleHidden: () => void;
  onToggleMuted: () => void;
}

function PageMenu({ hidden, muted, canMute, onClose, onToggleHidden, onToggleMuted }: PageMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40";
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute right-2 bottom-8 z-20 w-36 overflow-hidden rounded-md border border-neutral-700 bg-neutral-800 py-1 shadow-xl"
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onToggleHidden();
          onClose();
        }}
      >
        {hidden ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
        {hidden ? t.pageList.unhide : t.pageList.hide}
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        disabled={!canMute}
        onClick={() => {
          onToggleMuted();
          onClose();
        }}
      >
        {muted ? <Volume2 className="size-3.5" aria-hidden /> : <VolumeX className="size-3.5" aria-hidden />}
        {muted ? t.pageList.unmute : t.pageList.mute}
      </button>
    </div>
  );
}
