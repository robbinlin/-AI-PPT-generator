/**
 * Generation handlers with fake seams (no providers): pending-only estimates, generate_avatar
 * synthesizing stale audio first, zh-TW job messages, currentRenderHashes and list thumbnails.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CostEstimate, Job, Project, ProjectDetail } from "@lvs/shared";
import { runBackfills } from "../src/db/backfill.js";
import { assets, jobs, outlineRevisions, scenes, scriptRevisions } from "../src/db/schema.js";
import { outlineInputHash } from "../src/jobs/hashes.js";
import { createScriptRevision } from "../src/services/scripts.js";
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
  async generateScript({ ctx, scene, settings, instruction, currentScript }) {
    scriptCalls.push({ sceneId: scene.id, instruction, currentScript });
    const [row] = await ctx.db.select().from(scenes).where(eq(scenes.id, scene.id));
    const { revision } = await createScriptRevision(ctx.db, { scene: row!, script: "改寫後的講稿。", source: "ai", language: settings.language });
    return revision;
  },
  async translateScript({ script, previousScript, pageNumber, to }) {
    translateCalls.push({ script, previousScript, pageNumber, to });
    const text = `Page ${pageNumber} in English.`;
    return { script: text, pronunciationText: text, subtitleText: text, estimatedDurationSec: 2 };
  },
};
const translateCalls: Array<{ script: string; previousScript?: string; pageNumber: number; to: string }> = [];
const scriptCalls: Array<{ sceneId: string; instruction?: string; currentScript?: string }> = [];

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
    expect(row.error).toBe("第 1、3 頁的語音不是最新的，請先按上方的「補齊語音」，或在「匯出影片」裡按「產生語音並匯出」");
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
    expect((await estimate("type=generate_avatar")).reusedSceneCount).toBeUndefined();
    const calls = avatarCalls.length;
    expect((await run({ type: "generate_avatar" })).row.status).toBe("succeeded");
    expect(avatarCalls.length).toBe(calls + 3); // a new character is new clips

    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { avatarId: "mock-teacher" } } } });
    expect((await detail()).scenes.every((s) => s.avatar.status === "stale")).toBe(true);
    // The price says so before the job starts: three pages to do, all reused, no presenter seconds.
    const priced = await estimate("type=generate_avatar");
    expect(priced).toMatchObject({ sceneCount: 3, reusedSceneCount: 3, total: 0, seconds: 0 });
    expect(priced.lines.some((l) => l.unit === "avatar_seconds")).toBe(false);
    // "Redo everything" still prices every clip (what a voice change would cost).
    const redo = await estimate("type=generate_avatar&scope=all");
    expect(redo.reusedSceneCount).toBeUndefined();
    expect(redo.lines.find((l) => l.unit === "avatar_seconds")?.quantity).toBeGreaterThan(0);
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
    const srcOrdered = src.scenes.map((sc) => src.slides.find((sl) => sl.id === sc.slideId)!);
    await t.ctx.db.insert(outlineRevisions).values({
      id: randomUUID(),
      projectId,
      version: 1,
      objectives: ["目標"],
      summary: "課程摘要",
      sections: [],
      glossary: [{ term: "VO2max", reading: "最大攝氧量", definition: "有氧能力" }],
      timeAllocation: { [src.slides[0]!.id]: 40 },
      inputHash: outlineInputHash(srcOrdered, src.project.settings),
    });
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
    // Hiding a page in the copy must not mark the translation 需更新 (下一步 would then offer to
    // overwrite it with freshly generated scripts).
    expect(en.scripts[en.scenes[0]!.id]?.source).toBe("translation");
    // Translations saved before the "translation" source existed are fixed at startup.
    await t.ctx.db.update(scriptRevisions).set({ source: "ai" }).where(eq(scriptRevisions.id, en.scripts[en.scenes[0]!.id]!.id));
    await runBackfills(t.ctx.db);
    const [fixed] = await t.ctx.db.select().from(scriptRevisions).where(eq(scriptRevisions.id, en.scripts[en.scenes[0]!.id]!.id));
    expect(fixed!.source).toBe("translation");
    await t.app.inject({ method: "PATCH", url: `/projects/${project.id}/slides/${en.slides[2]!.id}`, payload: { hidden: true } });
    const hid = (await t.app.inject({ method: "GET", url: `/projects/${project.id}` })).json() as ProjectDetail;
    expect(hid.scenes.every((sc) => sc.script.status === "ready")).toBe(true);
    const listed = ((await t.app.inject({ method: "GET", url: "/projects" })).json() as Array<Project & { pageCount?: number; activePageCount?: number }>).find((p) => p.id === project.id)!;
    expect(listed.pageCount).toBe(3);
    expect(listed.activePageCount).toBe(2);
    // The original is untouched.
    const after = await detail();
    expect(after.scenes.map((s) => after.scripts[s.id]?.script)).toEqual(src.scenes.map((s) => src.scripts[s.id]?.script));
    expect(after.project.settings.language).toBe(src.project.settings.language);
    // The copy keeps the outline (glossary readings cleared: they were for the old language) and
    // it is current, so 下一步 does not pay to plan it again.
    const [srcOutline] = await t.ctx.db.select().from(outlineRevisions).where(eq(outlineRevisions.projectId, projectId)).orderBy(desc(outlineRevisions.version)).limit(1);
    const [enOutline] = await t.ctx.db.select().from(outlineRevisions).where(eq(outlineRevisions.projectId, project.id));
    expect(srcOutline).toBeDefined();
    expect(enOutline?.summary).toBe(srcOutline!.summary);
    expect(enOutline?.glossary).toEqual([{ term: "VO2max", definition: "有氧能力" }]);
    expect(enOutline?.timeAllocation).toEqual({ [en.slides[0]!.id]: 40 });
    const enEst = (await t.app.inject({ method: "GET", url: `/projects/${project.id}/estimate?type=generate_script` })).json() as { sceneCount: number; lines: unknown[] };
    expect(enEst.sceneCount).toBe(0);
    // A voice that cannot speak the new language is swapped by the caller (useTranslateProject).
    const swapped = await t.app.inject({ method: "POST", url: `/projects/${projectId}/translations`, payload: { language: "en", voiceId: "mock-voice-en" } });
    expect((swapped.json() as { project: Project }).project.settings.voice.voiceId).toBe("mock-voice-en");
    await t.ctx.runner.drain();
    // Later tests share this project and seed their own outline.
    await t.ctx.db.delete(outlineRevisions).where(eq(outlineRevisions.projectId, projectId));
  });

  it("zh-TW errors for a disabled avatar and a project without slides", async () => {
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { enabled: false } } } });
    const off = await run({ type: "generate_avatar" });
    expect(off.row.status).toBe("failed");
    expect(off.row.error).toBe("這個專案沒有啟用人像，請到「人像與聲音」分頁開啟");
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { enabled: true } } } });
    // 「只有投影片」: the render leaves the presenter out, so nothing is priced or made for it.
    const layout = (await detail()).project.settings.avatar.layout;
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { layout: { ...layout, visible: false } } } } });
    expect((await estimate("type=generate_avatar&scope=all")).sceneCount).toBe(0);
    const hidden = await run({ type: "generate_avatar", force: true });
    expect(hidden.row.status).toBe("failed");
    expect(hidden.row.error).toContain("只有投影片");
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { avatar: { layout } } } });

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

  it("correcting a glossary reading re-voices only the pages that use the term", async () => {
    const d0 = await detail();
    const [s1, s2, s3] = d0.scenes;
    const ordered = d0.scenes.map((sc) => d0.slides.find((sl) => sl.id === sc.slideId)!);
    await t.ctx.db.insert(outlineRevisions).values({
      id: randomUUID(),
      projectId,
      version: 1,
      objectives: ["目標"],
      summary: "摘要",
      sections: [],
      glossary: [{ term: "ANOVA", reading: "A NO VA" }],
      timeAllocation: {},
      // Current for these slides, so a script job does not plan a new outline first.
      inputHash: outlineInputHash(ordered, d0.project.settings),
    });
    await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${s3!.id}/script`, payload: { script: "最後用 ANOVA 比較三組。" } });
    expect((await run({ type: "synthesize_speech" })).row.status).toBe("succeeded");
    const before = await detail();
    // Page 1 is hidden (previous test), so the speech job left it alone.
    expect(before.scenes.filter((s) => s.id !== s1!.id).every((s) => s.audio.status === "ready")).toBe(true);
    expect(before.scripts[s3!.id]!.pronunciationText).toContain("A NO VA");

    const res = await t.app.inject({
      method: "PUT",
      url: `/projects/${projectId}/outline/glossary`,
      payload: { glossary: [{ term: "ANOVA", reading: "變異數分析" }, { term: "講稿", definition: "旁白" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedSceneIds).toEqual([s3!.id]);
    const after = await detail();
    expect(after.outline?.version).toBe(2);
    expect(after.outline?.glossary.find((g) => g.term === "ANOVA")?.reading).toBe("變異數分析");
    expect(after.scripts[s3!.id]!.pronunciationText).toContain("變異數分析");
    expect(after.scripts[s3!.id]!.script).toBe("最後用 ANOVA 比較三組。"); // the display text keeps the term
    expect(after.scenes.find((s) => s.id === s3!.id)!.audio.status).toBe("stale");
    // Pages that never say ANOVA keep their narration (and the avatars lip-synced to it).
    for (const id of [s2!.id]) {
      const sc = after.scenes.find((s) => s.id === id)!;
      const was = before.scenes.find((s) => s.id === id)!;
      expect(sc.audio.status).toBe("ready");
      expect(sc.subtitle.status).toBe(was.subtitle.status);
      expect(sc.avatar.status).toBe(was.avatar.status);
    }
    expect((await estimate("type=synthesize_speech")).sceneCount).toBe(1);
  });

  it("project list carries progress for the cards (length and whether the video is current)", async () => {
    const list = (await t.app.inject({ method: "GET", url: "/projects" })).json() as Array<Project & { totalDurationSec?: number; videoStatus?: string }>;
    const me = list.find((p) => p.id === projectId)!;
    expect(me.totalDurationSec).toBe((await detail()).totalDurationSec);
    expect(["current", "outdated"]).toContain(me.videoStatus); // earlier tests rendered a video
    const empty = list.find((p) => p.name === "empty");
    if (empty) expect(empty.videoStatus).toBe("none");
  });

  it("「全部做完再匯出」 queues the export on the server once the avatar job succeeds", async () => {
    const before = (await t.ctx.db.select().from(jobs).where(eq(jobs.projectId, projectId))).filter((j) => j.type === "render_video").length;
    const { row } = await run({ type: "generate_avatar", thenRender: { preset: "preview_540p", burnSubtitles: false } });
    expect(row.status).toBe("succeeded");
    const renders = (await t.ctx.db.select().from(jobs).where(eq(jobs.projectId, projectId))).filter((j) => j.type === "render_video");
    expect(renders.length).toBe(before + 1);
    const latest = renders.sort((a, b) => +b.createdAt - +a.createdAt)[0]!;
    expect(latest.payload).toMatchObject({ type: "render_video", preset: "preview_540p", burnSubtitles: false });
    expect(latest.status).toBe("succeeded");
  });

  it("「AI 重寫本頁」 with a direction passes it and the current script to the writer", async () => {
    const d = await detail();
    const sc = d.scenes[1]!;
    scriptCalls.length = 0;
    expect((await run({ type: "generate_script", sceneIds: [sc.id], force: true, instruction: "更口語；縮短到 30 秒" })).row.status).toBe("succeeded");
    expect(scriptCalls).toEqual([{ sceneId: sc.id, instruction: "更口語；縮短到 30 秒", currentScript: d.scripts[sc.id]!.script }]);
    expect((await detail()).scripts[sc.id]!.script).toBe("改寫後的講稿。");
  });

  it("rewriting one page after a page was shown again keeps the outline (no re-plan, other pages untouched)", async () => {
    const d = await detail();
    // An outline that planned pages 2–3 (page 1 hidden at the time).
    const planned = d.scenes.slice(1).map((sc) => d.slides.find((sl) => sl.id === sc.slideId)!);
    await t.ctx.db.insert(outlineRevisions).values({
      id: randomUUID(),
      projectId,
      version: (d.outline?.version ?? 0) + 1,
      // Listed out of deck order (a model that puts one page under 「其他」 at the end).
      sections: [{ title: "一", slideIds: [planned[1]!.id] }, { title: "其他", slideIds: [planned[0]!.id] }] as never,
      glossary: d.outline?.glossary ?? [],
      timeAllocation: {},
      inputHash: outlineInputHash(planned, d.project.settings),
    });
    // Page 1 back on: the stored outline no longer matches the visible pages.
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}/slides/${d.slides[0]!.id}`, payload: { hidden: false } });
    const before = await detail();
    const sc = before.scenes[2]!;
    // The fake seams can't plan an outline: a re-plan would fail this job.
    const { row } = await run({ type: "generate_script", sceneIds: [sc.id], force: true });
    expect(row.status).toBe("succeeded");
    const after = await detail();
    expect(after.outline?.version).toBe(before.outline?.version);
    for (const other of after.scenes.filter((s) => s.id !== sc.id)) {
      expect(other.script.status).toBe(before.scenes.find((s) => s.id === other.id)!.script.status);
      expect(other.audio.status).toBe(before.scenes.find((s) => s.id === other.id)!.audio.status);
    }
    // A page the outline never planned (page 1) needs a new plan; so does a changed 目標總長.
    const est = async (sceneId: string) => (await estimate(`type=generate_script&scope=all&sceneIds=${sceneId}`)).lines.length;
    const planned1 = await est(sc.id);
    expect(await est(before.scenes[0]!.id)).toBeGreaterThan(planned1);
    await t.app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { settings: { targetDurationSec: 1200 } } });
    expect(await est(sc.id)).toBeGreaterThan(planned1);
  });
});
