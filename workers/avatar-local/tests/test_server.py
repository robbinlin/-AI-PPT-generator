"""Contract tests against the passthrough engine (no GPU, no model weights)."""

import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

os.environ["LVS_AVATAR_ENGINE"] = "passthrough"

from fastapi.testclient import TestClient  # noqa: E402

from lvs_avatar.server import create_app  # noqa: E402


def make_wav(path: Path, seconds: float = 2.0) -> None:
    sr = 16000
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sf.write(path, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr)


def make_image(path: Path) -> None:
    import cv2

    img = np.full((360, 640, 3), (40, 80, 160), np.uint8)
    cv2.circle(img, (320, 180), 90, (200, 200, 230), -1)
    cv2.imwrite(str(path), img)


def make_video(path: Path, seconds: float = 1.0) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=25:duration={seconds}", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )


def probe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return float(json.loads(out.stdout)["format"]["duration"])


@pytest.fixture()
def client(tmp_path: Path):
    return TestClient(create_app(tmp_path / "data"))


def wait_task(client: TestClient, tid: str, timeout: float = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/tasks/{tid}").json()
        if body["status"] in ("succeeded", "failed", "cancelled"):
            return body
        time.sleep(0.2)
    raise AssertionError("task did not finish")


def test_health(client: TestClient):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["engine"] == "passthrough"
    assert body["modelsReady"] is True


def test_character_from_image_and_task(client: TestClient, tmp_path: Path):
    img, wav = tmp_path / "face.png", tmp_path / "a.wav"
    make_image(img)
    make_wav(wav, 2.0)
    r = client.post("/characters", files={"file": ("face.png", img.read_bytes(), "image/png")}, data={"name": "測試老師"})
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["name"] == "測試老師" and c["kind"] == "personal" and c["sourceKind"] == "image" and c["ready"] is True
    assert client.get(c["previewImageUrl"]).headers["content-type"] == "image/jpeg"
    assert [x["id"] for x in client.get("/characters").json()] == [c["id"]]

    r = client.post("/tasks", files={"audio": ("a.wav", wav.read_bytes(), "audio/wav")}, data={"characterId": c["id"]})
    assert r.status_code == 202, r.text
    tid = r.json()["taskId"]
    done = wait_task(client, tid)
    assert done["status"] == "succeeded", done
    assert done["resultUrl"] == f"/tasks/{tid}/result"
    assert abs(done["durationSec"] - 2.0) < 0.15
    mp4 = client.get(done["resultUrl"])
    assert mp4.status_code == 200 and mp4.headers["content-type"] == "video/mp4"
    out = tmp_path / "out.mp4"
    out.write_bytes(mp4.content)
    assert abs(probe_duration(out) - 2.0) < 0.15
    streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", str(out)], capture_output=True, text=True, check=True)
    codecs = {s["codec_type"]: s["codec_name"] for s in json.loads(streams.stdout)["streams"]}
    assert codecs == {"video": "h264", "audio": "aac"}

    assert client.delete(f"/characters/{c['id']}").status_code == 204
    assert client.get("/characters").json() == []


def test_character_from_video(client: TestClient, tmp_path: Path):
    vid, wav = tmp_path / "clip.mp4", tmp_path / "a.wav"
    make_video(vid, 1.0)
    make_wav(wav, 1.5)
    c = client.post("/characters", files={"file": ("clip.mp4", vid.read_bytes(), "video/mp4")}).json()
    assert c["sourceKind"] == "video" and c["name"] == "clip"
    tid = client.post("/tasks", files={"audio": ("a.wav", wav.read_bytes(), "audio/wav")}, data={"characterId": c["id"]}).json()["taskId"]
    done = wait_task(client, tid)
    assert done["status"] == "succeeded", done
    assert abs(done["durationSec"] - 1.5) < 0.15


def test_errors(client: TestClient, tmp_path: Path):
    r = client.post("/characters", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_media_type"
    r = client.post("/tasks", files={"audio": ("a.wav", b"xx", "audio/wav")}, data={"characterId": "nope"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert client.get("/tasks/nope").status_code == 404
    assert client.delete("/characters/nope").status_code == 404
