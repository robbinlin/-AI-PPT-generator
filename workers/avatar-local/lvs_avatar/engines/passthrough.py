"""No-ML engine: loops the character's frames forward/backward for the audio length and muxes the audio."""

from __future__ import annotations

import math
from pathlib import Path

from .. import ffmpeg
from . import Report


def cycle_frames(frames: list[Path], count: int) -> list[Path]:
    """Forward then backward, like MuseTalk's realtime mode, so loops never jump."""
    if len(frames) == 1:
        return [frames[0]] * count
    cycle = frames + frames[-2:0:-1]
    return [cycle[i % len(cycle)] for i in range(count)]


class PassthroughEngine:
    name = "passthrough"
    device = "cpu"

    def models_ready(self) -> bool:
        return True

    def render(self, frames: list[Path], audio: Path, out: Path, work_dir: Path, report: Report, character_dir: Path) -> Path:
        report(0.05)
        duration = ffmpeg.probe_duration(audio)
        count = max(1, math.ceil(duration * ffmpeg.FPS))
        report(0.2)
        ffmpeg.frames_to_video(cycle_frames(frames, count), audio, out)
        report(1.0)
        return out
