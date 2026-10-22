#!/usr/bin/env bash
# 本機語音安裝腳本 — Linux / macOS。可重複執行。
# 用法：bash workers/tts-local/install.sh [--engines cosyvoice2,gptsovits,fishspeech] [--device cpu|cu118|cu121]
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)
ENGINES="cosyvoice2,gptsovits,fishspeech"; DEVICE=""
while [ $# -gt 0 ]; do case "$1" in --engines) ENGINES="$2"; shift 2;; --device) DEVICE="$2"; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done
if [ -z "$DEVICE" ]; then command -v nvidia-smi >/dev/null 2>&1 && DEVICE=cu121 || DEVICE=cpu; fi
TORCH_INDEX="https://download.pytorch.org/whl/$DEVICE"
COSYVOICE_COMMIT=074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
GPTSOVITS_COMMIT=b4570b876f5c086819ba84e3215472733c6a7b70
FISHSPEECH_COMMIT=49374e0e95938d03ecbe7b3550e4f120104aaf82
step() { printf '\n==> %s\n' "$*"; }

step "安裝 uv"
command -v uv >/dev/null 2>&1 || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
step "建立主服務虛擬環境 (.venv, Python 3.11)"
[ -x .venv/bin/python ] || uv venv --seed --python 3.11 .venv
PY="$HERE/.venv/bin/python"
uv pip install --python "$PY" -e ".[test]" huggingface_hub
step "下載 Whisper small 模型"
"$PY" -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8'); print('Whisper OK')"

install_engine() {
  local name=$1 dir="$HERE/engines/$1" epy
  cd "$dir"; epy="$dir/.venv/bin/python"
  case "$name" in
    cosyvoice2)
      step "[CosyVoice 2] Python 3.10 虛擬環境"; [ -x "$epy" ] || uv venv --seed --python 3.10 .venv
      step "[CosyVoice 2] PyTorch 2.3.1 ($DEVICE)"; uv pip install --python "$epy" "torch==2.3.1" "torchaudio==2.3.1" --index-url "$TORCH_INDEX"
      step "[CosyVoice 2] 取得原始碼"; [ -d vendor/CosyVoice/cosyvoice ] || { mkdir -p vendor; git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git vendor/CosyVoice; }
      git -C vendor/CosyVoice checkout -q "$COSYVOICE_COMMIT"; git -C vendor/CosyVoice submodule update --init --recursive
      step "[CosyVoice 2] 相依套件"; uv pip install --python "$epy" "setuptools<81" wheel "numpy==1.26.4"
      uv pip install --python "$epy" --no-build-isolation "openai-whisper==20231117"   # its build needs pkg_resources
      uv pip install --python "$epy" -r requirements.txt
      [ "$DEVICE" = cpu ] || uv pip install --python "$epy" "onnxruntime-gpu==1.18.0" || true ;;
    gptsovits)
      step "[GPT-SoVITS] Python 3.10 虛擬環境"; [ -x "$epy" ] || uv venv --seed --python 3.10 .venv
      step "[GPT-SoVITS] PyTorch ($DEVICE)"; uv pip install --python "$epy" torch torchaudio torchcodec --index-url "$TORCH_INDEX"
      step "[GPT-SoVITS] 取得原始碼"; [ -d vendor/GPT-SoVITS/GPT_SoVITS ] || { mkdir -p vendor; git clone https://github.com/RVC-Boss/GPT-SoVITS.git vendor/GPT-SoVITS; }
      git -C vendor/GPT-SoVITS checkout -q "$GPTSOVITS_COMMIT"
      step "[GPT-SoVITS] 相依套件"; uv pip install --python "$epy" -r vendor/GPT-SoVITS/extra-req.txt --no-deps; uv pip install --python "$epy" -r requirements.txt
      # jieba_fast (C extension) is replaced by a shim over plain jieba, same as on Windows
      site=$("$epy" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'); cp -r shims/jieba_fast "$site/"
      step "[GPT-SoVITS] 英文 G2P 需要的 NLTK 資料"; "$epy" -c "import nltk; nltk.download('averaged_perceptron_tagger_eng', quiet=True); nltk.download('cmudict', quiet=True)" ;;
    fishspeech)
      step "[Fish Speech] Python 3.12 虛擬環境"; [ -x "$epy" ] || uv venv --seed --python 3.12 .venv
      step "[Fish Speech] 取得原始碼"; [ -d vendor/fish-speech/fish_speech ] || { mkdir -p vendor; git clone https://github.com/fishaudio/fish-speech.git vendor/fish-speech; }
      git -C vendor/fish-speech checkout -q "$FISHSPEECH_COMMIT"
      # transformers needs torch >= 2.6; 2.6 ships for cpu / cu124 / cu126
      FISH_INDEX="https://download.pytorch.org/whl/$([ "$DEVICE" = cpu ] && echo cpu || echo cu124)"
      step "[Fish Speech] PyTorch 2.6.0 與相依套件"; uv pip install --python "$epy" "torch==2.6.0" "torchaudio==2.6.0" --index-url "$FISH_INDEX"
      uv pip install --python "$epy" -r requirements.txt            # deps minus pyaudio/gradio/wandb
      uv pip install --python "$epy" --no-deps -e vendor/fish-speech
      [ -n "${HF_TOKEN:-}" ] || echo "警告：未設定 HF_TOKEN，openaudio-s1-mini 需要同意條款的 token 才能下載" ;;
  esac
  step "[$name] 下載模型權重"; "$PY" "$HERE/download_models.py" "$name"
  cd "$HERE"
}
IFS=, read -ra LIST <<< "$ENGINES"
for e in "${LIST[@]}"; do e=$(echo "$e" | tr -d ' '); [ -n "$e" ] && { install_engine "$e" || echo "警告：引擎 $e 安裝失敗，其他引擎繼續；之後可單獨重跑 --engines $e"; cd "$HERE"; }; done
step "檢查 ffmpeg"; command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version | head -1 || echo "警告：找不到 ffmpeg"
printf '\n安裝完成。啟動服務：pnpm dev:tts\n'
