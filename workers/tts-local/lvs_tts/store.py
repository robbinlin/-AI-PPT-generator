"""Reference voices and synthesized results on disk."""

from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import ffmpeg

log = logging.getLogger("lvs_tts")

AUDIO_EXT = {".wav", ".mp3", ".m4a", ".webm", ".ogg", ".flac", ".aac", ".mp4", ".opus"}
MIN_SECONDS = 3.0
MAX_SECONDS = 60.0
KEEP_RESULTS = 200


def default_data_dir() -> Path:
    env = os.environ.get("LVS_TTS_DATA")
    if env:
        return Path(env)
    repo = Path(__file__).resolve().parents[3]  # <repo>/workers/tts-local/lvs_tts/store.py
    return repo / "data" / "tts-local"


def detect_language(text: str) -> str:
    """'zh' / 'en' / 'mixed' from the script of a transcript."""
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    latin = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if cjk and latin:
        return "mixed"
    return "en" if latin and not cjk else "zh"


SHORT_REF_SECONDS = 9.5  # GPT-SoVITS rejects references outside 3–10 s


def short_cutoff(timestamps: Optional[list[dict]], duration: float, transcript: str, limit: float = SHORT_REF_SECONDS) -> tuple[float, str]:
    """Where to cut a long reference clip so the prompt text still matches the audio.

    Returns (seconds, transcript_of_that_part): the end of the last Whisper word that finishes
    before `limit`, or a proportional character cut when no timings are available.
    """
    if duration <= limit:
        return duration, transcript
    words = [w for w in (timestamps or []) if w.get("endSec", 0) <= limit and w.get("text")]
    if len(words) >= 3:
        cut = min(limit, words[-1]["endSec"] + 0.15)
        parts: list[str] = []
        for w in words:
            t = w["text"]
            if parts and t[:1].isascii() and parts[-1][-1:].isascii():
                parts.append(" ")
            parts.append(t)
        return round(cut, 3), "".join(parts)
    n = max(1, int(len(transcript) * limit / duration))
    return limit, transcript[:n]


@dataclass
class Voice:
    id: str
    name: str
    duration_sec: float
    transcript: str
    language: str
    # Shortened reference (≤ SHORT_REF_SECONDS) for engines with a 10 s cap; None when the clip is short enough.
    short_duration_sec: Optional[float] = None
    transcript_short: Optional[str] = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "durationSec": round(self.duration_sec, 3),
            "transcript": self.transcript,
            "language": self.language,
            "previewUrl": f"/voices/{self.id}/sample.wav",
        }


class VoiceStore:
    """Each voice: sample.wav (24 kHz, for engines), sample16k.wav (for Whisper), voice.json."""

    def __init__(self, root: Path):
        self.root = root / "voices"
        self.root.mkdir(parents=True, exist_ok=True)

    def dir(self, vid: str) -> Path:
        return self.root / vid

    def sample(self, vid: str) -> Path:
        return self.dir(vid) / "sample.wav"

    def sample16k(self, vid: str) -> Path:
        return self.dir(vid) / "sample16k.wav"

    def short(self, vid: str) -> Path:
        return self.dir(vid) / "short.wav"

    def reference_for(self, voice: Voice, max_seconds: Optional[float]) -> tuple[Path, str]:
        """(wav, prompt text) to hand an engine; shortened when the engine caps the reference length."""
        if not max_seconds or voice.duration_sec <= max_seconds:
            return self.sample(voice.id), voice.transcript
        short = self.short(voice.id)
        if short.is_file() and voice.transcript_short:
            return short, voice.transcript_short
        # Voices created before shortening existed: cut now, proportional transcript.
        cut, text = short_cutoff(None, voice.duration_sec, voice.transcript, max_seconds)
        ffmpeg.to_wav(self.sample(voice.id), short, rate=24000, max_seconds=cut)
        return short, text

    def list(self) -> list[Voice]:
        out = []
        for d in sorted(self.root.iterdir()):
            v = self.get(d.name)
            if v:
                out.append(v)
        return out

    def get(self, vid: str) -> Optional[Voice]:
        meta = self.dir(vid) / "voice.json"
        if not meta.is_file():
            return None
        return Voice(**json.loads(meta.read_text("utf-8")))

    def create(self, filename: str, data: bytes, name: Optional[str], transcribe, align=None) -> Voice:
        ext = Path(filename).suffix.lower()
        if ext not in AUDIO_EXT:
            raise ValueError(f"unsupported file type {ext or '(none)'}; use wav/mp3/m4a/webm")
        vid = uuid.uuid4().hex[:12]
        d = self.dir(vid)
        d.mkdir(parents=True)
        try:
            src = d / f"source{ext}"
            src.write_bytes(data)
            duration = ffmpeg.probe_duration(src)
            if duration < MIN_SECONDS:
                raise RuntimeError(f"reference clip is {duration:.1f}s; it must be at least {MIN_SECONDS:.0f}s")
            if duration > MAX_SECONDS:
                raise RuntimeError(f"reference clip is {duration:.1f}s; it must be at most {MAX_SECONDS:.0f}s")
            ffmpeg.to_wav(src, self.sample(vid), rate=24000)
            ffmpeg.to_wav(src, self.sample16k(vid), rate=16000)
            transcript = transcribe(self.sample16k(vid))
            if not transcript:
                raise RuntimeError("no transcript given and Whisper could not transcribe the clip; pass `transcript`")
            voice = Voice(
                id=vid,
                name=(name or Path(filename).stem or vid).strip()[:80],
                duration_sec=duration,
                transcript=transcript,
                language=detect_language(transcript),
            )
            if duration > SHORT_REF_SECONDS:
                timestamps = None
                if align:
                    try:
                        timestamps = align(self.sample16k(vid), transcript)
                    except Exception as e:  # alignment is best effort
                        log.warning("reference alignment failed: %s", e)
                cut, text = short_cutoff(timestamps, duration, transcript)
                ffmpeg.to_wav(src, self.short(vid), rate=24000, max_seconds=cut)
                voice.short_duration_sec = cut
                voice.transcript_short = text
            (d / "voice.json").write_text(json.dumps(voice.__dict__, ensure_ascii=False, indent=2), "utf-8")
            return voice
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise

    def delete(self, vid: str) -> bool:
        d = self.dir(vid)
        if not d.is_dir():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True


class ResultStore:
    """Synthesized clips (`synth/<id>.wav`); only the newest KEEP_RESULTS are kept."""

    def __init__(self, root: Path):
        self.root = root / "synth"
        self.root.mkdir(parents=True, exist_ok=True)

    def new_id(self) -> str:
        return uuid.uuid4().hex[:12]

    def path(self, sid: str) -> Path:
        return self.root / f"{sid}.wav"

    def prune(self) -> None:
        files = sorted(self.root.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[KEEP_RESULTS:]:
            old.unlink(missing_ok=True)
