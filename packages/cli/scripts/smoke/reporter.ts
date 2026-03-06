/**
 * Terminal table and JSON file output for smoke test results.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeResult, ProviderResult, SmokeRunResult } from "./types.js";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const useColors = process.stdout.isTTY;

function color(text: string, code: string): string {
  if (!useColors) return text;
  return `${code}${text}${RESET}`;
}

function renderStatus(result: ProbeResult | undefined): string {
  if (!result) return color("  —  ", DIM);
  switch (result.status) {
    case "pass":
      return color(" PASS ", GREEN);
    case "fail":
      return color(" FAIL ", RED);
    case "skip":
      return color(" SKIP ", YELLOW);
    default:
      return color("  ?  ", DIM);
  }
}

function padEnd(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  const padLen = Math.max(0, len - stripped.length);
  return str + " ".repeat(padLen);
}

/**
 * Print a formatted table of results to stdout.
 *
 * @param results - Provider results to display
 * @param quiet - If true, only print FAIL rows and summary
 */
export function printTable(results: ProviderResult[], quiet: boolean): void {
  const COL_PROVIDER = 20;
  const COL_MODEL = 30;
  const COL_STATUS = 8;

  const header =
    color(padEnd("Provider", COL_PROVIDER), BOLD) +
    color(padEnd("Model", COL_MODEL), BOLD) +
    padEnd("Tools", COL_STATUS) +
    padEnd("Reasoning", COL_STATUS) +
    padEnd("Vision", COL_STATUS);

  const separator = "─".repeat(COL_PROVIDER + COL_MODEL + COL_STATUS * 3);

  if (!quiet) {
    console.log(header);
    console.log(color(separator, DIM));
  }

  for (const result of results) {
    const toolProbe = result.probes.find((p) => p.capability === "tool_calling");
    const reasoningProbe = result.probes.find((p) => p.capability === "reasoning");
    const visionProbe = result.probes.find((p) => p.capability === "vision");

    const hasFail = result.probes.some((p) => p.status === "fail");

    if (quiet && !hasFail) continue;

    const row =
      padEnd(result.provider, COL_PROVIDER) +
      padEnd(result.model, COL_MODEL) +
      padEnd(renderStatus(toolProbe), COL_STATUS + 6) + // +6 for ANSI escape overhead
      padEnd(renderStatus(reasoningProbe), COL_STATUS + 6) +
      renderStatus(visionProbe);

    console.log(row);

    // Print failure details
    if (!quiet) {
      for (const probe of result.probes) {
        if (probe.status === "fail" && probe.reason) {
          console.log(color(`  ${probe.capability}: ${probe.reason}`, RED));
        }
      }
    }
  }
}

/**
 * Print a summary line with counts.
 */
export function printSummary(run: SmokeRunResult): void {
  const { total, passed, failed, skipped } = run.summary;
  const passedStr = color(`${passed} passed`, passed > 0 ? GREEN : DIM);
  const failedStr = color(`${failed} failed`, failed > 0 ? RED : DIM);
  const skippedStr = color(`${skipped} skipped`, skipped > 0 ? YELLOW : DIM);

  console.log("");
  console.log(
    `${total} providers: ${passedStr}, ${failedStr}, ${skippedStr}  (total time: ${run.durationMs}ms)`
  );
}

/**
 * Write results to a JSON file in the results directory.
 * Creates the directory if it does not exist.
 */
export function writeJsonResults(run: SmokeRunResult, resultsDir?: string): void {
  // Default to packages/cli/results relative to this script's location
  const dir = resultsDir ?? join(import.meta.dir, "../../results");
  mkdirSync(dir, { recursive: true });

  const filename = `smoke-${run.runId}.json`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`\nResults written to: ${filepath}`);
}

/**
 * Build the summary stats from a set of provider results.
 */
export function buildSummary(results: ProviderResult[]): SmokeRunResult["summary"] {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    for (const p of r.probes) {
      if (p.status === "pass") passed++;
      else if (p.status === "fail") failed++;
      else if (p.status === "skip") skipped++;
    }
  }

  return {
    total: results.length,
    passed,
    failed,
    skipped,
  };
}
