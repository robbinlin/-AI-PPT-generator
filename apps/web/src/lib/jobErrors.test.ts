import { describe, expect, it } from "vitest";
import { t } from "../i18n";
import { friendlyJobError } from "./jobErrors";

describe("friendlyJobError", () => {
  it("explains common provider errors in Chinese", () => {
    expect(friendlyJobError("avatar provider and avatarId must be set in project settings")).toBe(t.jobErrors.noAvatar);
    expect(friendlyJobError('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(t.jobErrors.quota);
    expect(friendlyJobError("This model is currently experiencing high demand (503)")).toBe(t.jobErrors.busy);
    expect(friendlyJobError("elevenlabs: 401 Unauthorized")).toBe(t.jobErrors.key);
  });

  it("leaves our own Chinese messages as they are", () => {
    expect(friendlyJobError("第 1、3 頁的語音不是最新的，請先按「產生全部語音」")).toBeUndefined();
    expect(friendlyJobError(undefined)).toBeUndefined();
  });

  it("gives unknown English errors a short Chinese lead-in", () => {
    expect(friendlyJobError("Something unexpected happened while processing the request")).toBe(t.jobErrors.generic);
  });
});
