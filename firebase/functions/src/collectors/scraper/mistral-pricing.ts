import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

// Docs page returns excellent capability data (29 models) even when pricing is empty.
// OpenRouter fills the pricing gap.
const SOURCE_URL = "https://docs.mistral.ai/getting-started/models/models_overview/";

const PROMPT =
  "Extract ALL Mistral AI models. For each: API model ID (like mistral-large-3, mistral-small-4, " +
  "codestral, pixtral-large, ministral-3-8b, etc.), display name, context window in tokens, " +
  "max output tokens, capabilities (vision, function calling/tools, thinking/reasoning, code). " +
  "Also get pricing if shown (prices in USD PER MILLION TOKENS).";

export class MistralPricingScraper extends BaseCollector {
  readonly collectorId = "mistral-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "mistral",
        PROMPT,
        5000,
        60000
      );

      const models: RawModel[] = extracted.map(m => ({
        collectorId: this.collectorId,
        confidence: "scrape_unverified" as const,
        sourceUrl: SOURCE_URL,
        externalId: m.modelId,
        canonicalId: m.modelId,
        displayName: m.displayName ?? m.modelId,
        provider: "mistral",
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
          fineTuning: false,
          batchApi: false,
          structuredOutput: false,
          citations: false,
          codeExecution: false,
          pdfInput: false,
        },
        status:
          m.status === "deprecated"
            ? "deprecated"
            : m.status === "preview" || m.status === "beta"
            ? "preview"
            : "active",
      }));

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
