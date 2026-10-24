import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ProjectDetail, ProjectEvent, ScriptRevision } from "@lvs/shared";
import { jobs } from "../src/db/schema.js";
import { createTestServer, multipart, TINY_PDF, type TestServer } from "./helpers.js";

let t: TestServer;
let projectId: string;

beforeAll(async () => {
  t = await createTestServer();
});
afterAll(async () => {
  await t.cleanup();
});

describe("project lifecycle", () => {
  it("health", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("creates a project with default settings", async () => {
    const res = await t.app.inject({ method: "POST", url: "/projects", payload: { name: "運動生理學 第3週" } });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    projectId = p.id;
    expect(p.settings.language).toBe("zh-TW");
    expect(p.settings.voice.voiceId).toBe("Orus");
    const list = await t.app.inject({ method: "GET", url: "/projects" });
    expect(list.json()).toHaveLength(1);
  });

  it("rejects an invalid body with ApiError shape", async () => {
    const res = await t.app.inject({ method: "POST", url: "/projects", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("answers a truncated or malformed project link with 404, not 500", async () => {
    for (const url of ["/projects/7684974e-b946a185", "/projects/abc", "/projects/00000000-0000-4000-8000-000000000000/jobs"]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("rejects an unsupported upload", async () => {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("x.docx", Buffer.from("PK\x03\x04word/document.xml")) });
    expect(res.statusCode).toBe(400);
  });

  it("uploads a PDF, parses it, creates slides and scenes", async () => {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("deck.pdf", TINY_PDF, "application/pdf") });
    expect(res.statusCode).toBe(200);
    const { sourceDocument, job } = res.json();
    expect(sourceDocument.kind).toBe("pdf");
    expect(sourceDocument.version).toBe(1);
    expect(job.type).toBe("parse_document");

    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("succeeded");
    expect(row?.progress).toBe(1);

    const detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    expect(detail.sourceDocument?.parseStatus).toBe("succeeded");
    expect(detail.sourceDocument?.pageCount).toBe(2);
    expect(detail.slides).toHaveLength(2);
    expect(detail.scenes).toHaveLength(2);
    expect(detail.slides[1]?.content.notes).toBe("mention effect size");
    expect(detail.scenes[0]?.script.status).toBe("missing");
    const imageId = detail.slides[0]!.imageAssetId!;
    expect(detail.assets[imageId]?.kind).toBe("slide_image");
    expect(detail.assets[imageId]?.width).toBe(1920);
  });

  it("serves assets through signed URLs with range support", async () => {
    const detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const assetId = detail.slides[0]!.imageAssetId!;
    const unsigned = await t.app.inject({ method: "GET", url: `/assets/${assetId}` });
    expect(unsigned.statusCode).toBe(403);
    const { url } = (await t.app.inject({ method: "GET", url: `/projects/${projectId}/assets/${assetId}/url` })).json();
    expect(url).toMatch(/^http:\/\/api\.test\/assets\//);
    const path = url.replace("http://api.test", "");
    const full = await t.app.inject({ method: "GET", url: path });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("image/png");
    expect(full.rawPayload.length).toBeGreaterThan(20);
    const partial = await t.app.inject({ method: "GET", url: path, headers: { range: "bytes=0-3" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload.length).toBe(4);
    expect(partial.headers["content-range"]).toMatch(/^bytes 0-3\//);
  });

  it("PUT script creates revisions, no-ops on identical text, marks audio stale", async () => {
    let detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const scene = detail.scenes[0]!;
    const r1 = await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${scene.id}/script`, payload: { script: "各位好，  今天介紹  VO2max。" } });
    expect(r1.statusCode).toBe(200);
    const rev1 = r1.json() as ScriptRevision;
    expect(rev1.version).toBe(1);
    expect(rev1.source).toBe("user");
    expect(rev1.pronunciationText).toBe("各位好， 今天介紹 VO2max。");

    const again = (await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${scene.id}/script`, payload: { script: "各位好，  今天介紹  VO2max。" } })).json();
    expect(again.id).toBe(rev1.id);

    // Pretend audio exists so we can observe it going stale.
    const { scenes: scenesTable } = await import("../src/db/schema.js");
    await t.ctx.db.update(scenesTable).set({ audio: { status: "ready", assetId: rev1.id, inputHash: "old" } }).where(eq(scenesTable.id, scene.id));

    const r2 = await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${scene.id}/script`, payload: { script: "各位好，今天介紹最大攝氧量。" } });
    const rev2 = r2.json() as ScriptRevision;
    expect(rev2.version).toBe(2);
    detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const updated = detail.scenes.find((s) => s.id === scene.id)!;
    expect(updated.scriptRevisionId).toBe(rev2.id);
    expect(updated.script.status).toBe("ready");
    expect(updated.audio.status).toBe("stale");
    expect(detail.scripts[scene.id]?.id).toBe(rev2.id);
    expect(detail.totalDurationSec).toBeGreaterThan(0);

    const history = (await t.app.inject({ method: "GET", url: `/projects/${projectId}/scenes/${scene.id}/scripts` })).json();
    expect(history.map((h: ScriptRevision) => h.version)).toEqual([2, 1]);
  });

  it("re-upload keeps scripts for unchanged pages and marks changed pages stale", async () => {
    t.parser.pages = [
      { pageNumber: 1, title: "Intro", plainText: "Welcome to the course" }, // unchanged => script survives
      { pageNumber: 2, title: "Methods v2", plainText: "ANOVA, VO2max and HRV", notes: "mention effect size" }, // changed => stale
      { pageNumber: 3, title: "New", plainText: "Brand new page" },
    ];
    let detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const scene2 = detail.scenes[1]!;
    await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${scene2.id}/script`, payload: { script: "第二頁講稿" } });
    const scene1Id = detail.scenes[0]!.id;

    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("deck-v2.pdf", TINY_PDF, "application/pdf") });
    expect(res.json().sourceDocument.version).toBe(2);
    await t.ctx.runner.drain();

    detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    expect(detail.slides).toHaveLength(3);
    expect(detail.scenes).toHaveLength(3);
    expect(detail.scenes[0]!.id).toBe(scene1Id);
    expect(detail.scenes[0]!.script.status).toBe("ready");
    expect(detail.scripts[scene1Id]?.version).toBe(2);
    expect(detail.scenes[1]!.id).toBe(scene2.id);
    expect(detail.scenes[1]!.script.status).toBe("stale");
    expect(detail.scripts[scene2.id]?.script).toBe("第二頁講稿");
    expect(detail.scenes[2]!.script.status).toBe("missing");
  });

  it("reorders and hides slides", async () => {
    let detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const ids = detail.slides.map((s) => s.id);
    const reordered = [ids[2]!, ids[0]!, ids[1]!];
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/slides/reorder`, payload: { slideIds: reordered } });
    expect(res.statusCode).toBe(200);
    detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    expect(detail.slides.map((s) => s.id)).toEqual(reordered);
    expect(detail.scenes.map((s) => s.slideId)).toEqual(reordered);
    const bad = await t.app.inject({ method: "POST", url: `/projects/${projectId}/slides/reorder`, payload: { slideIds: [ids[0]] } });
    expect(bad.statusCode).toBe(400);
    const hide = await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/slides/${ids[2]}`, payload: { hidden: true } });
    expect(hide.json().hidden).toBe(true);
    // restore order for later tests
    await t.app.inject({ method: "POST", url: `/projects/${projectId}/slides/reorder`, payload: { slideIds: ids } });
  });

  it("PATCH scene updates mute and layout", async () => {
    const detail = (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
    const scene = detail.scenes[0]!;
    const res = await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/scenes/${scene.id}`, payload: { muted: true, avatarLayout: { anchor: "top-left" }, tailPauseSec: 1.5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().muted).toBe(true);
    expect(res.json().avatarLayout.anchor).toBe("top-left");
    expect(res.json().avatarLayout.size).toBe(0.35);
    const reset = await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/scenes/${scene.id}`, payload: { muted: false, avatarLayout: null } });
    expect(reset.json().avatarLayout).toBeUndefined();
  });

  it("generate_script plans the outline first and fails non-retryably without a configured LLM key", async () => {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload: { type: "generate_script" } });
    expect(res.statusCode).toBe(202);
    const { job, estimate } = res.json() as { job: Job; estimate: { lines: unknown[] } };
    expect(job.status).toBe("queued");
    expect(estimate.lines.length).toBeGreaterThan(0);
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1); // configuration errors are non-retryable
    expect(row?.error).toMatch(/還沒有設定 API 金鑰/);
    const listed = (await t.app.inject({ method: "GET", url: `/projects/${projectId}/jobs?status=failed` })).json();
    expect(listed.some((j: Job) => j.id === job.id)).toBe(true);
  });

  it("render_video refuses when audio is missing", async () => {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload: { type: "render_video" } });
    const jobId = res.json().job.id;
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/^第 1、2 頁的語音不是最新的，請先按「產生全部語音」$/);
  });

  it("estimate endpoint", async () => {
    const res = await t.app.inject({ method: "GET", url: `/projects/${projectId}/estimate?type=synthesize_speech` });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0].unit).toBe("chars");
    const bad = await t.app.inject({ method: "GET", url: `/projects/${projectId}/estimate?type=nope` });
    expect(bad.statusCode).toBe(400);
  });

  it("exports the script as markdown (sync route and job)", async () => {
    const res = await t.app.inject({ method: "GET", url: `/projects/${projectId}/export/script?format=md` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("# 運動生理學 第3週");
    expect(res.body).toContain("各位好，今天介紹最大攝氧量。");
    expect(res.body).not.toContain("Brand new page"); // hidden slide excluded
    const job = (await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload: { type: "export_script", format: "txt" } })).json().job as Job;
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.status).toBe("succeeded");
    expect(row?.result).toMatchObject({ format: "txt" });
  });

  it("streams job events over SSE", async () => {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const address = t.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/projects/${projectId}/events`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // first chunk is the ": connected" comment
    const first = await reader.read();
    buffer += decoder.decode(first.value);
    expect(buffer).toContain(": connected");

    const enqueue = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload: { type: "export_script", format: "md" } });
    const jobId = enqueue.json().job.id;
    let event: ProjectEvent | undefined;
    for (let i = 0; i < 10 && !event; i++) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value);
      const m = /event: job\ndata: (.*)\n\n/.exec(buffer);
      if (m) event = JSON.parse(m[1]!);
    }
    ac.abort();
    expect(event?.kind).toBe("job");
    expect((event as { job: Job }).job.id).toBe(jobId);
    await t.ctx.runner.drain();
  });

  it("deletes the project", async () => {
    const res = await t.app.inject({ method: "DELETE", url: `/projects/${projectId}` });
    expect(res.statusCode).toBe(204);
    const gone = await t.app.inject({ method: "GET", url: `/projects/${projectId}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe("providers", () => {
  it("lists providers and stores an encrypted key", async () => {
    const before = (await t.app.inject({ method: "GET", url: "/providers" })).json();
    const el = before.find((p: { id: string }) => p.id === "elevenlabs");
    expect(el.configured).toBe(false);
    const set = await t.app.inject({ method: "PUT", url: "/providers/elevenlabs/key", payload: { apiKey: "sk-test-123" } });
    expect(set.json().configured).toBe(true);
    const { providerKeys } = await import("../src/db/schema.js");
    const [row] = await t.ctx.db.select().from(providerKeys);
    expect(row?.ciphertext).not.toContain("sk-test-123");
    expect((await t.ctx.providers.credentials("dev", "elevenlabs")).apiKey).toBe("sk-test-123");
    // A key encrypted under a different process key must read as "not configured", not as a run-time failure.
    const { KeyCrypto } = await import("../src/services/providers.js");
    await t.ctx.db
      .update(providerKeys)
      .set({ ciphertext: new KeyCrypto(Buffer.alloc(32, 5)).encrypt("sk-old") })
      .where(eq(providerKeys.providerId, "elevenlabs"));
    const stale = (await t.app.inject({ method: "GET", url: "/providers" })).json().find((p: { id: string }) => p.id === "elevenlabs");
    expect(stale.configured).toBe(false);
    const del = await t.app.inject({ method: "DELETE", url: "/providers/elevenlabs/key" });
    expect(del.json().configured).toBe(false);
    const unknown = await t.app.inject({ method: "PUT", url: "/providers/nope/key", payload: { apiKey: "x" } });
    expect(unknown.statusCode).toBe(404);
    const voices = await t.app.inject({ method: "GET", url: "/providers/elevenlabs/voices" });
    expect(voices.statusCode).toBe(400); // no key configured
    const mockVoices = await t.app.inject({ method: "GET", url: "/providers/mock/voices" });
    expect(mockVoices.statusCode).toBe(200);
    expect(mockVoices.json().length).toBeGreaterThan(0);
    // Custom characters (self-hosted / mock avatar providers): upload, list, preview, delete.
    const mockInfo = (await t.app.inject({ method: "GET", url: "/providers" })).json().find((p: { id: string; kind: string }) => p.id === "mock" && p.kind === "avatar");
    expect(mockInfo.customCharacters).toBe(true);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const up = multipart("me.png", png, "image/png");
    const created = await t.app.inject({ method: "POST", url: "/providers/mock/characters", payload: up.payload, headers: up.headers });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "me", kind: "personal" });
    const listed = (await t.app.inject({ method: "GET", url: "/providers/mock/avatars" })).json();
    expect(listed.some((a: { id: string }) => a.id === created.json().id)).toBe(true);
    const delChar = await t.app.inject({ method: "DELETE", url: `/providers/mock/characters/${created.json().id}` });
    expect(delChar.statusCode).toBe(204);
    const rejected = await t.app.inject({ method: "POST", url: "/providers/heygen/characters", payload: up.payload, headers: up.headers });
    expect(rejected.statusCode).toBe(400); // no key configured in tests -> 400 from requireAvatar
    // Custom voices (self-hosted / mock TTS): upload a reference clip, list, delete.
    const ttsInfo = (await t.app.inject({ method: "GET", url: "/providers" })).json().find((p: { id: string; kind: string }) => p.id === "mock" && p.kind === "tts");
    expect(ttsInfo.customVoices).toBe(true);
    const wav = multipart("my-voice.wav", Buffer.from("RIFF"), "audio/wav");
    const voice = await t.app.inject({ method: "POST", url: "/providers/mock/voices", payload: wav.payload, headers: wav.headers });
    expect(voice.statusCode).toBe(201);
    expect(voice.json()).toMatchObject({ name: "我的聲音・my-voice" });
    const voicesNow = (await t.app.inject({ method: "GET", url: "/providers/mock/voices" })).json();
    expect(voicesNow[0].id).toBe(voice.json().id);
    expect((await t.app.inject({ method: "DELETE", url: `/providers/mock/voices/${voice.json().id}` })).statusCode).toBe(204);
    const mockAvatars = await t.app.inject({ method: "GET", url: "/providers/mock/avatars" });
    expect(mockAvatars.json()[0].id).toBe("mock-teacher");
  });
});

