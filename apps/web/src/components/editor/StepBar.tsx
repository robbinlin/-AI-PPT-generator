import { useRef } from "react";
import { Check, ChevronRight } from "lucide-react";
import type { ProjectDetail } from "@lvs/shared";
import type { EstimateType } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { ACCEPTED_EXTENSIONS } from "../../hooks/useEditorActions";
import { usePendingEstimate } from "../../hooks/usePendingEstimate";
import { fmt, t } from "../../i18n";
import { twdShort } from "../../lib/paidJobs";
import { confirmReplaceSource } from "../../lib/replaceSource";
import { isVideoCurrent, latestProjectAsset } from "../../lib/scenes";
import { visibleScenes } from "../../lib/settingsImpact";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Misc";
import { useFreshUndownloadedVideo } from "./ExportMenu";
import { openEditorTab, type Tab } from "./RightPanel";

export const OPEN_EXPORT_EVENT = "lvs:open-export";

type StepId = "upload" | "script" | "voice" | "avatar" | "export";

interface Step {
  id: StepId;
  done: boolean;
  skipped?: boolean;
  busy: boolean;
  count?: { done: number; total: number };
  tab?: Tab;
}

/** Job behind each step's 下一步 button, for the price shown on it. */
const COST_TYPE: Partial<Record<StepId, EstimateType>> = {
  script: "generate_script",
  voice: "synthesize_speech",
  avatar: "generate_avatar",
};

export function buildSteps(detail: ProjectDetail, uploading = false): { steps: Step[]; next: Step | undefined } {
  const busy = (type: string) => detail.activeJobs.some((j) => j.type === type);
  const scenes = visibleScenes(detail);
  const spoken = scenes.filter((s) => !s.muted);
  const countReady = (list: typeof scenes, field: "script" | "audio" | "avatar") => ({
    done: list.filter((s) => s[field].status === "ready").length,
    total: list.length,
  });
  // A script written from an older outline still exists and still reads fine: it does not hold
  // up the next step (rewriting it would replace the text and its finished audio). Only pages
  // without a script do; the page list and the script panel point out the outdated ones.
  const scriptCount = {
    done: scenes.filter((s) => s.script.status === "ready" || s.script.status === "stale").length,
    total: scenes.length,
  };
  const audioCount = countReady(spoken, "audio");
  const avatarOn = detail.project.settings.avatar.enabled && !!detail.project.settings.avatar.avatarId;
  const avatarCount = countReady(spoken, "avatar");
  const video = latestProjectAsset(detail.assets, detail.scenes, "video");
  const videoCurrent = isVideoCurrent(detail.currentRenderHashes, video);
  const hasSlides = detail.slides.length > 0;

  const steps: Step[] = [
    { id: "upload", done: hasSlides, busy: uploading || busy("parse_document") || detail.sourceDocument?.parseStatus === "running" },
    { id: "script", done: hasSlides && scriptCount.done === scriptCount.total, busy: busy("generate_script") || busy("translate_script"), count: scriptCount, tab: "script" },
    { id: "voice", done: hasSlides && audioCount.done === audioCount.total, busy: busy("synthesize_speech"), count: audioCount, tab: "studio" },
    {
      id: "avatar",
      done: avatarOn && hasSlides && avatarCount.done === avatarCount.total,
      skipped: !avatarOn,
      busy: busy("generate_avatar"),
      count: avatarOn ? avatarCount : undefined,
      tab: "studio",
    },
    { id: "export", done: videoCurrent, busy: busy("render_video") },
  ];
  return { steps, next: steps.find((s) => !s.done && !s.skipped) };
}

/**
 * The guided path VoAI offers, on top of the free-form editor: 上傳 → 講稿 → 語音 → 人像 → 匯出,
 * each with its progress, and one button (with its price) for the next thing to do.
 */
