import type { CSSProperties } from "react";
import type { Asset, AvatarLayout, Project, Scene, Slide } from "@lvs/shared";
import { EyeOff, ImageOff, UserRound } from "lucide-react";
import { useAssetUrl } from "../../api/context";
import { t } from "../../i18n";
import { effectiveAvatarLayout, firstSubtitleCue } from "../../lib/scenes";

const RATIOS: Record<Project["settings"]["aspectRatio"], number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };

/** Fraction of frame width a rect avatar takes relative to its height (portrait 3:4). */
const RECT_ASPECT = 0.75;

export interface SlidePreviewProps {
  project: Project;
  slide: Slide;
  scene: Scene | undefined;
  subtitleText: string | undefined;
  /** True when subtitleText is already a timed cue (shown as-is, may be empty between cues). */
  subtitleIsCue?: boolean;
  assets: Record<string, Asset>;
}

/** The video frame: slide image letterboxed into the project aspect ratio, avatar and subtitle on top. */
export function SlidePreview({ project, slide, scene, subtitleText, subtitleIsCue = false, assets }: SlidePreviewProps) {
  const imageUrl = useAssetUrl(project.id, slide.imageAssetId);
  const ratio = RATIOS[project.settings.aspectRatio];
  const { avatar, subtitles } = project.settings;
  const layout = effectiveAvatarLayout(project, scene);
  const cue = subtitleIsCue ? (subtitleText ?? "") : firstSubtitleCue(subtitleText, subtitles.style.maxCharsPerLine);

  return (
    <div className="flex size-full items-center justify-center [container-type:size]">
      <div
        data-testid="video-frame"
        className="relative overflow-hidden rounded-md bg-black shadow-lg ring-1 ring-neutral-800 [container-type:size]"
        style={{ width: `min(100cqw, calc(100cqh * ${ratio}))`, aspectRatio: String(ratio) }}
      >
        {imageUrl ? (
          <img src={imageUrl} alt={slide.content.title ?? ""} className="size-full object-contain" draggable={false} />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-neutral-500">
            <ImageOff className="size-8" aria-hidden />
            <span className="text-xs">{t.preview.noImage}</span>
          </div>
        )}
        {avatar.enabled && layout.visible && (
          <AvatarOverlay
            projectId={project.id}
            layout={layout}
            ratio={ratio}
            asset={scene?.avatar.assetId ? assets[scene.avatar.assetId] : undefined}
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

/** Position/size of the avatar box as percentages of the frame. Sizes are fractions of frame height. */
export function avatarBoxStyle(layout: AvatarLayout, ratio: number): CSSProperties {
  const heightPct = layout.size * 100;
  const widthPct = ((layout.shape === "circle" ? 1 : RECT_ASPECT) * layout.size * 100) / ratio;
  const marginY = `${layout.margin * 100}%`;
  const marginX = `${(layout.margin * 100) / ratio}%`;
  const style: CSSProperties = { height: `${heightPct}%`, width: `${widthPct}%` };
  const [vertical, horizontal] = layout.anchor.includes("-")
    ? (layout.anchor.split("-") as [string, string])
    : ["center", layout.anchor];
  if (horizontal === "right") style.right = marginX;
  else style.left = marginX;
  if (vertical === "top") style.top = marginY;
  else if (vertical === "bottom") style.bottom = marginY;
  else style.top = `${(100 - heightPct) / 2}%`;
  return style;
}

function AvatarOverlay({
  projectId,
  layout,
  ratio,
  asset,
}: {
  projectId: string;
  layout: AvatarLayout;
  ratio: number;
  asset: Asset | undefined;
}) {
  const url = useAssetUrl(projectId, asset?.id);
  const rounded = layout.shape === "circle" ? "rounded-full" : "rounded-md";
  return (
    <div
      data-testid="avatar-overlay"
      data-anchor={layout.anchor}
      data-shape={layout.shape}
      className={`absolute overflow-hidden border-2 border-white/70 bg-neutral-700/80 shadow-lg ${rounded}`}
      style={avatarBoxStyle(layout, ratio)}
      title={t.preview.avatar}
    >
      {url && asset?.mimeType.startsWith("video/") ? (
        <video src={url} className="size-full object-cover" muted loop autoPlay playsInline />
      ) : url ? (
        <img src={url} alt={t.preview.avatar} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <UserRound className="size-1/2 text-neutral-300" aria-hidden />
        </div>
      )}
    </div>
  );
}

function SubtitleOverlay({ text, style }: { text: string; style: Project["settings"]["subtitles"]["style"] }) {
  // Style sizes are specified for a 1080-px-tall frame; scale with the preview's height.
  const scale = (px: number) => `${(px / 1080) * 100}cqh`;
  const bg = hexToRgba(style.backgroundColor, style.backgroundOpacity);
  return (
    <div
      className="absolute inset-x-0 flex justify-center px-[4%]"
      style={style.position === "top" ? { top: scale(style.marginPx) } : { bottom: scale(style.marginPx) }}
    >
      <p
        data-testid="subtitle-preview"
        className="rounded px-[0.5em] py-[0.15em] text-center leading-snug whitespace-pre-line"
        style={{
          color: style.color,
          backgroundColor: bg,
          fontSize: scale(style.fontSizePx),
          fontFamily: `${style.fontFamily}, sans-serif`,
        }}
      >
        {text}
      </p>
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
