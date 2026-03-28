#!/usr/bin/env npx tsx
/**
 * Local test script for model catalog collectors.
 * Tests real API calls without Firebase runtime.
 *
 * Usage:
 *   cd firebase/functions
 *   npx tsx src/test-local.ts
 *
 * Tests: OpenRouter (no auth), OpenCode Zen, Google Gemini, MiniMax scraper
 * Then merges results and prints summary.
 */

import type { RawModel, CollectorResult, PricingData, ConfidenceTier } from "./schema.js";
import { CONFIDENCE_RANK } from "./schema.js";

// ── Standalone collectors (no defineSecret) ──────────────────────────

async function collectOpenRouter(): Promise<CollectorResult> {
  console.log("[test] collecting from OpenRouter (no auth)...");
  const resp = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);

  const data = await resp.json() as { data: any[] };
  const models: RawModel[] = data.data.map((m: any) => {
    const inputPrice = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : undefined;
    const outputPrice = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : undefined;
    const slashIdx = m.id.indexOf("/");
    return {
      collectorId: "openrouter-api",
      confidence: "aggregator_reported" as ConfidenceTier,
      sourceUrl: "https://openrouter.ai/api/v1/models",
      externalId: m.id,
      canonicalId: slashIdx > 0 ? m.id.slice(slashIdx + 1) : m.id,
      displayName: m.name,
      provider: slashIdx > 0 ? m.id.slice(0, slashIdx) : undefined,
      pricing: inputPrice !== undefined && outputPrice !== undefined
        ? { input: inputPrice, output: outputPrice }
        : undefined,
      contextWindow: m.context_length,
      maxOutputTokens: m.top_provider?.max_completion_tokens,
      capabilities: {
        vision: m.architecture?.modality?.includes("image") || false,
        tools: m.supported_parameters?.includes("tools") ?? false,
        streaming: true,
      },
      status: "active" as const,
    };
  });

  return { collectorId: "openrouter-api", models, fetchedAt: new Date() };
}

async function collectOpenCodeZen(): Promise<CollectorResult> {
  const apiKey = process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    console.log("[test] OPENCODE_ZEN_API_KEY not set — skipping Zen");
    return { collectorId: "opencode-zen-api", models: [], error: "no API key", fetchedAt: new Date() };
  }

  console.log("[test] collecting from OpenCode Zen...");
  const resp = await fetch("https://opencode.ai/zen/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[test] Zen API ${resp.status}: ${text}`);
    return { collectorId: "opencode-zen-api", models: [], error: `${resp.status}: ${text}`, fetchedAt: new Date() };
  }

  const data = await resp.json() as { data: any[] };
  const models: RawModel[] = (data.data ?? []).map((m: any) => ({
    collectorId: "opencode-zen-api",
    confidence: "gateway_official" as ConfidenceTier,
    sourceUrl: "https://opencode.ai/zen/v1/models",
    externalId: m.id,
    canonicalId: m.id,
    provider: "opencode-zen",
    contextWindow: m.context_length,
    pricing: m.pricing ? { input: m.pricing.input, output: m.pricing.output } : undefined,
    status: "active" as const,
  }));

  return { collectorId: "opencode-zen-api", models, fetchedAt: new Date() };
}

async function collectGoogleGemini(): Promise<CollectorResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    console.log("[test] GEMINI_API_KEY not set — skipping Google");
    return { collectorId: "google-api", models: [], error: "no API key", fetchedAt: new Date() };
  }

  console.log("[test] collecting from Google Gemini...");
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
  );
  if (!resp.ok) {
    return { collectorId: "google-api", models: [], error: `Google ${resp.status}`, fetchedAt: new Date() };
  }

  const data = await resp.json() as { models: any[] };
  const models: RawModel[] = (data.models ?? [])
    .filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m: any) => ({
      collectorId: "google-api",
      confidence: "api_official" as ConfidenceTier,
      sourceUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      externalId: m.name?.replace("models/", "") ?? m.name,
      canonicalId: m.name?.replace("models/", "") ?? m.name,
      displayName: m.displayName,
      provider: "google",
      contextWindow: m.inputTokenLimit,
      maxOutputTokens: m.outputTokenLimit,
      status: "active" as const,
    }));

  return { collectorId: "google-api", models, fetchedAt: new Date() };
}

// ── Firecrawl helpers (mirrors firecrawl.ts model extraction schema) ──

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

