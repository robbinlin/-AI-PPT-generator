import { useEffect, useMemo, useState } from "react";
import type { SubtitleCue } from "@lvs/shared";
import type { AvatarLayout } from "@lvs/shared";
import { useApi, useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { avatarImageUrl, useAvatarList } from "../../hooks/useStudioLists";
import { t } from "../../i18n";
import { cueAt, parseSrt } from "../../lib/srt";
import { useEditor } from "../../store/editorStore";
import { ScenePlayer } from "./ScenePlayer";
import { SlidePreview } from "./SlidePreview";
import { Timeline } from "./Timeline";
import { ParseProgress, UploadDropZone } from "./UploadDropZone";

export function CenterPane({
  onUpload,
  actions,
}: {
  onUpload: (file: File) => void;
  actions?: Pick<EditorActions, "updateProject" | "updateScene" | "reorder">;
}) {
  const api = useApi();
  const detail = useEditor((s) => s.detail);
  const selectedSceneId = useEditor((s) => s.selectedSceneId);
  const drafts = useEditor((s) => s.drafts);
  const recentJobs = useEditor((s) => s.recentJobs);
  const currentTime = useEditor((s) => s.playback.currentTime);

  const scene = useMemo(() => detail?.scenes.find((s) => s.id === selectedSceneId), [detail, selectedSceneId]);
  const slide = useMemo(() => detail?.slides.find((s) => s.id === scene?.slideId), [detail, scene]);
  const cues = useSceneCues(detail?.project.id, scene?.subtitle.status === "ready" ? scene.subtitle.assetId : undefined);
  const avatarSettings = detail?.project.settings.avatar;
  const [avatars] = useAvatarList(avatarSettings?.enabled ? avatarSettings.providerId : undefined);
  if (!detail) return null;
  const avatarPreviewUrl = avatarImageUrl(api, avatarSettings?.providerId, avatars.find((a) => a.id === avatarSettings?.avatarId));
  // A page with its own layout keeps it; otherwise dragging edits the project-wide layout.
  const commitLayout = actions
    ? (layout: AvatarLayout) => {
        if (scene?.avatarLayout) void actions.updateScene(scene.id, { avatarLayout: layout });
        else void actions.updateProject({ settings: { avatar: { ...detail.project.settings.avatar, layout } } });
      }
    : undefined;

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
  // While the user is typing, preview the draft's first sentence. Otherwise follow the narration:
  // the cue at the playhead from the generated SRT, or the first sentence before any audio exists.
  const draft = scene ? drafts[scene.id] : undefined;
  const timedCue = draft === undefined && cues ? cueAt(cues, currentTime) : undefined;
  const subtitleText = draft !== undefined ? draft : cues ? (timedCue?.text ?? "") : script?.subtitleText;

  return (
    <section className="flex min-h-0 flex-col gap-2 bg-neutral-950 p-3">
      <div className="min-h-0 flex-1">
        {slide ? (
          <SlidePreview
            project={detail.project}
            slide={slide}
            scene={scene}
            subtitleText={subtitleText}
            subtitleIsCue={draft === undefined && !!cues}
            assets={detail.assets}
            avatarPreviewUrl={avatarPreviewUrl}
            onLayoutCommit={commitLayout}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm text-neutral-500">{t.editor.selectPage}</div>
        )}
      </div>
      <ScenePlayer projectId={detail.project.id} scene={scene} hidden={slide?.hidden ?? false} />
      {actions && <Timeline actions={actions} />}
      <p className="text-center text-xs text-neutral-400 [@media(max-height:760px)]:hidden">{t.player.shortcuts}</p>
    </section>
  );
}

const srtCache = new Map<string, Promise<SubtitleCue[]>>();

/** Cues of the scene's generated SRT (undefined until loaded or when the scene has none). */
function useSceneCues(projectId: string | undefined, assetId: string | undefined): SubtitleCue[] | undefined {
  const url = useAssetUrl(projectId, assetId);
  const [state, setState] = useState<{ url: string; cues: SubtitleCue[] } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let p = srtCache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then(parseSrt);
      srtCache.set(url, p);
    }
    p.then((cues) => alive && setState({ url, cues })).catch(() => srtCache.delete(url));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!url || state?.url !== url) return undefined;
  return state.cues;
}
