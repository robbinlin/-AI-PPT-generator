import { z } from "zod";

export const Language = z.enum(["zh-TW", "en", "mixed"]);
export type Language = z.infer<typeof Language>;

export const AspectRatio = z.enum(["16:9", "9:16", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const Audience = z.enum(["undergraduate", "graduate", "general", "custom"]);
export type Audience = z.infer<typeof Audience>;

/** faithful = 照稿解說, extended = 教學延伸, summary = 重點摘要 */
export const ScriptMode = z.enum(["faithful", "extended", "summary"]);
export type ScriptMode = z.infer<typeof ScriptMode>;

export const ContentBoundary = z.enum(["source_only", "allow_external"]);
export type ContentBoundary = z.infer<typeof ContentBoundary>;

export const SourceKind = z.enum(["pptx", "ppt", "pdf"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const JobType = z.enum([
  "parse_document",
  "generate_outline",
  "generate_script",
  "synthesize_speech",
  "generate_avatar",
  "render_video",
  "export_script",
  "translate_script",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const AssetKind = z.enum([
  "source",
  "slide_image",
  "thumbnail",
  "audio",
  "avatar_video",
  "subtitle",
  "video",
  "script_export",
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const Transition = z.enum(["none", "fade"]);
export type Transition = z.infer<typeof Transition>;

/** Per-scene readiness of a derived asset. `stale` means an upstream input changed. */
export const DerivedStatus = z.enum(["missing", "queued", "generating", "ready", "stale", "failed"]);
export type DerivedStatus = z.infer<typeof DerivedStatus>;

export const UsageUnit = z.enum([
  "chars",
  "tokens_in",
  "tokens_out",
  "audio_seconds",
  "avatar_seconds",
  "render_seconds",
  "bytes",
]);
export type UsageUnit = z.infer<typeof UsageUnit>;
