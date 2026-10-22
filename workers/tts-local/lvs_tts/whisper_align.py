"""faster-whisper: transcribe reference clips and align synthesized speech to its text."""

from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path
from typing import Optional

log = logging.getLogger("lvs_tts")

_lock = threading.Lock()
_model = None
_failed = False
_force_cpu = False
# A CUDA transcription that takes longer than this is treated as hung (missing cuDNN/cuBLAS on
# Windows makes CTranslate2 stall instead of failing); we then reload on CPU and retry once.
CUDA_TIMEOUT_SEC = float(os.environ.get("LVS_WHISPER_CUDA_TIMEOUT", "90"))


def available() -> bool:
    if _failed:
        return False
    try:
        import faster_whisper  # noqa: F401

        return True
    except Exception:
        return False


def _add_cuda_dlls() -> None:
    """On Windows, CTranslate2 needs cuBLAS/cuDNN DLLs on PATH; the pip wheels keep them in site-packages."""
    if os.name != "nt":
        return
    try:
        import nvidia  # type: ignore

        for base in nvidia.__path__:
            for sub in ("cublas", "cudnn", "cuda_runtime"):
                d = Path(base) / sub / "bin"
                if d.is_dir():
                    os.add_dll_directory(str(d))
                    os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        pass


def _load(cpu: bool = False):
    global _model, _failed
    with _lock:
        if _model is not None and not cpu:
            return _model
        if _failed:
            return None
        try:
            from faster_whisper import WhisperModel

            name = os.environ.get("LVS_WHISPER_MODEL", "small")
            device = os.environ.get("LVS_TTS_DEVICE") or "auto"
            cuda = not cpu and not _force_cpu and (device == "cuda" or (device == "auto" and _cuda_available()))
            if cuda:
                _add_cuda_dlls()
            try:
                _model = WhisperModel(name, device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
            except Exception as e:
                if not cuda:
                    raise
                log.warning("whisper could not start on cuda (%s); using cpu", e)
                cuda = False
                _model = WhisperModel(name, device="cpu", compute_type="int8")
            log.info("whisper %s loaded on %s", name, "cuda" if cuda else "cpu")
        except Exception as e:  # model missing / no network / no ctranslate2 build
            log.warning("whisper unavailable: %s", e)
            _failed = True
        return _model


def _on_cuda() -> bool:
    try:
        return _model is not None and _model.model.device == "cuda"
    except Exception:
        return False


def _run(fn):
    """Run `fn(model)`; if the CUDA model hangs or errors, switch to CPU once and retry."""
    global _force_cpu
    model = _load()
    if model is None:
        return None
    if not _on_cuda():
        return fn(model)
    result: dict = {}

    def worker():
        try:
            result["value"] = fn(model)
        except Exception as e:  # CTranslate2 raises RuntimeError on CUDA/cuDNN problems
            result["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(CUDA_TIMEOUT_SEC)
    if not t.is_alive() and "error" not in result:
        return result["value"]
    why = "timed out" if t.is_alive() else f"failed: {result['error']}"
    log.warning("whisper on cuda %s; falling back to cpu (install nvidia-cublas-cu12 / nvidia-cudnn-cu12 for GPU Whisper)", why)
    _force_cpu = True
    cpu_model = _load(cpu=True)
    if cpu_model is None:
        raise RuntimeError(f"whisper on cuda {why} and the cpu fallback could not load")
    return fn(cpu_model)


def _cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


ZH_PROMPT = "以下是繁體中文的課程旁白。"


def transcribe(wav16k: Path, language: Optional[str] = "zh") -> str:
    """Transcript of a reference clip. Chinese comes back as Taiwanese traditional characters."""
    def go(model):
        segments, _info = model.transcribe(
            str(wav16k), language=language, beam_size=5, vad_filter=False, initial_prompt=ZH_PROMPT if language == "zh" else None
        )
        return "".join(s.text for s in segments).strip()

    text = _run(go)
    return to_traditional(text) if text else ""


def to_traditional(text: str) -> str:
    """Whisper writes simplified Chinese; the app (and the user's subtitles) are Taiwanese traditional."""
    if not any(_is_cjk(c) for c in text):
        return text
    try:
        from opencc import OpenCC

        return OpenCC("s2twp").convert(text)
    except Exception:
        return text


def _is_cjk(ch: str) -> bool:
    return "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿"


def word_timestamps(wav: Path, text_hint: str, language: Optional[str] = None) -> Optional[list[dict]]:
    """Per-character (CJK) / per-word (Latin) timings of the speech in `wav`.

    Whisper's own words are used for timing; CJK words are split into characters with the span
    divided evenly, so subtitles can be cut anywhere in a sentence.
    """
    lang = language or ("zh" if any(_is_cjk(c) for c in text_hint) else None)
    # The traditional prompt biases Whisper's script; every token is converted again below so the
    # subtitle builder can match it against the traditional script character by character.
    prompt = (ZH_PROMPT + text_hint[:150]) if lang == "zh" else (text_hint[:200] or None)

    def go(model):
        segments, _ = model.transcribe(str(wav), language=lang, beam_size=5, word_timestamps=True, initial_prompt=prompt)
        return [(w.word, w.start, w.end) for seg in segments for w in (seg.words or [])]

    words = _run(go)
    if words is None:
        return None
    out: list[dict] = []
    for word, start, end in words:
        token = to_traditional(word.strip())
        if not token or not any(c.isalnum() or _is_cjk(c) for c in token):
            continue  # Whisper sometimes emits bare punctuation as a "word"
        chars = [c for c in token if not c.isspace()]
        if all(_is_cjk(c) or not c.isalnum() for c in chars) and any(_is_cjk(c) for c in chars):
            cjk = [c for c in chars if _is_cjk(c)]
            step = (end - start) / max(1, len(cjk))
            for i, c in enumerate(cjk):
                out.append({"text": c, "startSec": round(start + i * step, 3), "endSec": round(start + (i + 1) * step, 3)})
        else:
            clean = re.sub(r"^[\s\W_]+|[\s\W_]+$", "", token) or token
            out.append({"text": clean, "startSec": round(start, 3), "endSec": round(end, 3)})
    return out
