import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  setupSession,
  type TeamManifest,
  type TeamStatus,
  type ModelStatus,
} from "./team-orchestrator.js";

// ─── Elapsed Time Formatting ──────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

// ─── Multiplexer Binary Detection ────────────────────────────────────────────

interface MultiplexerBinary {
  path: string;
  kind: "magmux" | "mtm";
}

/**
 * Find a terminal multiplexer binary. Priority:
 * 1. Dev-built magmux (native/magmux/magmux — freshest, has latest features)
 * 2. Bundled magmux (native/magmux/magmux-<platform>-<arch>)
 * 3. magmux in PATH
 * 4. Dev-built mtm (native/mtm/mtm) — fallback
 * 5. Bundled mtm (native/mtm/mtm-<platform>-<arch>) — fallback
 * 6. mtm in PATH (only our fork with -g) — fallback
 */
function findMultiplexerBinary(): MultiplexerBinary {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const pkgRoot = join(thisDir, "..");
  const platform = process.platform;
  const arch = process.arch;

  // 1. Dev-built magmux (freshest, has latest features)
  const builtMagmux = join(pkgRoot, "native", "magmux", "magmux");
  if (existsSync(builtMagmux)) return { path: builtMagmux, kind: "magmux" };

  // 2. Bundled magmux binary
  const bundledMagmux = join(pkgRoot, "native", "magmux", `magmux-${platform}-${arch}`);
  if (existsSync(bundledMagmux)) return { path: bundledMagmux, kind: "magmux" };

  // 3. magmux in PATH
  try {
    const result = execSync("which magmux", { encoding: "utf-8" }).trim();
    if (result) return { path: result, kind: "magmux" };
  } catch {
    /* not in PATH */
  }

  // 4. Dev-built mtm (fallback)
  const builtMtm = join(pkgRoot, "native", "mtm", "mtm");
  if (existsSync(builtMtm)) return { path: builtMtm, kind: "mtm" };

  // 5. Bundled mtm binary (fallback)
  const bundledMtm = join(pkgRoot, "native", "mtm", `mtm-${platform}-${arch}`);
  if (existsSync(bundledMtm)) return { path: bundledMtm, kind: "mtm" };

  // 6. mtm in PATH (fallback — only our fork with -g)
  try {
    const result = execSync("which mtm", { encoding: "utf-8" }).trim();
    if (result && isMtmForkWithGrid(result)) return { path: result, kind: "mtm" };
  } catch {
    /* not in PATH */
  }

  throw new Error(
    "No terminal multiplexer found. Install magmux (recommended) or build mtm:\n" +
      "  brew install MadAppGang/tap/magmux\n" +
      "  # or: cd packages/cli/native/mtm && make"
  );
}

/**
 * Check if an mtm binary is our fork with -g (grid) support.
 */
function isMtmForkWithGrid(binPath: string): boolean {
  try {
    const output = execSync(`"${binPath}" --help 2>&1 || true`, {
      encoding: "utf-8",
      timeout: 2000,
    });
    return output.includes("-g ");
  } catch {
    return false;
  }
}

// ─── Status Bar Rendering ─────────────────────────────────────────────────────

interface GridStatusCounts {
  done: number;
  running: number;
  failed: number;
  total: number;
  elapsedMs: number;
  allDone: boolean;
}

/**
 * Render the aggregate team status bar in mtm's tab-separated pill format.
 * Colors: M=magenta, C=cyan, G=green, R=red, D=dim, W=white
 */
function renderGridStatusBar(counts: GridStatusCounts): string {
  const elapsed = formatElapsed(counts.elapsedMs);
  const { done, running, failed, total, allDone } = counts;

  if (allDone) {
    if (failed > 0) {
      return [
        "C: claudish team",
        `G: ${done} done`,
        `R: ${failed} failed`,
        `D: ${elapsed}`,
        "R: \u2717 issues",
        "D: ctrl-g q to quit",
      ].join("\t");
    }
    return [
      "C: claudish team",
      `G: ${total} done`,
      `D: ${elapsed}`,
      "G: \u2713 complete",
      "D: ctrl-g q to quit",
    ].join("\t");
  }

  return [
    "C: claudish team",
    `G: ${done} done`,
    `C: ${running} running`,
    `R: ${failed} failed`,
    `D: ${elapsed}`,
  ].join("\t");
}

