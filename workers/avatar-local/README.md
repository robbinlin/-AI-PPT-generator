# 本機人像（workers/avatar-local）

在你自己的電腦上產生嘴型同步的虛擬人像影片，不用付雲端費用。引擎是開源的
[MuseTalk](https://github.com/TMElyralab/MuseTalk)（MIT 授權，v1.5，固定在 commit `0a89dec`），
需要 NVIDIA 顯示卡（8 GB 顯示記憶體即可）。沒有顯示卡也能跑，但一分鐘影片要算很久。

App 的 API 透過 HTTP 呼叫這個服務（預設 `http://127.0.0.1:8765`，可用 `LOCAL_AVATAR_URL` 改）。
之後要做成網站版時，把這個服務放到一台有 GPU 的機器上、把網址填給 API 即可。

## 安裝（Windows）

1. 先更新 NVIDIA 驅動到 520 以上（`nvidia-smi` 右上角 CUDA Version 要是 11.8 以上）。
2. PowerShell 進到專案資料夾，執行：

```powershell
.\workers\avatar-local\install.ps1
```

腳本會自動安裝 uv、建立 Python 3.10 虛擬環境、安裝 PyTorch 2.0.1 (CUDA 11.8)、
OpenMMLab 套件、下載 MuseTalk 原始碼與約 3.5 GB 的模型權重。可以重複執行，已完成的步驟會略過。

macOS / Linux 用 `bash workers/avatar-local/install.sh`（自動判斷 CPU 或 CUDA）。

## 啟動

另外開一個 PowerShell 視窗（視窗 C）：

```powershell
cd C:\Users\user\-AI-PPT-generator
pnpm dev:avatar
```

看到 `engine=musetalk device=cuda` 代表模型可用。若顯示 `engine=passthrough`，表示 MuseTalk 或權重沒裝好，
服務仍會運作但**不會做嘴型**（只是把角色畫面循環播放配上聲音），用來測流程。

## 使用

1. App 的「服務供應商」頁會看到「本機人像」為已設定（服務有在跑時）。
2. 專案「設定」→「虛擬人像」→ 人像供應商選「本機人像」→ 上傳一張正面照片或一段 10 秒內、正面說話的影片當角色。
3. 按「產生人像」。第一次會先做角色前處理（偵測臉部、算遮罩），之後同一角色直接產生。

RTX 3050 約每分鐘影片需 1 到 3 分鐘。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `LVS_AVATAR_HOST` / `LVS_AVATAR_PORT` | `127.0.0.1` / `8765` | 監聽位址 |
| `LVS_AVATAR_DATA` | `<專案>/data/avatar-local` | 角色、產出影片存放處 |
| `LVS_AVATAR_ENGINE` | 自動 | `musetalk` 或 `passthrough`（強制不用模型） |
| `LVS_AVATAR_DEVICE` | 自動 | `cuda` 或 `cpu` |
| `LVS_AVATAR_BATCH` | GPU 8 / CPU 2 | 每批處理的影格數，顯示記憶體不足時調小 |
| `LVS_MUSETALK_DIR` | `workers/avatar-local/vendor/MuseTalk` | MuseTalk 原始碼與 `models/` 位置 |
| `FFMPEG_BIN` / `FFPROBE_BIN` | PATH 中的 ffmpeg | ffmpeg 路徑 |

## HTTP 介面

- `GET /health` → `{ok, engine, device, modelsReady, version}`
- `GET /characters` / `POST /characters`（multipart：`file` 圖片或影片，`name` 選填）/ `DELETE /characters/{id}` / `GET /characters/{id}/preview.jpg`
- `POST /tasks`（multipart：`audio`，`characterId`）→ `{taskId, status}`；`GET /tasks/{id}` → `{taskId, status, progress, error, durationSec, resultUrl}`；`GET /tasks/{id}/result` → mp4；`DELETE /tasks/{id}` 取消
- 錯誤格式 `{"error": {"code", "message"}}`

## 疑難排解

- **engine=passthrough**：`vendor/MuseTalk/models/musetalkV15/unet.pth` 不存在。重新執行安裝腳本。
- **CUDA out of memory**：設 `LVS_AVATAR_BATCH=4` 再啟動。
- **no face detected**：換一張臉部清楚、正面、光線充足的照片；影片請用 25 fps、臉不要太小。
- **numpy.dtype size changed**：numpy 被升級到 2.x 了。執行 `uv pip install --python .venv\Scripts\python.exe "numpy==1.26.4"`（安裝腳本最後一步會自動處理）。
- **mmcv 安裝失敗**：確認 Python 是 3.10、torch 是 2.0.1+cu118；mmcv 2.0.1 只有這個組合有預先編譯好的 Windows 版本。
- **驅動太舊**：`nvidia-smi` 顯示 Driver Version 低於 520 時 PyTorch 無法使用顯示卡。

## 測試

```bash
cd workers/avatar-local
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -e ".[test]"
LVS_AVATAR_ENGINE=passthrough .venv/bin/python -m pytest -q
```
