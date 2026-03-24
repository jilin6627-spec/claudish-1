import { createWriteStream, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WriteStream } from "node:fs";
import type { MtmDiagRunner } from "./pty-diag-runner.js";

// Backward-compat alias so old call sites using PtyDiagRunner still compile
type PtyDiagRunner = MtmDiagRunner;

/**
 * DiagOutput separates claudish diagnostic messages from Claude Code's TUI.
 * Instead of writing to stderr (which corrupts the TUI), diagnostic messages
 * are routed to a file or a dedicated tmux pane.
 */
export interface DiagOutput {
  write(msg: string): void;
  cleanup(): void;
}

/**
 * Get the path to the claudish directory, creating it if needed.
 */
function getClaudishDir(): string {
  const dir = join(homedir(), ".claudish");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Already exists
  }
  return dir;
}

/**
 * Get a session-unique diag log file path.
 * Uses PID to avoid conflicts when multiple claudish sessions run simultaneously.
 */
function getDiagLogPath(): string {
  return join(getClaudishDir(), `diag-${process.pid}.log`);
}

/**
 * LogFileDiagOutput writes diagnostic messages to ~/.claudish/diag.log.
 * Truncates the log on session start (overwrite mode). Includes timestamps.
 */
export class LogFileDiagOutput implements DiagOutput {
  protected logPath: string;
  protected stream: WriteStream;

  constructor() {
    this.logPath = getDiagLogPath();

    // Write session header (truncates previous session)
    try {
      writeFileSync(this.logPath, `--- claudish diag session ${new Date().toISOString()} ---\n`);
    } catch {
      // If write fails, we'll still try the stream
    }

    // Open append stream for subsequent writes
    this.stream = createWriteStream(this.logPath, { flags: "a" });
    this.stream.on("error", () => {}); // Best-effort — never crash on write errors
  }

  write(msg: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
      this.stream.write(line);
    } catch {
      // Ignore write errors — diag output is best-effort
    }
  }

  cleanup(): void {
    try {
      this.stream.end();
    } catch {
      // Ignore
    }
    // Remove session-specific diag file (ephemeral, not needed after exit)
    try {
      unlinkSync(this.logPath);
    } catch {
      // Ignore — file may already be gone
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}

/**
 * TmuxDiagOutput extends LogFileDiagOutput to also open a small tmux pane
 * at the bottom of the terminal showing a live tail of the log file.
 */
export class TmuxDiagOutput extends LogFileDiagOutput {
  private paneId: string | null = null;

  constructor() {
    super();
    this.openTmuxPane();
  }

  private openTmuxPane(): void {
    try {
      // Split a small pane (5 lines) at the bottom, detached (-d), print pane id (-P)
      // Uses execFileSync to avoid shell injection from logPath
      // -t targets the pane where claudish is running (not whichever pane is active)
      const targetPane = process.env.TMUX_PANE || "";
      const args = ["split-window", "-v", "-l", "5", "-d", "-P", "-F", "#{pane_id}"];
      if (targetPane) {
        args.push("-t", targetPane);
      }
      args.push("tail", "-f", this.logPath);
      const output = execFileSync("tmux", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.paneId = output.trim();
    } catch {
      // Tmux might be detected but fail (e.g., not enough space, wrong version)
      // Fall back to log-file-only mode silently
      this.paneId = null;
    }
  }

  cleanup(): void {
    if (this.paneId) {
      try {
        execFileSync("tmux", ["kill-pane", "-t", this.paneId], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // Pane may already be gone — idempotent
      }
      this.paneId = null;
    }
    super.cleanup();
  }
}

/**
 * MtmDiagOutput routes diagnostics to the MtmDiagRunner's log file.
 * The mtm bottom pane shows the log live via `tail -f`.
 */
export class MtmDiagOutput implements DiagOutput {
  constructor(private runner: MtmDiagRunner) {}

  write(msg: string): void {
    this.runner.write(msg);
  }

  cleanup(): void {
    // MtmDiagRunner cleanup is handled when the mtm process exits.
    // We don't call runner.cleanup() here because that would delete the log
    // file while mtm is still running and showing it.
  }
}

/**
 * OpentUiDiagOutput is kept for backward compatibility but now wraps
 * MtmDiagOutput. New code uses MtmDiagOutput directly.
 * @deprecated Use MtmDiagOutput
 */
export class OpentUiDiagOutput implements DiagOutput {
  private inner: MtmDiagOutput;

  constructor(runner: PtyDiagRunner) {
    this.inner = new MtmDiagOutput(runner);
  }

  write(msg: string): void {
    this.inner.write(msg);
  }

  cleanup(): void {
    this.inner.cleanup();
  }
}

/**
 * NullDiagOutput is a no-op. Used in single-shot mode where stderr is
 * available normally (Claude Code not running as TUI).
 */
export class NullDiagOutput implements DiagOutput {
  write(_msg: string): void {
    // no-op
  }

  cleanup(): void {
    // no-op
  }
}

/**
 * Factory: create the appropriate DiagOutput based on config and environment.
 *
 * diagMode controls which implementation is used:
 *   "auto" (default) → mtm → tmux → log file (priority order)
 *   "pty"            → mtm only (fall back to logfile if unavailable)
 *   "tmux"           → tmux pane only (fall back to logfile if not in tmux)
 *   "logfile"        → log file only (no live display)
 *   "off"            → no diagnostics at all
 *
 * Env var: CLAUDISH_DIAG_MODE=pty|tmux|logfile|off
 * CLI flag: --diag-mode pty|tmux|logfile|off
 */
export function createDiagOutput(options: {
  interactive: boolean;
  ptyRunner?: PtyDiagRunner | null;
  mtmRunner?: MtmDiagRunner | null;
  diagMode?: "auto" | "pty" | "tmux" | "logfile" | "off";
}): DiagOutput {
  if (!options.interactive) {
    return new NullDiagOutput();
  }

  const mode = options.diagMode || "auto";

  if (mode === "off") {
    return new NullDiagOutput();
  }

  // Resolve mtm runner (accept either ptyRunner or mtmRunner for compat)
  const mtmRunner = options.mtmRunner ?? options.ptyRunner ?? null;

  if (mode === "pty" || mode === "auto") {
    if (mtmRunner) {
      return new MtmDiagOutput(mtmRunner);
    }
    // pty explicitly requested but unavailable — fall through
    if (mode === "pty") {
      return new LogFileDiagOutput();
    }
  }

  if (mode === "tmux" || mode === "auto") {
    if (process.env.TMUX) {
      return new TmuxDiagOutput();
    }
    if (mode === "tmux") {
      return new LogFileDiagOutput();
    }
  }

  return new LogFileDiagOutput();
}
