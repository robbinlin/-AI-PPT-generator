"""Thin, checked wrappers around ffmpeg/ffprobe (on PATH or via FFMPEG_BIN / FFPROBE_BIN)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


def _bin(name: str) -> str:
    env = os.environ.get(f"LVS_{name.upper()}_BIN") or os.environ.get(f"{name.upper()}_BIN")
    if env:
        return env
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} not found on PATH; install ffmpeg or set {name.upper()}_BIN")
    return found


def run(args: list[str], *, timeout: float = 600) -> None:
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"{Path(args[0]).name} failed ({proc.returncode}): {proc.stderr.strip()[-800:]}")


def probe_duration(path: Path) -> float:
    proc = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr.strip()[-400:]}")
    return float(json.loads(proc.stdout)["format"]["duration"])


def to_wav(src: Path, out: Path, *, rate: int, max_seconds: float | None = None) -> None:
    """Mono 16-bit WAV at `rate` Hz (16 kHz for Whisper, 24 kHz for the TTS engines)."""
    args = [_bin("ffmpeg"), "-y", "-v", "error", "-i", str(src)]
    if max_seconds:
        args += ["-t", f"{max_seconds:.3f}"]
    args += ["-ac", "1", "-ar", str(rate), "-sample_fmt", "s16", str(out)]
    run(args)


def change_tempo(src: Path, out: Path, speed: float) -> None:
    """Time-stretch without pitch change for engines that have no native speed control."""
    # atempo accepts 0.5..100 per stage; chain two stages for anything below 0.5 (we clamp at 0.5 anyway).
    run([_bin("ffmpeg"), "-y", "-v", "error", "-i", str(src), "-filter:a", f"atempo={speed:.4f}", str(out)])
