"""GPT-SoVITS v2 engine (zero-shot, no training) inside engines/gptsovits/.venv.

Uses the same TTS pipeline as upstream api_v2.py. Protocol: GET /health, POST /synthesize.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "GPT-SoVITS"
os.chdir(VENDOR)
sys.path.insert(0, str(VENDOR))
sys.path.insert(0, str(VENDOR / "GPT_SoVITS"))

import torch  # noqa: E402
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # noqa: E402

device = os.environ.get("LVS_TTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
VERSION = os.environ.get("LVS_GPTSOVITS_VERSION", "v2")
PRETRAINED = VENDOR / "GPT_SoVITS" / "pretrained_models"  # upstream layout; some modules hard-code it
WEIGHTS = {
    "v2": ("gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt", "gsv-v2final-pretrained/s2G2333k.pth"),
    "v4": ("s1v3.ckpt", "gsv-v4-pretrained/s2Gv4.pth"),
}
t2s, vits = WEIGHTS[VERSION]
config = {
    "custom": {
        "device": device,
        "is_half": device == "cuda",
        "version": VERSION,
        "t2s_weights_path": str(PRETRAINED / t2s),
        "vits_weights_path": str(PRETRAINED / vits),
        "cnhuhbert_base_path": str(PRETRAINED / "chinese-hubert-base"),
        "bert_base_path": str(PRETRAINED / "chinese-roberta-wwm-ext-large"),
    }
}
print(f"loading GPT-SoVITS {VERSION} on {device}", flush=True)
tts_config = TTS_Config(config)
pipeline = TTS(tts_config)
print("ready", flush=True)

LANG = {"zh": "zh", "en": "en", "mixed": "auto"}


def synthesize(req: dict) -> dict:
    text, ref_wav, ref_text = req["text"], req["ref_wav"], req.get("ref_text") or ""
    lang = LANG.get(req.get("language", "zh"), "zh")
    prompt_lang = "zh" if any("一" <= c <= "鿿" for c in ref_text) else "en"
    params = {
        "text": text,
        "text_lang": lang,
        "ref_audio_path": ref_wav,
        "aux_ref_audio_paths": [],
        "prompt_text": ref_text,
        "prompt_lang": prompt_lang,
        "top_k": 15,
        "top_p": 1.0,
        "temperature": 1.0,
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": float(req.get("speed") or 1.0),
        "split_bucket": True,
        "return_fragment": False,
        "streaming_mode": False,
        "fragment_interval": 0.3,
        "seed": -1,
        "parallel_infer": True,
        "repetition_penalty": 1.35,
        "sample_steps": 32,
        "super_sampling": False,
    }
    pieces = []
    sr = 32000
    for sr, audio in pipeline.run(params):
        pieces.append(np.asarray(audio))
    if not pieces:
        raise RuntimeError("GPT-SoVITS produced no audio")
    audio = np.concatenate(pieces)
    out = Path(req["out_wav"])
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out), audio, sr, subtype="PCM_16")
    return {"wav": str(out), "sampleRate": int(sr)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json(200, {"ready": True, "engine": "gptsovits", "device": device, "version": VERSION})

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
            self._json(200, synthesize(req))
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()
    print(f"gptsovits engine listening on {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
