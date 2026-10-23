import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHeyGenGenerateBody,
  HeyGenAvatarProvider,
  heyGenLookSource,
  mapHeyGenLooks,
  mapHeyGenGenerateResponse,
  mapHeyGenStatus,
} from "../src/avatar/heygen.js";
import { MockAvatarProvider } from "../src/avatar/mock.js";

describe("heygen mapping (v3)", () => {
  it("builds an avatar video body from an uploaded asset, a url, or text", () => {
    const b = buildHeyGenGenerateBody({ avatarId: "av1", aspectRatio: "16:9", audioUrl: "https://x/a.wav", clientReference: "job-1" }, "asset-9");
    expect(b).toMatchObject({ type: "avatar", avatar_id: "av1", audio_asset_id: "asset-9", aspect_ratio: "16:9", resolution: "720p", output_format: "mp4", remove_background: true });
    expect(buildHeyGenGenerateBody({ avatarId: "av1", aspectRatio: "16:9", audioUrl: "u" }, undefined, "avatar_iii", false)).toMatchObject({ engine: { type: "avatar_iii" } });
    expect(buildHeyGenGenerateBody({ avatarId: "av1", aspectRatio: "16:9", audioUrl: "u" }, undefined, undefined, false).remove_background).toBeUndefined();
    expect(b.audio_url).toBeUndefined();
    expect(b.background).toEqual({ type: "color", value: "#00FF00" });
    expect(b.callback_id).toBe("job-1");
    expect(buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "9:16", audioUrl: "https://x/a.wav" })).toMatchObject({ audio_url: "https://x/a.wav", aspect_ratio: "9:16" });
    expect(buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "1:1", text: "hi", voiceId: "v" })).toMatchObject({ script: "hi", voice_id: "v" });
    expect(() => buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "1:1" })).toThrow();
    expect(() => buildHeyGenGenerateBody({ avatarId: "a", aspectRatio: "1:1", text: "hi" })).toThrow(/voiceId/);
  });
  it("maps generate/status/looks responses", () => {
    expect(mapHeyGenGenerateResponse({ data: { video_id: "vid", status: "waiting" } })).toEqual({ taskId: "vid" });
    expect(() => mapHeyGenGenerateResponse({ error: { message: "quota" } })).toThrow(/quota/);
    expect(mapHeyGenStatus("vid", { data: { status: "completed", video_url: "u", duration: 12.5 } })).toEqual({
      taskId: "vid",
      status: "succeeded",
      progress: 1,
      resultUrl: "u",
      durationSec: 12.5,
    });
    expect(mapHeyGenStatus("vid", { data: { status: "failed", failure_code: "rendering_failed", failure_message: "boom" } })).toMatchObject({ status: "failed", error: "boom" });
    expect(mapHeyGenStatus("vid", { data: { status: "pending" } }).status).toBe("queued");
    expect(mapHeyGenStatus("vid", { data: { status: "processing" } }).status).toBe("processing");
    expect(mapHeyGenLooks({ data: [{ id: "lk1", name: "Business Suit", preview_image_url: "p" }] }, "public")).toEqual([
      { id: "lk1", name: "Business Suit", kind: "stock", previewImageUrl: "p" },
    ]);
    expect(mapHeyGenLooks({ data: [{ id: "me", name: "Me" }] }, "private")).toEqual([{ id: "me", name: "我的人像・Me", kind: "personal" }]);
  });
  it("tells photo avatars from video-trained ones (avatar_type, else the preview path)", () => {
    expect(heyGenLookSource({ avatar_type: "talking_photo" })).toBe("photo");
    expect(heyGenLookSource({ avatar_type: "studio_avatar" })).toBe("video");
    expect(heyGenLookSource({ preview_image_url: "https://files2.heygen.ai/talking_photo/x/y.WEBP?Expires=1" })).toBe("photo");
    expect(heyGenLookSource({ preview_image_url: "https://files2.heygen.ai/avatar/v3/x/full/2.2/preview_target.webp" })).toBe("video");
    expect(heyGenLookSource({ preview_image_url: "p" })).toBeUndefined();
    expect(mapHeyGenLooks({ data: [{ id: "a", name: "A", preview_image_url: "https://h/talking_photo/a.webp" }] }, "private")[0]).toMatchObject({ source: "photo" });
  });
  it("uploads audio as an asset, then hits the v3 endpoints with x-api-key", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push(`${init.method ?? "GET"} ${url} ${h["x-api-key"]}`);
      if (url.endsWith("/v3/assets")) {
        expect(init.body).toBeInstanceOf(FormData);
        expect(h["content-type"]).toBeUndefined(); // fetch sets the multipart boundary itself
        const file = (init.body as FormData).get("file") as File;
        expect(file.type).toBe("audio/mpeg");
        return new Response(JSON.stringify({ data: { asset_id: "as1", url: "https://files/x.mp3" } }));
      }
      if (url.endsWith("/v3/videos")) {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ type: "avatar", audio_asset_id: "as1" });
        // First attempt asks for matting; this look rejects it, so the retry must drop the flag.
        if (body.remove_background) return new Response(JSON.stringify({ error: { code: "invalid", message: "avatar does not support matting" } }), { status: 400 });
        return new Response(JSON.stringify({ data: { video_id: "v9", status: "waiting" } }));
      }
      if (url.includes("/v3/videos/v9") && init.method !== "DELETE") return new Response(JSON.stringify({ data: { id: "v9", status: "processing" } }));
      if (url.includes("/v3/avatars/looks")) {
        const u = new URL(url);
        const own = u.searchParams.get("ownership");
        const second = u.searchParams.get("token") === "t2";
        return new Response(
          JSON.stringify({
            data: [{ id: `${own}-${second ? 2 : 1}`, name: own! }],
            has_more: own === "public" && !second,
            next_token: own === "public" && !second ? "t2" : null,
          }),
        );
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const p = new HeyGenAvatarProvider({ apiKey: "hg" }, { fetchImpl });
    const { taskId } = await p.createTask({
      avatarId: "a",
      aspectRatio: "16:9",
      audio: { data: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg", fileName: "s.mp3" },
      audioUrl: "https://x/a.mp3",
    });
    expect(taskId).toBe("v9");
    expect((await p.getTask("v9")).status).toBe("processing");
    await p.cancelTask("v9");
    const looks = await p.listAvatars();
    expect(looks.map((l) => l.id)).toEqual(["private-1", "public-1", "public-2"]);
    expect(looks[0]!.kind).toBe("personal");
    expect(seen.slice(0, 5)).toEqual([
      "POST https://api.heygen.com/v3/assets hg",
      "POST https://api.heygen.com/v3/videos hg",
      "POST https://api.heygen.com/v3/videos hg",
      "GET https://api.heygen.com/v3/videos/v9 hg",
      "DELETE https://api.heygen.com/v3/videos/v9 hg",
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
