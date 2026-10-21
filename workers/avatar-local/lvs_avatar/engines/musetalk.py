"""MuseTalk v1.5 engine (https://github.com/TMElyralab/MuseTalk, MIT).

Re-implements the `Avatar` flow of MuseTalk's `scripts/realtime_inference.py` with injected
models, checked ffmpeg calls, per-character caching of the prepared material and a progress
callback. Models load lazily on the first task so the server starts instantly.
"""

from __future__ import annotations

import copy
import glob
import logging
import os
import pickle
import shutil
import sys
import threading
from pathlib import Path

import cv2
import numpy as np

from .. import ffmpeg
from . import Report

log = logging.getLogger("lvs_avatar")

# MuseTalk defaults (realtime_inference.py argparse)
VERSION = "v15"
EXTRA_MARGIN = 10
PARSING_MODE = "jaw"
LEFT_CHEEK = 90
RIGHT_CHEEK = 90
AUDIO_PAD_LEFT = 2
AUDIO_PAD_RIGHT = 2


class MuseTalkEngine:
    name = "musetalk"

    def __init__(self, vendor: Path):
        self.vendor = vendor
        self.device = self._pick_device()
        self._models = None
        self._mods: dict = {}
        self._lock = threading.Lock()
        if str(vendor) not in sys.path:
            sys.path.insert(0, str(vendor))

    @staticmethod
    def _pick_device() -> str:
        forced = os.environ.get("LVS_AVATAR_DEVICE", "").strip().lower()
        if forced in ("cuda", "cpu"):
            return forced
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # torch missing: /health will say so once a task runs
            return "cpu"

    def models_ready(self) -> bool:
        return self._models is not None

    # ------------------------------------------------------------------ models --

    def _load(self):
        with self._lock:
            if self._models:
                return self._models
            import torch
            from transformers import WhisperModel

            cwd = os.getcwd()
            # MuseTalk resolves ./models and its DWPose config relative to cwd, and
            # preprocessing.py loads DWPose at import time, so import everything from inside the checkout.
            os.chdir(self.vendor)
            try:
                for extra in (str(self.vendor), str(self.vendor / "musetalk" / "utils")):
                    if extra not in sys.path:
                        sys.path.insert(0, extra)
                from musetalk.utils import blending, preprocessing, utils as mt_utils
                from musetalk.utils.audio_processor import AudioProcessor
                from musetalk.utils.face_parsing import FaceParsing

                load_all_model = mt_utils.load_all_model
                self._mods = dict(blending=blending, preprocessing=preprocessing, utils=mt_utils)
                models = self.vendor / "models"
                device = torch.device(self.device if self.device == "cpu" else "cuda:0")
                vae, unet, pe = load_all_model(
                    unet_model_path=str(models / "musetalkV15" / "unet.pth"),
                    vae_type="sd-vae",
                    unet_config=str(models / "musetalkV15" / "musetalk.json"),
                    device=device,
                )
                # Upstream casts to half unconditionally; fp16 only makes sense on CUDA.
                if self.device == "cuda":
                    pe = pe.half()
                    vae.vae = vae.vae.half()
                    unet.model = unet.model.half()
                else:
                    pe = pe.float()
                    vae.vae = vae.vae.float()
                    unet.model = unet.model.float()
                weight_dtype = unet.model.dtype
                whisper_dir = str(models / "whisper")
                audio_processor = AudioProcessor(feature_extractor_path=whisper_dir)
                whisper = WhisperModel.from_pretrained(whisper_dir).to(device=device, dtype=weight_dtype).eval()
                whisper.requires_grad_(False)
                fp = FaceParsing(left_cheek_width=LEFT_CHEEK, right_cheek_width=RIGHT_CHEEK)
            finally:
                os.chdir(cwd)
            self._models = dict(vae=vae, unet=unet, pe=pe, whisper=whisper, audio_processor=audio_processor, fp=fp, device=device, dtype=weight_dtype, timesteps=torch.tensor([0], device=device))
            log.info("MuseTalk models loaded on %s (%s)", self.device, weight_dtype)
            return self._models

    # ------------------------------------------------------------- preparation --

    def _prepare(self, frames: list[Path], cache: Path, m: dict, report: Report) -> dict:
        """Landmarks, crops, VAE latents and blending masks for the forward+backward frame cycle (cached)."""
        import torch

        get_image_prepare_material = self._mods["blending"].get_image_prepare_material
        get_landmark_and_bbox = self._mods["preprocessing"].get_landmark_and_bbox
        done = cache / "prepared.json"
        if done.is_file():
            frame_list = [cv2.imread(p) for p in sorted(glob.glob(str(cache / "full_imgs" / "*.png")))]
            masks = [cv2.imread(p) for p in sorted(glob.glob(str(cache / "mask" / "*.png")))]
            with open(cache / "coords.pkl", "rb") as f:
                coords = pickle.load(f)
            with open(cache / "mask_coords.pkl", "rb") as f:
                mask_coords = pickle.load(f)
            latents = torch.load(cache / "latents.pt", map_location="cpu")
            return dict(frames=frame_list, coords=coords, latents=latents, masks=masks, mask_coords=mask_coords)

        shutil.rmtree(cache, ignore_errors=True)
        (cache / "full_imgs").mkdir(parents=True)
        (cache / "mask").mkdir(parents=True)
        report(0.02)
        coord_list, frame_list = get_landmark_and_bbox([str(p) for p in frames], 0)
        placeholder = (0.0, 0.0, 0.0, 0.0)
        latents = []
        keep_coords, keep_frames = [], []
        for bbox, frame in zip(coord_list, frame_list):
            if bbox == placeholder:
                continue  # no face in this frame: drop it so coords and latents stay aligned
            x1, y1, x2, y2 = bbox
            y2 = min(y2 + EXTRA_MARGIN, frame.shape[0])
            crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
            latents.append(m["vae"].get_latents_for_unet(crop))
            keep_coords.append([x1, y1, x2, y2])
            keep_frames.append(frame)
        if not latents:
            raise ValueError("no face detected in the character source; use a clear, front-facing photo or video")
        frame_cycle = keep_frames + keep_frames[::-1]
        coord_cycle = keep_coords + keep_coords[::-1]
        latent_cycle = latents + latents[::-1]
        masks, mask_coords = [], []
        for i, frame in enumerate(frame_cycle):
            cv2.imwrite(str(cache / "full_imgs" / f"{i:08d}.png"), frame)
            mask, crop_box = get_image_prepare_material(frame, coord_cycle[i], fp=m["fp"], mode=PARSING_MODE)
            cv2.imwrite(str(cache / "mask" / f"{i:08d}.png"), mask)
            masks.append(mask)
            mask_coords.append(crop_box)
            report(0.02 + 0.13 * (i + 1) / len(frame_cycle))
        with open(cache / "coords.pkl", "wb") as f:
            pickle.dump(coord_cycle, f)
        with open(cache / "mask_coords.pkl", "wb") as f:
            pickle.dump(mask_coords, f)
        torch.save(latent_cycle, cache / "latents.pt")
        done.write_text("{}", "utf-8")
        return dict(frames=frame_cycle, coords=coord_cycle, latents=latent_cycle, masks=masks, mask_coords=mask_coords)

    # --------------------------------------------------------------- inference --

    def render(self, frames: list[Path], audio: Path, out: Path, work_dir: Path, report: Report, character_dir: Path) -> Path:
        import torch

        m = self._load()
        get_image_blending = self._mods["blending"].get_image_blending
        datagen = self._mods["utils"].datagen
        prep = self._prepare(frames, character_dir / "musetalk", m, report)
        wav = work_dir / "audio16k.wav"
        ffmpeg.to_wav16k(audio, wav)
        report(0.16)

        feats, librosa_len = m["audio_processor"].get_audio_feature(str(wav), weight_dtype=m["dtype"])
        chunks = m["audio_processor"].get_whisper_chunk(
            feats, m["device"], m["dtype"], m["whisper"], librosa_len,
            fps=ffmpeg.FPS, audio_padding_length_left=AUDIO_PAD_LEFT, audio_padding_length_right=AUDIO_PAD_RIGHT,
        )
        n = len(chunks)
        batch_size = int(os.environ.get("LVS_AVATAR_BATCH", "8" if self.device == "cuda" else "2"))
        tmp = work_dir / "frames"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        idx = 0
        total_batches = max(1, int(np.ceil(n / batch_size)))
        with torch.no_grad():
            for b, (whisper_batch, latent_batch) in enumerate(datagen(chunks, prep["latents"], batch_size, device=m["device"])):
                audio_feature = m["pe"](whisper_batch.to(m["device"]))
                latent_batch = latent_batch.to(device=m["device"], dtype=m["unet"].model.dtype)
                pred = m["unet"].model(latent_batch, m["timesteps"], encoder_hidden_states=audio_feature).sample
                recon = m["vae"].decode_latents(pred.to(device=m["device"], dtype=m["vae"].vae.dtype))
                for res in recon:
                    k = idx % len(prep["coords"])
                    x1, y1, x2, y2 = prep["coords"][k]
                    face = cv2.resize(res.astype(np.uint8), (x2 - x1, y2 - y1))
                    combined = get_image_blending(copy.deepcopy(prep["frames"][k]), face, prep["coords"][k], prep["masks"][k], prep["mask_coords"][k])
                    cv2.imwrite(str(tmp / f"{idx:08d}.png"), combined)
                    idx += 1
                report(0.16 + 0.8 * (b + 1) / total_batches)
        rendered = sorted(tmp.glob("*.png"))
        ffmpeg.frames_to_video(rendered, audio, out)
        shutil.rmtree(tmp, ignore_errors=True)
        report(1.0)
        return out
