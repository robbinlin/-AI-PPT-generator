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


def available() -> bool:
    if _failed:
        return False
    try:
        import faster_whisper  # noqa: F401

        return True
    except Exception:
        return False


def _load():
    global _model, _failed
    with _lock:
        if _model is not None or _failed:
            return _model
        try:
            from faster_whisper import WhisperModel

            name = os.environ.get("LVS_WHISPER_MODEL", "small")
            device = os.environ.get("LVS_TTS_DEVICE") or "auto"
            cuda = device == "cuda" or (device == "auto" and _cuda_available())
            _model = WhisperModel(name, device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
            log.info("whisper %s loaded on %s", name, "cuda" if cuda else "cpu")
        except Exception as e:  # model missing / no network / no ctranslate2 build
            log.warning("whisper unavailable: %s", e)
            _failed = True
        return _model


def _cuda_available() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


ZH_PROMPT = "以下是繁體中文的課程旁白。"


def transcribe(wav16k: Path, language: Optional[str] = "zh") -> str:
    """Transcript of a reference clip. Chinese comes back as Taiwanese traditional characters."""
    model = _load()
    if model is None:
        return ""
    segments, _info = model.transcribe(
        str(wav16k), language=language, beam_size=5, vad_filter=False, initial_prompt=ZH_PROMPT if language == "zh" else None
    )
    return to_traditional("".join(s.text for s in segments).strip())


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
    model = _load()
    if model is None:
        return None
    lang = language or ("zh" if any(_is_cjk(c) for c in text_hint) else None)
    # The traditional prompt biases Whisper's script; every token is converted again below so the
    # subtitle builder can match it against the traditional script character by character.
    prompt = (ZH_PROMPT + text_hint[:150]) if lang == "zh" else (text_hint[:200] or None)
    segments, _ = model.transcribe(str(wav), language=lang, beam_size=5, word_timestamps=True, initial_prompt=prompt)
    out: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            token = to_traditional(w.word.strip())
            if not token or not any(c.isalnum() or _is_cjk(c) for c in token):
                continue  # Whisper sometimes emits bare punctuation as a "word"
            chars = [c for c in token if not c.isspace()]
            if all(_is_cjk(c) or not c.isalnum() for c in chars) and any(_is_cjk(c) for c in chars):
                cjk = [c for c in chars if _is_cjk(c)]
                step = (w.end - w.start) / max(1, len(cjk))
                for i, c in enumerate(cjk):
                    out.append({"text": c, "startSec": round(w.start + i * step, 3), "endSec": round(w.start + (i + 1) * step, 3)})
            else:
                clean = re.sub(r"^[\s\W_]+|[\s\W_]+$", "", token) or token
                out.append({"text": clean, "startSec": round(w.start, 3), "endSec": round(w.end, 3)})
    return out
