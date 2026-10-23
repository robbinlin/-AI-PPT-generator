import { describe, expect, it } from "vitest";
import {
  LocalAvatarProvider,
  localHint,
  mapLocalTask,
} from "../src/avatar/local.js";

describe("local avatar provider", () => {
  it("maps task states and absolute result urls", () => {
    const base = "http://127.0.0.1:8765";
    expect(
      mapLocalTask(
        {
          taskId: "t1",
          status: "queued",
          progress: 0,
          error: null,
          durationSec: null,
          resultUrl: null,
        },
        base,
      ).status,
    ).toBe("queued");
    expect(
      mapLocalTask(
        {
          taskId: "t1",
          status: "processing",
          progress: 0.3,
          error: null,
          durationSec: null,
          resultUrl: null,
        },
        base,
      ),
    ).toMatchObject({ status: "processing", progress: 0.3 });
    expect(
      mapLocalTask(
        {
          taskId: "t1",
          status: "succeeded",
          progress: 1,
          error: null,
          durationSec: 4.2,
          resultUrl: "/tasks/t1/result",
        },
        base,
      ),
    ).toEqual({
      taskId: "t1",
      status: "succeeded",
      progress: 1,
      resultUrl: "http://127.0.0.1:8765/tasks/t1/result",
      durationSec: 4.2,
    });
    expect(
      mapLocalTask(
        {
          taskId: "t1",
          status: "failed",
          progress: 0,
          error: "no face",
          durationSec: null,
          resultUrl: null,
        },
        base,
      ),
    ).toMatchObject({ status: "failed", error: "no face" });
  });
  it("explains an unreachable or degraded service", () => {
    expect(localHint(null)).toMatch(/pnpm dev:avatar/);
    expect(
      localHint({
        ok: true,
        engine: "passthrough",
        device: "cpu",
        modelsReady: false,
      }),
    ).toMatch(/測試模式/);
    expect(
      localHint({
        ok: true,
        engine: "musetalk",
        device: "cuda",
        modelsReady: true,
      }),
    ).toBeUndefined();
  });
  it("uploads audio as multipart, lists characters, probes health", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/health"))
        return new Response(
          JSON.stringify({
            ok: true,
            engine: "musetalk",
            device: "cuda",
            modelsReady: true,
          }),
        );
      if (url.endsWith("/characters") && init.method === "POST") {
        const form = init.body as FormData;
        expect((form.get("file") as File).type).toBe("image/png");
        expect((form.get("file") as File).name).toBe("me.png");
        expect((form.get("file") as File).name).toBe("me.png");
        expect(form.get("name")).toBe("me");
        return new Response(
          JSON.stringify({
            id: "c1",
            name: "me",
            kind: "personal",
            previewImageUrl: "/characters/c1/preview.jpg",
            ready: true,
            sourceKind: "image",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/characters"))
        return new Response(
          JSON.stringify([
            {
              id: "c1",
              name: "me",
              kind: "personal",
              previewImageUrl: "/characters/c1/preview.jpg",
              ready: true,
              sourceKind: "image",
            },
          ]),
        );
      if (url.endsWith("/tasks") && init.method === "POST") {
        const form = init.body as FormData;
        expect(form.get("characterId")).toBe("c1");
        expect((form.get("audio") as File).type).toBe("audio/mpeg");
        return new Response(
          JSON.stringify({ taskId: "t9", status: "queued" }),
          { status: 202 },
        );
      }
      if (url.endsWith("/tasks/t9"))
        return new Response(
          JSON.stringify({
            taskId: "t9",
            status: "processing",
            progress: 0.5,
            error: null,
            durationSec: null,
            resultUrl: null,
          }),
        );
      return new Response("{}");
    }) as unknown as typeof fetch;
    const p = new LocalAvatarProvider(
      { baseUrl: "http://avatar.test/" },
      { fetchImpl },
    );
    expect(await p.probe()).toEqual({ ok: true });
    const c = await p.createCharacter({ data: new Uint8Array([1]), mimeType: "image/png", fileName: "me.png", name: "me" });
    expect(c).toEqual({
      id: "c1",
      name: "me",
      kind: "personal",
      previewImageUrl: "http://avatar.test/characters/c1/preview.jpg",
      source: "photo",
    });
    expect((await p.listAvatars())[0]!.id).toBe("c1");
    const { taskId } = await p.createTask({
      avatarId: "c1",
      aspectRatio: "16:9",
      audio: {
        data: new Uint8Array([1, 2]),
        mimeType: "audio/mpeg",
        fileName: "a.mp3",
      },
    });
    expect(taskId).toBe("t9");
    expect((await p.getTask("t9")).status).toBe("processing");
    expect(seen[0]).toBe("GET http://avatar.test/health");
    expect(seen).toContain("POST http://avatar.test/tasks");
  });
});
