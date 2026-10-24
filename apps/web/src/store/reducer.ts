import type { Job, ProjectDetail, ProjectEvent, Scene, Slide } from "@lvs/shared";
import { computeTotalDuration, sortByIndex } from "../lib/scenes";

export function isActiveJob(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

function upsertById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) return [...items, item];
  const next = [...items];
  next[i] = item;
  return next;
}

function withDuration(detail: ProjectDetail): ProjectDetail {
  return { ...detail, totalDurationSec: computeTotalDuration(detail.slides, detail.scenes, detail.project.settings.transition, detail.scripts) };
}

export function applyJob(detail: ProjectDetail, job: Job): ProjectDetail {
  const activeJobs = isActiveJob(job) ? upsertById(detail.activeJobs, job) : detail.activeJobs.filter((j) => j.id !== job.id);
  let sourceDocument = detail.sourceDocument;
  // There is no SourceDocument event; follow the parse job instead.
  if (sourceDocument && job.payload.type === "parse_document" && job.payload.sourceDocumentId === sourceDocument.id) {
    sourceDocument = {
      ...sourceDocument,
      parseStatus: job.status,
      parseJobId: job.id,
      ...(job.status === "succeeded" ? { pageCount: detail.slides.length } : {}),
    };
  }
  return { ...detail, activeJobs, ...(sourceDocument ? { sourceDocument } : {}) };
}

export function applyScene(detail: ProjectDetail, scene: Scene): ProjectDetail {
  return withDuration({ ...detail, scenes: sortByIndex(upsertById(detail.scenes, scene)) });
}

export function applySlides(detail: ProjectDetail, slides: Slide[], scenes: Scene[]): ProjectDetail {
  const sourceDocument =
    detail.sourceDocument && slides.length > 0 ? { ...detail.sourceDocument, pageCount: slides.length } : detail.sourceDocument;
  return withDuration({
    ...detail,
    slides: sortByIndex(slides),
    scenes: sortByIndex(scenes),
    ...(sourceDocument ? { sourceDocument } : {}),
  });
}

/**
 * Pure reducer for server-sent project events. Events for another project are ignored, and
 * older script revisions never replace a newer one.
 */
export function applyProjectEvent(detail: ProjectDetail, event: ProjectEvent): ProjectDetail {
  const projectId = detail.project.id;
  switch (event.kind) {
    case "job":
      if (event.job.projectId !== projectId) return detail;
      return applyJob(detail, event.job);
    case "scene":
      if (event.scene.projectId !== projectId) return detail;
      return applyScene(detail, event.scene);
    case "script": {
      const { script } = event;
      if (!detail.scenes.some((s) => s.id === script.sceneId)) return detail;
      const current = detail.scripts[script.sceneId];
      if (current && current.version > script.version) return detail;
      return { ...detail, scripts: { ...detail.scripts, [script.sceneId]: script } };
    }
    case "asset":
      if (event.asset.projectId !== projectId) return detail;
      return { ...detail, assets: { ...detail.assets, [event.asset.id]: event.asset } };
    case "slides":
      return applySlides(detail, event.slides, event.scenes);
    case "outline":
      if (event.outline.projectId !== projectId) return detail;
      if (detail.outline && detail.outline.version > event.outline.version) return detail;
      return { ...detail, outline: event.outline };
    case "project":
      if (event.project.id !== projectId) return detail;
      return { ...detail, project: event.project };
  }
}
