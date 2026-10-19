/**
 * Live smoke test against real Gemini (LLM + TTS): parse the fixture deck, plan the outline,
 * write scripts, synthesize speech, render a 540p MP4 into data/out/. Needs GEMINI_API_KEY.
 *
 *   GEMINI_API_KEY=... pnpm --filter @lvs/api smoke:live [path/to/deck.pptx]
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { Job, ProjectDetail } from "@lvs/shared";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { assets, jobs } from "../src/db/schema.js";
import { buildServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const deckPath = process.argv[2] ? resolve(process.argv[2]) : join(REPO, "fixtures/sample-exercise-physiology.pptx");
const MIME: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
};

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set; nothing to smoke-test.");
    process.exit(2);
  }
  const outDir = join(REPO, "data/out");
  await mkdir(outDir, { recursive: true });
  const config = loadConfig({
    LOG_LEVEL: "warn",
    PARSER_CLI: join(REPO, "workers/parser"),
    STORAGE_ROOT: join(REPO, "data/smoke-storage"),
    RENDER_WORK_DIR: join(REPO, "data/smoke-render"),
    DATABASE_URL: undefined,
  });
  // Persisted so a failed run (quota, 503) can be resumed: the same deck re-attaches to its
  // project and only missing/stale work is redone.
  const dbHandle = await createDb({ pgliteDir: join(REPO, "data/smoke-pglite") });
  const t = await buildServer({ config, dbHandle, startRunner: false, runnerOverrides: { concurrency: 2, pollIntervalMs: 50 } });

  let projectId = "";
  const detail = async () => (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
  async function run(payload: Record<string, unknown>): Promise<Job> {
    const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload });
    const job = res.json().job as Job;
    console.log(`→ ${payload.type} queued (${job.id})`);
    await t.ctx.runner.drain();
    const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
    if (row?.status !== "succeeded") throw new Error(`${payload.type} ${row?.status}: ${row?.error ?? ""}`);
    console.log(`✓ ${payload.type}`, JSON.stringify(row.result));
    return job;
  }

  const ext = deckPath.split(".").pop()!.toLowerCase();
  const file = await readFile(deckPath);
  const deckName = `smoke:${deckPath}`;
  const existing = ((await t.app.inject({ method: "GET", url: "/projects" })).json() as Array<{ id: string; name: string }>).find((p) => p.name === deckName);
  if (existing) {
    projectId = existing.id;
    console.log(`↻ resuming project ${projectId} (${(await detail()).slides.length} slides already parsed)`);
  } else {
    const created = await t.app.inject({
      method: "POST",
      url: "/projects",
      payload: {
        name: deckName,
        settings: { llmProviderId: "gemini", voice: { providerId: "gemini", voiceId: "Kore" }, audience: "undergraduate", mode: "faithful" },
      },
    });
    projectId = created.json().id;
    const boundary = "----lvsSmoke";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="deck.${ext}"\r\nContent-Type: ${MIME[ext] ?? "application/octet-stream"}\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    if (up.statusCode !== 200) throw new Error(`upload failed: ${up.body}`);
    await t.ctx.runner.drain();
    console.log(`✓ parsed ${(await detail()).slides.length} slides`);
  }

  await run({ type: "generate_outline" });
  const afterOutline = await detail();
  console.log("\n=== OUTLINE ===");
  console.log(JSON.stringify({ objectives: afterOutline.outline?.objectives, sections: afterOutline.outline?.sections.map((s) => s.title), glossary: afterOutline.outline?.glossary }, null, 2));

  await run({ type: "generate_script" });
  const afterScripts = await detail();
  for (const sc of afterScripts.scenes.slice(0, 2)) {
    const rev = afterScripts.scripts[sc.id]!;
    console.log(`\n=== SCRIPT scene ${sc.index + 1} (${rev.estimatedDurationSec}s) ===\n${rev.script}\n--- pronunciation ---\n${rev.pronunciationText}`);
  }

  await run({ type: "synthesize_speech" });
  const job = await run({ type: "render_video", preset: "preview_540p" });
  const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, job.id));
  const { videoAssetId, srtAssetId } = row!.result as { videoAssetId: string; srtAssetId?: string };
  for (const [id, name] of [[videoAssetId, "smoke.mp4"], [srtAssetId, "smoke.srt"]] as const) {
    if (!id) continue;
    const [a] = await t.ctx.db.select().from(assets).where(eq(assets.id, id));
    if (a) {
      await copyFile(t.ctx.storage.localPath!(a.storageKey), join(outDir, name));
      console.log(`✓ wrote ${join(outDir, name)}`);
    }
  }
  await t.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
