/** Ask once for browser notifications so long jobs can report back after the user looks away. */
export function requestNotifyPermission(): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // Unsupported (e.g. insecure context): the in-page toast still appears.
  }
}

/** Shows a system notification when the page is hidden and the user allowed it. */
export function notifyIfHidden(title: string, body: string): void {
  try {
    if (typeof document === "undefined" || !document.hidden) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification(title, { body, tag: title });
  } catch {
    // ignore
  }
}
