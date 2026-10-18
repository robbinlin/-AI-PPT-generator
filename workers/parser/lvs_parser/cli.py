"""Command line entry point.

    python3 -m lvs_parser parse <input> --out <dir> [--dpi 150] [--thumb-width 320] [--timeout 300]

Progress lines go to stderr as `PROGRESS <0..1> <message>`; the manifest path is the
last line on stdout. Failures exit non-zero with a JSON object on stderr.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from . import __version__
from .convert import ConvertError, soffice_binary, soffice_convert, soffice_version
from .manifest import PageEntry, SlideContent, build_manifest, write_json
from .pdf_parser import parse_pdf
from .pptx_parser import parse_pptx
from .render import RenderedPage, page_name, render_fallback_page, render_pdf_pages

MAGIC_ZIP = b"PK\x03\x04"
MAGIC_PDF = b"%PDF"
MAGIC_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


class ParseError(RuntimeError):
    pass


def progress(fraction: float, message: str) -> None:
    sys.stderr.write(f"PROGRESS {max(0.0, min(1.0, fraction)):.2f} {message}\n")
    sys.stderr.flush()


def detect_kind(path: Path) -> str:
    with path.open("rb") as fh:
        head = fh.read(8)
    suffix = path.suffix.lower()
    if head.startswith(MAGIC_PDF):
        return "pdf"
    if head.startswith(MAGIC_ZIP) and suffix in {".pptx", ".ppt", ""}:
        return "pptx"
    if head.startswith(MAGIC_OLE):
        return "ppt"
    if suffix == ".pdf":
        return "pdf"
    if suffix == ".pptx":
        return "pptx"
    if suffix == ".ppt":
        return "ppt"
    raise ParseError(f"unsupported file type: {path.name}")


def _write_pages(
    out_dir: Path, contents: list[SlideContent], rendered: dict[int, RenderedPage]
) -> list[PageEntry]:
    entries: list[PageEntry] = []
    for content in contents:
        page = rendered[content.page_number]
        content_rel = Path("pages") / f"{content.page_number:03d}.json"
        write_json(out_dir / content_rel, content.to_dict())
        entries.append(
            PageEntry(
                page_number=content.page_number,
                image_path=page.image_path.relative_to(out_dir).as_posix(),
                thumbnail_path=page.thumbnail_path.relative_to(out_dir).as_posix(),
                content_path=content_rel.as_posix(),
                image_width_px=page.width_px,
                image_height_px=page.height_px,
            )
        )
    return entries


def _render_with_fallback(
    contents: list[SlideContent], out_dir: Path, dpi: int, thumb_width: int, warnings: list[str], reason: str
) -> dict[int, RenderedPage]:
    warnings.append(f"page images rendered with fallback renderer: {reason}")
    rendered: dict[int, RenderedPage] = {}
    for content in contents:
        content.render_fidelity = "fallback"
        rendered[content.page_number] = render_fallback_page(
            content, out_dir / "pages" / page_name(content.page_number), out_dir / "thumbs" / page_name(content.page_number), dpi, thumb_width
        )
    return rendered


def parse_file(input_path: Path, out_dir: Path, *, dpi: int = 150, thumb_width: int = 320, timeout: float = 300) -> Path:
    started = time.perf_counter()
    if not input_path.is_file():
        raise ParseError(f"input not found: {input_path}")
    kind = detect_kind(input_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    converter: str | None = None
    progress(0.05, f"detected {kind}")

    with tempfile.TemporaryDirectory(prefix="lvs-parse-") as tmp:
        work = Path(tmp)
        pptx_path: Path | None = None
        pdf_path: Path | None = None

        if kind == "ppt":
            progress(0.1, "converting PPT to PPTX")
            try:
                pptx_path = soffice_convert(input_path, work / "pptx", "pptx", timeout)
            except ConvertError as exc:
                raise ParseError(f"cannot convert legacy PPT: {exc}") from exc
        elif kind == "pptx":
            pptx_path = input_path
        else:
            pdf_path = input_path

        if pptx_path is not None:
            progress(0.2, "extracting slide content")
            contents, meta = parse_pptx(pptx_path, "converted")
            binary = soffice_binary()
            if binary:
                progress(0.35, "rendering slides with LibreOffice")
                try:
                    pdf_path = soffice_convert(pptx_path, work / "pdf", "pdf", timeout)
                    converter = soffice_version(binary)
                except ConvertError as exc:
                    pdf_path = None
                    warnings.append(str(exc))
            else:
                warnings.append("soffice not found")
            if pdf_path is not None:
                rendered_list = render_pdf_pages(pdf_path, out_dir / "pages", out_dir / "thumbs", dpi, thumb_width)
                rendered = {p.page_number: p for p in rendered_list}
                if len(rendered) != len(contents):
                    warnings.append(f"LibreOffice rendered {len(rendered)} pages for {len(contents)} slides")
                    missing = [c for c in contents if c.page_number not in rendered]
                    rendered.update(_render_with_fallback(missing, out_dir, dpi, thumb_width, warnings, "page count mismatch"))
            else:
                rendered = _render_with_fallback(contents, out_dir, dpi, thumb_width, warnings, warnings[-1] if warnings else "no PDF")
        else:
            assert pdf_path is not None
            progress(0.2, "extracting PDF text")
            contents, meta = parse_pdf(pdf_path)
            converter = f"pymupdf {__import__('pymupdf').version[0]}"
            progress(0.5, "rendering PDF pages")
            rendered = {p.page_number: p for p in render_pdf_pages(pdf_path, out_dir / "pages", out_dir / "thumbs", dpi, thumb_width)}

        progress(0.9, "writing manifest")
        entries = _write_pages(out_dir, contents, rendered)
        manifest = build_manifest(
            kind,
            entries,
            title=meta.get("title"),
            author=meta.get("author"),
            converter=converter,
            warnings=warnings,
            duration_ms=(time.perf_counter() - started) * 1000,
        )
        manifest_path = out_dir / "manifest.json"
        write_json(manifest_path, manifest)
        progress(1.0, f"done: {len(entries)} pages")
        return manifest_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lvs_parser", description="Deck → page images + structured content")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("parse", help="parse a PPTX/PPT/PDF file")
    p.add_argument("input", type=Path)
    p.add_argument("--out", type=Path, required=True, help="output directory (created; existing pages are overwritten)")
    p.add_argument("--dpi", type=int, default=150)
    p.add_argument("--thumb-width", type=int, default=320)
    p.add_argument("--timeout", type=float, default=300, help="seconds allowed for each LibreOffice conversion")
    p.add_argument("--clean", action="store_true", help="delete the output directory first")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "parse":
        return 2
    try:
        if args.clean and args.out.exists():
            shutil.rmtree(args.out)
        manifest_path = parse_file(args.input, args.out, dpi=args.dpi, thumb_width=args.thumb_width, timeout=args.timeout)
    except ParseError as exc:
        sys.stderr.write(json.dumps({"error": "parse_failed", "message": str(exc)}) + "\n")
        return 1
    except Exception as exc:  # noqa: BLE001 - report anything to the caller as JSON
        sys.stderr.write(json.dumps({"error": "internal", "message": f"{type(exc).__name__}: {exc}"}) + "\n")
        return 1
    sys.stdout.write(str(manifest_path) + "\n")
    return 0
