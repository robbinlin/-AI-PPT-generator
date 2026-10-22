import numpy as np
import pytest

from lvs_avatar import matting
from lvs_avatar.engines.passthrough import cycle_indices


def test_apply_composites_person_over_chroma_green():
    frame = np.full((4, 4, 3), 200, np.uint8)
    mask = np.zeros((4, 4), np.uint8)
    mask[1:3, 1:3] = 255
    out = matting.apply(frame, mask)
    assert tuple(out[0, 0]) == matting.CHROMA_BGR
    assert tuple(out[1, 1]) == (200, 200, 200)
    # a half-transparent edge blends
    mask[0, 0] = 128
    edge = matting.apply(frame, mask)[0, 0]
    assert 90 < edge[0] < 110 and 220 < edge[1] < 235


def test_apply_resizes_mismatched_mask():
    frame = np.zeros((8, 8, 3), np.uint8)
    mask = np.full((4, 4), 255, np.uint8)
    assert matting.apply(frame, mask).shape == frame.shape


def test_ensure_masks_is_off_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("LVS_AVATAR_MATTE", "0")
    assert matting.ensure_masks([tmp_path / "x.png"], tmp_path) is None


def test_cycle_indices_bounce():
    assert cycle_indices(1, 3) == [0, 0, 0]
    assert cycle_indices(3, 7) == [0, 1, 2, 1, 0, 1, 2]


@pytest.mark.skipif(not matting.available(), reason="rembg not installed")
def test_ensure_masks_caches_per_character(tmp_path):
    import cv2

    frames = []
    for i in range(2):
        img = np.full((64, 64, 3), 255, np.uint8)
        cv2.circle(img, (32, 32), 16, (30, 30, 30), -1)
        p = tmp_path / f"{i:08d}.png"
        cv2.imwrite(str(p), img)
        frames.append(p)
    masks = matting.ensure_masks(frames, tmp_path)
    assert masks and len(masks) == 2 and (tmp_path / "matte" / "done.json").is_file()
    again = matting.ensure_masks(frames, tmp_path)
    assert again == masks
