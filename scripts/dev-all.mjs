#!/usr/bin/env node
// 一鍵啟動：API、網頁、本機人像、本機語音。
// Windows：每個服務開一個獨立的 PowerShell 視窗（關掉視窗就停止該服務）。
// macOS / Linux：在同一個終端機裡以前綴輸出並行執行（Ctrl+C 全部停止）。
// 已經在跑的服務（健康檢查有回應）會略過，不會重複啟動。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";
const venvPython = (worker) => join(root, "workers", worker, ".venv", win ? "Scripts/python.exe" : "bin/python");

const services = [
  { name: "A - API", cmd: "pnpm dev:api", health: "http://127.0.0.1:4000/health" },
  { name: "B - 網頁", cmd: "pnpm --filter @lvs/web dev", health: "http://127.0.0.1:5173/" },
  { name: "C - 本機人像", cmd: "pnpm dev:avatar", health: "http://127.0.0.1:8765/health", needs: venvPython("avatar-local") },
  { name: "D - 本機語音", cmd: "pnpm dev:tts", health: "http://127.0.0.1:8766/health", needs: venvPython("tts-local") },
];

// Vite may listen on ::1 only (Windows resolves localhost to IPv6 first), so try both hosts and
// count any HTTP answer as "up".
async function isUp(url) {
  for (const u of [url, url.replace("127.0.0.1", "localhost")]) {
    try {
      await fetch(u, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      /* try the next host */
    }
  }
  return false;
}

const toStart = [];
for (const s of services) {
  if (s.needs && !existsSync(s.needs)) {
    console.log(`略過 ${s.name}：尚未安裝（執行 workers\\${s.cmd.includes("avatar") ? "avatar-local" : "tts-local"}\\install.ps1 後才會啟動）`);
    continue;
  }
  if (await isUp(s.health)) {
    console.log(`已在執行 ${s.name}`);
    continue;
  }
  toStart.push(s);
}

if (toStart.length === 0) {
  // No process.exit here: on Windows it trips a libuv assertion while fetch handles are closing.
  console.log("四個服務都已經在跑。瀏覽器開 http://localhost:5173");
} else if (win) {
  for (const s of toStart) {
    const ps = `$Host.UI.RawUI.WindowTitle = '視窗 ${s.name}'; Set-Location '${root}'; ${s.cmd}`;
    spawn("powershell.exe", ["-NoExit", "-Command", ps], { cwd: root, detached: true, stdio: "ignore", windowsHide: false }).unref();
    console.log(`啟動 視窗 ${s.name}：${s.cmd}`);
  }
  console.log("\n等各視窗出現 ready 訊息後，瀏覽器開 http://localhost:5173 。要停止就關掉對應的視窗。");
} else {
  const children = toStart.map((s) => {
    const [bin, ...args] = s.cmd.split(" ");
    const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: true });
    const tag = `[${s.name}] `;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => process.stdout.write(String(chunk).replace(/^/gm, tag)));
    }
    return child;
  });
  const stop = () => {
    for (const c of children) c.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("瀏覽器開 http://localhost:5173 ；Ctrl+C 停止全部服務。");
}
