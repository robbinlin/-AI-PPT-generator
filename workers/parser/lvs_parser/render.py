"""Page image rendering: PDF pages via PyMuPDF, and a Pillow fallback when no PDF exists."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont

from .manifest import SlideContent

FALLBACK_FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msjh.ttc",
)


@dataclass
class RenderedPage:
    page_number: int
    image_path: Path
    thumbnail_path: Path
    width_px: int
    height_px: int


def page_name(page_number: int) -> str:
    return f"{page_number:03d}.png"


def write_thumbnail(image_path: Path, thumb_path: Path, thumb_width: int) -> None:
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as img:
        ratio = thumb_width / img.width
        size = (thumb_width, max(1, round(img.height * ratio)))
        img.convert("RGB").resize(size, Image.LANCZOS).save(thumb_path, format="PNG", optimize=True)


def render_pdf_pages(pdf_path: Path, pages_dir: Path, thumbs_dir: Path, dpi: int, thumb_width: int) -> list[RenderedPage]:
    """Rasterise every page of `pdf_path` into pages_dir/NNN.png and thumbs_dir/NNN.png."""
    pages_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    rendered: list[RenderedPage] = []
    with pymupdf.open(pdf_path) as doc:
        for index, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            image_path = pages_dir / page_name(index)
            pix.save(image_path)
            thumb_path = thumbs_dir / page_name(index)
            write_thumbnail(image_path, thumb_path, thumb_width)
            rendered.append(RenderedPage(index, image_path, thumb_path, pix.width, pix.height))
    return rendered


def find_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    override = os.environ.get("LVS_FALLBACK_FONT")
    for candidate in ([override] if override else []) + list(FALLBACK_FONT_CANDIDATES):
        if candidate and Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for raw in text.splitlines() or [""]:
        line = ""
        for ch in raw:
            candidate = line + ch
            if draw.textlength(candidate, font=font) > max_width and line:
                lines.append(line)
                line = ch
            else:
                line = candidate
        lines.append(line)
    return lines


def render_fallback_page(
    content: SlideContent, image_path: Path, thumb_path: Path, dpi: int, thumb_width: int
) -> RenderedPage:
    """Draw title + text on a white canvas. Used when LibreOffice is unavailable."""
    scale = dpi / 72.0
    width = max(320, round(content.width_pt * scale))
    height = max(180, round(content.height_pt * scale))
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    margin = round(width * 0.06)
    title_font = find_font(max(18, round(height * 0.07)))
    body_font = find_font(max(14, round(height * 0.04)))
    y = margin
    max_width = width - 2 * margin
    if content.title:
        for line in _wrap(draw, content.title, title_font, max_width):
            draw.text((margin, y), line, fill="#1f2937", font=title_font)
            y += round(title_font.size * 1.3)
        y += round(body_font.size * 0.6)
    for block in content.text_blocks:
        if block.get("role") == "title":
            continue  # already drawn above
        indent = margin + block.get("level", 0) * round(body_font.size * 1.5)
        is_bullet = block.get("role") == "bullet"
        text_x = indent + (round(body_font.size * 0.9) if is_bullet else 0)
        for first, line in enumerate(_wrap(draw, block["text"], body_font, max_width - (text_x - margin))):
            if y > height - margin:
                break
            if is_bullet and first == 0:
                r = max(2, round(body_font.size * 0.14))
                cy = y + round(body_font.size * 0.55)
                draw.ellipse((indent, cy - r, indent + 2 * r, cy + r), fill="#374151")
            draw.text((text_x, y), line, fill="#374151", font=body_font)
            y += round(body_font.size * 1.4)
    image_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(image_path, format="PNG", optimize=True)
    write_thumbnail(image_path, thumb_path, thumb_width)
    return RenderedPage(content.page_number, image_path, thumb_path, width, height)
