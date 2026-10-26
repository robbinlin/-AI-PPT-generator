# 本機語音（workers/tts-local）

在你自己的電腦上跑開源的中文語音合成，免費、不限量，而且可以用你本人的聲音。
主服務是一個小的 FastAPI 程式（`lvs_tts`），三個引擎各自放在獨立的 Python 環境裡，用到時才啟動，
同一時間只會有一個引擎在記憶體裡（8 GB 顯示卡放不下兩個）。Whisper（faster-whisper small）
負責把參考錄音轉成文字，以及把合成好的語音對回文字、產生逐字時間給字幕用。

| 引擎 | 模型 | 參考錄音 | 授權 |
|---|---|---|---|
| CosyVoice 2 | FunAudioLLM/CosyVoice2-0.5B | 3–30 秒 | Apache-2.0 |
| GPT-SoVITS | v2 預訓練（零樣本），或用你的長錄音訓練（見下方） | 3–10 秒 | MIT |
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
GPT-SoVITS 只吃 10 秒內的參考錄音：較長的錄音會在 9.5 秒前的停頓處切開，並重新聽寫切下來的那段當提示文字。

## 訓練自己的聲音（GPT-SoVITS）

上傳短錄音只是讓引擎「模仿」你的聲音；用一段 10 分鐘以上、只有你在說話的長錄音（例如一堂課）訓練，
聲音會像很多。8 GB 顯示卡上 30 分鐘的語音約需 20 分鐘（同一段錄音再訓練時會沿用上次的聽寫）：

```powershell
cd C:\Users\user\-AI-PPT-generator\workers\tts-local
.\.venv\Scripts\python -m lvs_tts.train_voice D:\錄音\上課.m4a --name "林老師"
```

程式會用 Whisper 聽寫、挑出清楚的句子（最多 `--max-minutes`，預設 40 分鐘）、用聲紋排除別人的聲音
（例如學生發問），再訓練 GPT-SoVITS 的音色（SoVITS；負責「怎麼念」的 GPT 沿用預訓練版，念錯字少很多，
要一起訓練加 `--gpt-epochs 15`）。最後用 8 段候選參考錄音各念一段試聽稿，Whisper 聽寫後挑念得最準的那段當參考，
把聲音加進清單。App 的語音選單會出現
「我的聲音・林老師（訓練版）」。本機語音服務可以開著：訓練前會先關掉它載入的引擎，讓出顯示記憶體。
聽寫用的 Whisper 預設是 large-v3-turbo（第一次會下載約 1.6 GB），可用 `LVS_TRAIN_WHISPER_MODEL` 改。

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

`GET /health`、`GET /engines`、`POST /engines/unload`、`GET /voices`（訓練過的聲音多一個 `trained: {engine, minutes}`）、`POST /voices`（multipart `file` + `name` + `transcript`）、
`GET /voices/{id}/sample.wav`、`DELETE /voices/{id}`、`POST /synthesize`（JSON：`text, voiceId, engine, language, speed, timestamps`）
→ `{id, durationSec, audioUrl, sampleRate, timestamps}`、`GET /synth/{id}.wav`。錯誤為 `{"error":{"code","message"}}`。

## 疑難排解

- 「engine_not_installed」：該引擎的 `.venv` 或 `models/.ready` 不存在，重跑安裝腳本。
- 引擎啟動超過 15 分鐘：第一次載入模型較慢；看視窗裡 `[cosyvoice2]` 等前綴的訊息。
- 合成失敗 500：訊息會附上引擎最後幾行輸出；最常見是顯示記憶體不足，先關掉其他用顯示卡的程式。
- 合成的中文有大陸讀音：三個引擎的文字前端都以簡體訓練（Fish Speech 收到繁體會念成廣東話），程式會先把繁體轉簡體再送進去，字幕仍用原本的繁體。

## 測試

```powershell
.\.venv\Scripts\python -m pytest -q
```

測試使用 `LVS_TTS_ENGINE=mock` 的假引擎（正弦波），不需要任何模型。
