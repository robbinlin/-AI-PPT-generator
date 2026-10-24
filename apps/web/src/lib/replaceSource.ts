import type { ProjectDetail } from "@lvs/shared";
import { fmt, t } from "../i18n";
import { confirmAction } from "../store/confirmStore";
import { toast } from "../store/toastStore";

const BLOCKING = new Set(["generate_script", "synthesize_speech", "generate_avatar", "translate_script", "render_video", "parse_document"]);
import { avatarInVideo } from "@lvs/shared";

/**
 * Asks before a new upload replaces the deck (a finished step looks like "look back", not "redo").
 * Resolves true straight away when there is nothing to replace yet.
 */
export function confirmReplaceSource(detail: ProjectDetail | null | undefined): Promise<boolean> {
  const doc = detail?.sourceDocument;
  if (!doc) return Promise.resolve(true);
  // Before the file picker, not after the upload: the server refuses a new deck while pages are
  // being written, voiced, animated or exported.
  const busy = detail.activeJobs.find((j) => BLOCKING.has(j.type));
  if (busy) {
    toast(fmt(t.upload.replaceBusy, { job: t.jobs.types[busy.type] }), "info");
    return Promise.resolve(false);
  }
  // Finished presenters were paid for: say how many are at stake, and that this can't be undone.
  const paid = avatarInVideo(detail.project.settings.avatar) ? detail.scenes.filter((s) => s.avatar.status === "ready").length : 0;
  return confirmAction({
    title: t.upload.replaceTitle,
    lines: [
      fmt(t.upload.replaceCurrent, { name: doc.filename, n: detail.slides.length }),
      ...(paid ? [fmt(t.upload.replacePaid, { n: paid })] : []),
      t.upload.replaceNoUndo,
    ],
    note: t.upload.replaceConfirm,
    confirmLabel: t.upload.replaceAction,
    danger: true,
  });
}