interface ExtractedModel {
  modelId: string;
  displayName?: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  supportsImages?: boolean;
  supportsAudio?: boolean;
  supportsPdf?: boolean;
  tier?: string;
  status?: string;
  deprecationDate?: string;
}

async function scrapeModelsWithFirecrawl(
  url: string,
  provider: string,
  prompt: string
): Promise<ExtractedModel[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not set");

  const fullPrompt = `${prompt} Provider context: ${provider}`;

  const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["extract"],
      waitFor: 3000,
      extract: { schema: MODEL_EXTRACTION_SCHEMA, prompt: fullPrompt },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Firecrawl ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as {
    success: boolean;
    data?: { extract?: { models?: ExtractedModel[] } };
    error?: string;
  };
  if (!data.success) throw new Error(`Firecrawl failed: ${data.error ?? "unknown error"}`);

  return (data.data?.extract?.models ?? []) as ExtractedModel[];
}

async function scrapeOpenCodeZenPricing(): Promise<CollectorResult> {
  console.log("[test] scraping OpenCode Zen pricing via Firecrawl...");

  try {
    const extracted = await scrapeModelsWithFirecrawl(
      "https://opencode.ai/docs/zen",
      "opencode zen gateway",
      "Extract ALL models from OpenCode Zen including: model ID, display name, " +
      "input/output/cached-read/cached-write prices per million tokens, whether the model is free or paid, " +
      "any time-limited free offers, deprecated models with dates, and which API format each model uses."
    );

    const models: RawModel[] = extracted.map(m => ({
      collectorId: "zen-pricing-scraper",
      confidence: "gateway_official" as ConfidenceTier,
      sourceUrl: "https://opencode.ai/docs/zen",
      externalId: m.modelId,
      canonicalId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      provider: "opencode-zen",
      pricing:
        m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
          ? {
              input: m.inputPerMTok,
              output: m.outputPerMTok,
              ...(m.cacheReadPerMTok !== undefined ? { cachedRead: m.cacheReadPerMTok } : {}),
              ...(m.cacheWritePerMTok !== undefined ? { cachedWrite: m.cacheWritePerMTok } : {}),
            }
          : undefined,
      contextWindow: m.contextWindow,
      status: "active" as const,
    }));

    return { collectorId: "zen-pricing-scraper", models, fetchedAt: new Date() };
  } catch (err) {
    return { collectorId: "zen-pricing-scraper", models: [], error: String(err), fetchedAt: new Date() };
  }
}

async function scrapeAnthropicPricing(): Promise<CollectorResult> {
  console.log("[test] scraping Anthropic pricing via Firecrawl...");

  try {
    const extracted = await scrapeModelsWithFirecrawl(
      "https://www.anthropic.com/pricing",
      "anthropic",
      "Extract all Claude model pricing. Include model names, input/output prices per million tokens, " +
      "cached read/write prices, context window sizes, and capabilities (vision, thinking, tools, PDF input)."
    );

    const models: RawModel[] = extracted.map(m => ({
      collectorId: "anthropic-pricing-scraper",
      confidence: "scrape_unverified" as ConfidenceTier,
      sourceUrl: "https://www.anthropic.com/pricing",
      externalId: m.modelId,
      canonicalId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      provider: "anthropic",
      pricing:
        m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
          ? {
              input: m.inputPerMTok,
              output: m.outputPerMTok,
              ...(m.cacheReadPerMTok !== undefined ? { cachedRead: m.cacheReadPerMTok } : {}),
              ...(m.cacheWritePerMTok !== undefined ? { cachedWrite: m.cacheWritePerMTok } : {}),
            }
          : undefined,
      contextWindow: m.contextWindow,
      capabilities: {
        vision: m.supportsVision ?? false,
        thinking: m.supportsThinking ?? false,
        tools: m.supportsTools ?? true,
        streaming: m.supportsStreaming ?? true,
        pdfInput: m.supportsPdf ?? false,
        batchApi: false,
        jsonMode: false,
        structuredOutput: false,
        citations: false,
        codeExecution: false,
        fineTuning: false,
      },
      status: "active" as const,
    }));

    return { collectorId: "anthropic-pricing-scraper", models, fetchedAt: new Date() };
  } catch (err) {
    return { collectorId: "anthropic-pricing-scraper", models: [], error: String(err), fetchedAt: new Date() };
  }
}

