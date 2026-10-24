import { describe, expect, it } from "vitest";
import { ApiRequestError, errorMessage } from "../api/types";
import { friendlyJobError } from "./jobErrors";

describe("errorMessage", () => {
  it("turns English API errors into plain zh-TW, keeps Chinese ones", () => {
    expect(errorMessage(new ApiRequestError("Network error", 0, "network_error"))).toContain("連不上伺服器");
    expect(errorMessage(new ApiRequestError("scene 3f2a not found", 404, "not_found"))).toContain("另一個分頁換了簡報");
    expect(errorMessage(new ApiRequestError("invalid body", 400, "bad_request"))).toContain("不符合格式");
    expect(errorMessage(new ApiRequestError("internal error", 500, "internal"))).toContain("伺服器發生錯誤");
    expect(errorMessage(new ApiRequestError("heygen: HTTP 401 invalid api key", 502, "upstream"))).not.toContain("HTTP 401");
    expect(errorMessage(new ApiRequestError("「產生語音」已經在進行中", 409, "conflict"))).toBe("「產生語音」已經在進行中");
  });
});

describe("friendlyJobError", () => {
  it("judges the vendor part after the Chinese label", () => {
    expect(friendlyJobError("產生講稿失敗：第 2 頁：anthropic: request was refused by safety classifiers")).toContain("拒絕");
    expect(friendlyJobError("產生語音失敗：elevenlabs returned no audio")).toContain("沒有回傳");
  });
});
