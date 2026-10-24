/**
 * Generation handlers with fake seams (no providers): pending-only estimates, generate_avatar
 * synthesizing stale audio first, zh-TW job messages, currentRenderHashes and list thumbnails.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostEstimate, Job, Project, ProjectDetail } from "@lvs/shared";
import { assets, jobs, scenes } from "../src/db/schema.js";
import type { GenerationSeams } from "../src/jobs/handlers/generation.js";
import { unimplementedSeams } from "../src/jobs/handlers/generation.js";
import { createTestServer, FakeParserRunner, multipart, TINY_PDF, type TestServer } from "./helpers.js";

const speechCalls: string[] = [];
const avatarCalls: Array<{ sceneId: string; audioAssetId: string }> = [];

async function fakeAsset(db: TestServer["ctx"]["db"], projectId: string, kind: string, inputHash: string, jobId: string) {
  const id = randomUUID();
  await db.insert(assets).values({ id, projectId, kind, storageKey: `fake/${id}`, mimeType: "application/octet-stream", sizeBytes: 1, inputHash, producedBy: { jobId } });
  return id;
}

const seams: GenerationSeams = {
  ...unimplementedSeams,
  async synthesizeSpeech({ ctx, scene, inputHash, progress }) {
    speechCalls.push(scene.id);
    await progress?.(0.5, "呼叫語音服務");
    const assetId = await fakeAsset(ctx.db, ctx.job.projectId, "audio", inputHash, ctx.job.id);
    const [row] = await ctx.db.select().from(scenes).where(eq(scenes.id, scene.id));
    await ctx.db
      .update(scenes)
      .set({
        durationSec: 5,
        audio: { status: "ready", assetId, inputHash, jobId: ctx.job.id },
        avatar: row!.avatar.status === "missing" ? row!.avatar : { ...row!.avatar, status: "stale" },
      })
      .where(eq(scenes.id, scene.id));
  },
  async generateAvatar({ ctx, scene, audioAssetId, inputHash }) {
    avatarCalls.push({ sceneId: scene.id, audioAssetId });
    const assetId = await fakeAsset(ctx.db, ctx.job.projectId, "avatar_video", inputHash, ctx.job.id);
    await ctx.storage.put(`fake/${assetId}`, Buffer.from("clip"), "video/mp4"); // a real file, so it can be reused
    await ctx.db.update(scenes).set({ avatar: { status: "ready", assetId, inputHash, jobId: ctx.job.id } }).where(eq(scenes.id, scene.id));
  },
  async renderVideo({ ctx, inputHash }) {
    const videoAssetId = await fakeAsset(ctx.db, ctx.job.projectId, "video", inputHash, ctx.job.id);
    return { videoAssetId };
  },
  async translateScript({ script, previousScript, pageNumber, to }) {
    translateCalls.push({ script, previousScript, pageNumber, to });
    const text = `Page ${pageNumber} in English.`;
    return { script: text, pronunciationText: text, subtitleText: text, estimatedDurationSec: 2 };
  },
};
const translateCalls: Array<{ script: string; previousScript?: string; pageNumber: number; to: string }> = [];

let t: TestServer;
let projectId: string;
const messages: string[] = [];

const detail = async () => (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
const estimate = async (query: string) => {
  const res = await t.app.inject({ method: "GET", url: `/projects/${projectId}/estimate?${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as CostEstimate;
};
async function run(payload: Record<string, unknown>, pid = projectId) {
  const res = await t.app.inject({ method: "POST", url: `/projects/${pid}/jobs`, payload });
  expect(res.statusCode).toBe(202);
  const body = res.json() as { job: Job; estimate?: CostEstimate };
  await t.ctx.runner.drain();
  const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, body.job.id));
  return { row: row!, estimate: body.estimate };
}

beforeAll(async () => {
  t = await createTestServer({
    seams,
    parser: new FakeParserRunner([
      { pageNumber: 1, title: "A", plainText: "第一頁" },
      { pageNumber: 2, title: "B", plainText: "第二頁" },
      { pageNumber: 3, title: "C", plainText: "第三頁" },
    ]),
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/projects",
    payload: {
      name: "gen",
      settings: {
        llmProviderId: "mock",
        voice: { providerId: "mock", voiceId: "mock-zh-f" },
        avatar: { enabled: true, providerId: "mock", avatarId: "mock-teacher" },
      },
    },
  });
  projectId = res.json().id;
  t.ctx.bus.subscribe(projectId, (ev) => {
    if (ev.kind === "job" && ev.job.progressMessage) messages.push(ev.job.progressMessage);
  });
  await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("deck.pdf", TINY_PDF, "application/pdf") });
  await t.ctx.runner.drain();
  const d = await detail();
  for (const [i, sc] of d.scenes.entries()) {
    await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${sc.id}/script`, payload: { script: `這是第 ${i + 1} 頁的講稿內容。`.repeat(i + 1) } });
  }
});
afterAll(async () => {
  await t.cleanup();
});

describe("generation handlers", () => {
  it("estimates only pending pages by default, all with scope=all, and respects sceneIds", async () => {
    const d = await detail();
    const first = d.scenes[0]!;
    let e = await estimate("type=synthesize_speech");
    expect(e.sceneCount).toBe(3);
    const allChars = d.scenes.reduce((n, sc) => n + d.scripts[sc.id]!.pronunciationText.length, 0);
    expect(e.lines[0]?.quantity).toBe(allChars);

    e = await estimate(`type=synthesize_speech&sceneIds=${first.id}`);
    expect(e.sceneCount).toBe(1);
    expect(e.lines[0]?.quantity).toBe(d.scripts[first.id]!.pronunciationText.length);

    const { row, estimate: attached } = await run({ type: "synthesize_speech", sceneIds: [first.id] });
    expect(row.status).toBe("succeeded");
    expect(attached?.sceneCount).toBe(1);
    expect(messages).toContain("正在產生第 1 頁語音");
    expect(messages).toContain("第 1 頁：呼叫語音服務");
    expect(messages).toContain("第 1 頁語音完成");

    expect((await estimate("type=synthesize_speech")).sceneCount).toBe(2);
    expect((await estimate("type=synthesize_speech&scope=all")).sceneCount).toBe(3);
    const bad = await t.app.inject({ method: "GET", url: `/projects/${projectId}/estimate?type=synthesize_speech&scope=some` });
    expect(bad.statusCode).toBe(400);
  });

  it("generate_script estimate counts only pages needing a script, plus the outline when it must be planned", async () => {
    const e = await estimate("type=generate_script");
    expect(e.sceneCount).toBe(0); // all three scripts are user-written and current
    expect(e.lines.some((l) => l.unit === "tokens_in" && l.quantity > 0)).toBe(true); // outline is missing
    expect((await estimate("type=generate_script&scope=all")).sceneCount).toBe(3);
  });

  it("generate_avatar estimate includes the speech for pages whose audio is not ready", async () => {
    const d = await detail();
    const e = await estimate("type=generate_avatar");
    expect(e.sceneCount).toBe(3);
    const chars = d.scenes.slice(1).reduce((n, sc) => n + d.scripts[sc.id]!.pronunciationText.length, 0);
    expect(e.lines.find((l) => l.unit === "chars")?.quantity).toBe(chars);
    const expectedSec = 5 + d.scenes.slice(1).reduce((n, sc) => n + (d.scripts[sc.id]!.estimatedDurationSec ?? d.scripts[sc.id]!.script.length / 4.5), 0);
    expect(e.seconds).toBeCloseTo(expectedSec, 1);
    expect(e.lines.find((l) => l.unit === "avatar_seconds")?.quantity).toBe(Math.ceil(expectedSec));
  });

  it("generate_avatar synthesizes missing audio first, then makes every avatar", async () => {
    speechCalls.length = 0;
    messages.length = 0;
    const { row } = await run({ type: "generate_avatar" });
    expect(row.error ?? "").toBe("");
    expect(row.status).toBe("succeeded");
    expect(row.result).toMatchObject({ processed: 3, skipped: 0, synthesized: 2 });
    const d = await detail();
    expect(speechCalls).toEqual([d.scenes[1]!.id, d.scenes[2]!.id]);
    expect(avatarCalls.map((c) => c.sceneId)).toEqual(d.scenes.map((s) => s.id));
    for (const sc of d.scenes) {
      expect(sc.audio.status).toBe("ready");
      expect(sc.avatar.status).toBe("ready");
      expect(avatarCalls.find((c) => c.sceneId === sc.id)?.audioAssetId).toBe(sc.audio.assetId);
    }
    expect(messages).toContain("正在產生第 2 頁語音");
    expect(messages).toContain("第 2 頁：呼叫語音服務");
    expect(messages).toContain("正在產生第 1 頁人像");
    expect(messages).toContain("第 3 頁人像完成");
    const after = await estimate("type=generate_avatar");
    expect(after.sceneCount).toBe(0);
    expect(after.total).toBe(0);
    expect((await estimate("type=generate_avatar&scope=all")).sceneCount).toBe(3);
  });

  it("currentRenderHashes contains a freshly rendered video's input hash until inputs change", async () => {
    const { row } = await run({ type: "render_video", preset: "preview_540p", burnSubtitles: false });
    expect(row.status).toBe("succeeded");
    expect(messages).toContain("準備合成影片");
    const videoId = (row.result as { videoAssetId: string }).videoAssetId;
    let d = await detail();
    expect(d.currentRenderHashes).toHaveLength(4);
    expect(d.currentRenderHashes).toContain(d.assets[videoId]?.inputHash);
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/scenes/${d.scenes[1]!.id}`, payload: { tailPauseSec: 2.5 } });
    d = await detail();
    expect(d.currentRenderHashes).not.toContain(d.assets[videoId]?.inputHash);
  });

  it("render precondition lists the pages (editor numbering) whose audio is out of date", async () => {
    const d = await detail();
    for (const i of [0, 2]) {
      await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${d.scenes[i]!.id}/script`, payload: { script: `改寫第 ${i + 1} 頁。` } });
    }
    const { row } = await run({ type: "render_video", preset: "preview_540p" });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("第 1、3 頁的語音不是最新的，請先按「產生全部語音」");
  });

  it("typing a script back to what the audio was made from makes audio, subtitles and avatar ready again", async () => {
    const d = await detail();
    for (const i of [0, 2]) {
      expect(d.scenes[i]!.audio.status).toBe("stale");
      expect(d.scenes[i]!.avatar.status).toBe("stale");
      await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${d.scenes[i]!.id}/script`, payload: { script: `這是第 ${i + 1} 頁的講稿內容。`.repeat(i + 1) } });
    }
    const after = await detail();
    for (const sc of after.scenes) {
      expect(sc.audio.status).toBe("ready");
      expect(sc.avatar.status).toBe("ready");
    }
    expect((await estimate("type=generate_avatar")).sceneCount).toBe(0); // nothing to pay for again
  });

  it("switching the character away and back reuses the clips already made instead of paying again", async () => {
    const before = await detail();
    const original = before.scenes.map((s) => s.avatar.assetId);
    expect(before.scenes.every((s) => s.avatar.status === "ready")).toBe(true);
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { avatarId: "mock-other" } } } });
    const calls = avatarCalls.length;
    expect((await run({ type: "generate_avatar" })).row.status).toBe("succeeded");
    expect(avatarCalls.length).toBe(calls + 3); // a new character is new clips

    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { avatarId: "mock-teacher" } } } });
    expect((await detail()).scenes.every((s) => s.avatar.status === "stale")).toBe(true);
    messages.length = 0;
    const back = await run({ type: "generate_avatar" });
    expect(back.row.result).toMatchObject({ processed: 3, reused: 3 });
    expect(avatarCalls.length).toBe(calls + 3); // nothing sent to the provider
    expect(messages).toContain("第 1 頁沿用先前做好的人像（不另收費）");
    const after = await detail();
    expect(after.scenes.map((s) => s.avatar.assetId)).toEqual(original);
    expect(after.scenes.every((s) => s.avatar.status === "ready")).toBe(true);
  });

  it("建立英文版 copies the deck under the new project and fills it with translated, current scripts", async () => {
    const src = await detail();
    const est = await estimate("type=translate_script");
    expect(est.sceneCount).toBe(3);
    expect(est.lines.map((l) => l.unit)).toEqual(["tokens_in", "tokens_out"]); // one LLM call per page (the mock LLM is free)

    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/translations`, payload: { language: "en" } });
    expect(res.statusCode).toBe(201);
    const { project, job } = res.json() as { project: Project; job: Job };
    expect(project.name).toBe("gen（英文版）");
    expect(project.settings.language).toBe("en");
    expect(project.settings.voice).toEqual(src.project.settings.voice);
    expect(job.type).toBe("translate_script");
    await t.ctx.runner.drain();

    const en = (await t.app.inject({ method: "GET", url: `/projects/${project.id}` })).json() as ProjectDetail;
    expect(en.slides).toHaveLength(src.slides.length);
    expect(en.slides.map((s) => s.content.title)).toEqual(src.slides.map((s) => s.content.title));
    expect(en.slides.map((s) => s.hidden)).toEqual(src.slides.map((s) => s.hidden));
    // Own assets and files: the copy's slide images are served for the copy, not borrowed.
    for (const s of en.slides) {
      expect(src.slides.some((o) => o.imageAssetId === s.imageAssetId)).toBe(false);
      const url = await t.app.inject({ method: "GET", url: `/projects/${project.id}/assets/${s.imageAssetId}/url` });
      expect(url.statusCode).toBe(200);
    }
    expect(translateCalls.map((c) => c.pageNumber)).toEqual([1, 2, 3]);
    expect(translateCalls.every((c) => c.to === "en")).toBe(true);
    expect(translateCalls[1]!.previousScript).toBe(src.scripts[src.scenes[0]!.id]!.script);
    for (const sc of en.scenes) {
      expect(en.scripts[sc.id]?.script).toBe(`Page ${sc.index + 1} in English.`);
      expect(sc.script.status).toBe("ready"); // current, not 需更新
      expect(sc.audio.status).toBe("missing"); // English speech is made in the copy
      expect(sc.avatar.status).toBe("missing");
    }
    // The original is untouched.
    const after = await detail();
    expect(after.scenes.map((s) => after.scripts[s.id]?.script)).toEqual(src.scenes.map((s) => src.scripts[s.id]?.script));
    expect(after.project.settings.language).toBe(src.project.settings.language);
  });

  it("zh-TW errors for a disabled avatar and a project without slides", async () => {
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { enabled: false } } } });
    const off = await run({ type: "generate_avatar" });
    expect(off.row.status).toBe("failed");
    expect(off.row.error).toBe("這個專案沒有啟用虛擬人像，請到「虛擬人與聲音」分頁開啟");
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { enabled: true } } } });

    const empty = (await t.app.inject({ method: "POST", url: "/projects", payload: { name: "empty" } })).json() as Project;
    const r = await run({ type: "render_video" }, empty.id);
    expect(r.row.error).toBe("專案還沒有投影片，請先上傳簡報");
    const s = await run({ type: "generate_script" }, empty.id);
    expect(s.row.error).toBe("專案還沒有投影片，請先上傳簡報");
  });

  it("project list and detail carry the first visible page's thumbnail", async () => {
    const d = await detail();
    const listed = () => t.app.inject({ method: "GET", url: "/projects" }).then((r) => (r.json() as Project[]).find((p) => p.id === projectId)!);
    expect(d.slides[0]!.thumbnailAssetId).toBeTruthy();
    expect(d.slides[1]!.thumbnailAssetId).not.toBe(d.slides[0]!.thumbnailAssetId);
    expect(d.project.thumbnailAssetId).toBe(d.slides[0]!.thumbnailAssetId);
    expect((await listed()).thumbnailAssetId).toBe(d.slides[0]!.thumbnailAssetId);
    expect((await listed()).pageCount).toBe(3);
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/slides/${d.slides[0]!.id}`, payload: { hidden: true } });
    expect((await listed()).thumbnailAssetId).toBe(d.slides[1]!.thumbnailAssetId);
    expect((await detail()).project.thumbnailAssetId).toBe(d.slides[1]!.thumbnailAssetId);
  });
});
