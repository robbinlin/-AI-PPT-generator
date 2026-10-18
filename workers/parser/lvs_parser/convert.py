"""LibreOffice (soffice) conversions with an isolated profile and a timeout."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


class ConvertError(RuntimeError):
    """soffice is missing, timed out, or produced no output."""


def soffice_binary() -> str | None:
    candidate = os.environ.get("SOFFICE_BIN", "soffice")
    return shutil.which(candidate)


def soffice_version(binary: str) -> str:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30, check=False)
        lines = (out.stdout or out.stderr).strip().splitlines()
        return lines[0] if lines else "soffice"
    except (OSError, subprocess.SubprocessError):
        return "soffice"


def soffice_convert(src: Path, out_dir: Path, target: str, timeout: float = 300) -> Path:
    """Convert `src` to `target` ("pdf" or "pptx") inside `out_dir`; returns the output path."""
    binary = soffice_binary()
    if binary is None:
        raise ConvertError("soffice not found (set SOFFICE_BIN)")
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="lvs-soffice-") as profile:
        cmd = [
            binary,
            f"-env:UserInstallation=file://{profile}",
            "--headless",
            "--norestore",
            "--nologo",
            "--convert-to",
            target,
            "--outdir",
            str(out_dir),
            str(src),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise ConvertError(f"soffice timed out after {timeout}s") from exc
        except OSError as exc:
            raise ConvertError(f"soffice failed to start: {exc}") from exc
    expected = out_dir / f"{src.stem}.{target}"
    if proc.returncode != 0 or not expected.exists():
        detail = (proc.stderr or proc.stdout).strip()[-500:]
        raise ConvertError(f"soffice conversion to {target} failed (rc={proc.returncode}): {detail}")
    return expected
