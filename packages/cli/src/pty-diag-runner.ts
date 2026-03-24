import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * MtmDiagRunner spawns Claude Code inside mtm — a real terminal multiplexer.
 *
 * Layout:
 *   Top pane  (~97%): Claude Code with a REAL PTY — mtm owns the terminal
 *   Bottom pane (~1 line): claudish status bar (model, errors)
 *
 * mtm is launched with:
 *   mtm -e "claude args..." -s 3 -b "status watcher"
 *
 * Diagnostics are written to ~/.claudish/diag-<PID>.log.
 * Status bar is updated via ~/.claudish/status-<PID>.txt.
 */
export class MtmDiagRunner {
  private mtmProc: ChildProcess | null = null;
  private logPath: string;
  private statusPath: string;
  private logStream: WriteStream | null = null;

  constructor() {
    const dir = join(homedir(), ".claudish");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Already exists
    }
    this.logPath = join(dir, `diag-${process.pid}.log`);
    this.statusPath = join(dir, `status-${process.pid}.txt`);
    this.logStream = createWriteStream(this.logPath, { flags: "w" });
    this.logStream.on("error", () => {}); // Best-effort
    // Initialize status bar — must end with newline for tail -f -n1 to display
    try {
      writeFileSync(this.statusPath, renderStatusBar({ model: "", provider: "", errorCount: 0, lastError: "" }) + "\n");
    } catch {}
  }

  /**
   * Launch mtm with Claude Code in the top pane. Returns the exit code when
   * mtm exits (which happens when Claude Code exits, closing the last pane).
   *
   * @param claudeCommand  Full path to the claude binary
   * @param claudeArgs     Arguments to pass to claude
   * @param env            Environment variables for the claude process
   */
  async run(
    claudeCommand: string,
    claudeArgs: string[],
    env: Record<string, string>
  ): Promise<number> {
    const mtmBin = this.findMtmBinary();

    // Build the claude command — just the binary + args, no env vars inline.
    // Environment is passed via spawn's env option (inherited by mtm's child panes).
    const quotedArgs = claudeArgs.map((a) => shellQuote(a)).join(" ");
    const claudeCmd = `${shellQuote(claudeCommand)} ${quotedArgs}`;

    // Merge claudish env overrides with current process env.
    // mtm inherits this env and passes it to child panes (both top and bottom).
    const mergedEnv = { ...process.env, ...env } as Record<string, string>;

    // Launch mtm:
    // -e claudeCmd  : run claude in the main pane
    // -S statusPath : render status bar on the last row (not a pane, just 1 ncurses line)
    // stdio: inherit — mtm gets direct terminal access
    this.mtmProc = spawn(mtmBin, ["-e", claudeCmd, "-S", this.statusPath], {
      stdio: "inherit",
      env: mergedEnv,
    });

    const exitCode = await new Promise<number>((resolve) => {
      this.mtmProc!.on("exit", (code) => resolve(code ?? 1));
      this.mtmProc!.on("error", () => resolve(1));
    });

    this.cleanup();
    return exitCode;
  }

  /**
   * Write a diagnostic message to the log file AND update the status bar.
   */
  write(msg: string): void {
    if (!this.logStream) return;
    const timestamp = new Date().toISOString();
    try {
      this.logStream.write(`[${timestamp}] ${msg}\n`);
    } catch {
      // Ignore write errors — diag output is best-effort
    }
    // Parse and track errors
    const parsed = parseLogMessage(msg);
    if (parsed.isError) {
      this.errorCount++;
      this.lastError = parsed.short;
      if (parsed.provider) this.provider = parsed.provider;
    }
    this.refreshStatusBar();
  }

  /** Current status bar state */
  private modelName = "";
  private provider = "";
  private lastError = "";
  private errorCount = 0;

  /**
   * Set the model name shown in the status bar.
   */
  setModel(name: string): void {
    // Strip vendor prefix: "openrouter/hunter-alpha" → "hunter-alpha"
    this.modelName = name.includes("/") ? name.split("/").pop()! : name;
    // Extract provider from prefix if present
    if (name.includes("@")) {
      this.provider = name.split("@")[0];
    } else if (name.includes("/")) {
      this.provider = name.split("/")[0];
    }
    this.refreshStatusBar();
  }

  /**
   * Render and write the ANSI-formatted status bar to the status file.
   */
  private refreshStatusBar(): void {
    const bar = renderStatusBar({
      model: this.modelName,
      provider: this.provider,
      errorCount: this.errorCount,
      lastError: this.lastError,
    });
    try {
      // Append new line — tail -f picks it up and shows the latest
      appendFileSync(this.statusPath, bar + "\n");
    } catch {
      // Best-effort
    }
  }

  /**
   * Get the diag log file path for this session.
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Clean up: close the log stream and remove the ephemeral log file.
   */
  cleanup(): void {
    if (this.logStream) {
      try {
        this.logStream.end();
      } catch {
        // Ignore
      }
      this.logStream = null;
    }
    try { unlinkSync(this.logPath); } catch {}
    try { unlinkSync(this.statusPath); } catch {}
    if (this.mtmProc) {
      try {
        this.mtmProc.kill();
      } catch {
        // Process may already be gone
      }
      this.mtmProc = null;
    }
  }

  /**
   * Find the mtm binary. Priority:
   * 1. Bundled platform-specific binary (native/mtm/mtm-<platform>-<arch>)
   * 2. Built binary in source tree (native/mtm/mtm) — for development
   * 3. mtm in PATH
   */
  findMtmBinary(): string {
    // Resolve __dirname equivalent for ESM
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);

    const platform = process.platform;
    const arch = process.arch;

    // 1. Platform-specific bundled binary (distributed with npm package)
    const bundledPlatform = join(thisDir, "..", "..", "native", "mtm", `mtm-${platform}-${arch}`);
    if (existsSync(bundledPlatform)) return bundledPlatform;

    // 2. Generic built binary (dev mode — run `make` in packages/cli/native/mtm/)
    const builtDev = join(thisDir, "..", "native", "mtm", "mtm");
    if (existsSync(builtDev)) return builtDev;

    // 3. mtm in PATH
    try {
      const result = execSync("which mtm", { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {
      // Not in PATH
    }

    throw new Error("mtm binary not found. Build it with: cd packages/cli/native/mtm && make");
  }
}

/**
 * Shell-quote a string so it can be safely embedded in a shell command.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

interface StatusBarState {
  model: string;
  provider: string;
  errorCount: number;
  lastError: string;
}

/**
 * Render the status bar in mtm's tab-separated format.
 * Each segment: "COLOR:text" separated by tabs.
 * Colors: M=magenta, C=cyan, G=green, R=red, D=dim, W=white
 * mtm renders each segment as a colored pill using ncurses.
 */
function renderStatusBar(state: StatusBarState): string {
  const { model, provider, errorCount, lastError } = state;

  const parts: string[] = [];

  parts.push("M: claudish ");
  if (model) parts.push(`C: ${model} `);
  if (provider) parts.push(`D: ${provider} `);

  if (errorCount > 0) {
    const errLabel = errorCount === 1 ? " ⚠ 1 error " : ` ⚠ ${errorCount} errors `;
    parts.push(`R:${errLabel}`);
    if (lastError) parts.push(`D: ${lastError} `);
  } else {
    parts.push("G: ● ok ");
  }

  return parts.join("\t");
}

/**
 * Parse a logStderr message into a short, human-readable form.
 */
function parseLogMessage(msg: string): { isError: boolean; short: string; provider?: string } {
  // Extract provider name: "Error [OpenRouter]: ..."
  const providerMatch = msg.match(/\[(\w+)\]/);
  const provider = providerMatch?.[1];

  // HTTP status errors — extract the human-readable part
  const httpMatch = msg.match(/HTTP (\d{3})/);
  if (httpMatch) {
    // Try to extract error message from JSON body
    const jsonMatch = msg.match(/"message"\s*:\s*"([^"]+)"/);
    if (jsonMatch?.[1]) {
      const detail = jsonMatch[1]
        .replace(/is not a valid model ID/, "invalid model")
        .replace(/Provider returned error/, "provider error");
      return { isError: true, short: detail, provider };
    }
    // Extract the hint after "HTTP NNN. "
    const hintMatch = msg.match(/HTTP \d{3}\.\s*(.+?)\.?\s*$/);
    if (hintMatch?.[1]) {
      return { isError: true, short: hintMatch[1], provider };
    }
    return { isError: true, short: `HTTP ${httpMatch[1]}`, provider };
  }

  // Fallback chain messages
  if (msg.includes("[Fallback]")) {
    const countMatch = msg.match(/(\d+) provider/);
    return { isError: false, short: `fallback: ${countMatch?.[1] || "?"} providers`, provider };
  }

  // Generic error
  if (msg.toLowerCase().includes("error")) {
    // Trim to key part
    const short = msg.replace(/^Error\s*\[\w+\]:\s*/, "").replace(/\.\s*$/, "");
    return { isError: true, short: short.length > 40 ? short.slice(0, 39) + "…" : short, provider };
  }

  return { isError: false, short: msg.length > 40 ? msg.slice(0, 39) + "…" : msg };
}

/**
 * Try to create an MtmDiagRunner. Returns null if mtm binary is not available.
 */
export async function tryCreateMtmRunner(): Promise<MtmDiagRunner | null> {
  try {
    const runner = new MtmDiagRunner();
    // Verify we can find the mtm binary before committing
    runner.findMtmBinary();
    return runner;
  } catch {
    return null;
  }
}

// Re-export DiagMessage interface for use by other modules
export interface DiagMessage {
  text: string;
  level: "error" | "warn" | "info";
}

/**
 * PtyDiagRunner is kept as a type alias for backward compatibility.
 * New code should use MtmDiagRunner directly.
 * @deprecated Use MtmDiagRunner
 */
export { MtmDiagRunner as PtyDiagRunner };

/**
 * tryCreatePtyRunner is kept for backward compatibility with index.ts.
 * @deprecated Use tryCreateMtmRunner
 */
export const tryCreatePtyRunner = tryCreateMtmRunner;
