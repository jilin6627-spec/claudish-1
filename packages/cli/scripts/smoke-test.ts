#!/usr/bin/env bun
/**
 * Claudish Smoke Test Suite
 *
 * Validates all available providers by running tool calling, reasoning,
 * and vision probes. Makes direct HTTP calls (no proxy server needed).
 *
 * Usage:
 *   bun run scripts/smoke-test.ts                      # all available providers
 *   bun run scripts/smoke-test.ts --provider kimi      # single provider
 *   bun run scripts/smoke-test.ts --quiet              # failures + summary only
 *   bun run scripts/smoke-test.ts --json-only          # no terminal table
 *   bun run scripts/smoke-test.ts --dry-run            # print what would run, no API calls
 *   bun run scripts/smoke-test.ts --timeout 60000      # custom timeout per probe (ms)
 */

import {
  runProbe,
  runReasoningProbe,
  runToolCallingProbe,
  runVisionProbe,
} from "./smoke/probes.js";
import { discoverProviders } from "./smoke/providers.js";
import { buildSummary, printSummary, printTable, writeJsonResults } from "./smoke/reporter.js";
import type {
  ProbeResult,
  ProviderResult,
  SmokeProviderConfig,
  SmokeRunResult,
} from "./smoke/types.js";

// ─────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────

interface CLIFlags {
  provider?: string;
  quiet: boolean;
  jsonOnly: boolean;
  dryRun: boolean;
  timeoutMs: number;
}

function parseCLIFlags(): CLIFlags {
  const args = process.argv.slice(2);
  const flags: CLIFlags = {
    quiet: false,
    jsonOnly: false,
    dryRun: false,
    timeoutMs: 30_000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
        flags.provider = args[++i];
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "--json-only":
        flags.jsonOnly = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--timeout":
        flags.timeoutMs = Number.parseInt(args[++i], 10) || 30_000;
        break;
    }
  }

  return flags;
}

// ─────────────────────────────────────────────────────────────
// Dry run
// ─────────────────────────────────────────────────────────────

function printDryRun(configs: SmokeProviderConfig[]): void {
  console.log("DRY RUN — no API calls will be made\n");
  console.log(`Found ${configs.length} provider(s):\n`);

  for (const c of configs) {
    console.log(`  ${c.name}`);
    console.log(`    model:    ${c.representativeModel}`);
    console.log(`    format:   ${c.wireFormat}`);
    console.log(`    endpoint: ${c.baseUrl}${c.apiPath}`);
    console.log(`    auth:     ${c.authScheme}`);
    const probes = [];
    probes.push("reasoning");
    if (c.capabilities.supportsTools) probes.push("tool_calling");
    if (c.capabilities.supportsVision) probes.push("vision");
    console.log(`    probes:   ${probes.join(", ")}`);
    console.log("");
  }
}

// ─────────────────────────────────────────────────────────────
// Build a failed result when a provider crashes entirely
// ─────────────────────────────────────────────────────────────

function buildFailedProviderResult(config: SmokeProviderConfig, reason: string): ProviderResult {
  const failProbe = (cap: ProbeResult["capability"]): ProbeResult => ({
    capability: cap,
    status: "fail",
    durationMs: 0,
    reason,
  });

  return {
    provider: config.name,
    model: config.representativeModel,
    wireFormat: config.wireFormat,
    timestamp: new Date().toISOString(),
    probes: [failProbe("tool_calling"), failProbe("reasoning"), failProbe("vision")],
  };
}

// ─────────────────────────────────────────────────────────────
// Per-provider probe runner
// ─────────────────────────────────────────────────────────────

async function runProviderProbes(
  config: SmokeProviderConfig,
  timeoutMs: number
): Promise<ProviderResult> {
  const timestamp = new Date().toISOString();

  // Run all three probes concurrently — Promise.allSettled so one failure
  // doesn't abort the other probes (C3 fix: allSettled at per-probe level)
  const settled = await Promise.allSettled([
    runProbe("tool_calling", runToolCallingProbe, config, timeoutMs),
    runProbe("reasoning", runReasoningProbe, config, timeoutMs),
    runProbe("vision", runVisionProbe, config, timeoutMs),
  ]);

  const probes: ProbeResult[] = settled.map((s, i) => {
    const caps: ProbeResult["capability"][] = ["tool_calling", "reasoning", "vision"];
    if (s.status === "fulfilled") return s.value;
    return {
      capability: caps[i],
      status: "fail" as const,
      durationMs: 0,
      reason: String(s.reason),
    };
  });

  return {
    provider: config.name,
    model: config.representativeModel,
    wireFormat: config.wireFormat,
    timestamp,
    probes,
  };
}

// ─────────────────────────────────────────────────────────────
// Build run result
// ─────────────────────────────────────────────────────────────

function buildRunId(): string {
  const now = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function buildRunResult(
  results: ProviderResult[],
  durationMs: number,
  runId: string,
  timestamp: string
): SmokeRunResult {
  return {
    runId,
    timestamp,
    durationMs,
    providers: results,
    summary: buildSummary(results),
  };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseCLIFlags();
  const runId = buildRunId();
  const timestamp = new Date().toISOString();

  const configs = discoverProviders(flags.provider);

  if (configs.length === 0) {
    if (flags.provider) {
      console.error(
        `No provider found matching "${flags.provider}". Check the provider name and ensure the API key env var is set.`
      );
    } else {
      console.error(
        "No providers available. Set at least one API key env var (e.g. MOONSHOT_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)."
      );
    }
    process.exit(1);
  }

  if (flags.dryRun) {
    printDryRun(configs);
    process.exit(0);
  }

  const t0 = Date.now();

  // Run all providers concurrently — Promise.allSettled so a single provider
  // crash does not abort the entire run (C3 fix: allSettled at provider level)
  const settled = await Promise.allSettled(
    configs.map((c) => runProviderProbes(c, flags.timeoutMs))
  );

  const results: ProviderResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return buildFailedProviderResult(configs[i], String(s.reason));
  });

  const run = buildRunResult(results, Date.now() - t0, runId, timestamp);

  if (!flags.jsonOnly) {
    printTable(results, flags.quiet);
    printSummary(run);
  }

  writeJsonResults(run);

  const anyFailed = results.some((r) => r.probes.some((p) => p.status === "fail"));
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
