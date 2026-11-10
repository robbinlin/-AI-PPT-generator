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

之後每次使用只要一行，全部服務都在**同一個視窗**裡執行（已經在跑的會略過）。也可以直接在檔案總管雙擊專案資料夾裡的 `start.bat`：

```powershell
pnpm dev
```

畫面會列出每個服務的狀態，全部就緒後自動開啟 http://localhost:5173 。平常只顯示狀態與錯誤；每個服務的完整輸出寫在 `data\logs\`（`api.log`、`web.log`、`avatar.log`、`tts.log`）。

要停止：在那個視窗按**一次** Ctrl+C，等出現「已全部停止」再關視窗（有人像影片正在建立時最多等約 25 秒；再按一次 Ctrl+C 是強制結束）。直接關掉視窗時，正在向 HeyGen 建立的人像影片可能沒記下來，重新啟動後會再建立一次（另外計費）。

| 服務 | 什麼時候需要 |
|---|---|
| API（http://localhost:4000） | 一定要 |
| 網頁（http://localhost:5173） | 一定要 |
| 本機人像 MuseTalk（8765） | 人像供應商選「本機人像」時；沒安裝會自動略過 |
| 本機語音 + Whisper（8766） | 語音供應商選「本機語音」時；沒安裝會自動略過 |

其他用法：`pnpm dev -- --verbose` 把每個服務的輸出都印在畫面上；`pnpm dev -- --no-open` 不自動開瀏覽器；`pnpm dev:windows` 是舊方式，每個服務各開一個 PowerShell 視窗。

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
