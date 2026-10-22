"""No-ML engine: loops the character's frames forward/backward for the audio length and muxes the audio."""

from __future__ import annotations

import math
import shutil
from pathlib import Path

import cv2

from .. import ffmpeg, matting
from . import Report


def cycle_indices(n: int, count: int) -> list[int]:
    """Forward then backward, like MuseTalk's realtime mode, so loops never jump."""
    if n == 1:
        return [0] * count
    cycle = list(range(n)) + list(range(n - 2, 0, -1))
    return [cycle[i % len(cycle)] for i in range(count)]


def cycle_frames(frames: list[Path], count: int) -> list[Path]:
    return [frames[i] for i in cycle_indices(len(frames), count)]


class PassthroughEngine:
    name = "passthrough"
    device = "cpu"

    def models_ready(self) -> bool:
        return True

    def render(self, frames: list[Path], audio: Path, out: Path, work_dir: Path, report: Report, character_dir: Path) -> Path:
        report(0.05)
        duration = ffmpeg.probe_duration(audio)
        count = max(1, math.ceil(duration * ffmpeg.FPS))
        masks = matting.ensure_masks(frames, character_dir, lambda f: report(0.05 + 0.4 * f))
        report(0.5)
        if masks:
            # Composite each (cycled) source frame onto chroma green once per distinct frame.
            tmp = work_dir / "frames"
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True)
            loaded = matting.load_masks(masks)
            keyed: dict[int, Path] = {}
            for i in set(cycle_indices(len(frames), count)):
                p = tmp / f"{i:08d}.png"
                cv2.imwrite(str(p), matting.apply(cv2.imread(str(frames[i])), loaded[i]))
                keyed[i] = p
            seq = [keyed[i] for i in cycle_indices(len(frames), count)]
            ffmpeg.frames_to_video(seq, audio, out)
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            ffmpeg.frames_to_video(cycle_frames(frames, count), audio, out)
        report(1.0)
        return out
