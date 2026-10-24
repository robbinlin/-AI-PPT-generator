/**
 * A deck chosen while creating a project (projects page), uploaded by the editor as soon as the
 * new project opens, so it shows the usual upload/parse progress. Taken once; not persisted, so a
 * reload never uploads twice.
 */
const pending = new Map<string, File>();

export function setPendingUpload(projectId: string, file: File): void {
  pending.set(projectId, file);
}

export function takePendingUpload(projectId: string): File | undefined {
  const file = pending.get(projectId);
  pending.delete(projectId);
  return file;
}

/** 「112-1 統計學 第3週.pptx」 → 「112-1 統計學 第3週」 */
export function nameFromFile(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").trim().slice(0, 200);
}
