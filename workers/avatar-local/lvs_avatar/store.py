"""Characters on disk and the in-memory task queue (one worker thread, one task at a time)."""

from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from . import ffmpeg

log = logging.getLogger("lvs_avatar")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi"}


def default_data_dir() -> Path:
    env = os.environ.get("LVS_AVATAR_DATA")
    if env:
        return Path(env)
    repo = Path(__file__).resolve().parents[3]  # <repo>/workers/avatar-local/lvs_avatar/store.py
    return repo / "data" / "avatar-local"


# ------------------------------------------------------------------ characters --


@dataclass
class Character:
    id: str
    name: str
    source_kind: str  # "image" | "video"
    frame_count: int
    width: int
    height: int
    ready: bool = True

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": "personal",
            "previewImageUrl": f"/characters/{self.id}/preview.jpg",
            "ready": self.ready,
            "sourceKind": self.source_kind,
        }


class CharacterStore:
    def __init__(self, root: Path):
        self.root = root / "characters"
        self.root.mkdir(parents=True, exist_ok=True)

    def dir(self, cid: str) -> Path:
        return self.root / cid

    def frames_dir(self, cid: str) -> Path:
        return self.dir(cid) / "frames"

    def list(self) -> list[Character]:
        out = []
        for d in sorted(self.root.iterdir()):
            c = self.get(d.name)
            if c:
                out.append(c)
        return out

    def get(self, cid: str) -> Optional[Character]:
        meta = self.dir(cid) / "character.json"
        if not meta.is_file():
            return None
        return Character(**json.loads(meta.read_text("utf-8")))

    def frames(self, cid: str) -> list[Path]:
        return sorted(self.frames_dir(cid).glob("*.png"))

    def create(self, filename: str, data: bytes, name: Optional[str]) -> Character:
        ext = Path(filename).suffix.lower()
        if ext in IMAGE_EXT:
            kind = "image"
        elif ext in VIDEO_EXT:
            kind = "video"
        else:
            raise ValueError(f"unsupported file type {ext or '(none)'}; use jpg/png or mp4/mov")
        cid = uuid.uuid4().hex[:12]
        d = self.dir(cid)
        d.mkdir(parents=True)
        try:
            src = d / f"source{ext}"
            src.write_bytes(data)
            frames = ffmpeg.extract_frames(src, self.frames_dir(cid)) if kind == "video" else ffmpeg.image_to_frame(src, self.frames_dir(cid))
            ffmpeg.make_preview(frames[0], d / "preview.jpg")
            import cv2  # local import keeps module import light

            h, w = cv2.imread(str(frames[0])).shape[:2]
            c = Character(id=cid, name=(name or Path(filename).stem or cid).strip()[:80], source_kind=kind, frame_count=len(frames), width=w, height=h)
            (d / "character.json").write_text(json.dumps(c.__dict__, ensure_ascii=False, indent=2), "utf-8")
            return c
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise

    def delete(self, cid: str) -> bool:
        d = self.dir(cid)
        if not d.is_dir():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True


# ----------------------------------------------------------------------- tasks --


@dataclass
class Task:
    id: str
    character_id: str
    audio_path: Path
    out_dir: Path
    status: str = "queued"  # queued | processing | succeeded | failed | cancelled
    progress: float = 0.0
    error: Optional[str] = None
    duration_sec: Optional[float] = None
    created_at: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def result_path(self) -> Path:
        return self.out_dir / "result.mp4"

    def to_json(self) -> dict:
        return {
            "taskId": self.id,
            "status": self.status,
            "progress": round(self.progress, 3),
            "error": self.error,
            "durationSec": self.duration_sec,
            "resultUrl": f"/tasks/{self.id}/result" if self.status == "succeeded" else None,
        }


RunFn = Callable[[Task, list[Path], Callable[[float], None]], Path]


class TaskQueue:
    """Single background worker: `run(task, frames, report)` must write task.result_path and return it."""

    def __init__(self, root: Path, run: RunFn, characters: CharacterStore):
        self.root = root / "tasks"
        self.root.mkdir(parents=True, exist_ok=True)
        self.run = run
        self.characters = characters
        self.tasks: dict[str, Task] = {}
        self.lock = threading.Lock()
        self.q: "queue.Queue[str]" = queue.Queue()
        self.thread = threading.Thread(target=self._loop, name="avatar-worker", daemon=True)
        self.thread.start()

    def submit(self, character_id: str, audio_filename: str, audio: bytes) -> Task:
        tid = uuid.uuid4().hex[:12]
        d = self.root / tid
        d.mkdir(parents=True)
        audio_path = d / ("audio" + (Path(audio_filename).suffix.lower() or ".bin"))
        audio_path.write_bytes(audio)
        task = Task(id=tid, character_id=character_id, audio_path=audio_path, out_dir=d)
        with self.lock:
            self.tasks[tid] = task
        self.q.put(tid)
        return task

    def get(self, tid: str) -> Optional[Task]:
        with self.lock:
            return self.tasks.get(tid)

    def cancel(self, tid: str) -> bool:
        task = self.get(tid)
        if not task:
            return False
        if task.status == "queued":
            task.status = "cancelled"
        task.cancel.set()
        return True

    def _loop(self) -> None:
        while True:
            tid = self.q.get()
            task = self.get(tid)
            if not task or task.status != "queued":
                continue
            task.status = "processing"
            try:
                frames = self.characters.frames(task.character_id)
                if not frames:
                    raise ValueError(f"character {task.character_id} not found")

                def report(p: float) -> None:
                    task.progress = max(0.0, min(1.0, p))
                    if task.cancel.is_set():
                        raise InterruptedError("cancelled")

                t0 = time.time()
                out = self.run(task, frames, report)
                task.duration_sec = round(ffmpeg.probe_duration(out), 3)
                task.progress = 1.0
                task.status = "succeeded"
                log.info("task %s done in %.1fs (%.1fs of video)", tid, time.time() - t0, task.duration_sec)
            except InterruptedError:
                task.status = "cancelled"
                log.info("task %s cancelled", tid)
            except Exception as e:  # noqa: BLE001 - surface every failure to the caller
                task.status = "failed"
                task.error = str(e)[:1000]
                log.exception("task %s failed", tid)
