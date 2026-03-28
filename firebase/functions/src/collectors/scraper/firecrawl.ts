import { defineSecret } from "firebase-functions/params";

const FIRECRAWL_API_KEY = defineSecret("FIRECRAWL_API_KEY");

// ─────────────────────────────────────────────────────────────
// Legacy pricing-only interface (kept for backward compat)
// ─────────────────────────────────────────────────────────────

export interface ExtractedPricing {
  modelId: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

// ─────────────────────────────────────────────────────────────
// Comprehensive model extraction interface
// ─────────────────────────────────────────────────────────────

export interface ExtractedModel {
  modelId: string;
  displayName?: string;

  // Pricing (USD per million tokens)
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;

  // Context
  contextWindow?: number;       // max input tokens
  maxOutputTokens?: number;

  // Capabilities
  supportsVision?: boolean;
  supportsThinking?: boolean;   // extended thinking / reasoning
  supportsTools?: boolean;      // function calling
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  supportsImages?: boolean;     // image generation
  supportsAudio?: boolean;
  supportsPdf?: boolean;

  // Subscription tier
  tier?: string;                // "free" | "paid" | "subscription" | "enterprise" | "limited-time-free"

  // Status
  status?: string;              // "active" | "deprecated" | "preview" | "beta"
  deprecationDate?: string;     // ISO date if deprecated
}

// ─────────────────────────────────────────────────────────────
// JSON schema for Firecrawl extraction
// ─────────────────────────────────────────────────────────────

const PRICING_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        properties: {
          modelId: { type: "string", description: "Model ID/name as shown on the page" },
          inputPerMTok: { type: "number", description: "Input price in USD per million tokens" },
          outputPerMTok: { type: "number", description: "Output price in USD per million tokens" },
          cacheReadPerMTok: { type: "number", description: "Cached input read price per MTok, if available" },
          cacheWritePerMTok: { type: "number", description: "Cached write price per MTok, if available" },
        },
        required: ["modelId", "inputPerMTok", "outputPerMTok"],
      },
    },
  },
  required: ["models"],
};

const MODEL_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        properties: {
          modelId: { type: "string", description: "Model ID/name as used in API calls" },
          displayName: { type: "string", description: "Human-readable display name" },
          inputPerMTok: { type: "number", description: "Input price in USD per million tokens" },
          outputPerMTok: { type: "number", description: "Output price in USD per million tokens" },
          cacheReadPerMTok: { type: "number", description: "Cached input read price per MTok, if available" },
          cacheWritePerMTok: { type: "number", description: "Cached write price per MTok, if available" },
          contextWindow: { type: "number", description: "Maximum input context window in tokens" },
          maxOutputTokens: { type: "number", description: "Maximum output tokens" },
          supportsVision: { type: "boolean", description: "Whether the model supports image/vision input" },
          supportsThinking: { type: "boolean", description: "Whether the model supports extended thinking or reasoning mode" },
          supportsTools: { type: "boolean", description: "Whether the model supports function calling / tool use" },
          supportsStreaming: { type: "boolean", description: "Whether the model supports streaming responses" },
          supportsJsonMode: { type: "boolean", description: "Whether the model supports JSON mode or structured output" },
          supportsImages: { type: "boolean", description: "Whether the model can generate images" },
          supportsAudio: { type: "boolean", description: "Whether the model supports audio input or output" },
          supportsPdf: { type: "boolean", description: "Whether the model supports PDF document input" },
          tier: { type: "string", description: "Subscription tier: free, paid, subscription, enterprise, or limited-time-free" },
          status: { type: "string", description: "Model status: active, deprecated, preview, or beta" },
          deprecationDate: { type: "string", description: "ISO date string for when the model will be or was deprecated" },
        },
        required: ["modelId"],
      },
    },
  },
  required: ["models"],
};

// ─────────────────────────────────────────────────────────────
// Internal Firecrawl response types
// ─────────────────────────────────────────────────────────────

interface FirecrawlExtractDataPricing {
  models?: ExtractedPricing[];
}

