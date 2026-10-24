import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Asset, AvatarLayout, DerivedStatus, Project, Scene, Slide } from "@lvs/shared";
import { EyeOff, ImageOff, Move, UserRound } from "lucide-react";
import { useAssetUrl } from "../../api/context";
import { CHROMA_PROVIDERS, KeyedVideo, SyncedVideo } from "./KeyedVideo";
import { t } from "../../i18n";
import { avatarBox, moveTo, resizeTo, slideBox, type Box } from "../../lib/avatarGeometry";
import { effectiveAvatarLayout, firstSubtitleCue } from "../../lib/scenes";
import { subtitleCss } from "../../lib/studioPresets";

const RATIOS: Record<Project["settings"]["aspectRatio"], number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };

export interface SlidePreviewProps {
  project: Project;
  slide: Slide;
  scene: Scene | undefined;
  subtitleText: string | undefined;
  /** True when subtitleText is already a timed cue (shown as-is, may be empty between cues). */
  subtitleIsCue?: boolean;
  assets: Record<string, Asset>;
  /** Still image of the chosen character, shown until a clip has been generated for this page. */
  avatarPreviewUrl?: string;
  /** When given, the avatar can be dragged and resized; called once when the gesture ends. */
  onLayoutCommit?: (layout: AvatarLayout) => void;
}

const pct = (v: number) => `${v * 100}%`;
const boxStyle = (b: Box): CSSProperties => ({ left: pct(b.left), top: pct(b.top), width: pct(b.width), height: pct(b.height) });

/** The video frame: slide (optionally scaled beside the avatar), avatar and subtitle, as the renderer composes them. */
export function SlidePreview({
  project,
  slide,
  scene,
  subtitleText,
  subtitleIsCue = false,
  assets,
  avatarPreviewUrl,
  onLayoutCommit,
}: SlidePreviewProps) {
  const imageUrl = useAssetUrl(project.id, slide.imageAssetId);
  const ratio = RATIOS[project.settings.aspectRatio];
  const { avatar, subtitles } = project.settings;
  const saved = effectiveAvatarLayout(project, scene);
  const [draft, setDraft] = useState<AvatarLayout | null>(null);
  useEffect(() => setDraft(null), [saved]);
  const layout = draft ?? saved;
  const showAvatar = avatar.enabled && layout.visible;
  const slideRect = slideBox(showAvatar ? layout : undefined, ratio);
  const cue = subtitleIsCue ? (subtitleText ?? "") : firstSubtitleCue(subtitleText, subtitles.style.maxCharsPerLine);

  return (
    <div className="flex size-full items-center justify-center [container-type:size]">
      <div
        data-testid="video-frame"
        className="relative overflow-hidden rounded-md shadow-lg ring-1 ring-neutral-800 [container-type:size]"
        style={{
          width: `min(100cqw, calc(100cqh * ${ratio}))`,
          aspectRatio: String(ratio),
          backgroundColor: project.settings.backgroundColor ?? "#000000",
        }}
      >
        <div className="absolute" style={boxStyle(slideRect)} data-testid="slide-box">
          {imageUrl ? (
            <img src={imageUrl} alt={slide.content.title ?? ""} className="size-full object-contain" draggable={false} />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-2 text-neutral-500">
              <ImageOff className="size-8" aria-hidden />
              <span className="text-xs">{t.preview.noImage}</span>
            </div>
          )}
        </div>
        {showAvatar && (
          <AvatarOverlay
            projectId={project.id}
            layout={layout}
            ratio={ratio}
            // An outdated clip may show a different presenter (an earlier choice): only a current
            // clip plays; otherwise the selected presenter's still stands in, dimmed and labelled.
            asset={scene?.avatar.assetId && scene.avatar.status === "ready" ? assets[scene.avatar.assetId] : undefined}
            stillUrl={avatarPreviewUrl}
            status={scene?.avatar.status ?? "missing"}
            onDraft={onLayoutCommit ? setDraft : undefined}
            onCommit={onLayoutCommit}
          />
        )}
        {subtitles.enabled && cue && <SubtitleOverlay text={cue} style={subtitles.style} />}
        {slide.hidden && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 text-sm text-neutral-200">
            <EyeOff className="size-4" aria-hidden /> {t.preview.hiddenOverlay}
          </div>
        )}
      </div>
    </div>
  );
}

