# 本機語音安裝腳本 — Windows PowerShell
# 用法：.\workers\tts-local\install.ps1 [-Engines cosyvoice2,gptsovits,fishspeech] [-Device cu118|cu121|cpu]
# 可重複執行；已完成的步驟會略過。三個引擎全裝約下載 8 GB。
param(
  [string]$Engines = "cosyvoice2,gptsovits,fishspeech",
  [string]$Device = ""
)
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $Here
trap { Pop-Location; break }
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

$CosyVoiceCommit = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
$GptSovitsCommit = "b4570b876f5c086819ba84e3215472733c6a7b70"
$FishSpeechCommit = "49374e0e95938d03ecbe7b3550e4f120104aaf82"

# ---- 0. 顯示卡 ---------------------------------------------------------------
Step "檢查 NVIDIA 驅動程式"
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  # nvidia-smi can print nothing (driver mid-update, remote session); never crash on it.
  $out = try { (& nvidia-smi 2>$null | Out-String) } catch { "" }
  # Newer drivers (600+) print "KMD Version" instead of "Driver Version".
  if ($out -match "(?:Driver|KMD) Version:\s*([\d.]+)") {
    $ver = [double]($Matches[1].Split(".")[0])
    if ($ver -lt 525) { Write-Warning "驅動版本 $($Matches[1]) 太舊（CUDA 12 需 525 以上）。請先到 https://www.nvidia.com/drivers 更新並重開機。" }
    else { Write-Host "驅動 $($Matches[1]) OK" }
  }
  if (-not $Device) { $Device = "cu121" }
} else {
  Write-Warning "找不到 nvidia-smi：沒有 NVIDIA 顯示卡，模型將以 CPU 執行（很慢）。"
  if (-not $Device) { $Device = "cpu" }
}
$TorchIndex = "https://download.pytorch.org/whl/$Device"

# ---- 1. uv ------------------------------------------------------------------
Step "安裝 uv"
function Find-Uv {
  $cmd = Get-Command uv -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @("$env:USERPROFILE\.local\bin\uv.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\uv.exe", "$env:LOCALAPPDATA\Programs\uv\uv.exe")) {
    if (Test-Path $c) { return $c }
  }
  return $null
}
$Uv = Find-Uv
if (-not $Uv) {
  # The official installer puts uv in ~\.local\bin; winget's copy only appears on PATH in a new window.
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  $Uv = Find-Uv
}
if (-not $Uv) { throw "找不到 uv。請手動安裝：在 PowerShell 執行  irm https://astral.sh/uv/install.ps1 | iex  後重新開一個視窗再跑本腳本。" }
Write-Host "uv: $Uv  $(& $Uv --version)"

