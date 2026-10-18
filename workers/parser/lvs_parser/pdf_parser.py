"""PDF structured-content extraction with PyMuPDF."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf

from .manifest import SlideContent, bbox, text_block

TITLE_MIN_RATIO = 1.15  # title font must be this much larger than the page's median size


def _block_text(block: dict[str, Any]) -> tuple[str, float]:
    """Return (joined text, max font size) for a PyMuPDF text block."""
    lines: list[str] = []
    max_size = 0.0
    for line in block.get("lines", []):
        spans = line.get("spans", [])
        text = "".join(span.get("text", "") for span in spans).strip()
        if text:
            lines.append(text)
        for span in spans:
            max_size = max(max_size, float(span.get("size", 0)))
    return "\n".join(lines), max_size


def parse_pdf_page(page: pymupdf.Page, page_number: int) -> SlideContent:
    rect = page.rect
    content = SlideContent(page_number=page_number, width_pt=rect.width, height_pt=rect.height, render_fidelity="native")
    raw = page.get_text("dict")
    blocks: list[tuple[str, float, pymupdf.Rect]] = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            if block.get("type") == 1:
                x0, y0, x1, y1 = block["bbox"]
                content.images.append({"bbox": bbox(x0, y0, x1 - x0, y1 - y0)})
            continue
        text, size = _block_text(block)
        if text:
            blocks.append((text, size, pymupdf.Rect(block["bbox"])))
    if not blocks:
        if not content.images:
            # No text and no images: treat as a scan only if the page has any drawing at all.
            pix = page.get_pixmap(dpi=20, alpha=False)
            content.needs_ocr = any(b != 255 for b in pix.samples[: pix.width * pix.height * pix.n])
        else:
            content.needs_ocr = True
        return content
    sizes = sorted(size for _, size, _ in blocks)
    median = sizes[len(sizes) // 2]
    title_index = None
    for index, (text, size, rect_) in enumerate(blocks):
        if size >= median * TITLE_MIN_RATIO and len(text) <= 120:
            title_index = index
            break
    if title_index is None and len(blocks) > 1 and len(blocks[0][0]) <= 80:
        title_index = 0
    for index, (text, _, rect_) in enumerate(blocks):
        box = bbox(rect_.x0, rect_.y0, rect_.width, rect_.height)
        if index == title_index:
            content.title = text.replace("\n", " ")
            content.text_blocks.append(text_block(content.title, "title", box))
        else:
            content.text_blocks.append(text_block(text, "body", box))
    return content


def pdf_metadata(doc: pymupdf.Document) -> dict[str, str]:
    meta = doc.metadata or {}
    return {k: v for k, v in (("title", meta.get("title")), ("author", meta.get("author"))) if v}


def parse_pdf(pdf_path: Path) -> tuple[list[SlideContent], dict[str, str]]:
    with pymupdf.open(pdf_path) as doc:
        pages = [parse_pdf_page(page, index) for index, page in enumerate(doc, start=1)]
        return pages, pdf_metadata(doc)
