/**
 * Re-planning the outline (mock LLM, mock TTS, real generation services): readings the lecturer
 * corrected survive, and only pages whose narration changes need new audio.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job, ProjectDetail } from "@lvs/shared";
import { jobs } from "../src/db/schema.js";
import { createTestServer, FakeParserRunner, multipart, TINY_PDF, type TestServer } from "./helpers.js";

let t: TestServer;
let projectId: string;
const detail = async () => (await t.app.inject({ method: "GET", url: `/projects/${projectId}` })).json() as ProjectDetail;
async function run(payload: Record<string, unknown>) {
  const res = await t.app.inject({ method: "POST", url: `/projects/${projectId}/jobs`, payload });
  expect(res.statusCode).toBe(202);
  await t.ctx.runner.drain();
  const [row] = await t.ctx.db.select().from(jobs).where(eq(jobs.id, (res.json().job as Job).id));
  expect(row?.error ?? "").toBe("");
  return row!;
}

beforeAll(async () => {
  t = await createTestServer({
    parser: new FakeParserRunner([
      { pageNumber: 1, title: "HIIT", plainText: "HIIT 的做法" },
      { pageNumber: 2, title: "VO₂max", plainText: "VO₂max 的定義" },
    ]),
  });
  const res = await t.app.inject({
    method: "POST",
    url: "/projects",
    payload: { name: "replan", settings: { llmProviderId: "mock", voice: { providerId: "mock", voiceId: "mock-zh-f" } } },
  });
  projectId = res.json().id;
  await t.app.inject({ method: "POST", url: `/projects/${projectId}/source`, ...multipart("deck.pdf", TINY_PDF, "application/pdf") });
  await t.ctx.runner.drain();
});
afterAll(async () => {
  await t.cleanup();
});

describe("re-planning the outline", () => {
  it("keeps corrected readings and re-voices only the pages that say a changed term", async () => {
    expect((await run({ type: "generate_outline", force: true })).status).toBe("succeeded");
    // The lecturer corrects one reading, clears another (spelled out) and deletes a term.
    const put = await t.app.inject({
      method: "PUT",
      url: `/projects/${projectId}/outline/glossary`,
      payload: { glossary: [{ term: "VO₂max", reading: "最大攝氧量" }, { term: "HIIT" }] },
    });
    expect(put.statusCode).toBe(200);
    const d0 = await detail();
    const [p1, p2] = d0.scenes;
    await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${p1!.id}/script`, payload: { script: "今天談 HIIT 與 ANOVA。" } });
    await t.app.inject({ method: "PUT", url: `/projects/${projectId}/scenes/${p2!.id}/script`, payload: { script: "接著看 VO₂max。" } });
    expect((await run({ type: "synthesize_speech" })).status).toBe("succeeded");
    expect((await detail()).scenes.every((s) => s.audio.status === "ready")).toBe(true);

    // The new plan reads VO₂max and HIIT its own way and brings ANOVA back (new to the glossary).
    expect((await run({ type: "generate_outline", force: true })).status).toBe("succeeded");
    const d1 = await detail();
    expect(d1.outline?.glossary.find((g) => g.term === "VO₂max")?.reading).toBe("最大攝氧量");
    expect(d1.outline?.glossary.find((g) => g.term === "HIIT")?.reading).toBeUndefined(); // stays spelled out
    expect(d1.scenes.find((s) => s.id === p2!.id)!.audio.status).toBe("ready"); // never says ANOVA
    expect(d1.scenes.find((s) => s.id === p1!.id)!.audio.status).toBe("stale");
    expect(d1.scripts[p1!.id]!.pronunciationText).toContain("變異數分析");
    expect(d1.scripts[p1!.id]!.pronunciationText).toContain("HIIT");
  });
});
