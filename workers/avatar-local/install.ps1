# 本機人像（MuseTalk）安裝腳本 — Windows PowerShell
# 用法：在 PowerShell 進到專案資料夾後執行  .\workers\avatar-local\install.ps1
# 可重複執行；已完成的步驟會略過。總下載量約 4 到 5 GB。
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $Here
trap { Pop-Location; break }
$MuseTalkCommit = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---- 0. 顯示卡驅動檢查 ------------------------------------------------------
Step "檢查 NVIDIA 驅動程式"
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  # nvidia-smi can print nothing (driver mid-update, remote session); never crash on it.
  $out = try { (& nvidia-smi 2>$null | Out-String) } catch { "" }
  # Newer drivers (600+) print "KMD Version" instead of "Driver Version".
  if ($out -match "(?:Driver|KMD) Version:\s*([\d.]+)") {
    $ver = [double]($Matches[1].Split(".")[0])
    if ($ver -lt 520) { Write-Warning "驅動版本 $($Matches[1]) 太舊（需 520 以上才支援 CUDA 11.8）。請先到 https://www.nvidia.com/drivers 更新並重開機，否則只能用 CPU（非常慢）。" }
    else { Write-Host "驅動 $($Matches[1]) OK" }
  }
} else { Write-Warning "找不到 nvidia-smi：沒有 NVIDIA 顯示卡或驅動未安裝，模型將以 CPU 執行（非常慢）。" }

# ---- 1. uv（負責下載 Python 3.10 與建立虛擬環境） ---------------------------
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

# ---- 2. Python 3.10 虛擬環境 -------------------------------------------------
Step "建立 Python 3.10 虛擬環境 (.venv)"
if (-not (Test-Path ".venv\Scripts\python.exe")) { & $Uv venv --seed --python 3.10 .venv }
$Py = Join-Path $Here ".venv\Scripts\python.exe"

# ---- 3. PyTorch 2.0.1 (CUDA 11.8) + OpenMMLab 套件 ----------------------------
Step "安裝 PyTorch 2.0.1 (CUDA 11.8)"
& $Uv pip install --python $Py "torch==2.0.1" "torchvision==0.15.2" "torchaudio==2.0.2" --index-url https://download.pytorch.org/whl/cu118
Step "安裝 OpenMMLab (mmcv 2.0.1 / mmdet 3.1.0 / mmpose 1.1.0)"
& $Uv pip install --python $Py -U "setuptools<81" wheel openmim
& $Py -m mim install mmengine "mmcv==2.0.1" "mmdet==3.1.0"
# chumpy (an mmpose dependency) imports pip inside its build, which breaks under build isolation
& $Py -m pip install --no-build-isolation chumpy
& $Py -m mim install "mmpose==1.1.0"

# ---- 4. MuseTalk 本體與其餘套件 -----------------------------------------------
Step "取得 MuseTalk 原始碼 (commit $($MuseTalkCommit.Substring(0,7)))"
if (-not (Test-Path "vendor\MuseTalk\musetalk")) {
  New-Item -ItemType Directory -Force vendor | Out-Null
  git clone https://github.com/TMElyralab/MuseTalk.git vendor\MuseTalk
}
Push-Location vendor\MuseTalk; git checkout -q $MuseTalkCommit; Pop-Location
Step "安裝 MuseTalk 相依套件"
& $Uv pip install --python $Py "diffusers==0.30.2" "accelerate==0.28.0" "numpy==1.26.4" "opencv-python==4.9.0.80" "soundfile==0.12.1" "transformers==4.39.2" "huggingface_hub==0.30.2" "librosa==0.11.0" "einops==0.8.1" requests "imageio[ffmpeg]" omegaconf ffmpeg-python tqdm gdown
Step "固定 numpy 1.26.4 並檢查編譯套件相容性"
& $Uv pip install --python $Py "numpy==1.26.4"
& $Py -c "import xtcocotools.mask"
if ($LASTEXITCODE -ne 0) { Write-Host "xtcocotools 與 numpy 不相容，重新編譯（需要 Visual C++ Build Tools）"; & $Py -m pip install --no-build-isolation --no-binary xtcocotools --force-reinstall --no-deps "xtcocotools==1.14.3" }
Step "安裝本機人像服務 (lvs_avatar)"
& $Uv pip install --python $Py -e ".[test]"
Step "下載去背模型 (u2net_human_seg, 約 170 MB)"
& $Py -c "from rembg import new_session; new_session('u2net_human_seg'); print('去背模型 OK')"

# ---- 5. 模型權重（約 3.5 GB） -------------------------------------------------
Step "下載模型權重到 vendor\MuseTalk\models"
& $Py download_weights.py
if ($LASTEXITCODE -ne 0) { throw "模型下載失敗" }

# ---- 6. ffmpeg ---------------------------------------------------------------
Step "檢查 ffmpeg"
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Warning "找不到 ffmpeg，請安裝後確認 PATH（專案其他部分也需要它）。" } else { ffmpeg -version | Select-Object -First 1 }

Write-Host "`n安裝完成。啟動服務：在專案根目錄執行  pnpm dev:avatar" -ForegroundColor Green
Pop-Location
