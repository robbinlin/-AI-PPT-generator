# 本機語音（workers/tts-local）

在你自己的電腦上跑開源的中文語音合成，免費、不限量，而且可以用你本人的聲音。
主服務是一個小的 FastAPI 程式（`lvs_tts`），三個引擎各自放在獨立的 Python 環境裡，用到時才啟動，
同一時間只會有一個引擎在記憶體裡（8 GB 顯示卡放不下兩個）。Whisper（faster-whisper small）
負責把參考錄音轉成文字，以及把合成好的語音對回文字、產生逐字時間給字幕用。

| 引擎 | 模型 | 參考錄音 | 授權 |
|---|---|---|---|
| CosyVoice 2 | FunAudioLLM/CosyVoice2-0.5B | 3–30 秒 | Apache-2.0 |
| GPT-SoVITS | v2 預訓練（零樣本，不訓練） | 3–10 秒 | MIT |
| Fish Speech | OpenAudio S1-mini | 3–30 秒 | CC-BY-NC-SA 4.0（非商業；下載需 Hugging Face 帳號同意條款並設定 `HF_TOKEN`） |

## 安裝（Windows）

需要 NVIDIA 驅動 525 以上（CUDA 12）、git、ffmpeg 在 PATH。磁碟約 10 GB。

```powershell
cd C:\Users\user\-AI-PPT-generator
.\workers\tts-local\install.ps1                              # 三個引擎全裝
.\workers\tts-local\install.ps1 -Engines cosyvoice2           # 只裝一個
```

每個引擎的安裝互相獨立；某個失敗不影響其他的，之後可用 `-Engines 名稱` 單獨重跑。

## 啟動

```powershell
pnpm dev:tts        # 127.0.0.1:8766
```

讓這個視窗一直開著。App 的「服務供應商」頁會顯示「本機語音」是否已連上，以及哪些引擎已安裝。

## 使用

在專案設定的「語音」區把供應商選成「本機語音」，上傳一段 3–30 秒你本人的錄音（安靜環境、單人、
語速自然），Whisper 會自動聽寫內容，之後「產生語音」就會用這個聲音。引擎可在聲音旁邊切換。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `LVS_TTS_PORT` | 8766 | 服務埠 |
| `LVS_TTS_DATA` | `<repo>/data/tts-local` | 參考聲音與合成結果 |
| `LVS_TTS_DEVICE` | 自動 | `cuda` 或 `cpu` |
| `LVS_WHISPER_MODEL` | small | faster-whisper 模型名稱 |
| `LVS_GPTSOVITS_VERSION` | v2 | `v2` 或 `v4` |
| `HF_TOKEN` | — | 下載 Fish Speech 權重用 |

## HTTP 介面

`GET /health`、`GET /engines`、`GET /voices`、`POST /voices`（multipart `file` + `name` + `transcript`）、
`GET /voices/{id}/sample.wav`、`DELETE /voices/{id}`、`POST /synthesize`（JSON：`text, voiceId, engine, language, speed, timestamps`）
→ `{id, durationSec, audioUrl, sampleRate, timestamps}`、`GET /synth/{id}.wav`。錯誤為 `{"error":{"code","message"}}`。

## 疑難排解

- 「engine_not_installed」：該引擎的 `.venv` 或 `models/.ready` 不存在，重跑安裝腳本。
- 引擎啟動超過 15 分鐘：第一次載入模型較慢；看視窗裡 `[cosyvoice2]` 等前綴的訊息。
- 合成失敗 500：訊息會附上引擎最後幾行輸出；最常見是顯示記憶體不足，先關掉其他用顯示卡的程式。
- 合成的中文有大陸讀音：CosyVoice 2 與 GPT-SoVITS 的文字前端以簡體訓練，程式會先把繁體轉簡體再送進去，字幕仍用原本的繁體。

## 測試

```powershell
.\.venv\Scripts\python -m pytest -q
```

測試使用 `LVS_TTS_ENGINE=mock` 的假引擎（正弦波），不需要任何模型。
