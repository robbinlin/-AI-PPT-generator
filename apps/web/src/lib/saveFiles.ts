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

export function videoFileName(projectName: string): string {
  return `${safeFileBase(projectName)}.mp4`;
}

/** Saves a project video and remembers it was downloaded (clears the export button's dot). */
export function saveVideo(url: string, projectName: string, assetId: string): Promise<void> {
  return saveWithToasts(url, videoFileName(projectName), VIDEO_FILE_TYPE, true, () => markDownloaded(assetId));
}
