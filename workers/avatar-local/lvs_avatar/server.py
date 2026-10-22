"""HTTP surface of the local avatar worker. See README.md for the contract."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from . import __version__, matting
from .engines import select_engine
from .store import CharacterStore, Task, TaskQueue, default_data_dir

log = logging.getLogger("lvs_avatar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app(data_dir: Optional[Path] = None) -> FastAPI:
    root = data_dir or default_data_dir()
    root.mkdir(parents=True, exist_ok=True)
    engine = select_engine()
    characters = CharacterStore(root)

    def run(task: Task, frames: list[Path], report) -> Path:
        return engine.render(frames, task.audio_path, task.result_path, task.out_dir, report, characters.dir(task.character_id))

    tasks = TaskQueue(root, run, characters)
    app = FastAPI(title="LVS local avatar worker", version=__version__)
    log.info("engine=%s device=%s data=%s", engine.name, engine.device, root)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        code = {400: "bad_request", 404: "not_found", 409: "conflict", 415: "unsupported_media_type"}.get(exc.status_code, "error")
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": code, "message": str(exc.detail)}})

    @app.exception_handler(Exception)
    async def any_error(_: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse(status_code=500, content={"error": {"code": "internal", "message": str(exc)[:500]}})

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "engine": engine.name,
            "device": engine.device,
            "modelsReady": engine.models_ready(),
            "matting": matting.enabled() and matting.available(),
            "version": __version__,
        }

    @app.get("/characters")
    def list_characters():
        return [c.to_json() for c in characters.list()]

    @app.post("/characters", status_code=201)
    async def create_character(file: UploadFile = File(...), name: Optional[str] = Form(None)):
        data = await file.read()
        if not data:
            raise HTTPException(400, "empty file")
        try:
            return characters.create(file.filename or "upload", data, name).to_json()
        except ValueError as e:
            raise HTTPException(415, str(e))
        except RuntimeError as e:
            raise HTTPException(400, str(e))

    @app.get("/characters/{cid}/preview.jpg")
    def preview(cid: str):
        p = characters.dir(cid) / "preview.jpg"
        if not p.is_file():
            raise HTTPException(404, f"character {cid} not found")
        return FileResponse(p, media_type="image/jpeg")

    @app.delete("/characters/{cid}", status_code=204)
    def delete_character(cid: str):
        if not characters.delete(cid):
            raise HTTPException(404, f"character {cid} not found")
        return Response(status_code=204)

    @app.post("/tasks", status_code=202)
    async def create_task(audio: UploadFile = File(...), characterId: str = Form(...)):
        if not characters.get(characterId):
            raise HTTPException(404, f"character {characterId} not found")
        data = await audio.read()
        if not data:
            raise HTTPException(400, "empty audio")
        task = tasks.submit(characterId, audio.filename or "audio.mp3", data)
        return {"taskId": task.id, "status": task.status}

    @app.get("/tasks/{tid}")
    def get_task(tid: str):
        task = tasks.get(tid)
        if not task:
            raise HTTPException(404, f"task {tid} not found")
        return task.to_json()

    @app.get("/tasks/{tid}/result")
    def get_result(tid: str):
        task = tasks.get(tid)
        if not task:
            raise HTTPException(404, f"task {tid} not found")
        if task.status != "succeeded" or not task.result_path.is_file():
            raise HTTPException(409, f"task {tid} is {task.status}")
        return FileResponse(task.result_path, media_type="video/mp4", filename=f"{tid}.mp4")

    @app.delete("/tasks/{tid}", status_code=204)
    def cancel_task(tid: str):
        if not tasks.cancel(tid):
            raise HTTPException(404, f"task {tid} not found")
        return Response(status_code=204)

    return app
