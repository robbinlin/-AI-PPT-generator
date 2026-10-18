import { z } from "zod";
import { SourceKind } from "./enums.js";

/**
 * Contract between the Python parser worker (workers/parser) and the API.
 * The worker writes `<outDir>/manifest.json` plus one PNG / JSON per page.
 * All paths in the manifest are relative to the manifest's directory.
 */

/** Bounding box in PDF points (1/72 in), origin top-left, y grows downward. */
export const BBox = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type BBox = z.infer<typeof BBox>;

export const TextRole = z.enum(["title", "subtitle", "body", "bullet", "caption", "table", "note", "other"]);
export type TextRole = z.infer<typeof TextRole>;

export const TextBlock = z.object({
  text: z.string(),
  role: TextRole.default("body"),
  bbox: BBox.optional(),
  /** Nesting level for bullets, 0 = top level. */
  level: z.number().int().min(0).default(0),
});
export type TextBlock = z.infer<typeof TextBlock>;

export const TableData = z.object({
  rows: z.array(z.array(z.string())),
  bbox: BBox.optional(),
});
export type TableData = z.infer<typeof TableData>;

export const ImageRef = z.object({
  /** Relative path to an extracted image, when extraction was possible. */
  path: z.string().optional(),
  bbox: BBox.optional(),
  altText: z.string().optional(),
});
export type ImageRef = z.infer<typeof ImageRef>;

export const ChartRef = z.object({
  chartType: z.string().optional(),
  title: z.string().optional(),
  /** Series/category text the parser could read from the chart XML. */
  dataSummary: z.string().optional(),
  bbox: BBox.optional(),
});
export type ChartRef = z.infer<typeof ChartRef>;

/** How faithfully the page image reproduces the original slide. */
export const RenderFidelity = z.enum(["native", "converted", "fallback"]);
export type RenderFidelity = z.infer<typeof RenderFidelity>;

export const SlideContent = z.object({
  pageNumber: z.number().int().min(1),
  title: z.string().optional(),
  textBlocks: z.array(TextBlock).default([]),
  /** Speaker notes (PPTX only). */
  notes: z.string().optional(),
  tables: z.array(TableData).default([]),
  images: z.array(ImageRef).default([]),
  charts: z.array(ChartRef).default([]),
  /** Plain-text concatenation used for hashing and prompts. */
  plainText: z.string().default(""),
  hasText: z.boolean().default(true),
  /** True when the page is a scanned image with no text layer; OCR is a v2 feature. */
  needsOcr: z.boolean().default(false),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
  renderFidelity: RenderFidelity,
});
export type SlideContent = z.infer<typeof SlideContent>;

export const ParserPageEntry = z.object({
  pageNumber: z.number().int().min(1),
  imagePath: z.string(),
  thumbnailPath: z.string(),
  contentPath: z.string(),
  imageWidthPx: z.number().int().positive(),
  imageHeightPx: z.number().int().positive(),
});
export type ParserPageEntry = z.infer<typeof ParserPageEntry>;

export const ParserManifest = z.object({
  schemaVersion: z.literal(1),
  sourceKind: SourceKind,
  pageCount: z.number().int().min(0),
  pages: z.array(ParserPageEntry),
  meta: z
    .object({
      title: z.string().optional(),
      author: z.string().optional(),
      /** e.g. "soffice 24.2", "pymupdf 1.26" */
      converter: z.string().optional(),
      warnings: z.array(z.string()).default([]),
      durationMs: z.number().optional(),
    })
    .default({ warnings: [] }),
});
export type ParserManifest = z.infer<typeof ParserManifest>;
