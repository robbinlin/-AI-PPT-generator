import { z } from "zod";
import { Id, IsoDate } from "./ids.js";
import {
  AspectRatio,
  AssetKind,
  Audience,
  ContentBoundary,
  DerivedStatus,
  JobStatus,
  JobType,
  Language,
  ScriptMode,
  SourceKind,
  Transition,
  UsageUnit,
} from "./enums.js";
import { SlideContent } from "./parser.js";

// ---------------------------------------------------------------------------
// Layout / style primitives
// ---------------------------------------------------------------------------

export const AvatarAnchor = z.enum(["bottom-right", "bottom-left", "top-right", "top-left", "right", "left"]);
export type AvatarAnchor = z.infer<typeof AvatarAnchor>;

/** Where and how big the avatar is drawn over the slide. Sizes are fractions of frame height. */
export const AvatarLayout = z.object({
  shape: z.enum(["circle", "rect"]).default("circle"),
  anchor: AvatarAnchor.default("bottom-right"),
  size: z.number().min(0.05).max(1).default(0.28),
  margin: z.number().min(0).max(0.5).default(0.03),
  visible: z.boolean().default(true),
  /**
   * Free position set by dragging in the editor: centre of the avatar box as a fraction of the
   * frame width / height. When both are set they override `anchor` + `margin`.
   */
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  /** Slide image scaled to this fraction of the frame (leaving room beside it for the avatar). */
  slideScale: z.number().min(0.4).max(1).default(1),
  /** Where the scaled slide sits horizontally. */
  slideAlign: z.enum(["center", "left", "right"]).default("center"),
});
export type AvatarLayout = z.infer<typeof AvatarLayout>;

export const SubtitleStyle = z.object({
  fontFamily: z.string().default("Noto Sans CJK TC"),
  fontSizePx: z.number().int().min(10).max(120).default(40),
  color: z.string().default("#FFFFFF"),
  backgroundColor: z.string().default("#000000"),
  backgroundOpacity: z.number().min(0).max(1).default(0.6),
  position: z.enum(["bottom", "top"]).default("bottom"),
  marginPx: z.number().int().min(0).default(48),
  /** Line width in CJK-equivalent columns: a CJK character counts 1, any other character 0.5. */
  maxCharsPerLine: z.number().int().min(8).max(80).default(28),
  highlightWords: z.boolean().default(false),
  bold: z.boolean().default(false),
  /** Text outline, drawn when the background box is fully transparent (backgroundOpacity 0). */
  outlineColor: z.string().default("#000000"),
  outlineWidthPx: z.number().int().min(0).max(12).default(0),
});
export type SubtitleStyle = z.infer<typeof SubtitleStyle>;