async function scrapeDeepSeekPricing(): Promise<CollectorResult> {
  if (!process.env.FIRECRAWL_API_KEY) {
    console.log("[test] FIRECRAWL_API_KEY not set — skipping DeepSeek scrape");
    return { collectorId: "deepseek-pricing-scraper", models: [], error: "no API key", fetchedAt: new Date() };
  }

  console.log("[test] scraping DeepSeek pricing via Firecrawl...");

  try {
    const extracted = await scrapeModelsWithFirecrawl(
      "https://api-docs.deepseek.com/quick_start/pricing",
      "deepseek",
      "Extract all DeepSeek model pricing. Include model IDs (deepseek-chat, deepseek-reasoner, " +
      "deepseek-coder, etc.), input/output prices per million tokens, cached input prices, " +
      "context window sizes. Note which models support reasoning/thinking mode."
    );

    const models: RawModel[] = extracted.map(m => ({
      collectorId: "deepseek-pricing-scraper",
      confidence: "scrape_unverified" as ConfidenceTier,
      sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      externalId: m.modelId,
      canonicalId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      provider: "deepseek",
      pricing:
        m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
          ? {
              input: m.inputPerMTok,
              output: m.outputPerMTok,
              ...(m.cacheReadPerMTok !== undefined ? { cachedRead: m.cacheReadPerMTok } : {}),
              ...(m.cacheWritePerMTok !== undefined ? { cachedWrite: m.cacheWritePerMTok } : {}),
            }
          : undefined,
      contextWindow: m.contextWindow,
      capabilities: {
        vision: m.supportsVision ?? false,
        thinking: m.supportsThinking ?? false,
        tools: m.supportsTools ?? false,
        streaming: m.supportsStreaming ?? true,
        jsonMode: m.supportsJsonMode ?? false,
        batchApi: false,
        structuredOutput: false,
        citations: false,
        codeExecution: false,
        pdfInput: false,
        fineTuning: false,
      },
      status: "active" as const,
    }));

    return { collectorId: "deepseek-pricing-scraper", models, fetchedAt: new Date() };
  } catch (err) {
    return { collectorId: "deepseek-pricing-scraper", models: [], error: String(err), fetchedAt: new Date() };
  }
}

async function scrapeXAI(): Promise<CollectorResult> {
  if (!process.env.FIRECRAWL_API_KEY) {
    console.log("[test] FIRECRAWL_API_KEY not set — skipping xAI scrape");
    return { collectorId: "xai-pricing-scraper", models: [], error: "no API key", fetchedAt: new Date() };
  }

  console.log("[test] scraping xAI/Grok models via Firecrawl...");

  try {
    const extracted = await scrapeModelsWithFirecrawl(
      "https://docs.x.ai/docs/models",
      "xai grok",
      "Extract all xAI/Grok model information. Include model IDs, pricing per million tokens, " +
      "context window sizes, and capabilities (vision, tools, reasoning). Include all Grok models."
    );

    const models: RawModel[] = extracted.map(m => ({
      collectorId: "xai-pricing-scraper",
      confidence: "scrape_unverified" as ConfidenceTier,
      sourceUrl: "https://docs.x.ai/docs/models",
      externalId: m.modelId,
      canonicalId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      provider: "xai",
      pricing:
        m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
          ? {
              input: m.inputPerMTok,
              output: m.outputPerMTok,
              ...(m.cacheReadPerMTok !== undefined ? { cachedRead: m.cacheReadPerMTok } : {}),
              ...(m.cacheWritePerMTok !== undefined ? { cachedWrite: m.cacheWritePerMTok } : {}),
            }
          : undefined,
      contextWindow: m.contextWindow,
      capabilities: {
        vision: m.supportsVision ?? false,
        thinking: m.supportsThinking ?? false,
        tools: m.supportsTools ?? false,
        streaming: m.supportsStreaming ?? true,
        jsonMode: m.supportsJsonMode ?? false,
        batchApi: false,
        structuredOutput: false,
        citations: false,
        codeExecution: false,
        pdfInput: false,
        fineTuning: false,
      },
      status: "active" as const,
    }));

    return { collectorId: "xai-pricing-scraper", models, fetchedAt: new Date() };
  } catch (err) {
    return { collectorId: "xai-pricing-scraper", models: [], error: String(err), fetchedAt: new Date() };
  }
}

