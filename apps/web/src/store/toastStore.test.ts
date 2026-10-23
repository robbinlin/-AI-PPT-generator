import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToasts } from "./toastStore";

describe("toast durations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  const alive = () => useToasts.getState().toasts.length;

  it("keeps a toast for the duration it was given (e.g. 影片匯出完成 / 下載影片 for 2 min)", () => {
    toast("影片匯出完成", "success", { label: "下載影片", run: () => undefined }, 120_000);
    vi.advanceTimersByTime(119_000);
    expect(alive()).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(alive()).toBe(0);
  });
  it("falls back to 10 s with an action, 7 s for errors, 3.5 s otherwise", () => {
    toast("a", "info", { label: "復原", run: () => undefined });
    toast("b", "error");
    toast("c");
    vi.advanceTimersByTime(3_600);
    expect(useToasts.getState().toasts.map((x) => x.text)).toEqual(["a", "b"]);
    vi.advanceTimersByTime(3_500);
    expect(useToasts.getState().toasts.map((x) => x.text)).toEqual(["a"]);
    vi.advanceTimersByTime(3_000);
    expect(alive()).toBe(0);
  });
});
