"""Engines turn (character frames, audio) into a talking-head mp4.

`select_engine()` picks MuseTalk when the vendored checkout and weights exist (or when forced),
otherwise the no-ML passthrough so the rest of the app can be exercised without a GPU.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Callable, Protocol

log = logging.getLogger("lvs_avatar")

Report = Callable[[float], None]


class Engine(Protocol):
    name: str
    device: str

    def models_ready(self) -> bool: ...

    def render(self, frames: list[Path], audio: Path, out: Path, work_dir: Path, report: Report, character_dir: Path) -> Path: ...


def vendor_dir() -> Path:
    env = os.environ.get("LVS_MUSETALK_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "vendor" / "MuseTalk"


def musetalk_available(vendor: Path) -> bool:
    if not ((vendor / "musetalk").is_dir() and (vendor / "models" / "musetalkV15" / "unet.pth").is_file()):
        return False
    try:
        import torch  # noqa: F401  (installed by install.ps1 / install.sh, not by the service's own deps)
    except ImportError:
        log.warning("MuseTalk checkout found but torch is missing in this Python; run the install script")
        return False
    return True


def select_engine() -> Engine:
    from .passthrough import PassthroughEngine

    forced = os.environ.get("LVS_AVATAR_ENGINE", "").strip().lower()
    vendor = vendor_dir()
    if forced == "passthrough":
        log.warning("LVS_AVATAR_ENGINE=passthrough: clips will NOT be lip-synced (frames are just looped)")
        return PassthroughEngine()
    if forced in ("", "musetalk") and musetalk_available(vendor):
        from .musetalk import MuseTalkEngine

        return MuseTalkEngine(vendor)
    if forced == "musetalk":
        raise RuntimeError(f"LVS_AVATAR_ENGINE=musetalk but MuseTalk is not installed under {vendor}; run install.ps1 / install.sh")
    log.warning("MuseTalk not installed under %s; falling back to passthrough (NO lip sync). Run install.ps1 / install.sh.", vendor)
    return PassthroughEngine()
