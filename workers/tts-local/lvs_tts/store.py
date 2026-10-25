"""Reference voices and synthesized results on disk."""

from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from difflib import SequenceMatcher
from typing import Callable, Optional

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


# Bump to rebuild every stored shortened reference (rev 1 took its prompt text from Whisper word
# timings over the whole clip, which can skip the first sentences: text and audio then disagreed).
SHORT_REF_REV = 2


def pick_cut(silences: list[tuple[float, float]], duration: float, limit: float = SHORT_REF_SECONDS) -> float:
    """Where a long reference clip ends: inside the last pause that starts between MIN_SECONDS and
    `limit` (never mid-word), else at `limit`."""
    if duration <= limit:
        return duration
    cut = None
    for start, end in silences:
        if MIN_SECONDS <= start < limit:
            cut = min(start + 0.15, end, limit)
    return round(cut if cut is not None else limit, 3)


def _spoken(c: str) -> bool:
    return c.isalnum()  # letters, digits and CJK characters; not punctuation or spaces


def matching_prefix(transcript: str, heard: str) -> Optional[str]:
    """The start of `transcript` that Whisper `heard` in the cut clip, or None when they disagree.

    The given transcript is kept (it is usually more accurate than Whisper) and ends where the heard
    text ends, plus the punctuation right after it.
    """
    keep = [(i, c.lower()) for i, c in enumerate(transcript) if _spoken(c)]
    t = "".join(c for _, c in keep)
    h = "".join(c.lower() for c in heard if _spoken(c))
    if not t or not h:
        return None
    blocks = [b for b in SequenceMatcher(None, t, h, autojunk=False).get_matching_blocks() if b.size]
    if not blocks or sum(b.size for b in blocks) < 0.6 * len(h) or blocks[0].a > 3:
        return None
    last = blocks[-1]
    end = min(len(t), last.a + last.size + (len(h) - (last.b + last.size)))
    if end >= len(t):
        return transcript.strip()
    idx = keep[end - 1][0] + 1
    while idx < len(transcript) and not _spoken(transcript[idx]) and not transcript[idx].isspace():
        idx += 1
    return transcript[:idx].strip()


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
    short_rev: int = 1
    # A model fine-tuned on this speaker (lvs_tts/train_voice.py): {"engine", "sovits", "gpt"?, "minutes"},
    # file names relative to the voice folder (no "gpt": the pretrained one). The reference clip above
    # is still the prompt.
    model: Optional[dict] = None

    def to_json(self) -> dict:
        out = {
            "id": self.id,
            "name": self.name,
            "durationSec": round(self.duration_sec, 3),
            "transcript": self.transcript,
            "language": self.language,
            "previewUrl": f"/voices/{self.id}/sample.wav",
        }
        if self.model:
            out["trained"] = {"engine": self.model["engine"], "minutes": self.model.get("minutes")}
        return out


class VoiceStore:
    """Each voice: sample.wav (24 kHz, for engines), sample16k.wav (for Whisper), voice.json."""

    def __init__(self, root: Path, transcribe_clip: Optional[Callable[[Path, str], str]] = None):
        self.root = root / "voices"
        self.root.mkdir(parents=True, exist_ok=True)
        # (16 kHz wav, voice language) -> transcript; None when Whisper is not available.
        self.transcribe_clip = transcribe_clip

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
        if not (short.is_file() and voice.transcript_short and voice.short_rev == SHORT_REF_REV):
            self._shorten(voice)  # voices from before rev 2 are rebuilt once, on first use
        return short, voice.transcript_short or voice.transcript

    def _shorten(self, voice: Voice) -> None:
        """Cut sample.wav at a pause before SHORT_REF_SECONDS and give it the text spoken in that part.

        The cut clip itself is transcribed, so the prompt text always matches the prompt audio; the
        given transcript is preferred where it agrees with what Whisper heard.
        """
        try:
            silences = ffmpeg.silences(self.sample16k(voice.id))
        except Exception as e:  # best effort: a cut at the limit still works
            log.warning("pause detection failed for %s: %s", voice.id, e)
            silences = []
        cut = pick_cut(silences, voice.duration_sec)
        ffmpeg.to_wav(self.sample(voice.id), self.short(voice.id), rate=24000, max_seconds=cut)
        text = None
        if self.transcribe_clip:
            clip16k = self.dir(voice.id) / "short16k.wav"
            try:
                ffmpeg.to_wav(self.sample16k(voice.id), clip16k, rate=16000, max_seconds=cut)
                heard = (self.transcribe_clip(clip16k, voice.language) or "").strip()
                if heard:
                    text = matching_prefix(voice.transcript, heard) or heard
            except Exception as e:
                log.warning("could not transcribe the shortened reference of %s: %s", voice.id, e)
            finally:
                clip16k.unlink(missing_ok=True)
        if not text:  # no Whisper: proportional share of the transcript
            text = voice.transcript[: max(1, int(len(voice.transcript) * cut / voice.duration_sec))]
        voice.short_duration_sec = cut
        voice.transcript_short = text
        voice.short_rev = SHORT_REF_REV
        self._save(voice)

    def _save(self, voice: Voice) -> None:
        (self.dir(voice.id) / "voice.json").write_text(json.dumps(voice.__dict__, ensure_ascii=False, indent=2), "utf-8")

    def attach_model(self, vid: str, engine: str, gpt: Optional[Path], sovits: Path, minutes: Optional[float] = None) -> Voice:
        """Store fine-tuned weights with the voice; synthesis with `engine` then uses them.

        `gpt` None keeps the engine's pretrained GPT (only SoVITS was fine-tuned)."""
        voice = self.get(vid)
        if not voice:
            raise LookupError(f"voice {vid} not found")
        files = {"sovits": f"{engine}-sovits{sovits.suffix}"}
        shutil.copyfile(sovits, self.dir(vid) / files["sovits"])
        if gpt:
            files["gpt"] = f"{engine}-gpt{gpt.suffix}"
            shutil.copyfile(gpt, self.dir(vid) / files["gpt"])
        voice.model = {"engine": engine, **files, "minutes": round(minutes, 1) if minutes else None}
        self._save(voice)
        return voice

    def model_weights(self, voice: Voice, engine: str) -> Optional[dict]:
        """Absolute paths of the voice's fine-tuned weights for `engine`, if it has them."""
        m = voice.model
        if not m or m.get("engine") != engine:
            return None
        paths = {k: self.dir(voice.id) / m[k] for k in ("gpt", "sovits") if m.get(k)}
        if "sovits" not in paths or not all(p.is_file() for p in paths.values()):
            log.warning("voice %s lists a %s model but its files are missing; using the pretrained one", voice.id, engine)
            return None
        return {k: str(p) for k, p in paths.items()}

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

    def create(self, filename: str, data: bytes, name: Optional[str], transcribe) -> Voice:
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
            self._save(voice)
            if duration > SHORT_REF_SECONDS:
                self._shorten(voice)
            return voice
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise

    def rename(self, vid: str, name: str) -> Optional[Voice]:
        voice = self.get(vid)
        if not voice:
            return None
        voice.name = name.strip()[:80] or voice.name
        self._save(voice)
        return voice

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