// ─── Status Polling ───────────────────────────────────────────────────────────

interface PollState {
  statusCache: TeamStatus;
  statusPath: string;
  sessionPath: string;
  anonIds: string[];
  startTime: number;
  timeoutMs: number;
  statusbarPath: string;
  completedAtMs: number | null; // frozen elapsed time when all done
}

/**
 * Check all model exit-code marker files and update status.json + statusbar.
 * Returns true when all models have reached a terminal state.
 */
function pollStatus(state: PollState): boolean {
  const { statusCache, statusPath, sessionPath, anonIds, startTime, timeoutMs, statusbarPath } =
    state;

  const elapsedMs = Date.now() - startTime;
  let changed = false;

  let done = 0;
  let running = 0;
  let failed = 0;

  for (const anonId of anonIds) {
    const current = statusCache.models[anonId];

    // Already terminal — skip
    if (
      current.state === "COMPLETED" ||
      current.state === "FAILED" ||
      current.state === "TIMEOUT"
    ) {
      if (current.state === "COMPLETED") done++;
      else failed++;
      continue;
    }

    const exitCodePath = join(sessionPath, "work", anonId, ".exit-code");

    if (existsSync(exitCodePath)) {
      const codeStr = readFileSync(exitCodePath, "utf-8").trim();
      const code = parseInt(codeStr, 10);
      const isSuccess = code === 0;

      const newState: ModelStatus = {
        ...current,
        state: isSuccess ? "COMPLETED" : "FAILED",
        exitCode: code,
        startedAt: current.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        outputSize: 0,
      };
      statusCache.models[anonId] = newState;
      changed = true;

      if (isSuccess) done++;
      else failed++;
    } else {
      // Check for timeout
      if (elapsedMs > timeoutMs) {
        const newState: ModelStatus = {
          ...current,
          state: "TIMEOUT",
          startedAt: current.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          outputSize: 0,
        };
        statusCache.models[anonId] = newState;
        changed = true;
        failed++;
      } else {
        // Mark as RUNNING after first second (panes launch immediately)
        if (current.state === "PENDING" && elapsedMs > 1000) {
          statusCache.models[anonId] = {
            ...current,
            state: "RUNNING",
            startedAt: current.startedAt ?? new Date().toISOString(),
          };
          changed = true;
        }
        running++;
      }
    }
  }

  if (changed) {
    writeFileSync(statusPath, JSON.stringify(statusCache, null, 2), "utf-8");
  }

  const total = anonIds.length;
  const allDone = done + failed >= total;

  // Freeze elapsed time when all models complete
  if (allDone && !state.completedAtMs) {
    state.completedAtMs = elapsedMs;
  }

  const counts: GridStatusCounts = {
    done,
    running,
    failed,
    total,
    elapsedMs: state.completedAtMs ?? elapsedMs,
    allDone,
  };

  appendFileSync(statusbarPath, renderGridStatusBar(counts) + "\n");

  return allDone;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run multiple models in grid mode using mtm.
 *
 * Sets up the session directory, writes a gridfile with one claudish command
 * per line, launches mtm with the grid, and polls for completion.
 *
 * @param sessionPath  Absolute path to the session directory
 * @param models       Model IDs to run in parallel
 * @param input        Task prompt text
 * @param opts         Optional timeout (seconds, default 300)
 */
export async function runWithGrid(
  sessionPath: string,
  models: string[],
  input: string,
  opts?: { timeout?: number }
): Promise<TeamStatus> {
  const timeoutMs = (opts?.timeout ?? 300) * 1000;

  // 1. Set up session directory (manifest.json, status.json, work dirs, input.md)
  const manifest: TeamManifest = setupSession(sessionPath, models, input);

  // 2. Ensure errors directory exists and clean stale .exit-code files from previous runs
  mkdirSync(join(sessionPath, "errors"), { recursive: true });
  for (const anonId of Object.keys(manifest.models)) {
    const stale = join(sessionPath, "work", anonId, ".exit-code");
    try {
      unlinkSync(stale);
    } catch {
      /* doesn't exist — fine */
    }
  }

  // 3. Generate gridfile — one shell command per pane
  const gridfilePath = join(sessionPath, "gridfile.txt");
  // Read prompt once, shell-escape single quotes
  const prompt = readFileSync(join(sessionPath, "input.md"), "utf-8").replace(/'/g, "'\\''");

  const gridLines = Object.entries(manifest.models).map(([anonId]) => {
    const errorLog = join(sessionPath, "errors", `${anonId}.log`);
    const exitCodeFile = join(sessionPath, "work", anonId, ".exit-code");
    // Run claudish in print mode — streams text to stdout without alternate screen.
    // -p = print mode (headless), -v = verbose claudish logs, -y = auto-approve.
    const model = manifest.models[anonId].model;
    const paneIndex = Object.keys(manifest.models).indexOf(anonId);
    return [
      `claudish --model ${model} -y -v '${prompt}' 2>${errorLog};`,
      `_ec=$?; echo $_ec > ${exitCodeFile};`,
      `if [ -n "$MAGMUX_SOCK" ]; then`,
      `  if [ $_ec -eq 0 ]; then`,
      `    echo '{"cmd":"tint","pane":${paneIndex},"color":"green"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `    echo '{"cmd":"overlay","pane":${paneIndex},"text":"DONE","color":"green"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `  else`,
      `    echo '{"cmd":"tint","pane":${paneIndex},"color":"red"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `    echo '{"cmd":"overlay","pane":${paneIndex},"text":"FAIL","color":"red"}' | nc -U "$MAGMUX_SOCK" -w 1 2>/dev/null;`,
      `  fi;`,
      `fi;`,
      `exec sleep 86400`,
    ].join(" ");
  });
  writeFileSync(gridfilePath, gridLines.join("\n") + "\n", "utf-8");

  // 4. Find multiplexer binary (prefers magmux over mtm)
  const mux = findMultiplexerBinary();

  // 5. Set up status bar file path
  const statusbarPath = join(sessionPath, "statusbar.txt");
  const statusPath = join(sessionPath, "status.json");
  const statusCache: TeamStatus = JSON.parse(readFileSync(statusPath, "utf-8"));
  const anonIds = Object.keys(manifest.models);
  const startTime = Date.now();

  // Write initial status bar line before multiplexer starts
  appendFileSync(
    statusbarPath,
    renderGridStatusBar({
      done: 0,
      running: 0,
      failed: 0,
      total: anonIds.length,
      elapsedMs: 0,
      allDone: false,
    }) + "\n"
  );

  // 6. Start polling interval (500ms)
  const pollState: PollState = {
    statusCache,
    statusPath,
    sessionPath,
    anonIds,
    startTime,
    timeoutMs,
    statusbarPath,
    completedAtMs: null,
  };

  const pollInterval = setInterval(() => {
    pollStatus(pollState);
  }, 500);

  // 7. Spawn multiplexer with grid mode
  const spawnArgs = ["-g", gridfilePath, "-S", statusbarPath];
  if (mux.kind === "mtm") {
    spawnArgs.push("-t", "xterm-256color");
  } else {
    // magmux: auto-exit when all panes complete
    spawnArgs.push("-w");
  }
  // magmux sets TERM=screen-256color internally — no -t flag needed
  const proc = spawn(mux.path, spawnArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  // 8. Wait for multiplexer to exit
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });

  // 9. Clear polling interval and do one final poll
  clearInterval(pollInterval);
  pollStatus(pollState);

  // 10. Return final status
  return JSON.parse(readFileSync(statusPath, "utf-8")) as TeamStatus;
}
