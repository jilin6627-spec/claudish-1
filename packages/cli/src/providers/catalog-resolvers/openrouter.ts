import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelCatalogResolver } from "../model-catalog-resolver.js";
import { staticOpenRouterFallback } from "./static-fallback.js";

/**
 * Slim catalog entry from the Firebase queryModels?catalog=slim endpoint.
 * Contains only what's needed for model name resolution.
 */
interface SlimModelEntry {
  modelId: string;
  aliases: string[];
  sources: Record<string, { externalId: string }>;
}

/**
 * Disk cache format (version 2).
 * Contains both the slim Firebase data (for resolver) and a backward-compatible
 * models array (for existing consumers in cli.ts/mcp-server.ts that expect {id: string}).
 */
interface DiskCache {
  version: 2;
  lastUpdated: string;
  entries: SlimModelEntry[];
  /** Backward-compatible: [{id: "vendor/model"}] for consumers that read all-models.json */
  models: Array<{ id: string }>;
}

const FIREBASE_CATALOG_URL =
  "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

const DISK_CACHE_PATH = join(homedir(), ".claudish", "all-models.json");

/**
 * Module-level memory cache of slim catalog entries.
 */
let _memCache: SlimModelEntry[] | null = null;

/**
 * Promise that resolves when the cache is warm (from warmCache or lazy load).
 * Stored so multiple callers can await the same in-flight fetch.
 */
let _warmPromise: Promise<void> | null = null;

/**
 * Resolution chain for OpenRouter model names, powered by Firebase model catalog.
 *
 * 1. Exact match on modelId           (e.g., "grok-4.20" → sources["openrouter-api"].externalId)
 * 2. Match in aliases array            (e.g., "grok-4-20" alias → same model)
 * 3. Match in sources[*].externalId    (e.g., "x-ai/grok-4.20" found directly)
 * 4. Suffix match on externalIds       (backward compat: "/grok-4.20" endsWith match)
 * 5. Static fallback: OPENROUTER_VENDOR_MAP (cold-start only)
 * 6. Passthrough: return null          (caller sends userInput unchanged)
 */
export class OpenRouterCatalogResolver implements ModelCatalogResolver {
  readonly provider = "openrouter";

  resolveSync(userInput: string): string | null {
    const entries = this._getEntries();

    // If already vendor-prefixed, check for exact externalId match, else passthrough
    if (userInput.includes("/")) {
      if (entries) {
        for (const entry of entries) {
          for (const src of Object.values(entry.sources)) {
            if (src.externalId === userInput) return userInput;
          }
        }
      }
      return userInput;
    }

    if (entries) {
      // Step 1: Exact modelId match
      const byModelId = entries.find((e) => e.modelId === userInput);
      if (byModelId) {
        const orId = this._getOpenRouterExternalId(byModelId);
        if (orId) return orId;
      }

      // Step 2: Match in aliases
      const byAlias = entries.find((e) => e.aliases.includes(userInput));
      if (byAlias) {
        const orId = this._getOpenRouterExternalId(byAlias);
        if (orId) return orId;
      }

      // Step 3: Match in any sources[*].externalId
      for (const entry of entries) {
        for (const src of Object.values(entry.sources)) {
          if (src.externalId === userInput) {
            const orId = this._getOpenRouterExternalId(entry);
            if (orId) return orId;
          }
        }
      }

      // Step 4: Suffix match on OpenRouter externalIds (backward compat)
      const suffix = `/${userInput}`;
      for (const entry of entries) {
        const orId = this._getOpenRouterExternalId(entry);
        if (orId && orId.endsWith(suffix)) return orId;
      }

      // Step 4b: Case-insensitive suffix match
      const lowerSuffix = `/${userInput.toLowerCase()}`;
      for (const entry of entries) {
        const orId = this._getOpenRouterExternalId(entry);
        if (orId && orId.toLowerCase().endsWith(lowerSuffix)) return orId;
      }
    }

    // Step 5: Static fallback (cold-start only)
    return staticOpenRouterFallback(userInput);
  }

  async warmCache(): Promise<void> {
    if (!_warmPromise) {
      _warmPromise = this._fetchAndCache();
    }
    await _warmPromise;
  }

  isCacheWarm(): boolean {
    return _memCache !== null && _memCache.length > 0;
  }

  async ensureReady(timeoutMs: number): Promise<void> {
    if (this.isCacheWarm()) return;

    // Start warming if not already in flight
    if (!_warmPromise) {
      _warmPromise = this._fetchAndCache();
    }

    // Race against timeout — never throw
    await Promise.race([
      _warmPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /**
   * Extract the OpenRouter externalId from a catalog entry.
   * Checks "openrouter-api" source first (most common), then any source with a "/" in externalId.
   */
  private _getOpenRouterExternalId(entry: SlimModelEntry): string | null {
    // Prefer the OpenRouter collector's externalId
    const orSource = entry.sources["openrouter-api"];
    if (orSource?.externalId) return orSource.externalId;

    // Fallback: any source with a vendor-prefixed externalId
    for (const src of Object.values(entry.sources)) {
      if (src.externalId.includes("/")) return src.externalId;
    }

    return null;
  }

  private _getEntries(): SlimModelEntry[] | null {
    if (_memCache) return _memCache;

    // Disk fallback
    if (existsSync(DISK_CACHE_PATH)) {
      try {
        const data = JSON.parse(readFileSync(DISK_CACHE_PATH, "utf-8"));

        // Version 2 format (Firebase catalog)
        if (data.version === 2 && Array.isArray(data.entries) && data.entries.length > 0) {
          _memCache = data.entries;
          return _memCache;
        }

        // Version 1 format (legacy OpenRouter — backward compat read)
        if (Array.isArray(data.models) && data.models.length > 0) {
          // Convert legacy {id: "vendor/model"} to slim entries for resolution
          _memCache = data.models.map((m: { id: string }) => ({
            modelId: m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id,
            aliases: [],
            sources: { "openrouter-api": { externalId: m.id } },
          }));
          return _memCache;
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  private async _fetchAndCache(): Promise<void> {
    try {
      const response = await fetch(FIREBASE_CATALOG_URL, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        throw new Error(`Firebase catalog returned ${response.status}`);
      }

      const data = (await response.json()) as { models: SlimModelEntry[]; total: number };
      if (!Array.isArray(data.models) || data.models.length === 0) return;

      _memCache = data.models;

      // Write to disk cache (version 2 format + backward-compatible models array)
      const backwardCompatModels: Array<{ id: string }> = [];
      for (const entry of data.models) {
        const orSource = entry.sources["openrouter-api"];
        if (orSource?.externalId) {
          backwardCompatModels.push({ id: orSource.externalId });
        }
      }

      const cacheDir = join(homedir(), ".claudish");
      mkdirSync(cacheDir, { recursive: true });
      const diskData: DiskCache = {
        version: 2,
        lastUpdated: new Date().toISOString(),
        entries: data.models,
        models: backwardCompatModels,
      };
      writeFileSync(DISK_CACHE_PATH, JSON.stringify(diskData), "utf-8");
    } catch {
      // Silent — fall back to disk read in resolveSync
    }
  }
}
