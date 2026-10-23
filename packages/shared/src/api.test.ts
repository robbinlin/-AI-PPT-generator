import { describe, expect, it } from "vitest";
import { UpdateProjectRequest } from "./api.js";

describe("UpdateProjectRequest", () => {
  it("does not inject defaults into a partial settings patch", () => {
    const parsed = UpdateProjectRequest.parse({ settings: { avatar: { providerId: "heygen", avatarId: "abc" } } });
    expect(parsed.settings).toEqual({ avatar: { providerId: "heygen", avatarId: "abc" } });
  });

  it("keeps nested patches partial", () => {
    const parsed = UpdateProjectRequest.parse({ settings: { avatar: { layout: { size: 0.5 } }, subtitles: { style: { bold: true } } } });
    expect(parsed.settings).toEqual({ avatar: { layout: { size: 0.5 } }, subtitles: { style: { bold: true } } });
  });

  it("still validates values", () => {
    expect(() => UpdateProjectRequest.parse({ settings: { avatar: { layout: { size: 5 } } } })).toThrow();
    expect(() => UpdateProjectRequest.parse({ settings: { aspectRatio: "4:3" } })).toThrow();
  });
});
