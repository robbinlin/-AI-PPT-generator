#!/usr/bin/env node
// Cross-platform launcher: runs the worker from its own virtualenv (created by install.ps1 / install.sh).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const python = process.platform === "win32" ? join(here, ".venv", "Scripts", "python.exe") : join(here, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`找不到 ${python}\n請先在 workers/avatar-local 執行安裝腳本：Windows 用 install.ps1，macOS/Linux 用 install.sh`);
  process.exit(1);
}
const child = spawn(python, ["-m", "lvs_avatar"], { cwd: here, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
