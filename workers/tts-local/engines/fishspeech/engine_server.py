"""Fish Speech / OpenAudio S1-mini engine inside engines/fishspeech/.venv. Protocol: GET /health, POST /synthesize."""

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
VENDOR = HERE / "vendor" / "fish-speech"
CKPT = HERE / "models" / "openaudio-s1-mini"
os.chdir(VENDOR)
sys.path.insert(0, str(VENDOR))

import torch  # noqa: E402
from fish_speech.inference_engine import TTSInferenceEngine  # noqa: E402
from fish_speech.models.dac.inference import load_model as load_decoder_model  # noqa: E402
from fish_speech.models.text2semantic.inference import launch_thread_safe_queue  # noqa: E402
from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest  # noqa: E402

device = os.environ.get("LVS_TTS_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
precision = torch.half if device == "cuda" else torch.float32
print(f"loading OpenAudio S1-mini from {CKPT} on {device}", flush=True)
llama_queue = launch_thread_safe_queue(checkpoint_path=str(CKPT), device=device, precision=precision, compile=False)
decoder = load_decoder_model(config_name="modded_dac_vq", checkpoint_path=str(CKPT / "codec.pth"), device=device)
engine = TTSInferenceEngine(llama_queue=llama_queue, decoder_model=decoder, precision=precision, compile=False)
print("ready", flush=True)


def synthesize(req: dict) -> dict:
    text, ref_wav, ref_text = req["text"], req["ref_wav"], req.get("ref_text") or ""
    audio_bytes = Path(ref_wav).read_bytes()
    tts_req = ServeTTSRequest(
        text=text,
        references=[ServeReferenceAudio(audio=audio_bytes, text=ref_text)],
        format="wav",
        chunk_length=200,
        max_new_tokens=1024,
        top_p=0.8,
        repetition_penalty=1.1,
        temperature=0.8,
        streaming=False,
        use_memory_cache="off",
    )
    final = None
    for result in engine.inference(tts_req):
        if result.code == "error":
            raise RuntimeError(str(result.error))
        if result.code == "final":
            final = result.audio
    if final is None:
        raise RuntimeError("Fish Speech produced no audio")
    sr, audio = final
    out = Path(req["out_wav"])
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out), np.asarray(audio, dtype=np.float32), int(sr), subtype="PCM_16")
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
        self._json(200, {"ready": True, "engine": "fishspeech", "device": device})

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
    print(f"fishspeech engine listening on {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
