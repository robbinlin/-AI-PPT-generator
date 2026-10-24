"""Contract tests with the mock engine (no models). Whisper is used when its weights are cached, else skipped."""

import os
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

import tempfile

os.environ["LVS_TTS_ENGINE"] = "mock"
os.environ["LVS_TTS_DEVICE"] = "cpu"
# No real engine is "installed" during tests, whatever the developer has set up locally.
os.environ["LVS_TTS_ENGINES_DIR"] = tempfile.mkdtemp(prefix="lvs-tts-no-engines-")

from fastapi.testclient import TestClient  # noqa: E402

from lvs_tts import whisper_align  # noqa: E402
from lvs_tts.server import create_app  # noqa: E402


def make_wav(path: Path, seconds: float, sr: int = 16000) -> None:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    sf.write(path, (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr)


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    app = create_app(tmp_path_factory.mktemp("tts-data"))
    with TestClient(app) as c:
        yield c


def test_health_and_engines(client):
    h = client.get("/health").json()
    assert h["ok"] and h["device"] in ("cuda", "cpu")
    assert set(h["engines"]) == {"cosyvoice2", "gptsovits", "fishspeech"}
    for st in h["engines"].values():
        assert {"installed", "ready"} <= set(st)
    engines = client.get("/engines").json()
    assert [e["displayName"] for e in engines] == ["CosyVoice 2", "GPT-SoVITS", "Fish Speech"]


def test_voice_lifecycle_and_synthesis(client, tmp_path):
    clip = tmp_path / "ref.wav"
    make_wav(clip, 4.0)
    short = tmp_path / "short.wav"
    make_wav(short, 1.0)

    # too short -> 400, wrong type -> 415
    with short.open("rb") as f:
        r = client.post("/voices", files={"file": ("short.wav", f, "audio/wav")}, data={"transcript": "x"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_request"
    r = client.post("/voices", files={"file": ("x.txt", b"nope", "text/plain")}, data={"transcript": "x"})
    assert r.status_code == 415

    with clip.open("rb") as f:
        r = client.post("/voices", files={"file": ("ref.wav", f, "audio/wav")}, data={"name": "我的聲音", "transcript": "各位同學好，今天我們要看訓練的影響。"})
    assert r.status_code == 201, r.text
    voice = r.json()
    assert voice["name"] == "我的聲音" and voice["language"] == "zh" and 3.9 < voice["durationSec"] < 4.1
    assert voice["previewUrl"] == f"/voices/{voice['id']}/sample.wav"
    assert client.get(voice["previewUrl"]).status_code == 200
    assert [v["id"] for v in client.get("/voices").json()] == [voice["id"]]
    r = client.patch(f"/voices/{voice['id']}", json={"name": "上課用的聲音"})
    assert r.status_code == 200 and r.json()["name"] == "上課用的聲音"
    assert client.get("/voices").json()[0]["name"] == "上課用的聲音"
    assert client.patch("/voices/nope", json={"name": "x"}).status_code == 404

    # unknown engine / not installed
    r = client.post("/synthesize", json={"text": "你好", "voiceId": voice["id"], "engine": "nope"})
    assert r.status_code == 400
    r = client.post("/synthesize", json={"text": "你好", "voiceId": voice["id"], "engine": "cosyvoice2"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "engine_not_installed"

    text = "各位同學好，今天我們要看高強度間歇訓練對最大攝氧量的影響。"
    r = client.post("/synthesize", json={"text": text, "voiceId": voice["id"], "engine": "mock", "language": "zh-TW", "speed": 1.0, "timestamps": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sampleRate"] == 24000 and body["audioUrl"] == f"/synth/{body['id']}.wav"
    wav = client.get(body["audioUrl"])
    assert wav.status_code == 200 and wav.headers["content-type"].startswith("audio/wav")
    out = tmp_path / "out.wav"
    out.write_bytes(wav.content)
    info = sf.info(out)
    assert info.samplerate == 24000 and info.channels == 1 and info.subtype == "PCM_16"
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    assert abs(body["durationSec"] - 0.25 * cjk) < 0.1
    if whisper_align.available() and whisper_align._load() is not None:
        assert body["timestamps"] is None or isinstance(body["timestamps"], list)  # a sine tone has no words
    else:
        assert body["timestamps"] is None

    # speed 2.0 halves the mock's duration natively
    r = client.post("/synthesize", json={"text": text, "voiceId": voice["id"], "engine": "mock", "speed": 2.0, "timestamps": False})
    assert r.status_code == 200 and abs(r.json()["durationSec"] - 0.125 * cjk) < 0.1

    assert client.delete(f"/voices/{voice['id']}").status_code == 204
    assert client.get("/voices").json() == []
    assert client.delete(f"/voices/{voice['id']}").status_code == 404


def test_word_timestamps_split_cjk_per_character():
    # Pure function check on the CJK splitting rule (no model needed).
    assert whisper_align._is_cjk("學") and not whisper_align._is_cjk("a")


def test_whisper_output_is_traditional_chinese():
    assert whisper_align.to_traditional("欢迎来到描述统计的课程，软件") == "歡迎來到描述統計的課程，軟體"
    assert whisper_align.to_traditional("hello world") == "hello world"


@pytest.mark.skipif(whisper_align._load() is None, reason="whisper weights not available")
def test_whisper_transcribes_mandarin_as_traditional(tmp_path):
    clip = Path(os.environ.get("LVS_TEST_MANDARIN_CLIP", "")) if os.environ.get("LVS_TEST_MANDARIN_CLIP") else None
    if not clip or not clip.is_file():
        pytest.skip("set LVS_TEST_MANDARIN_CLIP to a Mandarin wav/mp3 to run this")
    wav = tmp_path / "ref16k.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-t", "10", "-ac", "1", "-ar", "16000", str(wav)], check=True)
    text = whisper_align.transcribe(wav)
    assert text and not any(ch in text for ch in "欢统计课")  # simplified forms must not survive
    words = whisper_align.word_timestamps(wav, text, "zh")
    assert words and all(len(w["text"]) == 1 for w in words if whisper_align._is_cjk(w["text"][0]))
    assert all(w["endSec"] >= w["startSec"] for w in words)


def test_short_cutoff_uses_word_boundaries():
    from lvs_tts.store import short_cutoff

    ts = [{"text": c, "startSec": i * 1.0, "endSec": i * 1.0 + 0.9} for i, c in enumerate("大家好歡迎來到課程今天")]
    cut, text = short_cutoff(ts, 12.0, "大家好歡迎來到課程今天", limit=9.5)
    assert 8.9 < cut <= 9.5 and text == "大家好歡迎來到課程"
    assert short_cutoff(None, 12.0, "x" * 120, limit=9.5) == (9.5, "x" * 95)
    assert short_cutoff(None, 8.0, "short", limit=9.5) == (8.0, "short")
