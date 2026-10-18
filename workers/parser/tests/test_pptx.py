from __future__ import annotations

import time
from pathlib import Path

import pytest

from lvs_parser.cli import parse_file
from lvs_parser.convert import soffice_binary
from lvs_parser.pptx_parser import parse_pptx

from .conftest import validate_output


def test_parse_pptx_structure(sample_pptx: Path) -> None:
    pages, meta = parse_pptx(sample_pptx)
    assert meta == {"title": "運動生理學 第三章", "author": "測試作者"}
    assert [p.page_number for p in pages] == [1, 2, 3]
    assert all(abs(p.width_pt - 960) < 1 and abs(p.height_pt - 540) < 1 for p in pages)

    s1, s2, s3 = pages
    assert s1.title == "最大攝氧量 VO₂max 的測量"
    assert s1.notes == "開場先問學生有沒有做過跑步機測試。"
    assert any(b["role"] == "subtitle" for b in s1.text_blocks)

    bullets = [b for b in s2.text_blocks if b["role"] == "bullet"]
    assert [(b["text"], b["level"]) for b in bullets] == [("直接測量法", 0), ("氣體分析儀", 1), ("間接推估法", 0)]
    assert len(s2.images) == 1 and "bbox" in s2.images[0]
    assert abs(s2.images[0]["bbox"]["x"] - 576) < 1  # 8 inches

    assert s3.tables[0]["rows"][1] == ["介入組", "48.2", "4.1"]
    assert len(s3.charts) == 1
    assert s3.charts[0]["title"] == "VO2max 變化"
    assert "介入組" in s3.charts[0]["dataSummary"]
    assert "前測" in s3.charts[0]["dataSummary"]

    plain = s3.plain_text()
    assert plain.startswith("常模比較\n組別\t")  # title exactly once
    assert "介入組\t48.2\t4.1" in plain
    assert s3.plain_text() == plain  # deterministic


@pytest.mark.skipif(soffice_binary() is None, reason="LibreOffice not installed")
def test_pptx_end_to_end_with_soffice(sample_pptx: Path, tmp_path: Path, manifest_validator, content_validator) -> None:
    started = time.perf_counter()
    manifest_path = parse_file(sample_pptx, tmp_path / "out", dpi=96)
    elapsed = time.perf_counter() - started
    manifest = validate_output(manifest_path.parent, manifest_validator, content_validator)
    assert manifest["sourceKind"] == "pptx"
    assert manifest["pageCount"] == 3
    assert manifest["meta"]["title"] == "運動生理學 第三章"
    assert "LibreOffice" in manifest["meta"]["converter"]
    assert manifest["meta"]["warnings"] == []
    first = manifest["pages"][0]
    assert first["imageWidthPx"] > first["imageHeightPx"]  # 16:9
    import json

    content = json.loads((manifest_path.parent / first["contentPath"]).read_text(encoding="utf-8"))
    assert content["renderFidelity"] == "converted"
    assert content["hasText"] is True
    print(f"\npptx end-to-end: {elapsed:.1f}s")


def test_pptx_fallback_without_soffice(sample_pptx: Path, tmp_path: Path, no_soffice, manifest_validator, content_validator) -> None:
    manifest_path = parse_file(sample_pptx, tmp_path / "out")
    manifest = validate_output(manifest_path.parent, manifest_validator, content_validator)
    assert manifest["pageCount"] == 3
    assert any("fallback" in w for w in manifest["meta"]["warnings"])
    import json

    for entry in manifest["pages"]:
        content = json.loads((manifest_path.parent / entry["contentPath"]).read_text(encoding="utf-8"))
        assert content["renderFidelity"] == "fallback"
        assert entry["imageWidthPx"] == 2000  # 960pt at 150 dpi


@pytest.mark.skipif(soffice_binary() is None, reason="LibreOffice not installed")
def test_legacy_ppt(sample_ppt: Path | None, tmp_path: Path, manifest_validator, content_validator) -> None:
    if sample_ppt is None:
        pytest.skip("could not produce a .ppt fixture")
    manifest_path = parse_file(sample_ppt, tmp_path / "out", dpi=72)
    manifest = validate_output(manifest_path.parent, manifest_validator, content_validator)
    assert manifest["sourceKind"] == "ppt"
    assert manifest["pageCount"] == 3
    import json

    content = json.loads((manifest_path.parent / manifest["pages"][2]["contentPath"]).read_text(encoding="utf-8"))
    assert content["title"] == "常模比較"
    assert content["tables"][0]["rows"][2][0] == "對照組"
