/**
 * Whole flow on the real fixture deck: Python parser (LibreOffice) → mock LLM outline +
 * scripts → mock TTS → mock avatar → ffmpeg render. No network. Skipped when the external
 * tools are missing.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ProjectDetail } from "@lvs/shared";
import { MockAvatarProvider, MockTtsProvider, ProviderRegistry, mockLlmFactory } from "@lvs/providers";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { smartMockResponder } from "../src/services/mock-llm.js";
import { multipart } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const FIXTURE = join(REPO, "fixtures/sample-exercise-physiology.pptx");
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function has(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const toolsPresent = has("python3") && has("soffice") && has("ffmpeg") && has("ffprobe");

function ffprobeJson(file: string): { format: { duration: string }; streams: Array<Record<string, unknown>> } {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" }));
}

describe.skipIf(!toolsPresent)("end-to-end on the sample deck (mock providers)", () => {
  let t: BuiltServer;
  let dir: string;
  let projectId: string;
  const tts = new MockTtsProvider();
  const llmCalls: string[] = [];
  const registry = new ProviderRegistry()
    .registerLlm(
      mockLlmFactory((req) => {
        llmCalls.push(req.prompt);
        return smartMockResponder(req);
      }),
    )
    .registerTts({ id: "mock", displayName: "Mock TTS", requiresApiKey: false, create: () => tts })
    .registerAvatar({ id: "mock", displayName: "Mock Avatar", requiresApiKey: false, create: () => new MockAvatarProvider({ pollsUntilDone: 2 }) });

  async function enqueue(payload: Record<string, unknown>): Promise<Job> {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload });
    expect(res.statusCode).toBe(202);
    const job = res.json().job as Job;
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row?.error ?? "").toBe("");
    expect(row?.status).toBe("succeeded");
    return job;
  }
  const detail = async () => (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lvs-e2e-"));
    const config = loadConfig({
      LOG_LEVEL: "silent",
      STORAGE_ROOT: join(dir, "storage"),
      RENDER_WORK_DIR: join(dir, "render"),
      PARSER_CLI: join(REPO, "workers/parser"),
      ASSET_URL_SECRET: "e2e-secret",
      PROVIDER_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
      PUBLIC_BASE_URL: "http://api.test",
      EXPOSE_MOCK_PROVIDERS: true,
      VERIFY_PROVIDER_KEYS: false,
      DATABASE_URL: undefined,
      // Tests must never pick up real provider keys from a developer's .env.
      GEMINI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      ELEVENLABS_API_KEY: undefined,
      HEYGEN_API_KEY: undefined,
      AVATAR_POLL_INTERVAL_MS: 10,
      // Sequential so the continuity assertion (each prompt sees the previous script) is deterministic.
      SCRIPT_CONCURRENCY: 1,
      OUTLINE_MAX_IMAGES: 2,
      SCRIPT_ATTACH_IMAGE: false,
    });
    const dbHandle = await createDb({ pgliteDir: ":memory:" });
    t = await buildServer({ config, dbHandle, registry, startRunner: false, runnerOverrides: { backoffBaseMs: 1, pollIntervalMs: 20, concurrency: 2 } });
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a mock-provider project and parses the PPTX with LibreOffice", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        name: "運動生理學 HIIT",
        settings: {
          llmProviderId: "mock",
          voice: { providerId: "mock", voiceId: "mock-zh-f" },
          avatar: { enabled: true, providerId: "mock", avatarId: "mock-teacher" },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().id;

    const file = await readFile(FIXTURE);
    const up = await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("deck.pptx", file, PPTX_MIME) });
    expect(up.statusCode).toBe(200);
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, up.json().job.id));
    expect(row?.error ?? "").toBe("");
    expect(row?.status).toBe("succeeded");

    const d = await detail();
    expect(d.slides).toHaveLength(6);
    expect(d.scenes).toHaveLength(6);
    expect(d.slides[3]?.content.tables[0]?.rows[1]?.[0]).toBe("HIIT 組");
    expect(d.slides[4]?.content.notes).toContain("交互作用");
    for (const s of d.slides) expect(d.assets[s.imageAssetId!]?.kind).toBe("slide_image");
  }, 90_000);

  it("plans the outline, then writes every scene's script in order with glossary context", async () => {
    await enqueue({ type: "generate_outline" });
    let d = await detail();
    expect(d.outline?.glossary.some((g) => g.term === "VO₂max")).toBe(true);
    expect(Object.keys(d.outline!.timeAllocation)).toHaveLength(6);

    await enqueue({ type: "generate_script" });
    d = await detail();
    expect(Object.keys(d.scripts)).toHaveLength(6);
    for (const sc of d.scenes) {
      expect(sc.script.status).toBe("ready");
      expect(d.scripts[sc.id]?.source).toBe("ai");
    }
    const scriptPrompts = llmCalls.filter((p) => /## 本頁內容|## This slide/.test(p));
    expect(scriptPrompts).toHaveLength(6);
    expect(scriptPrompts.every((p) => p.includes("V O two max"))).toBe(true);
    // Continuity: from the second scene on, the previous script is in the prompt.
    expect(scriptPrompts.slice(1).every((p) => /前一頁的講稿|Previous slide's script/.test(p))).toBe(true);
    expect(d.scripts[d.scenes[0]!.id]?.script).toContain("各位同學好");

    // A second run with nothing stale is a no-op.
    const again = await enqueue({ type: "generate_script" });
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, again.id));
    expect(row?.result).toMatchObject({ processed: 0, skipped: 6 });
  });

  it("synthesizes only missing or stale audio, builds subtitles, and invalidates on edit", async () => {
    await enqueue({ type: "synthesize_speech" });
    expect(tts.calls).toHaveLength(6);
    let d = await detail();
    for (const sc of d.scenes) {
      expect(sc.audio.status).toBe("ready");
      expect(sc.subtitle.status).toBe("ready");
      expect(sc.subtitle.cues?.length ?? 0).toBeGreaterThan(0);
      expect(sc.durationSec).toBeGreaterThan(0);
      expect(d.assets[sc.audio.assetId!]?.mimeType).toBe("audio/wav");
      expect(d.assets[sc.subtitle.assetId!]?.mimeType).toBe("application/x-subrip");
    }
    expect(d.totalDurationSec).toBeGreaterThan(6);

    const third = d.scenes[2]!;
    const put = await t.app.inject({
      method: "PUT",
      url: `/projects/${projectId}/scenes/${third.id}/script`,
      payload: { script: "這一頁我們改講 VO₂max 的測量方式，p < .05 代表差異顯著。" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().source).toBe("user");
    expect(put.json().pronunciationText).toContain("V O two max");
    d = await detail();
    expect(d.scenes[2]?.audio.status).toBe("stale");
    expect(d.scenes[1]?.audio.status).toBe("ready");

    await enqueue({ type: "synthesize_speech" });
    expect(tts.calls).toHaveLength(7);
    expect(tts.calls[6]?.text).toContain("V O two max");
    d = await detail();
    expect(d.scenes[2]?.audio.status).toBe("ready");
  });

  it("generates avatar clips through the polling provider", async () => {
    const job = await enqueue({ type: "generate_avatar" });
    const d = await detail();
    for (const sc of d.scenes) {
      expect(sc.avatar.status).toBe("ready");
      expect(d.assets[sc.avatar.assetId!]?.mimeType).toBe("video/mp4");
      expect(d.assets[sc.avatar.assetId!]?.producedBy.providerTaskId).toMatch(/^mock-avatar-/);
    }
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    // Cleared once each clip is stored (nothing left to resume).
    expect(row?.providerTaskId ?? null).toBeNull();
  });

  it("renders a 540p MP4 with SRT whose duration matches the scenes", async () => {
    const job = await enqueue({ type: "render_video", preset: "preview_540p" });
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    const { videoAssetId, srtAssetId } = row!.result as { videoAssetId: string; srtAssetId?: string };
    expect(srtAssetId).toBeTruthy();

    const d = await detail();
    const expected = d.scenes.reduce((n, sc) => n + (sc.durationSec ?? 0) + sc.tailPauseSec, 0) - 5 * 0.4; // 5 fades
    const mp4 = t.ctx.storage.localPath!((await assetKey(videoAssetId))!);
    const probe = ffprobeJson(mp4);
    const video = probe.streams.find((s) => s.codec_type === "video")!;
    expect(video.width).toBe(960);
    expect(video.height).toBe(540);
    expect(Math.abs(Number(probe.format.duration) - expected)).toBeLessThan(0.5);
    expect(probe.streams.some((s) => s.codec_type === "audio")).toBe(true);

    const srt = await readFile(t.ctx.storage.localPath!((await assetKey(srtAssetId!))!), "utf8");
    const cueCount = (srt.match(/^\d+$/gm) ?? []).length;
    expect(cueCount).toBe(d.scenes.reduce((n, sc) => n + (sc.subtitle.cues?.length ?? 0), 0));
    expect(srt).toContain("-->");

    const { url } = (await t.app.inject({ method: "GET", url: `/projects/${projectId}/assets/${videoAssetId}/url` })).json();
    const dl = await t.app.inject({ method: "GET", url: url.replace("http://api.test", "") });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("video/mp4");
  }, 120_000);

  async function assetKey(id: string): Promise<string | undefined> {
    const { assets } = await import("../src/db/schema.js");
    const [a] = await t.ctx.db.select().from(assets).where(eq(assets.id, id));
    return a?.storageKey;
  }
});