export function StepBar({ actions }: { actions: EditorActions }) {
  const detail = useEditor((s) => s.detail);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadPct = useEditor((s) => s.upload.progress);
  const plan = detail ? buildSteps(detail, uploadPct !== null) : undefined;
  const costType = plan?.next ? COST_TYPE[plan.next.id] : undefined;
  // The price follows every status or settings change.
  const revision = detail
    ? detail.scenes.map((s) => `${s.script.status}${s.audio.status}${s.avatar.status}${s.muted}`).join("") + JSON.stringify(detail.project.settings)
    : "";
  // The script step only writes pages without a script, so its price covers just those.
  const missingScripts = detail && costType === "generate_script" ? visibleScenes(detail).filter((s) => s.script.status === "missing" || s.script.status === "failed").map((s) => s.id) : undefined;
  const nextCost = usePendingEstimate(detail?.project.id, costType, revision, "pending", missingScripts);
  const undownloaded = useFreshUndownloadedVideo();
  if (!detail || !plan) return null;
  const { steps, next } = plan;
  const translateJob = detail.activeJobs.find((j) => j.type === "translate_script");

  // A finished upload step looks like "look back", so replacing the deck always asks first.
  const pickFile = async () => {
    if (!(await confirmReplaceSource(detail))) return;
    fileInput.current?.click();
  };

  const runNext = () => {
    if (!next) return;
    switch (next.id) {
      case "upload":
        void pickFile();
        return;
      case "script": {
        openEditorTab("script");
        // Only the pages that have no script (missing/failed); never rewrite existing ones from here.
        const ids = visibleScenes(detail).filter((s) => s.script.status === "missing" || s.script.status === "failed").map((s) => s.id);
        if (ids.length) void actions.enqueue({ type: "generate_script", force: false, sceneIds: ids });
        return;
      }
      case "voice":
        void actions.enqueue({ type: "synthesize_speech", force: false });
        return;
      case "avatar":
        void actions.enqueue({ type: "generate_avatar", force: false });
        return;
      case "export":
        window.dispatchEvent(new Event(OPEN_EXPORT_EVENT));
        return;
    }
  };

  const stepTitle: Record<StepId, string> = {
    upload: detail.sourceDocument ? t.steps.titleReplace : t.steps.titleUpload,
    script: t.steps.titleScript,
    voice: t.steps.titleStudio,
    avatar: t.steps.titleStudio,
    export: t.steps.titleExport,
  };

  // 「補齊 3 頁語音」: the button only makes what is missing; 「全部」 would suggest redoing hand edits.
  const left = (s: Step | undefined) => (s?.count ? s.count.total - s.count.done : 0);
  const nextLabel: Record<StepId, string> = {
    upload: t.editor.upload,
    script: fmt(t.steps.fillScript, { n: left(steps.find((s) => s.id === "script")) }),
    voice: fmt(t.steps.fillSpeech, { n: left(steps.find((s) => s.id === "voice")) }),
    avatar: fmt(t.steps.fillAvatar, { n: left(steps.find((s) => s.id === "avatar")) }),
    export: t.editor.export,
  };

  return (
    <nav aria-label={t.steps.label} className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-900/60 px-3 text-xs" data-testid="step-bar">
      <ol className="flex min-w-0 items-center gap-1">
        {steps.map((step, i) => {
          const current = next?.id === step.id;
          return (
            <li key={step.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-neutral-600" aria-hidden />}
              <button
                type="button"
                onClick={() => {
                  // Every step does something: open its tab, the upload dialog, or the export menu.
                  if (step.id === "export") window.dispatchEvent(new Event(OPEN_EXPORT_EVENT));
                  else if (step.id === "upload") void pickFile();
                  else if (step.tab) openEditorTab(step.tab);
                }}
                title={stepTitle[step.id]}
                aria-current={current ? "step" : undefined}
                className={`flex items-center gap-1.5 rounded-full px-2 py-1 whitespace-nowrap hover:bg-neutral-800 ${
                  current ? "bg-accent-500/15 text-accent-200 ring-1 ring-accent-500/50" : step.done ? "text-emerald-300" : "text-neutral-400"
                }`}
              >
                <span
                  className={`flex size-5 items-center justify-center rounded-full text-xs font-semibold ${
                    step.done ? "bg-emerald-500 text-neutral-950" : current ? "bg-accent-600 text-white" : "bg-neutral-700 text-neutral-200"
                  }`}
                  aria-hidden
                >
                  {step.done ? <Check className="size-3" /> : i + 1}
                </span>
                {t.steps[step.id]}
                {step.done && <span className="sr-only">{t.steps.doneSr}</span>}
                {step.busy ? (
                  <Spinner className="size-3" />
                ) : step.skipped ? (
                  <span className="text-neutral-400">（{t.steps.skipped}）</span>
                ) : step.count && !step.done && step.count.total > 0 ? (
                  <span className="text-neutral-400">{fmt(t.steps.progress, step.count)}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">
        {next ? (
          <>
            <span className="hidden text-neutral-400 min-[1200px]:inline">{t.steps.next}</span>
            <Button
              size="sm"
              variant="primary"
              // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
              aria-disabled={next.busy || undefined}
              className={next.busy ? "cursor-default opacity-60" : ""}
              onClick={() => !next.busy && runNext()}
              data-testid="step-next"
            >
              {next.id === "upload" && next.busy
                ? uploadPct !== null
                  ? fmt(t.upload.uploading, { pct: Math.round(uploadPct * 100) })
                  : t.steps.parsing
                : next.id === "script" && translateJob
                  ? fmt(t.steps.translating, { pct: Math.round(translateJob.progress * 100) })
                  : nextLabel[next.id]}
              {nextCost && nextCost.sceneCount !== 0 && !translateJob && <span className="font-normal">（{twdShort(nextCost.total, nextCost.currency)}）</span>}
            </Button>
          </>
        ) : (
          // Done is only done once the file is saved: until then point at the download.
          <span className="text-emerald-300">{undownloaded ? t.steps.doneDownload : t.steps.allDone}</span>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void actions.upload(file);
          e.target.value = "";
        }}
      />
    </nav>
  );
}
