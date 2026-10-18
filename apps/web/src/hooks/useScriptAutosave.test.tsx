import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS, useScriptAutosave } from "./useScriptAutosave";

describe("useScriptAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const save = vi.fn<(sceneId: string, text: string) => void>();
    const hook = renderHook(({ drafts }: { drafts: Record<string, string> }) => useScriptAutosave(drafts, save), {
      initialProps: { drafts: {} },
    });
    return { save, ...hook };
  }

  it("saves once, 800 ms after the last keystroke, with the latest text", () => {
    expect(AUTOSAVE_DELAY_MS).toBe(800);
    const { save, rerender } = setup();

    rerender({ drafts: { s1: "a" } });
    act(() => void vi.advanceTimersByTime(500));
    rerender({ drafts: { s1: "ab" } });
    act(() => void vi.advanceTimersByTime(500));
    rerender({ drafts: { s1: "abc" } });

    act(() => void vi.advanceTimersByTime(799));
    expect(save).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("s1", "abc");
  });

  it("debounces each scene independently", () => {
    const { save, rerender } = setup();
    rerender({ drafts: { s1: "one" } });
    act(() => void vi.advanceTimersByTime(400));
    rerender({ drafts: { s1: "one", s2: "two" } });
    act(() => void vi.advanceTimersByTime(400));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("s1", "one");
    act(() => void vi.advanceTimersByTime(400));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("s2", "two");
  });

  it("does not re-send an unchanged draft while the save is in flight", () => {
    const { save, rerender } = setup();
    rerender({ drafts: { s1: "x" } });
    act(() => void vi.advanceTimersByTime(800));
    // Another scene changes; s1 still has the same pending draft.
    rerender({ drafts: { s1: "x", s2: "y" } });
    act(() => void vi.advanceTimersByTime(2000));
    expect(save.mock.calls).toEqual([
      ["s1", "x"],
      ["s2", "y"],
    ]);
  });

  it("cancels a pending save when the draft disappears", () => {
    const { save, rerender } = setup();
    rerender({ drafts: { s1: "typo" } });
    act(() => void vi.advanceTimersByTime(300));
    rerender({ drafts: {} });
    act(() => void vi.advanceTimersByTime(2000));
    expect(save).not.toHaveBeenCalled();
  });

  it("flushes pending saves on unmount", () => {
    const { save, rerender, unmount } = setup();
    rerender({ drafts: { s1: "leaving" } });
    act(() => void vi.advanceTimersByTime(100));
    unmount();
    expect(save).toHaveBeenCalledWith("s1", "leaving");
  });
});
