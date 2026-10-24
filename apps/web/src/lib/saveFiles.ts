import { errorMessage } from "../api/types";
import { fmt, t } from "../i18n";
import { toast } from "../store/toastStore";
import { markDownloaded } from "./autoExport";
import { saveFileAs } from "./format";

/**
 * Asks where to save (Chrome/Edge; other browsers drop the file in Downloads) and reports the
 * outcome in a toast. Call it straight from a click: the save dialog needs the user gesture.
 */
export async function saveWithToasts(
  source: Parameters<typeof saveFileAs>[0],
  filename: string,
  type: { description: string; mime: string },
  big = false,
  onSaved?: () => void,
): Promise<void> {
  try {
    const result = await saveFileAs(source, filename, type, big ? () => toast(fmt(t.export.saving, { name: filename })) : undefined);
    if (result !== "cancelled") onSaved?.();
    if (result === "saved") toast(fmt(t.export.saved, { name: filename }), "success");
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

export const VIDEO_FILE_TYPE = { description: t.export.videoFile, mime: "video/mp4" };

export function safeFileBase(projectName: string): string {
  return projectName.replace(/[\\/:*?"<>|]+/g, "_");
}

export interface VideoFileInfo {
  id: string;
  height?: number;
  createdAt?: string | Date;
}

/**
 * 「運動生理學_1080p_1025-1430.mp4」 (+「_舊版」): quality and export time in the name, so a 540p
 * check or an older export never overwrites the good copy, and the files tell themselves apart.
 */
export function videoFileName(projectName: string, video?: Omit<VideoFileInfo, "id">, old = false): string {
  const parts = [safeFileBase(projectName)];
  if (video?.height) parts.push(`${video.height}p`);
  if (video?.createdAt) {
    const d = new Date(video.createdAt);
    if (!Number.isNaN(d.getTime())) {
      const two = (n: number) => String(n).padStart(2, "0");
      parts.push(`${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`);
    }
  }
  if (old) parts.push(t.export.oldSuffix);
  return `${parts.join("_")}.mp4`;
}

/** Saves a project video and remembers it was downloaded (clears the export button's dot). */
export function saveVideo(url: string, projectName: string, video: VideoFileInfo, old = false): Promise<void> {
  return saveWithToasts(url, videoFileName(projectName, video, old), VIDEO_FILE_TYPE, true, () => markDownloaded(video.id));
}
