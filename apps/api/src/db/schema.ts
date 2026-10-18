/**
 * Drizzle schema. Kept free of runtime imports from @lvs/shared so drizzle-kit can load it;
 * nested objects are JSONB typed with shared types (type-only imports are erased).
 */
import type {
  AvatarLayout,
  GlossaryEntry,
  JobPayload,
  OutlineSection,
  ProjectSettings,
  SceneAssetState,
  SlideContent,
  Track,
} from "@lvs/shared";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("projects_owner_idx").on(t.ownerId)],
);

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    version: integer("version").notNull(),
    parseStatus: text("parse_status").notNull(),
    parseJobId: uuid("parse_job_id"),
    pageCount: integer("page_count"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("source_documents_project_idx").on(t.projectId)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    durationSec: real("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    inputHash: text("input_hash"),
    producedBy: jsonb("produced_by")
      .$type<{ jobId?: string; providerId?: string; providerTaskId?: string }>()
      .notNull()
      .default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("assets_project_idx").on(t.projectId), index("assets_input_hash_idx").on(t.projectId, t.inputHash)],
);

export const slides = pgTable(
  "slides",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    pageNumber: integer("page_number").notNull(),
    contentHash: text("content_hash").notNull(),
    imageAssetId: uuid("image_asset_id"),
    thumbnailAssetId: uuid("thumbnail_asset_id"),
    content: jsonb("content").$type<SlideContent>().notNull(),
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [index("slides_project_idx").on(t.projectId)],
);

export const scenes = pgTable(
  "scenes",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slideId: uuid("slide_id")
      .notNull()
      .references(() => slides.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    muted: boolean("muted").notNull().default(false),
    avatarLayout: jsonb("avatar_layout").$type<AvatarLayout>(),
    transitionIn: text("transition_in"),
    tailPauseSec: real("tail_pause_sec").notNull().default(0.5),
    scriptRevisionId: uuid("script_revision_id"),
    script: jsonb("script").$type<SceneAssetState>().notNull(),
    audio: jsonb("audio").$type<SceneAssetState>().notNull(),
    avatar: jsonb("avatar").$type<SceneAssetState>().notNull(),
    subtitle: jsonb("subtitle").$type<SceneAssetState>().notNull(),
    durationSec: real("duration_sec"),
  },
  (t) => [index("scenes_project_idx").on(t.projectId), uniqueIndex("scenes_slide_uidx").on(t.slideId)],
);

export const scriptRevisions = pgTable(
  "script_revisions",
  {
    id: uuid("id").primaryKey(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    script: text("script").notNull(),
    pronunciationText: text("pronunciation_text").notNull(),
    subtitleText: text("subtitle_text").notNull(),
    source: text("source").notNull(),
    outlineRevisionId: uuid("outline_revision_id"),
    contentHash: text("content_hash").notNull(),
    estimatedDurationSec: real("estimated_duration_sec"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("script_revisions_scene_version_uidx").on(t.sceneId, t.version)],
);

export const outlineRevisions = pgTable(
  "outline_revisions",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
    summary: text("summary").notNull().default(""),
    sections: jsonb("sections").$type<OutlineSection[]>().notNull().default([]),
    glossary: jsonb("glossary").$type<GlossaryEntry[]>().notNull().default([]),
    timeAllocation: jsonb("time_allocation").$type<Record<string, number>>().notNull().default({}),
    inputHash: text("input_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("outline_revisions_project_version_uidx").on(t.projectId, t.version)],
);

export const pronunciationDictionaries = pgTable("pronunciation_dictionaries", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  entries: jsonb("entries").$type<GlossaryEntry[]>().notNull().default([]),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload").$type<JobPayload>().notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    progress: real("progress").notNull().default(0),
    progressMessage: text("progress_message"),
    providerTaskId: text("provider_task_id"),
    dedupeKey: text("dedupe_key"),
    /** Earliest time the runner may claim this row (retry backoff). */
    runAfter: ts("run_after").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.runAfter, t.createdAt), index("jobs_project_idx").on(t.projectId)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    providerId: text("provider_id").notNull(),
    unit: text("unit").notNull(),
    quantity: real("quantity").notNull(),
    estimatedCost: real("estimated_cost"),
    currency: text("currency").notNull().default("USD"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("usage_records_project_idx").on(t.projectId)],
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    ownerId: text("owner_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** base64 AES-256-GCM: iv || ciphertext || tag */
    ciphertext: text("ciphertext").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.providerId] })],
);

export const timelineRevisions = pgTable(
  "timeline_revisions",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    totalDurationSec: real("total_duration_sec").notNull(),
    tracks: jsonb("tracks").$type<Track[]>().notNull().default([]),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("timeline_revisions_project_version_uidx").on(t.projectId, t.version)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type SourceDocumentRow = typeof sourceDocuments.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type SlideRow = typeof slides.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type ScriptRevisionRow = typeof scriptRevisions.$inferSelect;
export type OutlineRevisionRow = typeof outlineRevisions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
