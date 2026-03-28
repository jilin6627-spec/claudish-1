import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl, type ExtractedModel } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const ZEN_URL = "https://opencode.ai/docs/zen";
const GO_URL = "https://opencode.ai/docs/go";

const ZEN_PROMPT =
  "Extract ALL models and their pricing from this OpenCode Zen page. For each model: model ID " +
  "(like gpt-5.4, claude-opus-4-6, etc.), input price per million tokens, output price per million tokens, " +
  "cached read price, cached write price. Prices in USD. Note if model is free, has limited-time free " +
  "access, or is deprecated.";

const GO_PROMPT =
  "Extract all models from OpenCode Go (Gemini CodeAssist). Include model IDs, pricing, and capabilities.";

function toRawModel(
  m: ExtractedModel,
  collectorId: string,
  sourceUrl: string
): RawModel {
  return {
    collectorId,
    confidence: "gateway_official" as const,
    sourceUrl,
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
    maxOutputTokens: m.maxOutputTokens,
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
    status:
      m.status === "deprecated"
        ? "deprecated"
        : m.status === "preview" || m.status === "beta"
        ? "preview"
        : "active",
  };
}

export class OpenCodeZenPricingScraper extends BaseCollector {
  readonly collectorId = "opencode-zen-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      // Scrape Zen and Go pages in parallel
      const [zenResults, goResults] = await Promise.allSettled([
        extractModelsWithFirecrawl(ZEN_URL, "opencode zen gateway", ZEN_PROMPT, 10000, 90000),
        extractModelsWithFirecrawl(GO_URL, "opencode go gemini codeassist", GO_PROMPT, 10000, 90000),
      ]);

      const zenModels = zenResults.status === "fulfilled" ? zenResults.value : [];
      const goModels = goResults.status === "fulfilled" ? goResults.value : [];

      const allModels: RawModel[] = [
        ...zenModels.map(m => toRawModel(m, this.collectorId, ZEN_URL)),
        ...goModels.map(m => toRawModel(m, this.collectorId, GO_URL)),
      ];

      const errors: string[] = [];
      if (zenResults.status === "rejected") {
        errors.push(`zen: ${String(zenResults.reason)}`);
      }
      if (goResults.status === "rejected") {
        errors.push(`go: ${String(goResults.reason)}`);
      }

      return this.makeResult(allModels, errors.length > 0 ? errors.join("; ") : undefined);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
