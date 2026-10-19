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


# ---------------------------------------------------------------------------
# Microsoft PowerPoint (Windows only, optional): the most faithful renderer for
# PPTX, since it is the application the deck was authored in. Used before
# LibreOffice when available, unless LVS_PPTX_CONVERTER=soffice.
# ---------------------------------------------------------------------------

PP_SAVE_AS_PDF = 32  # PpSaveAsFileType.ppSaveAsPDF


def powerpoint_available() -> bool:
    """True on Windows when pywin32 is importable and PowerPoint is registered."""
    if os.name != "nt" or os.environ.get("LVS_PPTX_CONVERTER", "auto").lower() == "soffice":
        return False
    try:
        import winreg  # type: ignore[import-not-found]

        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "PowerPoint.Application"):
            pass
    except OSError:
        return False
    try:
        import win32com.client  # type: ignore[import-not-found]  # noqa: F401
    except ImportError:
        return False
    return True


def powerpoint_convert_to_pdf(src: Path, out_dir: Path, timeout: float = 300) -> Path:
    """Export `src` (pptx/ppt) to PDF with PowerPoint via COM. Runs in a thread to honour `timeout`."""
    import threading

    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{src.stem}.pdf"
    error: list[BaseException] = []

    def run() -> None:
        import pythoncom  # type: ignore[import-not-found]
        import win32com.client  # type: ignore[import-not-found]

        pythoncom.CoInitialize()
        app = None
        pres = None
        try:
            app = win32com.client.DispatchEx("PowerPoint.Application")
            # WithWindow=False keeps the export headless; ReadOnly avoids lock files.
            pres = app.Presentations.Open(str(src.resolve()), True, False, False)
            pres.SaveAs(str(target.resolve()), PP_SAVE_AS_PDF)
        except BaseException as exc:  # noqa: BLE001
            error.append(exc)
        finally:
            try:
                if pres is not None:
                    pres.Close()
                if app is not None and app.Presentations.Count == 0:
                    app.Quit()
            except BaseException:  # noqa: BLE001
                pass
            pythoncom.CoUninitialize()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise ConvertError(f"PowerPoint export timed out after {timeout}s")
    if error:
        raise ConvertError(f"PowerPoint export failed: {error[0]}")
    if not target.exists():
        raise ConvertError("PowerPoint export produced no PDF")
    return target
