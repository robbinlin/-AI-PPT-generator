import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHeyGenGenerateBody,
  HeyGenAvatarProvider,
  mapHeyGenAvatars,
  mapHeyGenGenerateResponse,
  mapHeyGenStatus,
} from "../src/avatar/heygen.js";
import { MockAvatarProvider } from "../src/avatar/mock.js";

describe("heygen mapping", () => {
  it("builds an audio-driven generate body with chroma background", () => {
    const b = buildHeyGenGenerateBody({ avatarId: "av1", aspectRatio: "16:9", audioUrl: "https://x/a.wav", clientReference: "job-1" });
    expect(b.dimension).toEqual({ width: 1280, height: 720 });
    expect(b.video_inputs[0]!.voice).toEqual({ type: "audio", audio_url: "https://x/a.wav" });
    expect(b.video_inputs[0]!.background).toEqual({ type: "color", value: "#00FF00" });
    expect(b.callback_id).toBe("job-1");
    expect(() => buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "1:1" })).toThrow();
    expect(() => buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "1:1", text: "hi" })).toThrow(/voiceId/);
  });
  it("maps generate/status/avatars responses", () => {
    expect(mapHeyGenGenerateResponse({ error: null, data: { video_id: "vid" } })).toEqual({ taskId: "vid" });
    expect(() => mapHeyGenGenerateResponse({ error: { message: "quota" } })).toThrow(/quota/);
    expect(mapHeyGenStatus("vid", { data: { status: "completed", video_url: "u", duration: 12.5 } })).toEqual({
      taskId: "vid",
      status: "succeeded",
      progress: 1,
      resultUrl: "u",
      durationSec: 12.5,
    });
    expect(mapHeyGenStatus("vid", { data: { status: "failed", error: { message: "boom" } } })).toMatchObject({ status: "failed", error: "boom" });
    expect(mapHeyGenStatus("vid", { data: { status: "pending" } }).status).toBe("queued");
    expect(mapHeyGenStatus("vid", { data: { status: "processing" } }).status).toBe("processing");
    const avatars = mapHeyGenAvatars({
      data: { avatars: [{ avatar_id: "a", avatar_name: "A", preview_image_url: "p" }], talking_photos: [{ talking_photo_id: "t", talking_photo_name: "T" }] },
    });
    expect(avatars).toEqual([
      { id: "a", name: "A", kind: "stock", previewImageUrl: "p" },
      { id: "t", name: "T", kind: "personal" },
    ]);
  });
  it("sends x-api-key and hits documented endpoints", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method ?? "GET"} ${url} ${(init.headers as Record<string, string>)["x-api-key"]}`);
      if (url.includes("video/generate")) return new Response(JSON.stringify({ error: null, data: { video_id: "v9" } }));
      if (url.includes("video_status.get")) return new Response(JSON.stringify({ data: { status: "processing" } }));
      return new Response("{}");
    }) as unknown as typeof fetch;
    const p = new HeyGenAvatarProvider({ apiKey: "hg" }, { fetchImpl });
    const { taskId } = await p.createTask({ avatarId: "a", aspectRatio: "16:9", audioUrl: "https://x/a.wav" });
    expect(taskId).toBe("v9");
    expect((await p.getTask("v9")).status).toBe("processing");
    await p.cancelTask("v9");
    expect(seen).toEqual([
      "POST https://api.heygen.com/v2/video/generate hg",
      "GET https://api.heygen.com/v1/video_status.get?video_id=v9 hg",
      "DELETE https://api.heygen.com/v1/video.delete?video_id=v9 hg",
    ]);
  });
});

describe("mock avatar", () => {
  it("succeeds after N polls with a file:// mp4", async () => {
    const p = new MockAvatarProvider({ pollsUntilDone: 2 });
    const { taskId } = await p.createTask({ avatarId: "mock-teacher", aspectRatio: "16:9", audioUrl: "file:///tmp/a.wav" });
    expect((await p.getTask(taskId)).status).toBe("processing");
    const done = await p.getTask(taskId);
    expect(done.status).toBe("succeeded");
    expect(done.resultUrl).toMatch(/^file:\/\//);
    expect(existsSync(fileURLToPath(done.resultUrl!))).toBe(true);
    await p.cancelTask(taskId);
    expect((await p.getTask(taskId)).status).toBe("cancelled");
  }, 30_000);
});
