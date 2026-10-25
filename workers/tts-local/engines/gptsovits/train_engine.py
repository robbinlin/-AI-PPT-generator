"""Fine-tune GPT-SoVITS v2 on one speaker. Runs inside engines/gptsovits/.venv (called by lvs_tts/train_voice.py).

Input: a list file `wav|speaker|zh|simplified text` of 3-12 s clips. Steps:
  1. drop clips that do not sound like the main speaker (ERes2Net embedding vs. the centroid)
  2. upstream dataset prep (1-get-text, 2-get-hubert-wav32k, 3-get-semantic)
  3. SoVITS (s2) training from the v2 pretrained weights; GPT (s1) only with --gpt-epochs
  4. one reading of --audition-text per candidate reference clip
Prints one JSON line at the end: {"gpt" (null = pretrained), "sovits", "kept", "minutes", "similarity": {wav: cos},
"auditions": [{ref, wav, similarity}]}.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "GPT-SoVITS"
PRE = "GPT_SoVITS/pretrained_models"
S1_PRETRAINED = f"{PRE}/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
S2G_PRETRAINED = f"{PRE}/gsv-v2final-pretrained/s2G2333k.pth"
S2D_PRETRAINED = f"{PRE}/gsv-v2final-pretrained/s2D2333k.pth"


def log(msg: str) -> None:
    print(f"[train] {msg}", flush=True)


def speaker_filter(lines: list[str]) -> tuple[list[str], dict[str, float]]:
    import numpy as np
    import torch
    import torchaudio

    from GPT_SoVITS.sv import SV  # needs cwd = VENDOR (relative model paths), see main()

    sv = SV("cuda" if torch.cuda.is_available() else "cpu", torch.cuda.is_available())
    embs = []
    for line in lines:
        wav, sr = torchaudio.load(line.split("|")[0])
        wav = torchaudio.functional.resample(wav.mean(0, keepdim=True), sr, 16000)
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        embs.append(torch.nn.functional.normalize(sv.compute_embedding3(wav.to(dev)).float(), dim=-1)[0].cpu())
    E = torch.stack(embs)
    c = torch.nn.functional.normalize(E.median(0).values, dim=0)
    for _ in range(2):  # re-center on the clips that clearly match
        sims = E @ c
        c = torch.nn.functional.normalize(E[sims > sims.quantile(0.3)].mean(0), dim=0)
    sims = (E @ c).numpy()
    thr = max(0.55, float(np.percentile(sims, 50)) - 0.2)
    keep = [l for l, s in zip(lines, sims) if s >= thr]
    log(f"speaker filter: kept {len(keep)} of {len(lines)} clips (threshold {thr:.2f})")
    del sv
    torch.cuda.empty_cache()
    return keep, {l.split("|")[0]: round(float(s), 4) for l, s in zip(lines, sims)}


def run(script: str, env: dict) -> None:
    log(f"running {script}")
    proc = subprocess.run([sys.executable, "-s", script], cwd=VENDOR, env=env)
    if proc.returncode != 0:
        raise SystemExit(f"{script} failed ({proc.returncode})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--work", required=True, help="scratch folder for this training run")
    ap.add_argument("--sovits-epochs", type=int, default=8)
    # 0 keeps the pretrained GPT (text -> speech tokens, trained on 5k hours): it misreads far less
    # than one fine-tuned on a single lecture, and the voice's timbre comes from SoVITS anyway.
    ap.add_argument("--gpt-epochs", type=int, default=0)
    ap.add_argument("--candidates", help="JSON list of {wav, text}: possible reference clips to audition")
    ap.add_argument("--auditions", type=int, default=8)
    ap.add_argument("--audition-text", default="")
    ap.add_argument("--batch-size", type=int, default=4)
    args = ap.parse_args()

    import torch
    import yaml

    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    lines = [l for l in Path(args.list).resolve().read_text("utf-8").splitlines() if l.strip()]
    # Upstream modules use paths relative to the checkout (GPT_SoVITS/pretrained_models/...).
    os.chdir(VENDOR)
    sys.path[:0] = [str(VENDOR), str(VENDOR / "GPT_SoVITS")]
    keep, sims = speaker_filter(lines)
    if len(keep) < 20:
        raise SystemExit(f"only {len(keep)} usable clips; record at least 5 minutes of clear speech")
    lst = work / "list_kept.txt"
    lst.write_text("\n".join(keep) + "\n", "utf-8")

    exp = "lvs_" + work.name
    opt = VENDOR / "logs" / exp
    shutil.rmtree(opt, ignore_errors=True)
    opt.mkdir(parents=True)
    half = torch.cuda.is_available()
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(VENDOR), str(VENDOR / "GPT_SoVITS"), str(HERE / "train_shims")]),
        "inp_text": str(lst),
        "inp_wav_dir": "",
        "exp_name": exp,
        "opt_dir": str(opt),
        "i_part": "0",
        "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": "0",
        "is_half": str(half),
        "version": "v2",
        "bert_pretrained_dir": f"{PRE}/chinese-roberta-wwm-ext-large",
        "cnhubert_base_dir": f"{PRE}/chinese-hubert-base",
        "pretrained_s2G": S2G_PRETRAINED,
        "s2config_path": "GPT_SoVITS/configs/s2.json",
        "hz": "25hz",
    }
    torch_lib = Path(torch.__file__).parent / "lib"  # cuBLAS/cuDNN for the child processes on Windows
    env["PATH"] = str(torch_lib) + os.pathsep + env.get("PATH", "")

    run("GPT_SoVITS/prepare_datasets/1-get-text.py", env)
    (opt / "2-name2text-0.txt").replace(opt / "2-name2text.txt")
    run("GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py", env)
    run("GPT_SoVITS/prepare_datasets/3-get-semantic.py", env)
    sem = (opt / "6-name2semantic-0.tsv").read_text("utf-8")
    (opt / "6-name2semantic.tsv").write_text("item_name\tsemantic_audio\n" + sem, "utf-8")

    sovits_dir, gpt_dir = work / "sovits_weights", work / "gpt_weights"
    for d in (sovits_dir, gpt_dir, opt / "logs_s2_v2", opt / "logs_s1_v2"):  # the trainers expect these to exist
        d.mkdir(exist_ok=True)
    s2 = json.loads((VENDOR / "GPT_SoVITS/configs/s2.json").read_text("utf-8"))
    s2["train"].update(
        batch_size=args.batch_size, epochs=args.sovits_epochs, text_low_lr_rate=0.4, pretrained_s2G=S2G_PRETRAINED,
        pretrained_s2D=S2D_PRETRAINED, if_save_latest=True, if_save_every_weights=True, save_every_epoch=args.sovits_epochs,
        gpu_numbers="0", grad_ckpt=False, lora_rank="32", fp16_run=half,
    )
    s2["model"]["version"] = "v2"
    s2["data"]["exp_dir"] = s2["s2_ckpt_dir"] = f"logs/{exp}"
    s2.update(save_weight_dir=str(sovits_dir), name=exp, version="v2")
    (work / "s2.json").write_text(json.dumps(s2), "utf-8")
    log(f"SoVITS: {args.sovits_epochs} epochs")
    if subprocess.run([sys.executable, "-s", "GPT_SoVITS/s2_train.py", "--config", str(work / "s2.json")], cwd=VENDOR, env=env).returncode:
        raise SystemExit("SoVITS training failed")

    gpt = None
    if args.gpt_epochs > 0:
        s1 = yaml.safe_load((VENDOR / "GPT_SoVITS/configs/s1longer-v2.yaml").read_text("utf-8"))
        s1["train"].update(
            batch_size=args.batch_size, epochs=args.gpt_epochs, save_every_n_epoch=args.gpt_epochs, if_save_every_weights=True,
            if_save_latest=True, if_dpo=False, half_weights_save_dir=str(gpt_dir), exp_name=exp, precision="16-mixed" if half else "32",
        )
        s1["data"]["num_workers"] = 2  # the upstream loader sets prefetch_factor, which needs workers
        s1.update(
            pretrained_s1=S1_PRETRAINED, train_semantic_path=str(opt / "6-name2semantic.tsv"), train_phoneme_path=str(opt / "2-name2text.txt"),
            output_dir=str(opt / "logs_s1_v2"),
        )
        (work / "s1.yaml").write_text(yaml.dump(s1, default_flow_style=False), "utf-8")
        log(f"GPT: {args.gpt_epochs} epochs")
        if subprocess.run([sys.executable, "-s", "GPT_SoVITS/s1_train.py", "--config_file", str(work / "s1.yaml")], cwd=VENDOR, env=env).returncode:
            raise SystemExit("GPT training failed")
        gpt = sorted(gpt_dir.glob("*.ckpt"), key=lambda p: p.stat().st_mtime)[-1]

    sovits = sorted(sovits_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime)[-1]
    shutil.rmtree(opt, ignore_errors=True)  # features + training checkpoints (GBs); the weights are kept
    import soundfile as sf

    minutes = sum(sf.info(l.split("|")[0]).duration for l in keep) / 60
    auditions = audition(args, work, sims, sovits, gpt)
    print(json.dumps({"gpt": str(gpt) if gpt else None, "sovits": str(sovits), "kept": len(keep), "minutes": round(minutes, 1),
                      "similarity": sims, "auditions": auditions}), flush=True)


def audition(args, work: Path, sims: dict[str, float], sovits: Path, gpt: Path | None) -> list[dict]:
    """Read the audition text with the new model once per candidate reference clip.

    Which clip is the prompt matters a lot (a steady, clearly read sentence vs. a hesitant one), so
    the caller scores these readings (Whisper) and keeps the clip that was read most accurately.
    """
    if not args.candidates:
        return []
    import numpy as np
    import soundfile as sf
    from opencc import OpenCC
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    t2s = OpenCC("t2s").convert
    cands = [c for c in json.loads(Path(args.candidates).read_text("utf-8")) if sims.get(c["wav"], 0) >= 0.75]
    cands = sorted(cands, key=lambda c: -sims[c["wav"]])[: args.auditions]
    if not cands:
        return []
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tts = TTS(TTS_Config({"custom": {
        "device": dev, "is_half": dev == "cuda", "version": "v2", "t2s_weights_path": str(gpt or S1_PRETRAINED), "vits_weights_path": str(sovits),
        "cnhuhbert_base_path": f"{PRE}/chinese-hubert-base", "bert_base_path": f"{PRE}/chinese-roberta-wwm-ext-large",
    }}))
    out_dir = work / "audition"
    out_dir.mkdir(exist_ok=True)
    text = t2s(args.audition_text)
    results = []
    for i, c in enumerate(cands):
        log(f"audition {i + 1}/{len(cands)}")
        params = {
            "text": text, "text_lang": "zh", "ref_audio_path": c["wav"], "aux_ref_audio_paths": [], "prompt_text": t2s(c["text"]), "prompt_lang": "zh",
            "top_k": 15, "top_p": 1.0, "temperature": 1.0, "text_split_method": "cut2", "batch_size": 1, "speed_factor": 1.0, "split_bucket": False,
            "return_fragment": False, "streaming_mode": False, "fragment_interval": 0.3, "seed": 1234, "parallel_infer": False,
            "repetition_penalty": 1.35, "sample_steps": 32, "super_sampling": False,
        }
        pieces, sr = [], 32000
        for sr, a in tts.run(params):
            pieces.append(np.asarray(a))
        wav = out_dir / f"cand{i}.wav"
        sf.write(str(wav), np.concatenate(pieces), sr, subtype="PCM_16")
        results.append({"ref": c["wav"], "wav": str(wav), "similarity": sims[c["wav"]]})
    return results


if __name__ == "__main__":
    main()
