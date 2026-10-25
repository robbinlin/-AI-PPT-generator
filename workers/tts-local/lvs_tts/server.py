"""HTTP surface of the local TTS worker. See README.md for the contract."""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import __version__, ffmpeg, whisper_align
from .engine_client import DISPLAY_NAMES, ENGINE_IDS, NATIVE_SPEED, NOTES, EngineManager, detect_device, is_installed
from .store import ResultStore, VoiceStore, default_data_dir

log = logging.getLogger("lvs_tts")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Engines whose text front-ends were trained on simplified Chinese. Only the text sent to the
# engine is converted; the caller's traditional text is what subtitles are built from.
NEEDS_SIMPLIFIED = {"cosyvoice2", "gptsovits"}
# Engines that reject references longer than N seconds get a shortened clip + matching prompt text.
MAX_REF_SECONDS: dict[str, float] = {"gptsovits": 9.5}


class RenameVoiceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    voiceId: str
    engine: str
    language: str = "zh-TW"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    timestamps: bool = True


def _to_simplified(text: str) -> str:
    try:
        from opencc import OpenCC

        return OpenCC("t2s").convert(text)
    except Exception as e:  # pragma: no cover - opencc missing
        log.warning("opencc unavailable (%s); sending traditional text as-is", e)
        return text


def create_app(data_dir: Optional[Path] = None) -> FastAPI:
    root = data_dir or default_data_dir()
    root.mkdir(parents=True, exist_ok=True)
    device = detect_device()
    engines = EngineManager(device)

    def transcribe_clip(wav16k: Path, language: str) -> str:
        if not whisper_align.available():
            return ""
        return whisper_align.transcribe(wav16k, "en" if language == "en" else "zh")

    voices = VoiceStore(root, transcribe_clip)
    results = ResultStore(root)
    synth_lock = threading.Lock()  # engines are not re-entrant; one synthesis at a time
    allowed_engines = set(ENGINE_IDS) | ({"mock"} if os.environ.get("LVS_TTS_ENGINE") == "mock" or os.environ.get("LVS_TTS_ALLOW_MOCK") else set())

    app = FastAPI(title="LVS local TTS worker", version=__version__)
    log.info("device=%s data=%s engines=%s", device, root, {e: is_installed(e) for e in ENGINE_IDS})

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        detail = exc.detail
        if isinstance(detail, dict) and "code" in detail:
            return JSONResponse(status_code=exc.status_code, content={"error": detail})
        code = {400: "bad_request", 404: "not_found", 409: "conflict", 415: "unsupported_media_type"}.get(exc.status_code, "error")
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": code, "message": str(detail)}})

    @app.exception_handler(Exception)
    async def any_error(_: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse(status_code=500, content={"error": {"code": "internal", "message": str(exc)[:1500]}})

    @app.on_event("shutdown")
    def _shutdown():
        engines.shutdown()

    @app.get("/health")
    def health():
        return {"ok": True, "device": device, "engines": engines.status(), "whisper": whisper_align.available(), "version": __version__}

    @app.get("/engines")
    def list_engines():
        return [{"id": e, "displayName": DISPLAY_NAMES[e], "installed": is_installed(e), "notes": NOTES[e]} for e in ENGINE_IDS]

    @app.post("/engines/unload")
    def unload_engine():
        """Stop the loaded engine (frees GPU memory, e.g. before training); the next synthesis starts it again."""
        with synth_lock:
            engines.shutdown()
        return {"ok": True}

    @app.get("/voices")
    def list_voices():
        return [v.to_json() for v in voices.list()]

    @app.post("/voices", status_code=201)
    async def create_voice(file: UploadFile = File(...), name: Optional[str] = Form(None), transcript: Optional[str] = Form(None)):
        data = await file.read()
        if not data:
            raise HTTPException(400, "empty file")
        given = (transcript or "").strip()

        def transcribe(wav16k: Path) -> str:
            return given or whisper_align.transcribe(wav16k)

        try:
            return voices.create(file.filename or "upload", data, name, transcribe).to_json()
        except ValueError as e:
            raise HTTPException(415, str(e))
        except RuntimeError as e:
            raise HTTPException(400, str(e))

    @app.get("/voices/{vid}/sample.wav")
    def voice_sample(vid: str):
        p = voices.sample(vid)
        if not p.is_file():
            raise HTTPException(404, f"voice {vid} not found")
        return FileResponse(p, media_type="audio/wav")

    @app.patch("/voices/{vid}")
    def rename_voice(vid: str, body: RenameVoiceRequest):
        v = voices.rename(vid, body.name)
        if not v:
            raise HTTPException(404, f"voice {vid} not found")
        return v.to_json()

    @app.delete("/voices/{vid}", status_code=204)
    def delete_voice(vid: str):
        if not voices.delete(vid):
            raise HTTPException(404, f"voice {vid} not found")
        return Response(status_code=204)

    @app.post("/synthesize")
    def synthesize(req: SynthesizeRequest):
        if req.engine not in allowed_engines:
            raise HTTPException(400, {"code": "bad_request", "message": f"unknown engine {req.engine}; use one of {sorted(ENGINE_IDS)}"})
        if not is_installed(req.engine):
            raise HTTPException(400, {"code": "engine_not_installed", "message": f"engine {req.engine} is not installed; run install with -Engines {req.engine}"})
        voice = voices.get(req.voiceId)
        if not voice:
            raise HTTPException(404, f"voice {req.voiceId} not found")
        text = req.text.strip()
        engine_text = _to_simplified(text) if req.engine in NEEDS_SIMPLIFIED else text
        lang = {"zh-TW": "zh", "en": "en", "mixed": "mixed"}.get(req.language, "zh")
        sid = results.new_id()
        final = results.path(sid)
        raw = final.with_name(f"{sid}.raw.wav")
        native_speed = req.engine in NATIVE_SPEED or req.engine == "mock"
        with synth_lock:
            proc = engines.get(req.engine)
            ref_wav, ref_text = voices.reference_for(voice, MAX_REF_SECONDS.get(req.engine))
            if req.engine in NEEDS_SIMPLIFIED:
                ref_text = _to_simplified(ref_text)
            out = proc.synthesize(engine_text, ref_wav, ref_text, lang, req.speed if native_speed else 1.0, raw, voices.model_weights(voice, req.engine))
        # Normalise every engine's output to 24 kHz mono 16-bit, stretching if the engine has no speed control.
        if not native_speed and abs(req.speed - 1.0) > 1e-3:
            stretched = final.with_name(f"{sid}.tempo.wav")
            ffmpeg.change_tempo(out.wav_path, stretched, req.speed)
            ffmpeg.to_wav(stretched, final, rate=24000)
            stretched.unlink(missing_ok=True)
        else:
            ffmpeg.to_wav(out.wav_path, final, rate=24000)
        if out.wav_path != final:
            out.wav_path.unlink(missing_ok=True)
        results.prune()
        duration = ffmpeg.probe_duration(final)
        timestamps = None
        if req.timestamps and whisper_align.available():
            try:
                timestamps = whisper_align.word_timestamps(final, text, "zh" if lang != "en" else "en")
            except Exception as e:
                log.warning("whisper alignment failed: %s", e)
        return {"id": sid, "durationSec": round(duration, 3), "audioUrl": f"/synth/{sid}.wav", "sampleRate": 24000, "timestamps": timestamps}

    @app.get("/synth/{sid}.wav")
    def get_synth(sid: str):
        p = results.path(sid)
        if not p.is_file():
            raise HTTPException(404, f"result {sid} not found")
        return FileResponse(p, media_type="audio/wav", filename=f"{sid}.wav")

    return app
