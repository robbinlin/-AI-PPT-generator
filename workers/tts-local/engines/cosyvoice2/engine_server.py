"""CosyVoice2-0.5B engine (runs inside engines/cosyvoice2/.venv). Protocol: GET /health, POST /synthesize."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "CosyVoice"
MODEL_DIR = HERE / "models" / "CosyVoice2-0.5B"
os.chdir(VENDOR)
sys.path.insert(0, str(VENDOR))
sys.path.insert(0, str(VENDOR / "third_party" / "Matcha-TTS"))

import torch  # noqa: E402
import torchaudio  # noqa: E402
from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

device = os.environ.get("LVS_TTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
if device == "cpu":
    torch.set_num_threads(max(1, os.cpu_count() or 1))
print(f"loading CosyVoice2 from {MODEL_DIR} on {device}", flush=True)
model = CosyVoice2(str(MODEL_DIR), load_jit=False, load_trt=False, load_vllm=False, fp16=(device == "cuda"))
print(f"ready (sample_rate={model.sample_rate})", flush=True)


def synthesize(req: dict) -> dict:
    text, ref_wav, ref_text = req["text"], req["ref_wav"], req.get("ref_text") or ""
    speed = float(req.get("speed") or 1.0)
    chunks = [out["tts_speech"] for out in model.inference_zero_shot(text, ref_text, ref_wav, stream=False, speed=speed, text_frontend=True)]
    if not chunks:
        raise RuntimeError("CosyVoice2 produced no audio")
    audio = torch.cat(chunks, dim=1)
    out = Path(req["out_wav"])
    out.parent.mkdir(parents=True, exist_ok=True)
    torchaudio.save(str(out), audio, model.sample_rate)
    return {"wav": str(out), "sampleRate": model.sample_rate}


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
        self._json(200, {"ready": True, "engine": "cosyvoice2", "device": device})

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
    print(f"cosyvoice2 engine listening on {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
