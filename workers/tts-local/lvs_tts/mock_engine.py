"""Test engine: a sine tone whose length follows the text (≈ 0.25 s per CJK char / word). No ML."""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 24000


def units(text: str) -> int:
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    words = len(re.findall(r"[A-Za-z0-9]+", text))
    return max(1, cjk + words)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._json(200, {"ready": True, "engine": "mock"})

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        req = json.loads(self.rfile.read(n) or b"{}")
        if not req.get("text", "").strip():
            return self._json(400, {"error": "empty text"})
        seconds = 0.25 * units(req["text"]) / float(req.get("speed") or 1.0)
        t = np.linspace(0, seconds, int(SR * seconds), endpoint=False)
        tone = 0.2 * np.sin(2 * np.pi * 220 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
        out = Path(req["out_wav"])
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, tone.astype(np.float32), SR, subtype="PCM_16")
        self._json(200, {"wav": str(out), "sampleRate": SR})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()
    print(f"mock engine listening on {args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
