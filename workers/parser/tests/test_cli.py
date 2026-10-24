from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .conftest import PARSER_DIR, validate_output


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "lvs_parser", *args],
        cwd=PARSER_DIR,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )


def test_cli_parse_pdf(sample_pdf: Path, tmp_path: Path, manifest_validator, content_validator) -> None:
    out = tmp_path / "cli-out"
    proc = run_cli("parse", str(sample_pdf), "--out", str(out), "--dpi", "72")
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().splitlines()[-1] == str(out / "manifest.json")
    progress = [line for line in proc.stderr.splitlines() if line.startswith("PROGRESS ")]
    assert progress and progress[-1].startswith("PROGRESS 1.00")
    fractions = [float(line.split()[1]) for line in progress]
    assert fractions == sorted(fractions)
    validate_output(out, manifest_validator, content_validator)


def test_cli_rejects_unknown_file(tmp_path: Path) -> None:
    bogus = tmp_path / "notes.txt"
    bogus.write_text("hello")
    proc = run_cli("parse", str(bogus), "--out", str(tmp_path / "out"))
    assert proc.returncode == 2  # bad input: not retried
    err = json.loads(proc.stderr.strip().splitlines()[-1])
    assert err["error"] == "parse_failed"
    assert "unsupported" in err["message"]


def test_cli_missing_input(tmp_path: Path) -> None:
    proc = run_cli("parse", str(tmp_path / "missing.pdf"), "--out", str(tmp_path / "out"))
    assert proc.returncode == 2  # bad input: not retried
    err = json.loads(proc.stderr.strip().splitlines()[-1])
    assert err["error"] == "parse_failed"
