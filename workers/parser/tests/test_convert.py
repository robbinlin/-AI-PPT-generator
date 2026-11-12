from __future__ import annotations

from pathlib import Path

import pytest

from lvs_parser import convert
from lvs_parser.convert import ConvertError


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr("time.sleep", slept.append)
    return slept


def test_powerpoint_start_failure_is_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, no_sleep: list[float]) -> None:
    calls: list[int] = []

    def flaky(src: Path, out_dir: Path, timeout: float) -> Path:
        calls.append(1)
        if len(calls) < 3:
            raise ConvertError("PowerPoint export failed: (-2146959355, '伺服器執行失敗', None, None)")
        return out_dir / "deck.pdf"

    monkeypatch.setattr(convert, "_powerpoint_export_once", flaky)
    assert convert.powerpoint_convert_to_pdf(tmp_path / "deck.pptx", tmp_path) == tmp_path / "deck.pdf"
    assert len(calls) == 3
    assert no_sleep == list(convert.POWERPOINT_RETRY_DELAYS)


def test_powerpoint_gives_up_after_the_last_retry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, no_sleep: list[float]) -> None:
    def broken(src: Path, out_dir: Path, timeout: float) -> Path:
        raise ConvertError("PowerPoint export failed: boom")

    monkeypatch.setattr(convert, "_powerpoint_export_once", broken)
    with pytest.raises(ConvertError, match="boom"):
        convert.powerpoint_convert_to_pdf(tmp_path / "deck.pptx", tmp_path)
    assert len(no_sleep) == len(convert.POWERPOINT_RETRY_DELAYS)


def test_powerpoint_timeout_is_not_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, no_sleep: list[float]) -> None:
    calls: list[int] = []

    def slow(src: Path, out_dir: Path, timeout: float) -> Path:
        calls.append(1)
        raise ConvertError(f"PowerPoint export timed out after {timeout}s")

    monkeypatch.setattr(convert, "_powerpoint_export_once", slow)
    with pytest.raises(ConvertError, match="timed out"):
        convert.powerpoint_convert_to_pdf(tmp_path / "deck.pptx", tmp_path, timeout=1)
    assert len(calls) == 1 and no_sleep == []
