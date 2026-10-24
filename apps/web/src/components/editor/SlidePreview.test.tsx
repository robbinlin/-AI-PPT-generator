import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AvatarLayout } from "@lvs/shared";
import { ApiProvider, makeEnv } from "../../api/context";
import { MockApiClient } from "../../api/mock";
import { makeDetail } from "../../test/fixtures";
import { SlidePreview } from "./SlidePreview";

function setup(onLayoutCommit: (l: AvatarLayout) => Promise<boolean>) {
  const detail = makeDetail();
  const project = { ...detail.project, settings: { ...detail.project.settings, avatar: { ...detail.project.settings.avatar, enabled: true, avatarId: "a1" } } };
  const slide = detail.slides[0]!;
  const scene = detail.scenes.find((s) => s.slideId === slide.id);
  const env = makeEnv(new MockApiClient({ seed: false }), "requested", "http://test");
  render(
    <ApiProvider env={env}>
      <SlidePreview project={project} slide={slide} scene={scene} subtitleText="" assets={detail.assets} onLayoutCommit={onLayoutCommit} />
    </ApiProvider>,
  );
  const overlay = screen.getByTestId("avatar-overlay");
  // jsdom has no layout: give the video frame a size so the drag maths has something to work with.
  const frame = overlay.parentElement!;
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
  return overlay;
}

describe("SlidePreview avatar drag", () => {
  it("saves the new position when the drag ends (it used to compare against the live draft and never save)", () => {
    const commit = vi.fn(async (_l: AvatarLayout) => true);
    const overlay = setup(commit);
    fireEvent.pointerDown(overlay, { clientX: 1400, clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(commit).toHaveBeenCalledTimes(1);
    const saved = commit.mock.calls[0]![0];
    expect(saved.x).toBeLessThan(0.5);
  });

  it("does not save a click without movement", () => {
    const commit = vi.fn(async (_l: AvatarLayout) => true);
    const overlay = setup(commit);
    fireEvent.pointerDown(overlay, { clientX: 1400, clientY: 700, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 1400, clientY: 700, pointerId: 1 });
    expect(commit).not.toHaveBeenCalled();
  });
});
