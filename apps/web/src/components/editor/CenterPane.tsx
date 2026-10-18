import { useMemo } from "react";
import { t } from "../../i18n";
import { useEditor } from "../../store/editorStore";
import { ScenePlayer } from "./ScenePlayer";
import { SlidePreview } from "./SlidePreview";
import { ParseProgress, UploadDropZone } from "./UploadDropZone";

export function CenterPane({ onUpload }: { onUpload: (file: File) => void }) {
  const detail = useEditor((s) => s.detail);
  const selectedSceneId = useEditor((s) => s.selectedSceneId);
  const drafts = useEditor((s) => s.drafts);
  const recentJobs = useEditor((s) => s.recentJobs);

  const scene = useMemo(() => detail?.scenes.find((s) => s.id === selectedSceneId), [detail, selectedSceneId]);
  const slide = useMemo(() => detail?.slides.find((s) => s.id === scene?.slideId), [detail, scene]);
  if (!detail) return null;

  const source = detail.sourceDocument;
  if (
    !source ||
    (detail.slides.length === 0 &&
      source.parseStatus !== "queued" &&
      source.parseStatus !== "running" &&
      source.parseStatus !== "failed")
  ) {
    return (
      <section className="flex min-h-0 items-center justify-center bg-neutral-950 p-8">
        <UploadDropZone onFile={onUpload} />
      </section>
    );
  }

  if (detail.slides.length === 0) {
    const job = detail.activeJobs.find((j) => j.payload.type === "parse_document");
    const failedJob = recentJobs.find((j) => j.id === source.parseJobId);
    return (
      <section className="flex min-h-0 flex-col items-center justify-center gap-6 bg-neutral-950 p-8">
        <ParseProgress
          filename={source.filename}
          progress={job?.progress}
          message={job?.progressMessage}
          failed={source.parseStatus === "failed" ? (failedJob?.error ?? t.jobs.statuses.failed) : null}
        />
        {source.parseStatus === "failed" && <UploadDropZone onFile={onUpload} />}
      </section>
    );
  }

  const script = scene ? detail.scripts[scene.id] : undefined;
  // Subtitles preview the saved subtitle text, or the draft while the user is typing.
  const subtitleText = scene && drafts[scene.id] !== undefined ? drafts[scene.id] : script?.subtitleText;

  return (
    <section className="flex min-h-0 flex-col gap-3 bg-neutral-950 p-4">
      <div className="min-h-0 flex-1">
        {slide ? (
          <SlidePreview project={detail.project} slide={slide} scene={scene} subtitleText={subtitleText} assets={detail.assets} />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-neutral-500">{t.editor.selectPage}</div>
        )}
      </div>
      <ScenePlayer projectId={detail.project.id} scene={scene} hidden={slide?.hidden ?? false} />
      <p className="text-center text-[11px] text-neutral-600">{t.player.shortcuts}</p>
    </section>
  );
}
