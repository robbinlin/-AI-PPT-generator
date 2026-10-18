# lvs-parser (workers/parser)

Converts a slide deck into per-page images and structured content for the API.
Pure CLI, no network. Contract: `packages/shared/src/parser.ts`
(JSON Schema copies in `packages/shared/schemas/parser-manifest.json` and `slide-content.json`).

## Install

```bash
python3 -m pip install -r workers/parser/requirements.txt
# LibreOffice is needed for PPTX/PPT page images (SOFFICE_BIN, default `soffice`).
```

## Usage

```bash
cd workers/parser
python3 -m lvs_parser parse deck.pptx --out /tmp/deck [--dpi 150] [--thumb-width 320] [--timeout 300] [--clean]
```

Output layout (`<out>` relative paths are what the manifest references):

```
<out>/manifest.json        ParserManifest
<out>/pages/001.png        full page image (dpi × page size)
<out>/pages/001.json       SlideContent
<out>/thumbs/001.png       thumbnail (--thumb-width wide)
```

* stdout: last line is the manifest path.
* stderr: `PROGRESS <0..1> <message>` lines while running; on failure a single JSON object
  `{"error": "parse_failed" | "internal", "message": "..."}` and exit code 1.

## Behaviour by input

| Input | Content | Page image | `renderFidelity` |
|---|---|---|---|
| PPTX | python-pptx: title, bullets with `level`, tables, pictures (bbox), charts (type/title/series), speaker notes | soffice → PDF → PyMuPDF | `converted` |
| PPT  | soffice → PPTX, then as PPTX | same | `converted` |
| PDF  | PyMuPDF text blocks with bbox; title = largest font (≥1.15× median) else first short block; pages without a text layer get `hasText=false, needsOcr=true` | PyMuPDF | `native` |

If soffice is missing or fails, pages are drawn with Pillow (white background, title + text,
CJK font when available), `renderFidelity` becomes `fallback` and `meta.warnings` explains why.
The CLI still exits 0.

* bbox units: PDF points, origin top-left (PPTX EMU ÷ 12700).
* `plainText` = title + text blocks + table cells (tab-joined) + chart summary + notes,
  newline-joined, title emitted once. The API hashes this, so it is deterministic.
* Each soffice run uses a private `-env:UserInstallation` profile, so parallel parses are safe.

## Tests

```bash
cd workers/parser && python3 -m pytest -q
```

Fixtures are generated in-test (3-slide PPTX with notes/table/chart/picture, 3-page PDF with a
scanned-style page, and a `.ppt` produced by LibreOffice). Every manifest and page JSON is
validated against the shared JSON Schemas. soffice-dependent tests skip when it is absent.
