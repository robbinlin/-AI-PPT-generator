"""Per-frame person mattes so the avatar is composited onto chroma green.

MuseTalk only repaints the mouth, so the generated clip keeps the character's own backdrop
(office wall, living room). The render worker chroma-keys HeyGen clips; to give local
avatars the same clean cut-out we matte the character's source frames once (rembg,
`u2net_human_seg`), cache the masks next to the character, and composite every generated
frame onto pure green. Disable with LVS_AVATAR_MATTE=0.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np

log = logging.getLogger("lvs_avatar")

CHROMA_BGR = (0, 255, 0)  # must match CHROMA_KEY_BY_PROVIDER["local"] in the API
FEATHER_PX = 3
Report = Callable[[float], None]

_session = None


def enabled() -> bool:
    return os.environ.get("LVS_AVATAR_MATTE", "1").strip().lower() not in ("0", "false", "no")


def available() -> bool:
    try:
        import rembg  # noqa: F401

        return True
    except Exception:
        return False


def model_name() -> str:
    return os.environ.get("LVS_AVATAR_MATTE_MODEL", "u2net_human_seg")


def _get_session():
    global _session
    if _session is None:
        from rembg import new_session

        _session = new_session(model_name())
        log.info("matting model %s ready", model_name())
    return _session


def mask_dir(character_dir: Path) -> Path:
    return character_dir / "matte"


def ensure_masks(frames: list[Path], character_dir: Path, report: Optional[Report] = None) -> Optional[list[Path]]:
    """Mask PNGs (one per source frame, same order), computed once per character; None when matting is off."""
    if not enabled() or not available() or not frames:
        return None
    out = mask_dir(character_dir)
    done = out / "done.json"
    if done.is_file():
        try:
            meta = json.loads(done.read_text("utf-8"))
            masks = sorted(out.glob("*.png"))
            if meta.get("count") == len(frames) == len(masks) and meta.get("model") == model_name():
                return masks
        except Exception:
            pass
    from rembg import remove

    session = _get_session()
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.png"):
        old.unlink()
    masks: list[Path] = []
    for i, f in enumerate(frames):
        bgr = cv2.imread(str(f))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        mask = remove(rgb, session=session, only_mask=True)
        mask = np.asarray(mask)
        if mask.ndim == 3:
            mask = mask[..., 0]
        if FEATHER_PX:
            k = FEATHER_PX * 2 + 1
            mask = cv2.GaussianBlur(mask, (k, k), 0)
        p = out / f"{i:08d}.png"
        cv2.imwrite(str(p), mask)
        masks.append(p)
        if report:
            report((i + 1) / len(frames))
    done.write_text(json.dumps({"count": len(frames), "model": model_name()}), "utf-8")
    return masks


def load_masks(paths: list[Path]) -> list[np.ndarray]:
    return [cv2.imread(str(p), cv2.IMREAD_GRAYSCALE) for p in paths]


def apply(frame_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Composite the person (mask) over chroma green; the renderer keys the green out."""
    if mask.shape[:2] != frame_bgr.shape[:2]:
        mask = cv2.resize(mask, (frame_bgr.shape[1], frame_bgr.shape[0]), interpolation=cv2.INTER_LINEAR)
    alpha = (mask.astype(np.float32) / 255.0)[..., None]
    green = np.empty_like(frame_bgr)
    green[:] = CHROMA_BGR
    out = frame_bgr.astype(np.float32) * alpha + green.astype(np.float32) * (1.0 - alpha)
    return out.astype(np.uint8)
