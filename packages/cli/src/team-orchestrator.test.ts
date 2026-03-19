/**
 * Black box tests for team-orchestrator.ts
 *
 * Tests are derived from:
 *   - requirements.md: FR3 (file convention), FR4 (anonymous IDs / shuffle),
 *     FR5 (per-model work dirs), FR6 (status tracking), FR8 (model list)
 *   - architecture.md: public API signatures, manifest.json schema,
 *     status.json schema, security (path validation), revision #5 (zero-padded IDs)
 *
 * runModels and judgeResponses are excluded — they spawn child processes and
 * belong in integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ─── Dynamic imports (resolved at runtime so the module doesn't need to exist
//     until the tests actually run) ──────────────────────────────────────────

async function getOrchestrator() {
  return import("./team-orchestrator.js");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fresh isolated temp directory for each test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "team-orch-test-"));
}

/** Parse JSON file from disk, or return null on failure. */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

// ─── Types mirroring architecture.md public contracts ────────────────────────

interface ManifestModelEntry {
  model: string;
  assignedAt: string;
}

interface TeamManifest {
  created: string;
  models: Record<string, ManifestModelEntry>;
  shuffleOrder?: string[];
}

interface ModelStatus {
  state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT";
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  outputSize: number;
}

interface TeamStatus {
  startedAt: string;
  models: Record<string, ModelStatus>;
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("team-orchestrator", () => {
  // ── FR3 / FR5: Directory structure ────────────────────────────────────────

  describe("setupSession — directory structure", () => {
    it("TEST-01: creates work/ and errors/ subdirectories", async () => {
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b"], "task content");

      expect(existsSync(join(tempDir, "work"))).toBe(true);
      expect(existsSync(join(tempDir, "errors"))).toBe(true);
    });

    it("TEST-02: creates one work subdirectory per model", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task content");

      const workEntries = readdirSync(join(tempDir, "work"));
      expect(workEntries.length).toBe(models.length);
    });
  });

  // ── FR4: manifest.json ────────────────────────────────────────────────────

  describe("setupSession — manifest.json", () => {
    it("TEST-03: manifest.json has correct number of model entries", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      expect(Object.keys(manifest.models).length).toBe(models.length);
    });

    it("TEST-04: anonymous IDs are zero-padded numeric strings (01, 02, ...)", async () => {
      // Architecture revision #5: use zero-padded numeric IDs to support >26 models
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b", "model-c"], "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const ids = Object.keys(manifest.models);

      const zeroPaddedNumeric = /^\d{2,}$/;
      for (const id of ids) {
        expect(zeroPaddedNumeric.test(id)).toBe(true);
      }
    });

    it("TEST-05: manifest model entries contain all provided model names", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-alpha", "model-beta"];

      setupSession(tempDir, models, "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      const storedModelNames = Object.values(manifest.models).map((e) => e.model);

      // Order may differ due to shuffle; use set equality
      expect(storedModelNames.sort()).toEqual(models.sort());
    });

    it("TEST-06: manifest.json has a valid ISO 8601 created timestamp", async () => {
      const { setupSession } = await getOrchestrator();

      setupSession(tempDir, ["model-a"], "task");

      const manifest = readJson<TeamManifest>(join(tempDir, "manifest.json"));
      expect(typeof manifest.created).toBe("string");
      const parsed = new Date(manifest.created);
      // A valid ISO date parses without NaN
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    });

    it("TEST-07: shuffle produces different order across multiple runs (statistical)", async () => {
      // With 6 models, probability of all 20 runs preserving original order is
      // (1/720)^20 ≈ 10^{-57} — effectively impossible if shuffle is implemented.
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4", "m5", "m6"];

      // Collect the model-name arrays as ordered by the anonymous ID keys across runs
      const orderings: string[][] = [];

      for (let run = 0; run < 20; run++) {
        const runDir = mkdtempSync(join(tmpdir(), "team-shuffle-"));
        try {
          setupSession(runDir, models, "task");
          const manifest = readJson<TeamManifest>(join(runDir, "manifest.json"));
          // Sort by anonymous ID key to get a deterministic ordering per run
          const ordering = Object.keys(manifest.models)
            .sort()
            .map((k) => manifest.models[k].model);
          orderings.push(ordering);
        } finally {
          rmSync(runDir, { recursive: true, force: true });
        }
      }

      // At least one run should produce a different ordering from the first
      const first = orderings[0].join(",");
      const allIdentical = orderings.every((o) => o.join(",") === first);
      expect(allIdentical).toBe(false);
    });
  });