describe("cors", () => {
  it("allows the browser preflight for PUT/PATCH/DELETE from the editor origin", async () => {
    const t = await createTestServer();
    try {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const res = await t.app.inject({
          method: "OPTIONS",
          url: "/projects/x/scenes/y/script",
          headers: { origin: "http://localhost:5173", "access-control-request-method": method, "access-control-request-headers": "content-type" },
        });
        expect(res.statusCode).toBeLessThan(300);
        expect(res.headers["access-control-allow-methods"]).toContain(method);
        expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      }
    } finally {
      await t.close();
    }
  });
});

describe("project isolation", () => {
  it("parsing a document in one project never touches another project's slides, and a re-upload restores scripts", async () => {
    const t = await createTestServer();
    try {
      const mk = async (name: string) => (await t.app.inject({ method: "POST", url: "/projects", payload: { name } })).json().id as string;
      const upload = async (pid: string) => {
        const res = await t.app.inject({ method: "POST", url: `/projects/${pid}/source`, ...multipart("deck.pdf", TINY_PDF, "application/pdf") });
        expect(res.statusCode).toBe(200);
        await t.ctx.runner.drain();
      };
      const a = await mk("A");
      const b = await mk("B");
      await upload(a);
      let da = (await t.app.inject({ method: "GET", url: `/projects/${a}` })).json() as ProjectDetail;
      const slidesA = da.slides.length;
      expect(slidesA).toBeGreaterThan(0);
      const sceneA = da.scenes[0]!;
      await t.app.inject({ method: "PUT", url: `/projects/${a}/scenes/${sceneA.id}/script`, payload: { script: "A 專案第一頁的講稿" } });

      await upload(b);
      da = (await t.app.inject({ method: "GET", url: `/projects/${a}` })).json() as ProjectDetail;
      expect(da.slides.length).toBe(slidesA);
      expect(da.scripts[sceneA.id]?.script).toBe("A 專案第一頁的講稿");

      // Re-uploading the same deck keeps the scene (matched by content hash) and its script.
      await upload(a);
      da = (await t.app.inject({ method: "GET", url: `/projects/${a}` })).json() as ProjectDetail;
      expect(da.slides.length).toBe(slidesA);
      expect(Object.values(da.scripts).some((s) => s.script === "A 專案第一頁的講稿")).toBe(true);
    } finally {
      await t.close();
    }
  });
});
