"""Engines run as subprocesses inside their own virtualenv (engines/<name>/.venv) and speak a tiny
HTTP protocol on a loopback port; this module starts, talks to and stops them.

Only one engine is resident at a time (8 GB GPUs cannot hold two models); switching engines
terminates the previous process.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests

log = logging.getLogger("lvs_tts")

HERE = Path(__file__).resolve().parent
# Tests point this at an empty directory so no real engine counts as installed.
ENGINES_DIR = Path(os.environ.get("LVS_TTS_ENGINES_DIR") or HERE.parent / "engines")

ENGINE_IDS = ("cosyvoice2", "gptsovits", "fishspeech")
DISPLAY_NAMES = {"cosyvoice2": "CosyVoice 2", "gptsovits": "GPT-SoVITS", "fishspeech": "Fish Speech"}
NOTES = {
    "cosyvoice2": "阿里 CosyVoice2-0.5B，零樣本聲音複製（參考音 3–30 秒），中文自然度高。Apache-2.0。",
    "gptsovits": "GPT-SoVITS v2 零樣本模式（參考音 3–10 秒），台灣社群常用。MIT。",
    "fishspeech": "Fish Speech OpenAudio S1-mini（參考音 3–30 秒）。模型授權 CC-BY-NC-SA 4.0（非商業），下載權重需 Hugging Face 帳號同意條款。",
}
# Engines that stretch audio natively; the rest get ffmpeg atempo in the main service.
NATIVE_SPEED = {"cosyvoice2", "gptsovits"}


def engine_dir(engine: str) -> Path:
    return ENGINES_DIR / engine


def engine_python(engine: str) -> Path:
    d = engine_dir(engine) / ".venv"
    return d / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def is_installed(engine: str) -> bool:
    if engine == "mock":
        return True
    d = engine_dir(engine)
    return engine_python(engine).is_file() and (d / "models" / ".ready").is_file()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class SynthResult:
    wav_path: Path
    sample_rate: int


class EngineProcess:
    def __init__(self, engine: str, device: str):
        self.engine = engine
        self.device = device
        self.port = _free_port()
        self.proc: Optional[subprocess.Popen] = None
        self.stderr_tail: deque[str] = deque(maxlen=40)
        self._reader: Optional[threading.Thread] = None

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 900) -> None:
        if self.engine == "mock":
            script = HERE / "mock_engine.py"
            python = sys.executable
        else:
            script = engine_dir(self.engine) / "engine_server.py"
            python = engine_python(self.engine)
        env = {**os.environ, "LVS_TTS_DEVICE": self.device, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        log.info("starting engine %s on port %d", self.engine, self.port)
        self.proc = subprocess.Popen(
            [str(python), str(script), "--port", str(self.port)],
            cwd=str(script.parent),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"engine {self.engine} exited during startup ({self.proc.returncode}):\n" + self.tail())
            try:
                r = requests.get(f"{self.base}/health", timeout=2)
                if r.ok and r.json().get("ready"):
                    log.info("engine %s ready", self.engine)
                    return
            except requests.RequestException:
                pass
            time.sleep(1)
        self.stop()
        raise RuntimeError(f"engine {self.engine} did not become ready within {timeout:.0f}s:\n" + self.tail())

    def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            line = line.rstrip()
            self.stderr_tail.append(line)
            log.info("[%s] %s", self.engine, line)

    def tail(self) -> str:
        return "\n".join(list(self.stderr_tail)[-12:])

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def synthesize(self, text: str, ref_wav: Path, ref_text: str, language: str, speed: float, out_wav: Path) -> SynthResult:
        payload = {"text": text, "ref_wav": str(ref_wav), "ref_text": ref_text, "language": language, "speed": speed, "out_wav": str(out_wav)}
        try:
            r = requests.post(f"{self.base}/synthesize", json=payload, timeout=1800)
        except requests.RequestException as e:
            raise RuntimeError(f"engine {self.engine} crashed or stopped responding: {e}\n" + self.tail())
        if not r.ok:
            try:
                msg = r.json().get("error", r.text)
            except Exception:
                msg = r.text
            raise RuntimeError(f"engine {self.engine} failed: {msg}\n" + self.tail())
        body = r.json()
        return SynthResult(Path(body["wav"]), int(body.get("sampleRate", 24000)))

    def stop(self) -> None:
        p = self.proc
        if not p:
            return
        if p.poll() is None:
            log.info("stopping engine %s", self.engine)
            p.terminate()
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=10)
        self.proc = None


class EngineManager:
    """Lazily starts the requested engine, keeping at most one alive."""

    def __init__(self, device: str):
        self.device = device
        self.current: Optional[EngineProcess] = None
        self.lock = threading.Lock()

    def status(self) -> dict:
        return {
            e: {"installed": is_installed(e), "ready": bool(self.current and self.current.engine == e and self.current.alive())}
            for e in ENGINE_IDS
        }

    def get(self, engine: str) -> EngineProcess:
        if engine != "mock" and engine not in ENGINE_IDS:
            raise ValueError(f"unknown engine {engine}")
        if not is_installed(engine):
            raise LookupError(f"engine {engine} is not installed; run the install script with -Engines {engine}")
        if self.current and (self.current.engine != engine or not self.current.alive()):
            self.current.stop()
            self.current = None
        if not self.current:
            proc = EngineProcess(engine, self.device)
            proc.start()
            self.current = proc
        return self.current

    def shutdown(self) -> None:
        if self.current:
            self.current.stop()
            self.current = None


def detect_device() -> str:
    env = os.environ.get("LVS_TTS_DEVICE")
    if env in ("cuda", "cpu"):
        return env
    try:
        out = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True, timeout=5)
        return "cuda" if out.returncode == 0 and "GPU" in out.stdout else "cpu"
    except Exception:
        return "cpu"