# ---- 2. 主服務 (Python 3.11 + Whisper) ---------------------------------------
Step "建立主服務虛擬環境 (.venv, Python 3.11)"
if (-not (Test-Path ".venv\Scripts\python.exe")) { & $Uv venv --seed --python 3.11 .venv }
$Py = Join-Path $Here ".venv\Scripts\python.exe"
& $Uv pip install --python $Py -e ".[test]" huggingface_hub
if ($Device -ne "cpu") { & $Uv pip install --python $Py "nvidia-cublas-cu12" "nvidia-cudnn-cu12"   # CTranslate2 (Whisper on GPU) needs these DLLs on Windows }
Step "下載 Whisper small 模型"
& $Py -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8'); print('Whisper OK')"

# ---- 3. 引擎 -------------------------------------------------------------------
function Install-Engine($name) {
  $dir = Join-Path $Here "engines\$name"
  $venv = Join-Path $dir ".venv"
  $EPy = Join-Path $venv "Scripts\python.exe"
  Set-Location $dir
  switch ($name) {
    "cosyvoice2" {
      Step "[CosyVoice 2] Python 3.10 虛擬環境"
      if (-not (Test-Path $EPy)) { & $Uv venv --seed --python 3.10 .venv }
      Step "[CosyVoice 2] PyTorch 2.3.1 ($Device)"
      & $Uv pip install --python $EPy "torch==2.3.1" "torchaudio==2.3.1" --index-url $TorchIndex
      Step "[CosyVoice 2] 取得原始碼"
      if (-not (Test-Path "vendor\CosyVoice\cosyvoice")) { New-Item -ItemType Directory -Force vendor | Out-Null; git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git vendor\CosyVoice }
      Push-Location vendor\CosyVoice; git checkout -q $CosyVoiceCommit; git submodule update --init --recursive; Pop-Location
      Step "[CosyVoice 2] 相依套件"
      & $Uv pip install --python $EPy "setuptools<81" wheel "numpy==1.26.4"
      & $Uv pip install --python $EPy --no-build-isolation "openai-whisper==20231117"   # its build needs pkg_resources
      & $Uv pip install --python $EPy -r requirements.txt
      if ($Device -ne "cpu") { & $Uv pip install --python $EPy "onnxruntime-gpu==1.18.0" }
    }
    "gptsovits" {
      Step "[GPT-SoVITS] Python 3.10 虛擬環境"
      if (-not (Test-Path $EPy)) { & $Uv venv --seed --python 3.10 .venv }
      Step "[GPT-SoVITS] PyTorch ($Device)"
      & $Uv pip install --python $EPy torch torchaudio torchcodec --index-url $TorchIndex
      Step "[GPT-SoVITS] 取得原始碼"
      if (-not (Test-Path "vendor\GPT-SoVITS\GPT_SoVITS")) { New-Item -ItemType Directory -Force vendor | Out-Null; git clone https://github.com/RVC-Boss/GPT-SoVITS.git vendor\GPT-SoVITS }
      Push-Location vendor\GPT-SoVITS; git checkout -q $GptSovitsCommit; Pop-Location
      Step "[GPT-SoVITS] 相依套件"
      & $Uv pip install --python $EPy -r vendor\GPT-SoVITS\extra-req.txt --no-deps
      & $Uv pip install --python $EPy -r requirements.txt
      Step "[GPT-SoVITS] 英文 G2P 需要的 NLTK 資料"
      & $EPy -c "import nltk; nltk.download('averaged_perceptron_tagger_eng', quiet=True); nltk.download('cmudict', quiet=True)"
    }
    "fishspeech" {
      Step "[Fish Speech] Python 3.12 虛擬環境"
      if (-not (Test-Path $EPy)) { & $Uv venv --seed --python 3.12 .venv }
      Step "[Fish Speech] 取得原始碼"
      if (-not (Test-Path "vendor\fish-speech\fish_speech")) { New-Item -ItemType Directory -Force vendor | Out-Null; git clone https://github.com/fishaudio/fish-speech.git vendor\fish-speech }
      Push-Location vendor\fish-speech; git checkout -q $FishSpeechCommit; Pop-Location
      # transformers needs torch >= 2.6; 2.6 ships for cpu / cu124 / cu126
      $FishIndex = if ($Device -eq "cpu") { "https://download.pytorch.org/whl/cpu" } else { "https://download.pytorch.org/whl/cu124" }
      Step "[Fish Speech] PyTorch 2.6.0 與相依套件"
      & $Uv pip install --python $EPy "torch==2.6.0" "torchaudio==2.6.0" --index-url $FishIndex
      & $Uv pip install --python $EPy -r requirements.txt            # deps minus pyaudio/gradio/wandb
      & $Uv pip install --python $EPy --no-deps -e vendor\fish-speech
      if (-not $env:HF_TOKEN) { Write-Warning "未設定 HF_TOKEN：openaudio-s1-mini 需要先在 Hugging Face 同意條款並建立 token，否則下載會失敗。" }
    }
  }
  Step "[$name] 下載模型權重"
  & $Py (Join-Path $Here "download_models.py") $name
  Set-Location $Here
}

foreach ($e in $Engines.Split(",")) {
  $e = $e.Trim()
  if ($e) { try { Install-Engine $e } catch { Write-Warning "引擎 $e 安裝失敗：$($_.Exception.Message)`n其他引擎會繼續安裝；之後可單獨重跑  .\install.ps1 -Engines $e"; Set-Location $Here } }
}

Step "檢查 ffmpeg"
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { ffmpeg -version | Select-Object -First 1 } else { Write-Warning "找不到 ffmpeg，請安裝後確認 PATH" }
Write-Host "`n安裝完成。啟動服務：pnpm dev:tts" -ForegroundColor Green
Pop-Location
