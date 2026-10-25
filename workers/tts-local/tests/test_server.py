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


def test_pick_cut_ends_in_a_pause():
    from lvs_tts.store import pick_cut

    assert pick_cut([(1.0, 1.5), (4.0, 4.6), (8.0, 8.6), (9.8, 10.2)], 12.0, limit=9.5) == 8.15
    assert pick_cut([(2.0, 2.5)], 12.0, limit=9.5) == 9.5  # a pause before 3 s would leave too little
    assert pick_cut([(9.4, 9.9)], 12.0, limit=9.5) == 9.5
    assert pick_cut([], 8.0, limit=9.5) == 8.0


def test_matching_prefix_follows_what_was_heard():
    from lvs_tts.store import matching_prefix

    full = "大家好，歡迎來到課程。今天我們講機率。"
    assert matching_prefix(full, "大家好歡迎來到課程") == "大家好，歡迎來到課程。"
    # Whisper's homophone errors still map onto the given transcript.
    assert matching_prefix(full, "大家好歡迎來到課成今天") == "大家好，歡迎來到課程。今天"
    assert matching_prefix(full, "大家好歡迎來到課程今天我們講機率") == full
    assert matching_prefix("Hello world, this is VO2 max.", "hello world this") == "Hello world, this"
    # Nothing in common, or heard text starting somewhere else: no prefix.
    assert matching_prefix(full, "完全不同的句子") is None
    assert matching_prefix(full, "今天我們講機率") is None


def _speech_with_pauses(path: Path, sr: int = 16000) -> None:
    """Tone 0-4 s, pause, tone 4.5-8 s, pause 8.0-8.6 s, tone to 12 s."""
    t = np.arange(int(sr * 12.0)) / sr
    a = 0.3 * np.sin(2 * np.pi * 220 * t)
    a[(t >= 4.0) & (t < 4.5)] = 0
    a[(t >= 8.0) & (t < 8.6)] = 0
    sf.write(path, a.astype(np.float32), sr)


def test_long_reference_prompt_matches_the_cut_audio(tmp_path):
    from lvs_tts.store import SHORT_REF_REV, Voice, VoiceStore

    heard: list[float] = []

    def fake_whisper(wav16k: Path, language: str) -> str:
        d = duration(wav16k)
        heard.append(d)
        return "大家好歡迎來到課程" if d < 9 else "大家好歡迎來到課程今天我們講機率"

    store = VoiceStore(tmp_path, fake_whisper)
    clip = tmp_path / "ref.wav"
    _speech_with_pauses(clip)
    v = store.create("ref.wav", clip.read_bytes(), "t", lambda _p: "大家好，歡迎來到課程。今天我們講機率。")
    assert 8.0 < v.short_duration_sec < 8.6 and abs(duration(store.short(v.id)) - v.short_duration_sec) < 0.05
    assert v.transcript_short == "大家好，歡迎來到課程。" and v.short_rev == SHORT_REF_REV
    assert heard and all(d < 8.7 for d in heard)  # Whisper only listened to the cut part
    assert store.reference_for(store.get(v.id), 9.5) == (store.short(v.id), "大家好，歡迎來到課程。")

    # A voice shortened by the old rule is rebuilt once, on first use.
    old = store.get(v.id)
    old.short_rev, old.transcript_short = 1, "來到課程今天我們講"
    store._save(old)
    wav, text = store.reference_for(store.get(v.id), 9.5)
    assert text == "大家好，歡迎來到課程。" and store.get(v.id).short_rev == SHORT_REF_REV
    assert store.reference_for(store.get(v.id), None) == (store.sample(v.id), "大家好，歡迎來到課程。今天我們講機率。")

    # Without Whisper the transcript is shared out by length.
    plain = VoiceStore(tmp_path / "plain")
    p = plain.create("ref.wav", clip.read_bytes(), "t", lambda _p: "一二三四五六七八九十一二")
    assert p.transcript_short == "一二三四五六七八"


def test_trained_voice_carries_its_model(tmp_path, client):
    from lvs_tts.store import VoiceStore

    store = VoiceStore(tmp_path)
    clip = tmp_path / "ref.wav"
    make_wav(clip, 6.0)
    v = store.create("ref.wav", clip.read_bytes(), "林老師", lambda _p: "大家好")
    assert "trained" not in v.to_json() and store.model_weights(v, "gptsovits") is None
    gpt, sovits = tmp_path / "a.ckpt", tmp_path / "b.pth"
    gpt.write_bytes(b"g")
    sovits.write_bytes(b"s")
    v = store.attach_model(v.id, "gptsovits", gpt, sovits, 33.04)
    assert v.to_json()["trained"] == {"engine": "gptsovits", "minutes": 33.0}
    w = store.model_weights(store.get(v.id), "gptsovits")
    assert Path(w["gpt"]).read_bytes() == b"g" and Path(w["sovits"]).parent == store.dir(v.id)
    assert store.model_weights(store.get(v.id), "cosyvoice2") is None  # other engines stay zero-shot
    (store.dir(v.id) / "gptsovits-sovits.pth").unlink()
    assert store.model_weights(store.get(v.id), "gptsovits") is None  # missing files: pretrained weights
    # Only SoVITS fine-tuned: the engine keeps its pretrained GPT.
    v = store.attach_model(v.id, "gptsovits", None, sovits, 20)
    assert set(store.model_weights(store.get(v.id), "gptsovits")) == {"sovits"}

    assert client.post("/engines/unload").json() == {"ok": True}
