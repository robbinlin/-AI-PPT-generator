"""Builders for the SlideContent / ParserManifest JSON contract."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


def bbox(x: float, y: float, w: float, h: float) -> dict[str, float]:
    return {"x": round(x, 2), "y": round(y, 2), "w": round(w, 2), "h": round(h, 2)}


def text_block(text: str, role: str = "body", box: dict[str, float] | None = None, level: int = 0) -> dict[str, Any]:
    block: dict[str, Any] = {"text": text, "role": role, "level": max(0, int(level))}
    if box is not None:
        block["bbox"] = box
    return block


@dataclass
class SlideContent:
    page_number: int
    width_pt: float
    height_pt: float
    render_fidelity: str
    title: str | None = None
    text_blocks: list[dict[str, Any]] = field(default_factory=list)
    notes: str | None = None
    tables: list[dict[str, Any]] = field(default_factory=list)
    images: list[dict[str, Any]] = field(default_factory=list)
    charts: list[dict[str, Any]] = field(default_factory=list)
    needs_ocr: bool = False

    def plain_text(self) -> str:
        """Deterministic text used by the API for hashing and prompts."""
        parts: list[str] = []
        if self.title:
            parts.append(self.title)
        # The title also appears as a "title" text block (for its bbox); emit it once.
        parts.extend(b["text"] for b in self.text_blocks if b["text"] and b.get("role") != "title")
        for table in self.tables:
            for row in table["rows"]:
                parts.append("\t".join(row))
        for chart in self.charts:
            summary = " ".join(filter(None, [chart.get("title"), chart.get("dataSummary")]))
            if summary:
                parts.append(summary)
        if self.notes:
            parts.append(self.notes)
        return "\n".join(p.strip() for p in parts if p and p.strip())

    def to_dict(self) -> dict[str, Any]:
        plain = self.plain_text()
        out: dict[str, Any] = {
            "pageNumber": self.page_number,
            "textBlocks": self.text_blocks,
            "tables": self.tables,
            "images": self.images,
            "charts": self.charts,
            "plainText": plain,
            "hasText": bool(plain.strip()),
            "needsOcr": self.needs_ocr,
            "widthPt": round(self.width_pt, 2),
            "heightPt": round(self.height_pt, 2),
            "renderFidelity": self.render_fidelity,
        }
        if self.title:
            out["title"] = self.title
        if self.notes:
            out["notes"] = self.notes
        return out


@dataclass
class PageEntry:
    page_number: int
    image_path: str
    thumbnail_path: str
    content_path: str
    image_width_px: int
    image_height_px: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "pageNumber": self.page_number,
            "imagePath": self.image_path,
            "thumbnailPath": self.thumbnail_path,
            "contentPath": self.content_path,
            "imageWidthPx": self.image_width_px,
            "imageHeightPx": self.image_height_px,
        }


def build_manifest(
    source_kind: str,
    pages: list[PageEntry],
    *,
    title: str | None = None,
    author: str | None = None,
    converter: str | None = None,
    warnings: list[str] | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    meta: dict[str, Any] = {"warnings": list(warnings or [])}
    if title:
        meta["title"] = title
    if author:
        meta["author"] = author
    if converter:
        meta["converter"] = converter
    if duration_ms is not None:
        meta["durationMs"] = round(duration_ms, 1)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceKind": source_kind,
        "pageCount": len(pages),
        "pages": [p.to_dict() for p in pages],
        "meta": meta,
    }


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
