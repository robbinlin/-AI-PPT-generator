import { z } from "zod";
import { Id } from "./ids.js";
import { Transition } from "./enums.js";
import { AvatarLayout, SubtitleCue, SubtitleStyle } from "./entities.js";

/**
 * Input to the render worker (workers/render). Produced by the API from the
 * current scenes + assets, fully resolved to local file paths.
 * Subtitle cue times are relative to their scene; `fontSizePx`/`marginPx` are output pixels.
 */
export const RenderScene = z.object({
  sceneId: Id,
  imagePath: z.string(),
  /** Omit for muted scenes; the scene then holds for `durationSec`. */
  audioPath: z.string().optional(),
  durationSec: z.number().positive(),
  avatar: z
    .object({
      videoPath: z.string(),
      layout: AvatarLayout,
      /** True when the provider supplied an alpha channel (webm/mov). */
      hasAlpha: z.boolean().default(false),
      /** Background colour (#RRGGBB) to key out, e.g. "#00FF00" for HeyGen green-screen output. */
      chromaKey: z.string().optional(),
    })
    .optional(),
  /**
   * Where the slide sits when the project shows a presenter but this scene has no clip (not
   * made yet, or a muted page): same size and side as on the pages with the presenter, so the
   * deck does not jump between full-frame and scaled slides.
   */
  slideFrame: AvatarLayout.pick({ slideScale: true, slideAlign: true }).optional(),
  subtitles: z.array(SubtitleCue).default([]),
  transitionIn: Transition.default("none"),
  transitionDurationSec: z.number().min(0).max(2).default(0.4),
});
export type RenderScene = z.infer<typeof RenderScene>;

export const RenderSpec = z.object({
  schemaVersion: z.literal(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().min(1).max(60).default(30),
  scenes: z.array(RenderScene).min(1),
  subtitleStyle: SubtitleStyle,
  burnSubtitles: z.boolean().default(true),
  backgroundColor: z.string().default("#000000"),
  outputs: z.object({
    mp4Path: z.string(),
    srtPath: z.string().optional(),
  }),
});
export type RenderSpec = z.infer<typeof RenderSpec>;

export const RenderResult = z.object({
  mp4Path: z.string(),
  srtPath: z.string().optional(),
  durationSec: z.number().nonnegative(),
  width: z.number().int(),
  height: z.number().int(),
  renderSeconds: z.number().nonnegative(),
});
export type RenderResult = z.infer<typeof RenderResult>;
