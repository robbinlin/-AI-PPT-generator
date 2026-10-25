"""Train a voice on a long recording of one speaker (a lecture, 10+ minutes) and add it to the voice list.

    .venv\\Scripts\\python -m lvs_tts.train_voice <recording> --name "林老師（訓練版）"

1. Whisper transcribes the recording (large-v3-turbo by default; LVS_TRAIN_WHISPER_MODEL).
2. Clean 2.5–11.5 s sentences are cut out (at most --max-minutes of them).
3. engines/gptsovits/train_engine.py keeps the clips of the main speaker and fine-tunes GPT-SoVITS v2's
   SoVITS (the timbre); the pretrained GPT is kept, it misreads much less (--gpt-epochs to train it too).
4. Up to 8 candidate reference clips each read an audition text with the new model; Whisper scores the
   readings and the most accurate clip becomes the voice's reference. The voice is saved with its
   model, so the app lists it as 「…（訓練版）」.

Takes about 20 minutes on an 8 GB GPU for 30 minutes of speech. The local TTS service may keep
running: its loaded engine is unloaded first so training has the GPU memory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from . import ffmpeg, whisper_align
from .store import VoiceStore, default_data_dir

HERE = Path(__file__).resolve().parents[1]
GS = HERE / "engines" / "gptsovits"


# Read by every candidate reference clip; the clip whose reading Whisper understands best wins.
AUDITION_TEXT = (
    "各位同學大家好，今天我們要比較兩組樣本的平均數。首先說明研究問題與虛無假設，接著看兩組資料的描述統計，"
    "最後用獨立樣本 t 檢定，判斷兩組之間的差異是否達到統計上的顯著。"
)


def char_error_rate(ref: str, hyp: str) -> float:
    from opencc import OpenCC

    t2s = OpenCC("t2s").convert
    r = [c for c in t2s(ref).lower() if c.isalnum()]
    h = [c for c in t2s(hyp).lower() if c.isalnum()]
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


def whisper_model(model_name: str):
    whisper_align._add_cuda_dlls()
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(model_name, device="cuda", compute_type="float16")
    except Exception as e:
        say(f"Whisper on GPU failed ({e}); using CPU (slow)")
        return WhisperModel(model_name, device="cpu", compute_type="int8")


def say(msg: str) -> None:
    print(f"[train-voice] {msg}", flush=True)


def transcribe(wav16k: Path, model_name: str) -> list[dict]:
    model = whisper_model(model_name)
    segs, _ = model.transcribe(
        str(wav16k), language="zh", vad_filter=True, beam_size=5, condition_on_previous_text=False, initial_prompt=whisper_align.ZH_PROMPT
    )
    out = []
    for s in segs:
        out.append({"start": s.start, "end": s.end, "text": s.text.strip(), "logprob": s.avg_logprob, "nospeech": s.no_speech_prob})
        if len(out) % 100 == 0:
            say(f"  transcribed {s.end / 60:.0f} min")
    del model
    return out


def cut_clips(segs: list[dict], wav32: Path, out_dir: Path, max_minutes: float) -> list[dict]:
    import numpy as np
    import soundfile as sf
    from opencc import OpenCC

    t2s = OpenCC("t2s").convert
    audio, sr = sf.read(str(wav32), dtype="float32")
    (out_dir / "wavs").mkdir(parents=True, exist_ok=True)
    clips, total = [], 0.0
    for i, s in enumerate(segs):
        d = s["end"] - s["start"]
        if not (2.5 <= d <= 11.5) or s["logprob"] < -0.45 or s["nospeech"] > 0.2 or len(s["text"]) < 6:
            continue
        a = audio[int(max(0.0, s["start"] - 0.05) * sr) : int((s["end"] + 0.15) * sr)]
        peak = float(np.abs(a).max()) if len(a) else 0.0
        if peak < 0.05:
            continue
        a = a / peak * 0.9 * 0.25 + a * 0.75  # the GPT-SoVITS slicer's loudness mix
        path = out_dir / "wavs" / f"seg{i:05d}.wav"
        sf.write(str(path), a, sr, subtype="PCM_16")
        clips.append({"wav": str(path), "text": whisper_align.to_traditional(s["text"]), "zh": t2s(s["text"]), "sec": d, "logprob": s["logprob"]})
        total += d
        if total >= max_minutes * 60:
            break
    return clips


def unload_service_engine(url: str) -> None:
    try:
        urllib.request.urlopen(urllib.request.Request(f"{url}/engines/unload", data=b"", method="POST"), timeout=30).read()
        say("unloaded the local TTS service's engine to free GPU memory")
    except Exception:
        pass  # service not running, or an older version without the endpoint


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("recording", type=Path)
    ap.add_argument("--name", required=True, help="voice name shown in the app")
    ap.add_argument("--max-minutes", type=float, default=40, help="speech used for training (default 40)")
    ap.add_argument("--sovits-epochs", type=int, default=8)
    ap.add_argument("--gpt-epochs", type=int, default=0, help="also fine-tune GPT (default: keep the pretrained one)")
    ap.add_argument("--service", default=os.environ.get("LOCAL_TTS_URL", "http://127.0.0.1:8766"))
    ap.add_argument("--keep-work", action="store_true", help="keep the clips and logs (data/tts-local/training/<id>)")
    args = ap.parse_args()
    if not args.recording.is_file():
        raise SystemExit(f"{args.recording} not found")
    gs_py = GS / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not gs_py.is_file():
        raise SystemExit("GPT-SoVITS is not installed; run install.ps1 -Engines gptsovits")

    data = default_data_dir()
    work = data / "training" / time.strftime("%Y%m%d-%H%M%S")  # removed afterwards unless --keep-work
    work.mkdir(parents=True)
    t0 = time.time()
    try:
        say(f"converting {args.recording.name}")
        wav16, wav32 = work / "rec16k.wav", work / "rec32k.wav"
        ffmpeg.to_wav(args.recording, wav16, rate=16000)
        ffmpeg.to_wav(args.recording, wav32, rate=32000)
        say(f"recording is {ffmpeg.probe_duration(wav16) / 60:.0f} min; transcribing")
        # Transcripts are kept per recording, so training the same recording again skips this step.
        h = hashlib.sha256()
        with args.recording.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        cached = data / "training" / "transcripts" / f"{h.hexdigest()[:16]}.json"
        if cached.is_file():
            say("using the transcript from an earlier run on this recording")
            segs = json.loads(cached.read_text("utf-8"))
        else:
            segs = transcribe(wav16, os.environ.get("LVS_TRAIN_WHISPER_MODEL", "large-v3-turbo"))
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(segs, ensure_ascii=False), "utf-8")
        clips = cut_clips(segs, wav32, work, args.max_minutes)
        say(f"{len(clips)} clean sentences, {sum(c['sec'] for c in clips) / 60:.1f} min")
        if len(clips) < 40:
            raise SystemExit("too little clear speech for training; use a longer recording (10+ minutes) of one speaker")
        lst = work / "list.txt"
        lst.write_text("".join(f"{c['wav']}|spk|zh|{c['zh']}\n" for c in clips), "utf-8")
        # Reference candidates: confidently transcribed 4.5–9.5 s sentences (the engine then keeps the
        # ones that sound most like the speaker and auditions them).
        cands = sorted((c for c in clips if 4.5 <= c["sec"] <= 9.5 and c["logprob"] > -0.3), key=lambda c: -c["logprob"])[:30]
        cand_file = work / "candidates.json"
        cand_file.write_text(json.dumps([{"wav": c["wav"], "text": c["text"]} for c in cands], ensure_ascii=False), "utf-8")

        unload_service_engine(args.service)
        proc = subprocess.Popen(
            [str(gs_py), "-s", str(GS / "train_engine.py"), "--list", str(lst), "--work", str(work),
             "--sovits-epochs", str(args.sovits_epochs), "--gpt-epochs", str(args.gpt_epochs),
             "--candidates", str(cand_file), "--audition-text", AUDITION_TEXT],
            stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
        )
        result = None
        for line in proc.stdout:  # streamed, so the trainers' progress shows as it happens
            if line.startswith("{") and '"sovits"' in line:
                result = json.loads(line)
            else:
                print(line, end="", flush=True)
        if proc.wait() or not result:
            raise SystemExit("training failed (see the output above)")

        auditions = result.get("auditions") or []
        if not auditions:
            raise SystemExit("no reference clip could be auditioned (too few clear 4.5–9.5 s sentences of the speaker)")
        say(f"scoring {len(auditions)} reference candidates")
        model = whisper_model(os.environ.get("LVS_TRAIN_WHISPER_MODEL", "large-v3-turbo"))
        by_wav = {c["wav"]: c for c in clips}
        for a in auditions:
            segs, _ = model.transcribe(a["wav"], language="zh", beam_size=5, condition_on_previous_text=False)
            a["cer"] = char_error_rate(AUDITION_TEXT, "".join(s.text for s in segs))
            say(f"  {a['cer']:.0%} misread, similarity {a['similarity']:.2f}: {by_wav[a['ref']]['text']}")
        del model
        best = min(auditions, key=lambda a: (round(a["cer"], 2), -a["similarity"]))
        ref = by_wav[best["ref"]]
        store = VoiceStore(data)
        voice = store.create(Path(ref["wav"]).name, Path(ref["wav"]).read_bytes(), args.name, lambda _p: ref["text"])
        voice = store.attach_model(voice.id, "gptsovits", Path(result["gpt"]) if result.get("gpt") else None, Path(result["sovits"]), result["minutes"])
        say(f"reference: {ref['text']} ({best['cer']:.0%} misread in the audition)")
        say(f"done in {(time.time() - t0) / 60:.0f} min: voice {voice.id} 「{voice.name}」, trained on {result['minutes']} min")
        say("in the app: 專案設定 → 語音 → 本機語音 → 「我的聲音・" + voice.name + "（訓練版）」")
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
