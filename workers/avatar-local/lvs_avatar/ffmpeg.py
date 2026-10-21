"""Thin, checked wrappers around ffmpeg/ffprobe (both must be on PATH or given via env)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

FPS = 25


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


def extract_frames(video: Path, out_dir: Path, *, max_seconds: float = 10, fps: int = FPS) -> list[Path]:
    """First `max_seconds` of a video as zero-padded PNGs at `fps` (MuseTalk trains at 25 fps)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    run([_bin("ffmpeg"), "-y", "-v", "error", "-i", str(video), "-t", str(max_seconds), "-vf", f"fps={fps}", str(out_dir / "%08d.png")])
    frames = sorted(out_dir.glob("*.png"))
    if not frames:
        raise RuntimeError("no frames could be extracted from the video")
    return frames


def image_to_frame(image: Path, out_dir: Path) -> list[Path]:
    """A still image becomes a one-frame source (even dimensions, as yuv420p needs them)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "00000001.png"
    run([_bin("ffmpeg"), "-y", "-v", "error", "-i", str(image), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", str(out)])
    return [out]


def make_preview(frame: Path, out: Path) -> None:
    run([_bin("ffmpeg"), "-y", "-v", "error", "-i", str(frame), "-vf", "scale=-2:360", "-q:v", "4", str(out)])


def frames_to_video(frames: list[Path], audio: Path, out: Path, *, fps: int = FPS) -> None:
    """Concat-demuxer render (no frame copies) of `frames` at `fps`, muxed with `audio`, H.264 + AAC."""
    list_file = out.with_suffix(".txt")
    with list_file.open("w", encoding="utf-8") as f:
        for p in frames:
            f.write(f"file '{p.as_posix()}'\nduration {1 / fps:.6f}\n")
        f.write(f"file '{frames[-1].as_posix()}'\n")  # concat needs the last entry repeated
    try:
        run(
            [
                _bin("ffmpeg"), "-y", "-v", "error",
                "-f", "concat", "-safe", "0", "-i", str(list_file),
                "-i", str(audio),
                "-r", str(fps), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast",
                "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
                str(out),
            ]
        )
    finally:
        list_file.unlink(missing_ok=True)


def to_wav16k(src: Path, out: Path) -> None:
    """Mono 16 kHz WAV, the input Whisper/MuseTalk expects."""
    run([_bin("ffmpeg"), "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(out)])
