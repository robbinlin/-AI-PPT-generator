import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider, makeEnv } from "../../api/context";
import { MockApiClient } from "../../api/mock";
import { editorStore } from "../../store/editorStore";
import { makeDetail, testId } from "../../test/fixtures";
import { PageList } from "./PageList";
import { StatusDots, StatusSummary } from "./StatusDots";

function renderList() {
  const actions = {
    reorder: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    updateScene: vi.fn(async () => true),
  };
  const env = makeEnv(new MockApiClient({ seed: false }), "requested", "http://test");
  render(
    <ApiProvider env={env}>
      <PageList actions={actions} />
    </ApiProvider>,
  );
  return actions;
}

function dotsOf(item: HTMLElement): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const dot of item.querySelectorAll("[data-field]"))
    out[dot.getAttribute("data-field") ?? ""] = dot.getAttribute("data-status");
  return out;
}

describe("StatusDots", () => {
  it("renders the four states in order with labels", () => {
    const detail = makeDetail();
    const scene = detail.scenes[0];
    if (!scene) throw new Error("fixture");
    render(<StatusDots scene={{ ...scene, avatar: { status: "generating" }, subtitle: { status: "failed", error: "boom" } }} />);
    const dots = screen.getAllByRole("img");
    expect(dots.map((d) => d.getAttribute("data-field"))).toEqual(["script", "audio", "avatar", "subtitle"]);
    expect(screen.getByLabelText("講稿：就緒")).toHaveClass("bg-emerald-500/20");
    expect(screen.getByLabelText("人像：產生中")).toHaveClass("animate-pulse");
    expect(screen.getByLabelText("字幕：失敗 (boom)")).toHaveClass("bg-rose-500/30");
    // Each chip carries its field's first character, so state is not conveyed by colour alone.
    expect(screen.getByLabelText("語音：就緒")).toHaveTextContent("語");
  });

  it("summarises the most urgent state in words", () => {
    const detail = makeDetail();
    const scene = detail.scenes[0];
    if (!scene) throw new Error("fixture");
    render(<StatusSummary scene={{ ...scene, audio: { status: "stale" }, avatar: { status: "stale" } }} />);
    expect(screen.getByText("語音、人像需更新")).toBeInTheDocument();
  });
});

describe("PageList", () => {
  beforeEach(() => {
    const detail = makeDetail();
    const [, second, third] = detail.scenes;
    if (!second || !third) throw new Error("fixture");
    second.script = { status: "ready" };
    second.audio = { status: "stale", assetId: testId() };
    second.muted = true;
    third.script = { status: "queued" };
    const thirdSlide = detail.slides[2];
    if (thirdSlide) thirdSlide.hidden = true;
    editorStore.getState().load(detail);
  });
  afterEach(() => editorStore.getState().reset());

  it("shows each page's status dots, first script line and hidden/muted icons", () => {
    renderList();
    const items = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-scene-id"));
    expect(items).toHaveLength(3);
    const [p1, p2, p3] = items as [HTMLElement, HTMLElement, HTMLElement];

    // The fixture project has no avatar, so that chip reads 未使用 instead of 尚未產生.
    expect(dotsOf(p1)).toEqual({ script: "ready", audio: "ready", avatar: "unused", subtitle: "missing" });
    expect(dotsOf(p2)).toEqual({ script: "ready", audio: "stale", avatar: "unused", subtitle: "missing" });
    expect(dotsOf(p3)).toEqual({ script: "queued", audio: "missing", avatar: "unused", subtitle: "missing" });

    expect(within(p1).getByText("第一頁講稿")).toBeInTheDocument();
    expect(within(p2).getByText("（尚無講稿）")).toBeInTheDocument();
    expect(within(p2).getByLabelText("已靜音")).toBeInTheDocument();
    expect(within(p3).getByLabelText("已隱藏（不會出現在影片中）")).toBeInTheDocument();
    expect(within(p1).queryByLabelText("已靜音")).toBeNull();
  });

  it("updates the dots when a scene event arrives", () => {
    renderList();
    const scene = editorStore.getState().detail?.scenes[0];
    if (!scene) throw new Error("fixture");
    act(() => editorStore.getState().applyEvent({ kind: "scene", scene: { ...scene, audio: { status: "generating" } } }));
    const first = screen.getAllByRole("listitem").find((li) => li.getAttribute("data-scene-id") === scene.id);
    expect(first && dotsOf(first).audio).toBe("generating");
  });

  it("selects a page on click and offers hide/mute in the context menu", async () => {
    const user = userEvent.setup();
    const actions = renderList();
    const second = editorStore.getState().detail?.scenes[1];
    await user.click(screen.getByRole("button", { name: "第 2 頁" }));
    expect(editorStore.getState().selectedSceneId).toBe(second?.id);

    const item = screen.getAllByRole("listitem").find((li) => li.getAttribute("data-scene-id") === second?.id);
    if (!item) throw new Error("missing item");
    await user.click(within(item).getByRole("button", { name: "第 2 頁的動作" }));
    await user.click(screen.getByRole("menuitem", { name: "取消靜音" }));
    expect(actions.updateScene).toHaveBeenCalledWith(second?.id, { muted: false });

    await user.click(within(item).getByRole("button", { name: "第 2 頁的動作" }));
    await user.click(screen.getByRole("menuitem", { name: "隱藏此頁" }));
    expect(actions.setHidden).toHaveBeenCalledWith(second?.slideId, true);
  });
});