async function scrapeMiniMax(): Promise<CollectorResult> {
  if (!process.env.FIRECRAWL_API_KEY) {
    console.log("[test] FIRECRAWL_API_KEY not set — skipping MiniMax scrape");
    return { collectorId: "minimax-pricing-scraper", models: [], error: "no API key", fetchedAt: new Date() };
  }

  console.log("[test] scraping MiniMax pricing + capabilities via Firecrawl...");

  try {
    const [pricingResults, capabilityResults] = await Promise.allSettled([
      scrapeModelsWithFirecrawl(
        "https://platform.minimaxi.com/document/Price",
        "minimax",
        "Extract all MiniMax model pricing. Include model IDs, input/output prices " +
        "(may be in CNY — convert to USD if possible). Include context window sizes. " +
        "Note any free models or free tiers."
      ),
      scrapeModelsWithFirecrawl(
        "https://platform.minimaxi.com/document/introduction",
        "minimax",
        "Extract all MiniMax model names, capabilities (vision, tools, streaming), " +
        "context window sizes, and any model descriptions."
      ),
    ]);

    const pricingModels = pricingResults.status === "fulfilled" ? pricingResults.value : [];
    const capabilityModels = capabilityResults.status === "fulfilled" ? capabilityResults.value : [];

    const byId = new Map<string, ExtractedModel>();
    for (const m of capabilityModels) byId.set(m.modelId, m);
    for (const m of pricingModels) {
      const existing = byId.get(m.modelId);
      byId.set(m.modelId, existing ? { ...existing, ...m } : m);
    }

    const models: RawModel[] = [...byId.values()].map(m => ({
      collectorId: "minimax-pricing-scraper",
      confidence: "scrape_unverified" as ConfidenceTier,
      sourceUrl: "https://platform.minimaxi.com/document/Price",
      externalId: m.modelId,
      canonicalId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      provider: "minimax",
      pricing:
        m.inputPerMTok !== undefined && m.outputPerMTok !== undefined
          ? {
              input: m.inputPerMTok,
              output: m.outputPerMTok,
              ...(m.cacheReadPerMTok !== undefined ? { cachedRead: m.cacheReadPerMTok } : {}),
              ...(m.cacheWritePerMTok !== undefined ? { cachedWrite: m.cacheWritePerMTok } : {}),
            }
          : undefined,
      contextWindow: m.contextWindow,
      capabilities: {
        vision: m.supportsVision ?? false,
        thinking: m.supportsThinking ?? false,
        tools: m.supportsTools ?? false,
        streaming: m.supportsStreaming ?? true,
        jsonMode: m.supportsJsonMode ?? false,
        audioInput: m.supportsAudio ?? false,
        batchApi: false,
        structuredOutput: false,
        citations: false,
        codeExecution: false,
        pdfInput: false,
        fineTuning: false,
      },
      status: "active" as const,
    }));

    const errors: string[] = [];
    if (pricingResults.status === "rejected") errors.push(`pricing: ${String(pricingResults.reason)}`);
    if (capabilityResults.status === "rejected") errors.push(`capabilities: ${String(capabilityResults.reason)}`);

    return {
      collectorId: "minimax-pricing-scraper",
      models,
      error: errors.length > 0 ? errors.join("; ") : undefined,
      fetchedAt: new Date(),
    };
  } catch (err) {
    return { collectorId: "minimax-pricing-scraper", models: [], error: String(err), fetchedAt: new Date() };
  }
}

// ── Lightweight merger (no firebase-admin dependency) ──────────────────

interface SimpleMergedModel {
  modelId: string;
  displayName: string;
  provider: string;
  pricing?: PricingData;
  pricingCollectorId?: string;
  pricingConfidenceTier?: ConfidenceTier;
  contextWindow?: number;
  maxOutputTokens?: number;
  sources: string[];
  status: string;
}