export const VoiceSettings = z.object({
  providerId: z.string().default("gemini"),
  voiceId: z.string().default("Orus"),
  /** 1.0 = provider default. Changing this re-synthesizes audio. */
  speed: z.number().min(0.5).max(2).default(1),
  /** Default pause inserted between sentences, in seconds. */
  sentencePauseSec: z.number().min(0).max(3).default(0.3),
  pronunciationDictionaryId: Id.optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

export const AvatarSettings = z.object({
  enabled: z.boolean().default(false),
  providerId: z.string().optional(),
  avatarId: z.string().optional(),
  /**
   * What the chosen character was made from (from the provider's list). HeyGen video twins
   * already move like the recording, so they render with the cheaper Avatar III engine.
   */
  avatarSource: z.enum(["photo", "video"]).optional(),
  layout: AvatarLayout.default({}),
});
export type AvatarSettings = z.infer<typeof AvatarSettings>;

export const SubtitleSettings = z.object({
  enabled: z.boolean().default(true),
  burnIn: z.boolean().default(true),
  style: SubtitleStyle.default({}),
});
export type SubtitleSettings = z.infer<typeof SubtitleSettings>;

export const ProjectSettings = z.object({
  language: Language.default("zh-TW"),
  aspectRatio: AspectRatio.default("16:9"),
  /** Target total narration length. Undefined = let the model decide per slide density. */
  targetDurationSec: z.number().int().positive().optional(),
  audience: Audience.default("undergraduate"),
  audienceNote: z.string().max(500).optional(),
  mode: ScriptMode.default("faithful"),
  contentBoundary: ContentBoundary.default("source_only"),
  /** Extra guidance for the script writer, e.g. course name or tone. */
  styleNote: z.string().max(1000).optional(),
  llmProviderId: z.string().default("gemini"),
  voice: VoiceSettings.default({}),
  avatar: AvatarSettings.default({}),
  subtitles: SubtitleSettings.default({}),
  transition: Transition.default("fade"),
  /** Frame colour around the slide (visible when the slide is letterboxed or scaled down). */
  backgroundColor: z.string().default("#000000"),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export const Project = z.object({
  id: Id,
  ownerId: z.string(),
  name: z.string().min(1).max(200),
  settings: ProjectSettings,
  /** Pages in the latest parsed source document; absent until a deck has been uploaded. */
  pageCount: z.number().int().nonnegative().optional(),
  /** Slide image of the first visible page, for the project list thumbnail. */
  thumbnailAssetId: Id.optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

export const SourceDocument = z.object({
  id: Id,
  projectId: Id,
  filename: z.string(),
  mimeType: z.string(),
  kind: SourceKind,
  storageKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  version: z.number().int().min(1),
  parseStatus: JobStatus,
  parseJobId: Id.optional(),
  pageCount: z.number().int().nonnegative().optional(),
  createdAt: IsoDate,
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export const Slide = z.object({
  id: Id,
  projectId: Id,
  sourceDocumentId: Id,
  /** Position in the current ordering (0-based). Reordering changes this, not `pageNumber`. */
  index: z.number().int().nonnegative(),
  /** Page in the source document (1-based). */
  pageNumber: z.number().int().min(1),
  /** sha256 of SlideContent.plainText + notes; used to match slides across re-uploads. */
  contentHash: z.string(),
  imageAssetId: Id.optional(),
  thumbnailAssetId: Id.optional(),
  content: SlideContent,
  hidden: z.boolean().default(false),
});
export type Slide = z.infer<typeof Slide>;

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

export const SceneAssetState = z.object({
  status: DerivedStatus.default("missing"),
  assetId: Id.optional(),
  /** Hash of the inputs that produced `assetId`; compared to current inputs to detect `stale`. */
  inputHash: z.string().optional(),
  jobId: Id.optional(),
  error: z.string().optional(),
  /** Subtitle state only: timed cues (scene-relative seconds) that the SRT asset was written from. */
  cues: z.array(SubtitleCue).optional(),
});
export type SceneAssetState = z.infer<typeof SceneAssetState>;

/** Longest hold after the narration (the timeline's page-length handle stops here). */
export const MAX_TAIL_PAUSE_SEC = 60;

export const Scene = z.object({
  id: Id,
  projectId: Id,
  slideId: Id,
  index: z.number().int().nonnegative(),
  muted: z.boolean().default(false),
  /** Overrides project avatar layout for this scene only. */
  avatarLayout: AvatarLayout.optional(),
  /** Overrides project transition for this scene only. */
  transitionIn: Transition.optional(),
  /** Extra hold time after narration ends, in seconds. */
  tailPauseSec: z.number().min(0).max(MAX_TAIL_PAUSE_SEC).default(0.5),
  /** Latest script revision chosen for this scene. */
  scriptRevisionId: Id.optional(),
  script: SceneAssetState.default({}),
  audio: SceneAssetState.default({}),
  avatar: SceneAssetState.default({}),
  subtitle: SceneAssetState.default({}),
  /** Measured narration length once audio exists. */
  durationSec: z.number().nonnegative().optional(),
});
export type Scene = z.infer<typeof Scene>;

export const ScriptRevision = z.object({
  id: Id,
  sceneId: Id,
  version: z.number().int().min(1),
  /** What the user reads and edits. */
  script: z.string(),
  /** Symbols, abbreviations and numbers rewritten for the TTS engine. */
  pronunciationText: z.string(),
  /** Formal spelling for on-screen subtitles. */
  subtitleText: z.string(),
  source: z.enum(["ai", "user"]),
  outlineRevisionId: Id.optional(),
  /** sha256 of script + settings that affect speech; drives audio reuse. */
  contentHash: z.string(),
  /** Model-estimated speaking time before audio exists. */
  estimatedDurationSec: z.number().nonnegative().optional(),
  createdAt: IsoDate,
});
export type ScriptRevision = z.infer<typeof ScriptRevision>;

export const GlossaryEntry = z.object({
  term: z.string(),
  /** How to say it aloud, e.g. "VO2max" -> "V O two max". */
  reading: z.string().optional(),
  definition: z.string().optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const OutlineSection = z.object({
  title: z.string(),
  slideIds: z.array(Id),
  keyPoints: z.array(z.string()).default([]),
});
export type OutlineSection = z.infer<typeof OutlineSection>;

/** Whole-document plan produced before per-slide scripts. */
export const OutlineRevision = z.object({
  id: Id,
  projectId: Id,
  version: z.number().int().min(1),
  objectives: z.array(z.string()).default([]),
  summary: z.string().default(""),
  sections: z.array(OutlineSection).default([]),
  glossary: z.array(GlossaryEntry).default([]),
  /** Seconds allotted per slide id. */
  timeAllocation: z.record(Id, z.number().nonnegative()).default({}),
  /** Hash of all slide contents + settings used; stale when it no longer matches. */
  inputHash: z.string(),
  createdAt: IsoDate,
});
export type OutlineRevision = z.infer<typeof OutlineRevision>;

export const PronunciationDictionary = z.object({
  id: Id,
  ownerId: z.string(),
  name: z.string(),
  entries: z.array(GlossaryEntry),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type PronunciationDictionary = z.infer<typeof PronunciationDictionary>;

export const Asset = z.object({
  id: Id,
  projectId: Id,
  kind: AssetKind,
  storageKey: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Hash of the inputs that produced this asset. Same hash => reusable. */
  inputHash: z.string().optional(),
  producedBy: z
    .object({
      jobId: Id.optional(),
      providerId: z.string().optional(),
      providerTaskId: z.string().optional(),
    })
    .default({}),
  createdAt: IsoDate,
});
export type Asset = z.infer<typeof Asset>;

// ---------------------------------------------------------------------------
// Timeline (v1: derived from scenes; v2: user-editable multi-track)
// ---------------------------------------------------------------------------

export const TrackKind = z.enum(["slide", "avatar", "narration", "subtitle", "effect", "music"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const Clip = z.object({
  id: Id,
  sceneId: Id.optional(),
  assetId: Id.optional(),
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  speed: z.number().positive().default(1),
  transitionIn: Transition.default("none"),
  data: z.record(z.unknown()).optional(),
});
export type Clip = z.infer<typeof Clip>;

export const Track = z.object({
  kind: TrackKind,
  clips: z.array(Clip),
});
export type Track = z.infer<typeof Track>;

export const TimelineRevision = z.object({
  id: Id,
  projectId: Id,
  version: z.number().int().min(1),
  totalDurationSec: z.number().nonnegative(),
  tracks: z.array(Track),
  createdAt: IsoDate,
});
export type TimelineRevision = z.infer<typeof TimelineRevision>;

// ---------------------------------------------------------------------------
// Jobs & usage
// ---------------------------------------------------------------------------

export const JobPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("parse_document"), sourceDocumentId: Id }),
  z.object({ type: z.literal("generate_outline"), force: z.boolean().default(false) }),
  z.object({
    type: z.literal("generate_script"),
    /** Omit to (re)generate every scene whose script is missing or stale. */
    sceneIds: z.array(Id).optional(),
    force: z.boolean().default(false),
  }),
  z.object({ type: z.literal("synthesize_speech"), sceneIds: z.array(Id).optional(), force: z.boolean().default(false) }),
  z.object({ type: z.literal("generate_avatar"), sceneIds: z.array(Id).optional(), force: z.boolean().default(false) }),
  z.object({
    type: z.literal("render_video"),
    preset: z.enum(["preview_540p", "hd_1080p"]).default("hd_1080p"),
    burnSubtitles: z.boolean().optional(),
  }),
  z.object({ type: z.literal("export_script"), format: z.enum(["txt", "md", "docx"]).default("md") }),
  /** Runs on the NEW (translated) project: translates each page's latest script of `sourceProjectId`. */
  z.object({ type: z.literal("translate_script"), sourceProjectId: Id, targetLanguage: Language }),
]);
export type JobPayload = z.infer<typeof JobPayload>;

export const Job = z.object({
  id: Id,
  projectId: Id,
  type: JobType,
  status: JobStatus,
  payload: JobPayload,
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).default(3),
  progress: z.number().min(0).max(1).default(0),
  progressMessage: z.string().optional(),
  /** Set when an external provider task was created; prevents duplicate billing on retry. */
  providerTaskId: z.string().optional(),
  /** Identical queued jobs collapse onto one row. */
  dedupeKey: z.string().optional(),
  createdAt: IsoDate,
  startedAt: IsoDate.optional(),
  finishedAt: IsoDate.optional(),
});
export type Job = z.infer<typeof Job>;

export const UsageRecord = z.object({
  id: Id,
  projectId: Id,
  jobId: Id.optional(),
  providerId: z.string(),
  unit: UsageUnit,
  quantity: z.number().nonnegative(),
  estimatedCost: z.number().nonnegative().optional(),
  currency: z.string().length(3).default("USD"),
  createdAt: IsoDate,
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/** Rough price before a job runs; shown in the UI. */
export const CostEstimate = z.object({
  lines: z.array(
    z.object({ providerId: z.string(), unit: UsageUnit, quantity: z.number(), estimatedCost: z.number() }),
  ),
  total: z.number(),
  currency: z.string().length(3).default("USD"),
  /** Pages the job would process (scope "pending": only missing/stale/failed ones). */
  sceneCount: z.number().int().nonnegative().optional(),
  /** Narration seconds covered by those pages (avatar and render estimates). */
  seconds: z.number().nonnegative().optional(),
});
export type CostEstimate = z.infer<typeof CostEstimate>;
