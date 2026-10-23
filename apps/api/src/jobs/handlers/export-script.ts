import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ProjectDetail } from "@lvs/shared";
import { assets, projects } from "../../db/schema.js";
import { NonRetryableJobError } from "../../errors.js";
import { getProjectDetail } from "../../services/projects.js";
import type { JobHandler } from "../context.js";

/** Builds the plain-text / markdown script document. Shared with the sync export route. */
export function renderScriptDocument(detail: ProjectDetail, format: "txt" | "md"): string {
  const slidesById = new Map(detail.slides.map((s) => [s.id, s]));
  const parts: string[] = [];
  if (format === "md") parts.push(`# ${detail.project.name}\n`);
  else parts.push(`${detail.project.name}\n${"=".repeat(detail.project.name.length)}\n`);
  for (const scene of detail.scenes) {
    const slide = slidesById.get(scene.slideId);
    if (!slide || slide.hidden) continue;
    const rev = detail.scripts[scene.id];
    const title = slide.content.title?.trim() || `第 ${slide.pageNumber} 頁`;
    if (format === "md") {
      parts.push(`## ${scene.index + 1}. ${title}\n`);
      parts.push(rev ? `${rev.script.trim()}\n` : "_（尚未生成講稿）_\n");
    } else {
      parts.push(`[${scene.index + 1}] ${title}\n`);
      parts.push(rev ? `${rev.script.trim()}\n` : "（尚未生成講稿）\n");
    }
  }
  return parts.join("\n");
}

export const exportScript: JobHandler<{ type: "export_script"; format: "txt" | "md" | "docx" }> = async (ctx) => {
  const { db, storage, job } = ctx;
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId)).limit(1);
  if (!project) throw new NonRetryableJobError("找不到這個專案");
  const format = job.payload.format;
  if (format === "docx") throw new NonRetryableJobError("尚未支援匯出 Word（docx）講稿，請改用 Markdown 或純文字"); // TODO(v2): docx via `docx` package
  const detail = await getProjectDetail(db, project.ownerId, job.projectId);
  const text = renderScriptDocument(detail, format);
  const assetId = randomUUID();
  const key = `projects/${job.projectId}/exports/script-${assetId}.${format}`;
  const buf = Buffer.from(text, "utf8");
  await storage.put(key, buf, format === "md" ? "text/markdown" : "text/plain");
  await db.insert(assets).values({
    id: assetId,
    projectId: job.projectId,
    kind: "script_export",
    storageKey: key,
    mimeType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    sizeBytes: buf.length,
    producedBy: { jobId: job.id },
  });
  return { assetId, format, bytes: buf.length };
};