interface FirecrawlExtractDataModel {
  models?: ExtractedModel[];
}

interface FirecrawlResponse<T> {
  success: boolean;
  data?: {
    extract?: T;
  };
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────

/**
 * Round a price to 6 decimal places to eliminate floating-point noise
 * from per-token → per-MTok conversions (e.g. 0.30000000000000004 → 0.3).
 */
export function roundPrice(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ─────────────────────────────────────────────────────────────
// Core fetch helper
// ─────────────────────────────────────────────────────────────

async function firecrawlScrape<T>(
  url: string,
  schema: object,
  prompt: string,
  waitFor = 5000,
  timeout = 60000
): Promise<T> {
  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIRECRAWL_API_KEY.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["extract"],
      waitFor,
      timeout,
      extract: {
        schema,
        prompt,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Firecrawl ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as FirecrawlResponse<T>;

  if (!data.success) {
    throw new Error(`Firecrawl extraction failed: ${data.error ?? "unknown error"}`);
  }

  return data.data?.extract as T;
}

// ─────────────────────────────────────────────────────────────
// Public API — comprehensive model extraction
// ─────────────────────────────────────────────────────────────

/**
 * Extracts comprehensive model data (pricing + capabilities + context + status)
 * from a provider page in a single Firecrawl API call.
 * Returns an empty array on any failure.
 */
export async function extractModelsWithFirecrawl(
  url: string,
  providerHint: string,
  prompt: string,
  waitFor = 5000,
  timeout = 60000
): Promise<ExtractedModel[]> {
  const fullPrompt = `${prompt} Provider context: ${providerHint}`;
  const result = await firecrawlScrape<FirecrawlExtractDataModel>(
    url,
    MODEL_EXTRACTION_SCHEMA,
    fullPrompt,
    waitFor,
    timeout
  );
  return result?.models ?? [];
}

// ─────────────────────────────────────────────────────────────
// Public API — dual-page scraping with merge
// ─────────────────────────────────────────────────────────────

export interface MultiUrlConfig {
  url: string;
  providerHint: string;
  prompt: string;
  waitFor?: number;
  timeout?: number;
}

/**
 * Scrapes multiple URLs in parallel and merges the results.
 * Later configs in the array override earlier ones for the same modelId,
 * but only fill in missing fields (not replace existing non-null values).
 */
export async function extractFromMultipleUrls(
  configs: MultiUrlConfig[]
): Promise<ExtractedModel[]> {
  const results = await Promise.allSettled(
    configs.map(c =>
      extractModelsWithFirecrawl(c.url, c.providerHint, c.prompt, c.waitFor, c.timeout)
    )
  );

  // Merge: later configs override earlier for same modelId (fill missing fields)
  const byId = new Map<string, ExtractedModel>();
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const m of r.value) {
        const existing = byId.get(m.modelId);
        if (existing) {
          // Merge: fill in missing fields from the new source
          byId.set(
            m.modelId,
            {
              ...existing,
              ...Object.fromEntries(
                Object.entries(m).filter(([, v]) => v !== undefined && v !== null)
              ),
            } as ExtractedModel
          );
        } else {
          byId.set(m.modelId, m);
        }
      }
    }
  }
  return [...byId.values()];
}

// ─────────────────────────────────────────────────────────────
// Backward-compat wrapper — pricing only
// ─────────────────────────────────────────────────────────────

/**
 * @deprecated Use extractModelsWithFirecrawl instead for full model data.
 * Kept as a thin wrapper for any callers that haven't migrated yet.
 */
export async function extractPricingWithFirecrawl(
  url: string,
  providerHint: string
): Promise<ExtractedPricing[]> {
  const prompt = `Extract all AI model pricing from this page. Prices should be in USD per million tokens (per MTok). Provider: ${providerHint}`;
  const result = await firecrawlScrape<FirecrawlExtractDataPricing>(
    url,
    PRICING_EXTRACTION_SCHEMA,
    prompt
  );
  return result?.models ?? [];
}
