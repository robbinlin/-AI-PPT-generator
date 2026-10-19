import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParserManifest } from "@lvs/shared";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import type { ParserRunInput, ParserRunner } from "../src/jobs/parser-runner.js";
import { buildServer, type BuildServerOptions, type BuiltServer } from "../src/server.js";

/** 1x1 transparent PNG. */
export const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A structurally valid single-page PDF (enough for magic sniffing and the fake parser). */
export const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`,
  "latin1",
);

export interface FakePage {
  pageNumber: number;
  title?: string;
  plainText: string;
  notes?: string;
}

/** Writes a manifest + PNGs + content JSON instead of spawning Python. */
export class FakeParserRunner implements ParserRunner {
  calls = 0;
  constructor(
    public pages: FakePage[] = [
      { pageNumber: 1, title: "Intro", plainText: "Welcome to the course" },
      { pageNumber: 2, title: "Methods", plainText: "ANOVA and VO2max", notes: "mention effect size" },
    ],
    public failWith?: Error,
  ) {}

  async run(input: ParserRunInput): Promise<ParserManifest> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    input.onProgress?.(0.5, "halfway");
    await mkdir(join(input.outDir, "pages"), { recursive: true });
    const manifest: ParserManifest = {
      schemaVersion: 1,
      sourceKind: input.kind,
      pageCount: this.pages.length,
      pages: [],
      meta: { converter: "fake", warnings: [] },
    };
    for (const p of this.pages) {
      const n = String(p.pageNumber).padStart(3, "0");
      await writeFile(join(input.outDir, "pages", `${n}.png`), PNG_1x1);
      await writeFile(join(input.outDir, "pages", `${n}.thumb.png`), PNG_1x1);
      await writeFile(
        join(input.outDir, "pages", `${n}.json`),
        JSON.stringify({
          pageNumber: p.pageNumber,
          title: p.title,
          textBlocks: [{ text: p.plainText, role: "body" }],
          notes: p.notes,
          plainText: p.plainText,
          widthPt: 960,
          heightPt: 540,
          renderFidelity: "native",
        }),
      );
      manifest.pages.push({
        pageNumber: p.pageNumber,
        imagePath: `pages/${n}.png`,
        thumbnailPath: `pages/${n}.thumb.png`,
        contentPath: `pages/${n}.json`,
        imageWidthPx: 1920,
        imageHeightPx: 1080,
      });
    }
    await writeFile(join(input.outDir, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  }
}

export interface TestServer extends BuiltServer {
  parser: FakeParserRunner;
  storageDir: string;
  cleanup(): Promise<void>;
}

export async function createTestServer(opts: Partial<BuildServerOptions> & { parser?: FakeParserRunner } = {}): Promise<TestServer> {
  const storageDir = await mkdtemp(join(tmpdir(), "lvs-test-storage-"));
  const config = loadConfig({
    LOG_LEVEL: "silent",
    STORAGE_ROOT: storageDir,
    ASSET_URL_SECRET: "test-secret",
    PROVIDER_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    PUBLIC_BASE_URL: "http://api.test",
    DATABASE_URL: undefined,
    // Tests must never pick up real provider keys from a developer's .env.
    GEMINI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    ELEVENLABS_API_KEY: undefined,
    HEYGEN_API_KEY: undefined,
  });
  const dbHandle = await createDb({ pgliteDir: ":memory:" });
  const parser = opts.parser ?? new FakeParserRunner();
  const built = await buildServer({
    config,
    dbHandle,
    parserRunner: parser,
    startRunner: false,
    runnerOverrides: { backoffBaseMs: 1, pollIntervalMs: 20, concurrency: 2 },
    ...opts,
  });
  return {
    ...built,
    parser,
    storageDir,
    cleanup: async () => {
      await built.close();
      await dbHandle.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** Build a multipart/form-data body for app.inject(). */
export function multipart(filename: string, content: Buffer, mime = "application/octet-stream") {
  const boundary = "----lvsTestBoundary7MA4YWxkTrZu0gW";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
