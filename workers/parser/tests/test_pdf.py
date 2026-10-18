from __future__ import annotations

import json
from pathlib import Path

from lvs_parser.cli import parse_file
from lvs_parser.pdf_parser import parse_pdf

from .conftest import validate_output


def test_parse_pdf_structure(sample_pdf: Path) -> None:
    pages, meta = parse_pdf(sample_pdf)
    assert meta == {"title": "Exercise Physiology", "author": "Tester"}
    assert len(pages) == 3
    p1, p2, p3 = pages
    assert p1.title == "Chapter 3: Measuring VO2max"
    assert p1.width_pt == 960 and p1.height_pt == 540
    body = [b for b in p1.text_blocks if b["role"] == "body"]
    assert any("gas analysis" in b["text"] for b in body)
    assert all("bbox" in b for b in p1.text_blocks)
    title_box = next(b["bbox"] for b in p1.text_blocks if b["role"] == "title")
    assert 50 < title_box["x"] < 70 and 50 < title_box["y"] < 95

    assert p2.title == "Normative values"
    assert p3.needs_ocr is True
    assert p3.plain_text() == ""


def test_pdf_end_to_end(sample_pdf: Path, tmp_path: Path, manifest_validator, content_validator) -> None:
    manifest_path = parse_file(sample_pdf, tmp_path / "out", dpi=72, thumb_width=200)
    out = manifest_path.parent
    manifest = validate_output(out, manifest_validator, content_validator)
    assert manifest["sourceKind"] == "pdf"
    assert manifest["pageCount"] == 3
    assert manifest["meta"]["converter"].startswith("pymupdf")
    assert manifest["pages"][0]["imageWidthPx"] == 960
    assert manifest["pages"][0]["imageHeightPx"] == 540
    c1 = json.loads((out / manifest["pages"][0]["contentPath"]).read_text(encoding="utf-8"))
    assert c1["renderFidelity"] == "native"
    assert c1["hasText"] is True and c1["needsOcr"] is False
    c3 = json.loads((out / manifest["pages"][2]["contentPath"]).read_text(encoding="utf-8"))
    assert c3["hasText"] is False and c3["needsOcr"] is True
    from PIL import Image

    with Image.open(out / manifest["pages"][0]["thumbnailPath"]) as thumb:
        assert thumb.width == 200
