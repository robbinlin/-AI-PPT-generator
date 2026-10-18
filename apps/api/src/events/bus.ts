import type { ProjectEvent } from "@lvs/shared";

type Listener = (event: ProjectEvent) => void;

/**
 * In-process pub/sub keyed by project id. The SSE route subscribes; the job runner and
 * mutating routes publish. Multi-instance deployments replace this with Redis/NOTIFY.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(projectId: string, fn: Listener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) {
      set = new Set();
      this.listeners.set(projectId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) this.listeners.delete(projectId);
    };
  }

  publish(projectId: string, event: ProjectEvent): void {
    const set = this.listeners.get(projectId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must not break publishers */
      }
    }
  }

  subscriberCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }
}
