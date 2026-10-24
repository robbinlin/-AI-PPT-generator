import { useEffect, useState } from "react";
import type { Job } from "@lvs/shared";
import { CircleCheck, CircleSlash, CircleX, Download, ListChecks, X } from "lucide-react";
import { useApi, useAssetUrl } from "../../api/context";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { formatRelativeTime, formatWait, remainingSec } from "../../lib/format";
import { editorStore, useEditor } from "../../store/editorStore";
import { Button, IconButton } from "../ui/Button";
import { ProgressBar, Spinner } from "../ui/Misc";
import { friendlyJobError } from "../../lib/jobErrors";
import { pageRanges } from "../../lib/settingsImpact";
import { saveVideo } from "../../lib/saveFiles";

function JobError({ message }: { message: string }) {
  const friendly = friendlyJobError(message);
  if (!friendly) return <div className="mt-0.5 break-words text-rose-300">{message}</div>;
  return (
    <div className="mt-0.5 text-rose-300">
      <div className="break-words">{friendly}</div>
      <details className="mt-0.5 text-xs text-neutral-400">
        <summary className="cursor-pointer select-none">{t.jobErrors.details}</summary>
        <div className="break-words">{message}</div>
      </details>
    </div>
  );
}

/** 「・第 2–6 頁・完成後自動匯出」: which pages a job covers, so recent jobs are told apart. */
function JobDetail({ job }: { job: Job }) {
  const scenes = useEditor((s) => s.detail?.scenes);
  const parts: string[] = [];
  const ids = "sceneIds" in job.payload ? job.payload.sceneIds : undefined;
  const result = job.result as { processed?: number; reused?: number } | undefined;
  if (ids?.length && scenes) {
    const pages = ids.map((id) => scenes.find((s) => s.id === id)?.index).filter((i): i is number => i !== undefined).map((i) => i + 1).sort((a, b) => a - b);
    if (pages.length) parts.push(fmt(t.jobs.detailPages, { pages: pageRanges(pages) }));
  } else if (typeof result?.processed === "number") {
    parts.push(fmt(t.jobs.detailCount, { n: result.processed }));
  }
  if (result?.reused) parts.push(fmt(t.jobs.detailReused, { n: result.reused }));
  if ("thenRender" in job.payload && job.payload.thenRender) parts.push(t.jobs.detailThenRender);
  if (parts.length === 0) return null;
  return <span className="ml-1 text-xs font-normal text-neutral-400">・{parts.join("・")}</span>;
}

/** Re-renders every few seconds so remaining-time estimates move between progress events. */
export function useTick(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return now;
}

export function etaText(job: Job, now: number): string | null {
  if (job.status !== "running") return null;
  const sec = remainingSec(job.startedAt, job.progress, now);
  return sec === null ? null : fmt(t.jobs.eta, { wait: formatWait(sec) });
}

export function JobsIndicator({ onOpen }: { onOpen: () => void }) {
  const jobs = useEditor((s) => s.detail?.activeJobs);
  const active = jobs ?? [];
  const lead = active[active.length - 1];
  const now = useTick(5000, !!lead);
  const eta = lead ? etaText(lead, now) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t.jobs.title}
      title={lead ? undefined : t.jobs.idle}
      className="flex h-8 max-w-64 items-center gap-2 rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:bg-neutral-800"
    >
      {lead ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <ListChecks className="size-3.5 shrink-0 text-neutral-400" aria-hidden />
      )}
      {lead ? (
        <span className="truncate">
          {`${t.jobs.types[lead.type]} ${Math.round(lead.progress * 100)}%${eta ? ` · ${eta}` : ""}${active.length > 1 ? ` · ${fmt(t.jobs.count, { n: active.length })}` : ""}`}
        </span>
      ) : (
        <>
          <span className="truncate min-[1360px]:hidden">{t.jobs.title}</span>
          <span className="hidden truncate min-[1360px]:inline">{t.jobs.idle}</span>
        </>
      )}
    </button>
  );
}

export interface JobsDrawerProps {
  open: boolean;
  onClose: () => void;
  actions: Pick<EditorActions, "cancelJob">;
}

