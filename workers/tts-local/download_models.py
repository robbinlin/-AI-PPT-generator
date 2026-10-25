"""Download engine weights into engines/<name>/models (idempotent). Usage: python download_models.py <engine>"""

from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download

HERE = Path(__file__).resolve().parent


def mark_ready(models: Path) -> None:
    (models / ".ready").write_text("ok", "utf-8")


def cosyvoice2() -> None:
    models = HERE / "engines" / "cosyvoice2" / "models"
    target = models / "CosyVoice2-0.5B"
    print(f"  CosyVoice2-0.5B → {target}")
    snapshot_download("FunAudioLLM/CosyVoice2-0.5B", local_dir=str(target))
    mark_ready(models)


def gptsovits() -> None:
    models = HERE / "engines" / "gptsovits" / "models"
    # GPT-SoVITS hard-codes GPT_SoVITS/pretrained_models/... in a few modules, so the weights live
    # inside the vendored checkout (gitignored); models/.ready only marks completion.
    vendor = HERE / "engines" / "gptsovits" / "vendor" / "GPT-SoVITS" / "GPT_SoVITS"
    pre = vendor / "pretrained_models"
    models.mkdir(parents=True, exist_ok=True)
    print(f"  GPT-SoVITS v2 pretrained + BERT + HuBERT → {pre}")
    snapshot_download(
        "lj1995/GPT-SoVITS",
        local_dir=str(pre),
        allow_patterns=[
            "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
            "gsv-v2final-pretrained/s2G2333k.pth",
            "gsv-v2final-pretrained/s2D2333k.pth",  # discriminator, for fine-tuning a voice
            "sv/pretrained_eres2netv2w24s4ep4.ckpt",  # speaker embedding, picks the speaker's clips
            "chinese-roberta-wwm-ext-large/*",
            "chinese-hubert-base/*",
            "s1v3.ckpt",
            "gsv-v4-pretrained/s2Gv4.pth",
            "gsv-v4-pretrained/vocoder.pth",
        ],
    )
    # G2PW (Chinese grapheme-to-phoneme) lives next to the text front-end inside the vendored repo.
    text_dir = vendor / "text"
    if not (text_dir / "G2PWModel").is_dir():
        print("  G2PWModel.zip → GPT_SoVITS/text/G2PWModel")
        z = hf_hub_download("XXXXRT/GPT-SoVITS-Pretrained", "G2PWModel.zip", local_dir=str(models / "_zips"))
        with zipfile.ZipFile(z) as zf:
            zf.extractall(text_dir)
    # GPT-SoVITS keeps fast-langdetect's model cache under its own pretrained_models folder and
    # fails if the directory is missing (the upstream zip would have created it).
    (pre / "fast_langdetect").mkdir(parents=True, exist_ok=True)
    mark_ready(models)


def fishspeech() -> None:
    models = HERE / "engines" / "fishspeech" / "models"
    target = models / "openaudio-s1-mini"
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    print(f"  openaudio-s1-mini (gated: needs a Hugging Face token that accepted the model terms) → {target}")
    try:
        # The repo was renamed from openaudio-s1-mini to s1-mini; try the new id first.
        try:
            snapshot_download("fishaudio/s1-mini", local_dir=str(target), token=token)
        except Exception:
            snapshot_download("fishaudio/openaudio-s1-mini", local_dir=str(target), token=token)
        if not (target / "codec.pth").is_file():
            raise RuntimeError("codec.pth missing after download")
    except Exception as e:
        print(
            "\n  下載失敗：openaudio-s1-mini 是需要同意條款的模型。請到 https://huggingface.co/fishaudio/s1-mini 登入並同意，"
            "再到 https://huggingface.co/settings/tokens 建立 token，設定環境變數 HF_TOKEN 後重跑安裝。\n  原始錯誤："
            + str(e)[:300]
        )
        raise SystemExit(2)
    mark_ready(models)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    {"cosyvoice2": cosyvoice2, "gptsovits": gptsovits, "fishspeech": fishspeech}[which]()
    print("  完成")
