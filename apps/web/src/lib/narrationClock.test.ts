import { describe, expect, it } from "vitest";
import { avatarSyncAction } from "./narrationClock";

const audio = (currentTime: number, paused = false, ended = false) => ({ currentTime, paused, ended });
const video = (currentTime: number, paused = true, duration = 20) => ({ currentTime, paused, duration });

describe("avatarSyncAction", () => {
  it("plays alongside the narration and leaves small drift alone", () => {
    expect(avatarSyncAction(audio(5), video(5.05, false))).toEqual({ play: true });
  });
  it("re-seeks when the lips fall behind or run ahead of the voice", () => {
    expect(avatarSyncAction(audio(5), video(4.6, false))).toEqual({ play: true, seekTo: 5 });
    expect(avatarSyncAction(audio(5), video(5.5, false))).toEqual({ play: true, seekTo: 5 });
  });
  it("shows the matching frame while paused (no idle talking loop)", () => {
    expect(avatarSyncAction(audio(7.2, true), video(0, false))).toEqual({ play: false, seekTo: 7.2 });
    expect(avatarSyncAction(audio(0, true), video(0))).toEqual({ play: false });
  });
  it("holds the last frame once the narration runs past the clip", () => {
    const r = avatarSyncAction(audio(21), video(19.96));
    expect(r.play).toBe(false);
    expect(r.seekTo).toBeUndefined();
  });
});