function AvatarOverlay({
  projectId,
  layout,
  ratio,
  asset,
  stillUrl,
  status,
  onDraft,
  onCommit,
}: {
  projectId: string;
  layout: AvatarLayout;
  ratio: number;
  asset: Asset | undefined;
  stillUrl?: string;
  /** The scene's avatar state: anything but ready is left out of the export, so say so. */
  status: DerivedStatus;
  onDraft?: (l: AvatarLayout) => void;
  onCommit?: (l: AvatarLayout) => void;
}) {
  const url = useAssetUrl(projectId, asset?.id);
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ kind: "move" | "resize"; frame: DOMRect; dx: number; dy: number; last: AvatarLayout } | null>(null);
  const editable = !!onCommit;
  const box = avatarBox(layout, ratio);
  const circle = layout.shape === "circle";
  const keyed = !!asset?.producedBy.providerId && CHROMA_PROVIDERS.has(asset.producedBy.providerId);
  // A generated clip on a keyed green screen is shown without a frame, like the render.
  const framed = circle || !url;

  const start = (kind: "move" | "resize") => (e: ReactPointerEvent) => {
    if (!editable) return;
    const frame = ref.current?.parentElement?.getBoundingClientRect();
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer: moves still arrive while over the box */
    }
    const cx = frame.left + (box.left + box.width / 2) * frame.width;
    const cy = frame.top + (box.top + box.height / 2) * frame.height;
    gesture.current = { kind, frame, dx: e.clientX - cx, dy: e.clientY - cy, last: layout };
  };
  const move = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const { frame } = g;
    let next: AvatarLayout;
    if (g.kind === "move") {
      next = moveTo(layout, ratio, (e.clientX - g.dx - frame.left) / frame.width, (e.clientY - g.dy - frame.top) / frame.height);
    } else {
      // Distance from the box centre to the pointer sets the new half-height.
      const cx = frame.left + (box.left + box.width / 2) * frame.width;
      const cy = frame.top + (box.top + box.height / 2) * frame.height;
      const halfW = Math.abs(e.clientX - cx) / frame.width;
      const halfH = Math.abs(e.clientY - cy) / frame.height;
      const aspect = circle ? 1 : 0.75;
      const size = Math.max(halfH * 2, (halfW * 2 * ratio) / aspect);
      next = resizeTo(layout, ratio, size);
    }
    g.last = next;
    onDraft?.(next);
  };
  const end = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    if (g.last.x !== layout.x || g.last.y !== layout.y || g.last.size !== layout.size) onCommit?.(g.last);
  };

  return (
    <div
      ref={ref}
      data-testid="avatar-overlay"
      data-anchor={layout.anchor}
      data-shape={layout.shape}
      className={`group absolute ${editable ? "cursor-move touch-none" : ""}`}
      style={boxStyle(box)}
      title={editable ? t.studio.dragHint : t.preview.avatar}
      onPointerDown={start("move")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className={`size-full overflow-hidden ${circle ? "rounded-full" : "rounded-md"} ${
          framed ? "border-2 border-white/70 bg-neutral-700/80 shadow-lg" : ""
        } ${status === "ready" ? "" : "opacity-50"}`}
      >
        {url && asset?.mimeType.startsWith("video/") && keyed ? (
          <KeyedVideo src={url} poster={stillUrl} className="size-full object-cover object-top" />
        ) : url && asset?.mimeType.startsWith("video/") ? (
          <SyncedVideo src={url} className="size-full object-cover" />
        ) : url || stillUrl ? (
          <img src={url ?? stillUrl} alt={t.preview.avatar} className={`size-full object-cover ${circle ? "" : "object-top"}`} draggable={false} />
        ) : (
          <div className="flex size-full items-center justify-center">
            <UserRound className="size-1/2 text-neutral-300" aria-hidden />
          </div>
        )}
      </div>
      {status !== "ready" && (
        <span
          data-testid="avatar-status-badge"
          // Top edge of the avatar: the bottom is where subtitles usually sit.
          className="pointer-events-none absolute inset-x-0 top-1 z-10 mx-auto w-fit max-w-full rounded bg-black/80 px-1.5 py-0.5 text-center text-xs leading-tight font-medium text-amber-200"
        >
          {status === "missing"
            ? t.preview.avatarMissing
            : status === "queued" || status === "generating"
              ? `${t.status.avatar}${t.status[status]}`
              : t.preview.avatarStale}
        </span>
      )}
      {editable && (
        <>
          <span className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent-400/0 transition group-hover:ring-accent-400/80" />
          <span className="pointer-events-none absolute top-1 left-1 hidden rounded bg-black/60 p-0.5 text-white group-hover:block">
            <Move className="size-3" aria-hidden />
          </span>
          <span
            data-testid="avatar-resize"
            role="slider"
            tabIndex={0}
            aria-label={t.studio.resizeHandle}
            aria-valuemin={10}
            aria-valuemax={100}
            aria-valuenow={Math.round(layout.size * 100)}
            aria-valuetext={`${Math.round(layout.size * 100)}%`}
            title={t.studio.resizeKeys}
            // Always visible (not hover-only) and operable with the arrow keys.
            className="absolute -right-1.5 -bottom-1.5 size-4 cursor-nwse-resize rounded-sm border-2 border-white bg-accent-500 opacity-80 shadow transition group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-300 focus-visible:outline-none"
            onKeyDown={(e) => {
              const step = e.key === "ArrowUp" || e.key === "ArrowRight" ? 0.02 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -0.02 : 0;
              if (!step) return;
              e.preventDefault();
              e.stopPropagation();
              onCommit?.(resizeTo(layout, ratio, Math.min(1, Math.max(0.1, layout.size + step))));
            }}
            onPointerDown={start("resize")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        </>
      )}
    </div>
  );
}

function SubtitleOverlay({ text, style }: { text: string; style: Project["settings"]["subtitles"]["style"] }) {
  // Style sizes are specified for a 1080-px-tall frame; scale with the preview's height.
  const scale = (px: number) => `${(px / 1080) * 100}cqh`;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex justify-center px-[4%]"
      style={style.position === "top" ? { top: scale(style.marginPx) } : { bottom: scale(style.marginPx) }}
    >
      <p
        data-testid="subtitle-preview"
        className="rounded px-[0.5em] py-[0.15em] text-center leading-snug whitespace-pre-line"
        style={{ ...subtitleCss(style, scale), fontFamily: `${style.fontFamily}, sans-serif` }}
      >
        {text}
      </p>
    </div>
  );
}