function mergeLocal(results: CollectorResult[]): SimpleMergedModel[] {
  const allRaw = results.flatMap(r => r.models);
  const byId = new Map<string, RawModel[]>();

  for (const raw of allRaw) {
    const key = raw.canonicalId ?? raw.externalId.toLowerCase();
    const group = byId.get(key) ?? [];
    group.push(raw);
    byId.set(key, group);
  }

  const docs: SimpleMergedModel[] = [];
  for (const [id, raws] of byId) {
    const sorted = [...raws].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
    const best = sorted[0];
    const pricingRaw = sorted.find(r => r.pricing);

    docs.push({
      modelId: id,
      displayName: best.displayName ?? id,
      provider: best.provider ?? "unknown",
      pricing: pricingRaw?.pricing,
      pricingCollectorId: pricingRaw?.collectorId,
      pricingConfidenceTier: pricingRaw?.confidence,
      contextWindow: sorted.find(r => r.contextWindow)?.contextWindow,
      maxOutputTokens: sorted.find(r => r.maxOutputTokens)?.maxOutputTokens,
      sources: [...new Set(raws.map(r => r.collectorId))],
      status: best.status ?? "unknown",
    });
  }

  return docs;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Model Catalog Collector — Local Test Run");
  console.log("═══════════════════════════════════════════════════════════\n");

  const collectors = [
    collectOpenRouter(),
    collectOpenCodeZen(),
    collectGoogleGemini(),
    scrapeOpenCodeZenPricing(),
    scrapeAnthropicPricing(),
    ...(process.env.FIRECRAWL_API_KEY ? [
      scrapeDeepSeekPricing(),
      scrapeXAI(),
      scrapeMiniMax(),
    ] : []),
  ];

  const results = await Promise.allSettled(collectors);
  const collected: CollectorResult[] = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      collected.push(r.value);
      const status = r.value.error ? `⚠ ${r.value.error}` : `✓ ${r.value.models.length} models`;
      console.log(`  ${r.value.collectorId}: ${status}`);
    } else {
      console.log(`  CRASHED: ${r.reason}`);
    }
  }

  console.log("\n── Merging ──────────────────────────────────────────────\n");

  const merged = mergeLocal(collected);
  console.log(`  Total unique models after merge: ${merged.length}\n`);

  // Show some interesting examples
  console.log("── Sample models with pricing (from multiple sources) ──\n");

  const withMultipleSources = merged
    .filter(m => m.sources.length > 1 && m.pricing)
    .slice(0, 15);

  for (const m of withMultipleSources) {
    console.log(`  ${m.modelId}`);
    console.log(`    Display: ${m.displayName}`);
    console.log(`    Provider: ${m.provider}`);
    console.log(`    Pricing: $${m.pricing!.input}/MTok in, $${m.pricing!.output}/MTok out (${m.pricingConfidenceTier} from ${m.pricingCollectorId})`);
    console.log(`    Context: ${m.contextWindow?.toLocaleString() ?? "unknown"} tokens`);
    console.log(`    Sources: ${m.sources.join(", ")}`);
    console.log();
  }

  // Show MiniMax specifically (since you asked about it)
  console.log("── MiniMax models ──────────────────────────────────────\n");
  const minimaxModels = merged.filter(m =>
    m.provider === "minimax" ||
    m.modelId.includes("minimax") ||
    m.displayName?.toLowerCase().includes("minimax")
  );

  if (minimaxModels.length === 0) {
    console.log("  No MiniMax models found in merged results");
  } else {
    for (const m of minimaxModels) {
      console.log(`  ${m.modelId}`);
      console.log(`    Pricing: ${m.pricing ? `$${m.pricing.input}/$${m.pricing.output} per MTok` : "none"}`);
      console.log(`    Context: ${m.contextWindow?.toLocaleString() ?? "unknown"}`);
      console.log(`    Sources: ${m.sources.join(", ")}`);
      console.log();
    }
  }

  // Summary stats
  console.log("── Summary ─────────────────────────────────────────────\n");
  const withPricing = merged.filter(m => m.pricing);
  const withContext = merged.filter(m => m.contextWindow);
  const providers = [...new Set(merged.map(m => m.provider))];

  console.log(`  Total models:     ${merged.length}`);
  console.log(`  With pricing:     ${withPricing.length}`);
  console.log(`  With context:     ${withContext.length}`);
  console.log(`  Unique providers: ${providers.length}`);
  console.log(`  Providers:        ${providers.sort().join(", ")}`);
  console.log();

  // Show pricing tier distribution
  const byConfidence = new Map<string, number>();
  for (const m of withPricing) {
    const tier = m.pricingConfidenceTier ?? "unknown";
    byConfidence.set(tier, (byConfidence.get(tier) ?? 0) + 1);
  }
  console.log("  Pricing confidence distribution:");
  for (const [tier, count] of [...byConfidence].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${tier}: ${count} models`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Done. To write to Firestore, deploy and run:");
  console.log("  curl -X POST https://us-central1-claudish-6da10.cloudfunctions.net/collectModelCatalogManual");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(console.error);