  // ── FR6: status.json ──────────────────────────────────────────────────────

  describe("setupSession — status.json", () => {
    it("TEST-08: all models start with PENDING state in status.json", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["model-a", "model-b", "model-c"];

      setupSession(tempDir, models, "task");

      const status = readJson<TeamStatus>(join(tempDir, "status.json"));
      const states = Object.values(status.models).map((m) => m.state);
      expect(states.every((s) => s === "PENDING")).toBe(true);
    });

    it("TEST-09: status.json model count matches input models array length", async () => {
      const { setupSession } = await getOrchestrator();
      const models = ["m1", "m2", "m3", "m4", "m5"];

      setupSession(tempDir, models, "task");

      const status = readJson<TeamStatus>(join(tempDir, "status.json"));
      expect(Object.keys(status.models).length).toBe(models.length);
    });
  });

  // ── FR3: input.md handling ────────────────────────────────────────────────

  describe("setupSession — input.md", () => {
    it("TEST-10: writes input.md with provided input text", async () => {
      const { setupSession } = await getOrchestrator();
      const inputText = "test task content for model evaluation";

      setupSession(tempDir, ["model-a"], inputText);

      const written = readFileSync(join(tempDir, "input.md"), "utf-8");
      expect(written).toBe(inputText);
    });

    it("TEST-11: succeeds when input.md already exists and no input text given", async () => {
      const { setupSession } = await getOrchestrator();
      const preExisting = "pre-existing task description";
      writeFileSync(join(tempDir, "input.md"), preExisting, "utf-8");

      // Must not throw
      expect(() => setupSession(tempDir, ["model-a"])).not.toThrow();

      // input.md content must be preserved
      const content = readFileSync(join(tempDir, "input.md"), "utf-8");
      expect(content).toBe(preExisting);
    });

    it("TEST-12: throws when no input.md exists and no input text is provided", async () => {
      const { setupSession } = await getOrchestrator();

      // No input.md in tempDir, no input argument
      expect(() => setupSession(tempDir, ["model-a"])).toThrow();
    });
  });

  // ── FR8: input validation — empty models ──────────────────────────────────

  describe("setupSession — input validation", () => {
    it("TEST-13: throws for an empty models array", async () => {
      const { setupSession } = await getOrchestrator();

      expect(() => setupSession(tempDir, [], "task")).toThrow();
    });
  });

  // ── Security: validateSessionPath ─────────────────────────────────────────

  describe("validateSessionPath", () => {
    it("TEST-14: throws when path resolves outside CWD", async () => {
      const { validateSessionPath } = await getOrchestrator();

      // /tmp is virtually always outside CWD (which is the project directory)
      const outsidePath = "/tmp/definitely-outside-cwd-test-path";

      // Only run if /tmp is actually outside CWD
      if (!resolve(outsidePath).startsWith(process.cwd())) {
        expect(() => validateSessionPath(outsidePath)).toThrow();
      } else {
        // CWD is /tmp or a subdir — skip this particular check
        console.warn("Skipping TEST-14: /tmp is inside CWD, cannot test outside-CWD rejection");
      }
    });

    it("TEST-15: accepts a path that resolves within CWD and returns resolved path", async () => {
      const { validateSessionPath } = await getOrchestrator();

      // Use a subdir of CWD that we know exists
      const insidePath = join(process.cwd(), "packages");

      const result = validateSessionPath(insidePath);

      // Should return the resolved absolute path without throwing
      expect(typeof result).toBe("string");
      expect(result.startsWith(process.cwd())).toBe(true);
    });
  });

  // ── FR6: getStatus ────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("TEST-16: returns parsed status.json with PENDING state after setupSession", async () => {
      const { setupSession, getStatus } = await getOrchestrator();

      setupSession(tempDir, ["model-a", "model-b"], "task");

      const status = getStatus(tempDir);

      expect(status).toBeDefined();
      expect(typeof status.models).toBe("object");

      const states = Object.values(status.models).map((m: ModelStatus) => m.state);
      expect(states.every((s) => s === "PENDING")).toBe(true);
    });
  });
});