export function JobsDrawer({ open, onClose, actions }: JobsDrawerProps) {
  const api = useApi();
  const projectId = useEditor((s) => s.detail?.project.id);
  const active = useEditor((s) => s.detail?.activeJobs);
  const recent = useEditor((s) => s.recentJobs);
  const now = useTick(5000, open && (active?.length ?? 0) > 0);

  useEffect(() => {
    if (!open || !projectId) return;
    api.listJobs(projectId).then(
      (jobs) => editorStore.getState().setRecentJobs(jobs),
      () => undefined,
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, projectId, api, onClose]);

  if (!open) return null;
  const activeJobs = [...(active ?? [])].reverse();

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <aside
        aria-label={t.jobs.title}
        className="absolute top-0 right-0 flex h-full w-96 flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">{t.jobs.title}</h2>
          <IconButton icon={X} label={t.common.close} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h3 className="mb-2 text-xs font-semibold text-neutral-400">{t.jobs.active}</h3>
          {activeJobs.length === 0 && <p className="mb-4 text-xs text-neutral-400">{t.jobs.none}</p>}
          {activeJobs.length > 0 && <p className="mb-2 text-xs text-neutral-400">{t.jobs.closeHint}</p>}
          <ul className="mb-6 flex flex-col gap-2">
            {activeJobs.map((job) => (
              <li key={job.id} className="rounded-md border border-neutral-800 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-100">
                    {t.jobs.types[job.type]}
                    <JobDetail job={job} />
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void actions.cancelJob(job.id)}>
                    {t.jobs.cancel}
                  </Button>
                </div>
                <ProgressBar value={job.progress} indeterminate={job.status === "queued"} />
                <div className="mt-1.5 flex justify-between gap-2 text-xs text-neutral-400">
                  <span className="truncate">{job.progressMessage ?? t.jobs.statuses[job.status]}</span>
                  <span className="shrink-0">{Math.round(job.progress * 100)}%</span>
                </div>
                <div className="mt-1 text-xs text-neutral-400">
                  {job.status === "running" ? (etaText(job, now) ?? t.jobs.etaPending) : t.jobs.statuses[job.status]}
                </div>
              </li>
            ))}
          </ul>
          <h3 className="mb-2 text-xs font-semibold text-neutral-400">{t.jobs.recent}</h3>
          {recent.length === 0 && <p className="text-xs text-neutral-400">{t.jobs.none}</p>}
          <ul className="flex flex-col gap-1">
            {recent.map((job) => (
              <RecentJob key={job.id} job={job} />
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function RecentJob({ job }: { job: Job }) {
  const Icon = job.status === "succeeded" ? CircleCheck : job.status === "failed" ? CircleX : CircleSlash;
  const color = job.status === "succeeded" ? "text-emerald-400" : job.status === "failed" ? "text-rose-400" : "text-neutral-400";
  return (
    <li className="flex items-start gap-2 rounded px-1 py-1.5 text-xs">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${color}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2">
          <span className="text-neutral-200">
            {t.jobs.types[job.type]}
            <JobDetail job={job} />
          </span>
          <span className="text-neutral-400">{formatRelativeTime(job.finishedAt ?? job.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={color}>{t.jobs.statuses[job.status]}</span>
          {job.type === "render_video" && job.status === "succeeded" && <RenderDownload job={job} />}
        </div>
        {job.error && <JobError message={job.error} />}
      </div>
    </li>
  );
}

/** 下載 next to a finished export, so the video can be fetched after its toast is gone. */
function RenderDownload({ job }: { job: Job }) {
  const projectName = useEditor((s) => s.detail?.project.name ?? "video");
  const assetId = (job.result as { videoAssetId?: string } | undefined)?.videoAssetId;
  const url = useAssetUrl(job.projectId, assetId);
  if (!assetId || !url) return null;
  return (
    <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-300 hover:bg-neutral-800" onClick={() => void saveVideo(url, projectName, assetId)}>
      <Download className="size-3.5" aria-hidden />
      {t.jobs.download}
    </button>
  );
}
