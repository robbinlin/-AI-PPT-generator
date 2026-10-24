import { describe, expect, it } from "vitest";
import { voiceTagLabels } from "../components/editor/StudioPanel";
import { pageDragAnnouncements, pageDragInstructions } from "./dndA11y";

describe("voiceTagLabels", () => {
  it("shows vendor tags in Chinese and leaves out the ones it cannot name", () => {
    expect(voiceTagLabels(["middle_aged", "British", "narration", "zzz-unknown"])).toEqual(["中年", "英式口音", "旁白"]);
    expect(voiceTagLabels(["middle-aged", "middle aged"])).toEqual(["中年"]);
    expect(voiceTagLabels(undefined)).toEqual([]);
  });
});

describe("page drag announcements", () => {
  const pages = new Map([
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ]);
  const a = pageDragAnnouncements((id) => pages.get(String(id)));
  const ev = (active: string, over?: string) => ({ active: { id: active }, over: over ? { id: over } : null }) as never;

  it("speaks Chinese and names pages by number", () => {
    expect(pageDragInstructions.draggable).toContain("空白鍵");
    expect(a.onDragStart(ev("a"))).toBe("已拿起第 1 頁。");
    expect(a.onDragOver(ev("a", "c"))).toBe("第 1 頁移到第 3 頁的位置。");
    expect(a.onDragEnd(ev("a", "c"))).toBe("第 1 頁已放到第 3 頁的位置。");
    expect(a.onDragEnd(ev("b", "b"))).toBe("第 2 頁已放下，順序沒有改變。");
    expect(a.onDragCancel(ev("c"))).toBe("已取消，第 3 頁回到原位。");
  });
});
