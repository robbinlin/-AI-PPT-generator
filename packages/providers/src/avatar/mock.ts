import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  AvatarCapabilities,
  AvatarCharacter,
  AvatarCreateRequest,
  AvatarProvider,
  AvatarTaskStatus,
  ProviderFactory,
} from "@lvs/shared";

const execFileAsync = promisify(execFile);

export const MOCK_AVATARS: AvatarCharacter[] = [
  { id: "mock-teacher", name: "Mock Teacher", kind: "stock" },
  { id: "mock-personal", name: "Mock Personal Likeness", kind: "personal" },
];

export interface MockAvatarOptions {
  /** Number of `getTask` calls before a task reports success. */
  pollsUntilDone?: number;
  ffmpegBin?: string;
  /** Directory for the generated sample clip. */
  cacheDir?: string;
}

/**
 * Offline avatar provider. Tasks succeed after `pollsUntilDone` polls and
 * return a `file://` URL to a 1-second test-pattern mp4 generated with ffmpeg.
 */
export class MockAvatarProvider implements AvatarProvider {
  readonly id = "mock";
  readonly capabilities: AvatarCapabilities = {
    acceptsAudio: true,
    acceptsText: true,
    transparentBackground: false,
    maxDurationSec: 600,
    aspectRatios: ["16:9", "9:16", "1:1"],
    billingUnit: "avatar_seconds",
  };
  readonly tasks = new Map<string, { req: AvatarCreateRequest; polls: number; cancelled: boolean }>();
  private readonly pollsUntilDone: number;
  private readonly ffmpegBin: string;
  private readonly cacheDir: string;
  private seq = 0;

  constructor(opts: MockAvatarOptions = {}) {
    this.pollsUntilDone = opts.pollsUntilDone ?? 2;
    this.ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg";
    this.cacheDir = opts.cacheDir ?? join(tmpdir(), "lvs-mock-avatar");
  }

  async listAvatars(): Promise<AvatarCharacter[]> {
    return MOCK_AVATARS;
  }

  async createTask(req: AvatarCreateRequest): Promise<{ taskId: string }> {
    if (!req.audioUrl && !req.text) throw new Error("mock avatar: audioUrl or text required");
    const taskId = `mock-avatar-${++this.seq}`;
    this.tasks.set(taskId, { req, polls: 0, cancelled: false });
    return { taskId };
  }

  async getTask(taskId: string): Promise<AvatarTaskStatus> {
    const t = this.tasks.get(taskId);
    if (!t) return { taskId, status: "failed", error: "unknown task" };
    if (t.cancelled) return { taskId, status: "cancelled" };
    t.polls += 1;
    if (t.polls < this.pollsUntilDone) return { taskId, status: "processing", progress: t.polls / this.pollsUntilDone };
    const path = await this.sampleClip(t.req.aspectRatio);
    return { taskId, status: "succeeded", progress: 1, resultUrl: pathToFileURL(path).href, durationSec: 1 };
  }

  async cancelTask(taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) t.cancelled = true;
  }

  /** Generate (once per aspect ratio) a 1-second test pattern clip. */
  async sampleClip(aspect: AvatarCreateRequest["aspectRatio"]): Promise<string> {
    const size = { "16:9": "640x360", "9:16": "360x640", "1:1": "360x360" }[aspect];
    mkdirSync(this.cacheDir, { recursive: true });
    const out = join(this.cacheDir, `sample-${size}.mp4`);
    if (existsSync(out)) return out;
    await execFileAsync(this.ffmpegBin, [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=25:duration=1`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      out,
    ]);
    return out;
  }
}

export function mockAvatarFactory(opts: MockAvatarOptions = {}): ProviderFactory<AvatarProvider> {
  return { id: "mock", displayName: "Mock Avatar", requiresApiKey: false, create: () => new MockAvatarProvider(opts) };
}
