#!/usr/bin/env node
// 一鍵啟動：API、網頁、本機人像、本機語音，全部在「同一個終端機」裡執行。
//
//   pnpm dev              一個視窗跑全部；畫面只顯示狀態與錯誤，完整記錄寫到 data/logs/
//   pnpm dev -- --verbose 同上，但把每個服務的輸出都印出來
//   pnpm dev -- --no-open 不要自動開瀏覽器
//   pnpm dev:windows      舊方式（僅 Windows）：每個服務各開一個 PowerShell 視窗
//
// 停止：按一次 Ctrl+C，等「已全部停止」。API 會先把進行中的工作收好（最多約 25 秒）；
// 再按一次 Ctrl+C 才是強制結束。已經在跑的服務（健康檢查有回應）會略過，不會重複啟動。
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose");
const separateWindows = args.has("--windows");
const openBrowser = !args.has("--no-open");
const URL = "http://localhost:5173";
/** Longer than the API's own wind-down (20 s for a presenter task being created, plus margin). */
const STOP_WAIT_MS = 26_000;

const venvPython = (worker) => join(root, "workers", worker, ".venv", win ? "Scripts/python.exe" : "bin/python");
const resolveFrom = (pkgDir, request) => createRequire(join(root, pkgDir, "package.json")).resolve(request);

