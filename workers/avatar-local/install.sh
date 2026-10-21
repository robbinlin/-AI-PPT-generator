#!/usr/bin/env bash
# 本機人像（MuseTalk）安裝腳本 — Linux / macOS。可重複執行。
# 用法：bash workers/avatar-local/install.sh [cpu|cu118]   （預設：有 nvidia-smi 就 cu118，否則 cpu）
set -euo pipefail
cd "$(dirname "$0")"
MUSETALK_COMMIT=0a89dec45a0192b824e3cf4daf96c239440c5ed8
FLAVOR="${1:-}"
if [ -z "$FLAVOR" ]; then command -v nvidia-smi >/dev/null 2>&1 && FLAVOR=cu118 || FLAVOR=cpu; fi
step() { printf '\n==> %s\n' "$*"; }

step "安裝 uv"
command -v uv >/dev/null 2>&1 || { curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"; }
step "建立 Python 3.10 虛擬環境 (.venv)"
[ -x .venv/bin/python ] || uv venv --seed --python 3.10 .venv
PY=.venv/bin/python
step "安裝 PyTorch 2.0.1 ($FLAVOR)"
uv pip install --python $PY "torch==2.0.1" "torchvision==0.15.2" "torchaudio==2.0.2" --index-url "https://download.pytorch.org/whl/$FLAVOR"
step "安裝 OpenMMLab (mmcv 2.0.1 / mmdet 3.1.0 / mmpose 1.1.0)"
uv pip install --python $PY -U "setuptools<81" wheel openmim
$PY -m mim install mmengine "mmcv==2.0.1" "mmdet==3.1.0"
# chumpy (an mmpose dependency) imports pip inside its build, which breaks under build isolation
$PY -m pip install --no-build-isolation chumpy
$PY -m mim install "mmpose==1.1.0"
step "取得 MuseTalk 原始碼 (${MUSETALK_COMMIT:0:7})"
[ -d vendor/MuseTalk/musetalk ] || { mkdir -p vendor; git clone https://github.com/TMElyralab/MuseTalk.git vendor/MuseTalk; }
git -C vendor/MuseTalk checkout -q "$MUSETALK_COMMIT"
step "安裝 MuseTalk 相依套件"
uv pip install --python $PY "diffusers==0.30.2" "accelerate==0.28.0" "numpy==1.26.4" "opencv-python==4.9.0.80" "soundfile==0.12.1" "transformers==4.39.2" "huggingface_hub==0.30.2" "librosa==0.11.0" "einops==0.8.1" requests "imageio[ffmpeg]" omegaconf ffmpeg-python tqdm gdown
step "固定 numpy 1.26.4 並檢查編譯套件相容性"
uv pip install --python $PY "numpy==1.26.4"
$PY -c "import xtcocotools.mask" 2>/dev/null || $PY -m pip install --no-build-isolation --no-binary xtcocotools --force-reinstall --no-deps "xtcocotools==1.14.3"
step "安裝本機人像服務 (lvs_avatar)"
uv pip install --python $PY -e ".[test]"
step "下載模型權重到 vendor/MuseTalk/models"
$PY download_weights.py
step "檢查 ffmpeg"
command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version | head -1 || echo "警告：找不到 ffmpeg，請安裝後確認 PATH"
printf '\n安裝完成。啟動服務：pnpm dev:avatar\n'
