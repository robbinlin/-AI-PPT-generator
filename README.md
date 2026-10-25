# Lecture Video Studio

Turn a slide deck (PPTX / PPT / PDF) into a narrated lecture video: per-slide AI scripts,
Taiwanese-Mandarin or English TTS, optional talking avatar, subtitles, MP4 + SRT export.
Edit one slide's script and only that slide's assets are regenerated.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, [docs/API.md](docs/API.md)
for the HTTP surface and [docs/VOAI-COMPARISON.md](docs/VOAI-COMPARISON.md) for the product
benchmark that shaped v1 scope.

## Quick start

```bash
pnpm install
cp .env.example .env            # add GEMINI_API_KEY (or ANTHROPIC_API_KEY)
python3 -m pip install -r workers/parser/requirements.txt
pnpm build                      # builds shared schemas first
pnpm dev:api                    # builds the shared packages, then serves http://localhost:4000 (PGlite, no Docker needed; restarts on file changes)
# or: pnpm serve:api            # same without the file watcher (what `pnpm dev` uses; Ctrl+C winds running jobs down first)
pnpm dev:web                    # http://localhost:5173
```

Optional: `docker compose up -d` for PostgreSQL + MinIO and set `DATABASE_URL`.

## Windows 快速啟動（中文）

第一次安裝（PowerShell，在專案資料夾內）：

```powershell
pnpm install
Copy-Item .env.example .env          # 用記事本填入 GEMINI_API_KEY；其他金鑰可在網頁「服務供應商」頁貼上
pip install -r workers\parser\requirements.txt
pnpm build
.\workers\tts-local\install.ps1      # 選用：本機語音（CosyVoice 2 / GPT-SoVITS / Fish Speech，約 13 GB）
.\workers\avatar-local\install.ps1   # 選用：本機人像（MuseTalk，約 5 GB，需要 NVIDIA 顯示卡）
```

之後每次使用只要一行，它會幫你開好四個視窗（已經在跑的會略過）：

```powershell
pnpm dev
```

瀏覽器開 http://localhost:5173 。要停止：先在「A - API」視窗按 Ctrl+C，等它回到提示字元（有人像影片正在建立時最多等 20 秒）再關視窗；其他視窗直接關掉即可。直接關掉 API 視窗時，正在向 HeyGen 建立的人像影片可能沒記下來，重新啟動後會再建立一次（另外計費）。

| 視窗 | 服務 | 什麼時候需要 |
|---|---|---|
| A | API（http://localhost:4000） | 一定要 |
| B | 網頁（http://localhost:5173） | 一定要 |
| C | 本機人像 MuseTalk（8765） | 人像供應商選「本機人像」時 |
| D | 本機語音 + Whisper（8766） | 語音供應商選「本機語音」時 |

免費方案：講稿用 Gemini（免費額度），語音用「本機語音」上傳自己的錄音複製聲音，人像用「本機人像」上傳自己的照片或短片。
付費方案（品質較高、不占用自己的電腦）：ElevenLabs 語音、HeyGen 人像，金鑰貼在「服務供應商」頁即可。

## Workspace

```
packages/shared     contracts (zod) → also emits JSON Schema for Python
packages/providers  LLM / TTS / avatar adapters
packages/pipeline   outline + script generation, subtitles, estimates
apps/api            Fastify API, DB, jobs, SSE
apps/web            React editor
workers/parser      Python: deck → page images + structured content
workers/render      ffmpeg: RenderSpec → MP4/SRT
legacy/             original prototype (not built)
```

`pnpm test` builds the libraries and runs every TypeScript test suite (including the
end-to-end flow on the fixture deck with mock providers); `pytest workers/parser` runs the
parser tests. `GEMINI_API_KEY=... pnpm --filter @lvs/api smoke:live` runs the same flow
against real Gemini and writes `data/out/smoke.mp4`.

No API key is needed to try the product: create a project with `llmProviderId: "mock"`,
`voice.providerId: "mock"` (and `avatar.providerId: "mock"`); the mock providers produce
deterministic scripts, silent audio and a test-pattern avatar.