// Each service is started directly (no pnpm, no shell in between), so one Ctrl+C reaches each
// process exactly once and nothing is left behind when a wrapper exits first.
const services = [
  {
    id: "api",
    name: "API",
    required: true,
    health: "http://127.0.0.1:4000/health",
    cwd: join(root, "apps/api"),
    // One process, no file watcher: a watcher kills the API at once on Ctrl+C (on Windows), before
    // running jobs are put back in the queue and the database is closed.
    command: () => [process.execPath, ["--import", "tsx", "src/main.ts"]],
    windowCmd: "pnpm serve:api",
  },
  {
    id: "web",
    name: "網頁",
    required: true,
    health: "http://127.0.0.1:5173/",
    cwd: join(root, "apps/web"),
    command: () => [process.execPath, [join(dirname(resolveFrom("apps/web", "vite/package.json")), "bin/vite.js")]],
    windowCmd: "pnpm --filter @lvs/web dev",
  },
  {
    id: "avatar",
    name: "本機人像",
    health: "http://127.0.0.1:8765/health",
    cwd: join(root, "workers/avatar-local"),
    needs: venvPython("avatar-local"),
    install: "workers\\avatar-local\\install.ps1",
    command: () => [venvPython("avatar-local"), ["-m", "lvs_avatar"]],
    windowCmd: "pnpm dev:avatar",
  },
  {
    id: "tts",
    name: "本機語音",
    health: "http://127.0.0.1:8766/health",
    cwd: join(root, "workers/tts-local"),
    needs: venvPython("tts-local"),
    install: "workers\\tts-local\\install.ps1",
    command: () => [venvPython("tts-local"), ["-m", "lvs_tts"]],
    windowCmd: "pnpm dev:tts",
  },
];

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const yellow = (s) => paint("33", s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const say = (line = "") => process.stdout.write(`${line}\n`);

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

/** What a line of service output means for the terminal when not in --verbose. */
export function classify(serviceId, line, state = {}) {
  if (!line.trim()) return null;
  if (serviceId === "api") {
    // pino JSON: level 40 = warn, 50 = error, 60 = fatal.
    try {
      const o = JSON.parse(line);
      if (typeof o.level === "number" && o.level >= 40) {
        const detail = typeof o.err === "string" ? o.err : (o.err?.message ?? "");
        return { level: o.level >= 50 ? "error" : "warn", text: [o.msg, detail].filter(Boolean).join("：") };
      }
      return null;
    } catch {
      // Not JSON: start-up notices (dotenv) stay in the log file; a crash message is shown.
      return /error|fatal|無法|失敗|EADDRINUSE/i.test(line) ? { level: "error", text: line } : null;
    }
  }
  if (serviceId === "web") return /error|failed/i.test(line) ? { level: "error", text: line } : null;
  // Python workers: warnings, errors and whole tracebacks (indented lines up to the exception line).
  if (/^Traceback /.test(line)) {
    state.trace = true;
    return { level: "error", text: line };
  }
  if (state.trace) {
    if (!/^\s/.test(line)) state.trace = false;
    return { level: "error", text: line };
  }
  if (/\b(ERROR|CRITICAL)\b/.test(line)) return { level: "error", text: line };
  if (/\bWARNING\b/.test(line)) return { level: "warn", text: line };
  return null;
}

async function main() {
  const toStart = [];
  for (const s of services) {
    if (s.needs && !existsSync(s.needs)) {
      say(dim(`－ ${s.name}：尚未安裝，略過（要用時先執行 ${s.install}）`));
      continue;
    }
    if (await isUp(s.health)) {
      say(green(`✔ ${s.name} 已在執行`));
      s.ready = true;
      continue;
    }
    toStart.push(s);
  }

  if (toStart.length === 0) {
    // No process.exit here: on Windows it trips a libuv assertion while fetch handles are closing.
    say(`全部服務都已經在跑。瀏覽器開 ${URL}`);
    return;
  }
  if (separateWindows) return void startInWindows(toStart);

  // The API imports the built workspace packages; build them once up front (quiet unless it fails).
  if (toStart.some((s) => s.id === "api")) {
    say(dim("準備中（建置共用套件）…"));
    const build = spawnSync("pnpm build:libs", { cwd: root, shell: true, encoding: "utf8" });
    if (build.status !== 0) {
      say(red("✖ 建置失敗，無法啟動："));
      say((build.stdout ?? "") + (build.stderr ?? ""));
      process.exitCode = 1;
      return;
    }
  }

  const logDir = join(root, "data", "logs");
  mkdirSync(logDir, { recursive: true });
  let stopping = false;

  for (const s of toStart) {
    const [bin, binArgs] = s.command();
    s.log = createWriteStream(join(logDir, `${s.id}.log`), { flags: "w" });
    s.tail = [];
    s.state = {};
    // POSIX: own process group, so the terminal's Ctrl+C reaches only this launcher, which then
    // passes one SIGTERM on (the API treats a second signal as "force"). Windows has no such
    // signal to send; there every process on the console receives the Ctrl+C itself.
    s.child = spawn(bin, binArgs, { cwd: s.cwd, env: { ...process.env, ...(s.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: !win });
    let pending = "";
    const onData = (chunk) => {
      s.log.write(chunk);
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        s.tail.push(line);
        if (s.tail.length > 20) s.tail.shift();
        if (verbose) {
          if (line.trim()) say(`${dim(`[${s.name}]`)} ${line}`);
          continue;
        }
        const shown = classify(s.id, line, s.state);
        if (shown) say(`${shown.level === "error" ? red(`[${s.name}]`) : shown.level === "warn" ? yellow(`[${s.name}]`) : dim(`[${s.name}]`)} ${shown.text}`);
      }
    };
    s.child.stdout.on("data", onData);
    s.child.stderr.on("data", onData);
    s.child.on("error", (err) => say(red(`✖ ${s.name} 無法啟動：${err.message}`)));
    s.child.on("exit", (code, signal) => {
      s.exited = true;
      s.log.end();
      if (stopping) return void say(dim(`－ ${s.name} 已停止`));
      say(red(`✖ ${s.name} 意外停止（${signal ?? `代碼 ${code}`}）。最後的輸出：`));
      for (const line of s.tail.filter((l) => l.trim()).slice(-12)) say(dim(`    ${line}`));
      say(dim(`    完整記錄：data/logs/${s.id}.log`));
      if (s.required) say(yellow(`  ${s.name} 是必要的服務；修正後按 Ctrl+C 停止再重新執行 pnpm dev。`));
    });
    say(dim(`… ${s.name} 啟動中`));
  }

  // Announce each service once it answers; open the page when both required ones do.
  let announced = false;
  const watch = setInterval(async () => {
    for (const s of toStart) {
      // `checking`: a slow probe must not be started again by the next tick.
      if (s.ready || s.exited || s.checking) continue;
      s.checking = true;
      const up = await isUp(s.health);
      s.checking = false;
      if (up && !s.ready) {
        s.ready = true;
        say(green(`✔ ${s.name} 已就緒`));
      }
    }
    const required = services.filter((s) => s.required);
    if (!announced && !stopping && required.every((s) => s.ready)) {
      announced = true;
      say();
      say(bold(`  可以使用了：${URL}`));
      say(dim("  停止：按一次 Ctrl+C，等「已全部停止」再關視窗。記錄檔在 data/logs/"));
      say();
      if (openBrowser) openUrl(URL);
    }
    if (toStart.every((s) => s.ready || s.exited)) clearInterval(watch);
  }, 1000);

  const alive = () => toStart.filter((s) => !s.exited);
  const forceKill = () => {
    for (const s of alive()) {
      // /T: the TTS worker runs its engines as child processes.
      if (win) spawnSync("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], { stdio: "ignore" });
      else {
        try {
          process.kill(-s.child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  };
  const stop = (signal) => {
    if (stopping) {
      say(red("強制結束。"));
      forceKill();
      process.exit(1);
    }
    stopping = true;
    clearInterval(watch);
    say();
    say(yellow("正在停止…（API 會先把進行中的工作收好，最多約 25 秒；再按一次 Ctrl+C 強制結束）"));
    if (!win) for (const s of alive()) s.child.kill("SIGTERM");
    // Closing the window gives every process about 5 s; nothing more to arrange here.
    const deadline = setTimeout(() => {
      say(yellow("有服務沒有在時限內結束，改為強制結束。"));
      forceKill();
    }, signal === "SIGHUP" ? 4000 : STOP_WAIT_MS);
    const done = setInterval(() => {
      if (alive().length > 0) return;
      clearInterval(done);
      clearTimeout(deadline);
      say(green("已全部停止。"));
      process.exit(0);
    }, 200);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => stop(sig));
}

/** Legacy mode (Windows): one PowerShell window per service; closing a window stops that service. */
function startInWindows(toStart) {
  if (!win) {
    say("--windows 只適用於 Windows；請直接執行 pnpm dev。");
    return;
  }
  for (const s of toStart) {
    const ps = `$Host.UI.RawUI.WindowTitle = '${s.name}'; Set-Location '${root}'; ${s.windowCmd}`;
    spawn("powershell.exe", ["-NoExit", "-Command", ps], { cwd: root, detached: true, stdio: "ignore", windowsHide: false }).unref();
    say(`啟動視窗「${s.name}」：${s.windowCmd}`);
  }
  say(`\n等各視窗出現 ready 訊息後，瀏覽器開 ${URL} 。要停止就在各視窗按 Ctrl+C。`);
}

function openUrl(url) {
  try {
    if (win) spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the address is printed above */
  }
}

// Imported by the test for `classify`; run only when invoked as a script.
const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(resolve(fileURLToPath(import.meta.url)), resolve(process.argv[1]))) await main();
