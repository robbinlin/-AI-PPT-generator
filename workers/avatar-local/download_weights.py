"""Download MuseTalk v1.5 weights into vendor/MuseTalk/models in the layout MuseTalk expects.

Mirrors MuseTalk's download_weights.bat (same Hugging Face repos and files); idempotent.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

HERE = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("LVS_MUSETALK_DIR", HERE / "vendor" / "MuseTalk")) / "models"

# (repo, file in repo, target sub-directory)
FILES = [
    ("TMElyralab/MuseTalk", "musetalkV15/musetalk.json", "musetalkV15"),
    ("TMElyralab/MuseTalk", "musetalkV15/unet.pth", "musetalkV15"),
    ("stabilityai/sd-vae-ft-mse", "config.json", "sd-vae"),
    ("stabilityai/sd-vae-ft-mse", "diffusion_pytorch_model.bin", "sd-vae"),
    ("openai/whisper-tiny", "config.json", "whisper"),
    ("openai/whisper-tiny", "pytorch_model.bin", "whisper"),
    ("openai/whisper-tiny", "preprocessor_config.json", "whisper"),
    ("yzd-v/DWPose", "dw-ll_ucoco_384.pth", "dwpose"),
    ("ManyOtherFunctions/face-parse-bisent", "79999_iter.pth", "face-parse-bisent"),
    ("ManyOtherFunctions/face-parse-bisent", "resnet18-5c106cde.pth", "face-parse-bisent"),
]


def main() -> int:
    for repo, name, sub in FILES:
        target = MODELS / sub / Path(name).name
        if target.is_file() and target.stat().st_size > 0:
            print(f"  已存在 {target.relative_to(MODELS)}")
            continue
        print(f"  下載 {repo}/{name} ...", flush=True)
        got = hf_hub_download(repo_id=repo, filename=name, local_dir=str(MODELS / sub) if "/" not in name else str(MODELS))
        got = Path(got)
        if got != target:
            target.parent.mkdir(parents=True, exist_ok=True)
            got.replace(target)
    # MuseTalk's face detector (S3FD) otherwise fetches its 86 MB weights from adrianbulat.com on
    # the first avatar job, which looks like a hang on a slow link. Put the file where
    # sfd_detector.py looks first (next to the module) so first use is instant.
    sfd = MODELS.parent / "musetalk" / "utils" / "face_detection" / "detection" / "sfd" / "s3fd.pth"
    if not (sfd.is_file() and sfd.stat().st_size > 80_000_000):
        print("  下載 S3FD 人臉偵測權重 (s3fd-619a316812.pth, 86 MB) ...", flush=True)
        import urllib.request

        tmp = sfd.with_suffix(".pth.part")
        urllib.request.urlretrieve("https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth", tmp)
        tmp.replace(sfd)
    print(f"模型權重就緒：{MODELS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
