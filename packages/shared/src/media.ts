import { z } from "zod";
import { Id } from "./ids.js";
import { Transition } from "./enums.js";
import { AvatarLayout, SubtitleStyle } from "./entities.js";

/** Word (or character for CJK) level timing returned by a TTS provider or forced aligner. */
export const WordTimestamp = z.object({
  text: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
});
export type WordTimestamp = z.infer<typeof WordTimestamp>;

export const SubtitleCue = z.object({
  index: z.number().int().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string(),
  /** Optional per-word timing for karaoke-style highlight. */
  words: z.array(WordTimestamp).optional(),
});
export type SubtitleCue = z.infer<typeof SubtitleCue>;

/**
 * Input to the render worker (workers/render). Produced by the API from the
 * current scenes + assets, fully resolved to local file paths.
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
    })
    .optional(),
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
