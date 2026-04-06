import { BaseCollector } from "../base-collector.js";
import { extractFromMultipleUrls } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const PRICING_URL = "https://www.anthropic.com/pricing";
const MODELS_URL = "https://docs.anthropic.com/en/docs/about-claude/models";

const PRICING_PROMPT =
  "Extract ALL Claude model pricing. For each model: model name/ID, input price per million tokens, " +
  "output price per million tokens, cached input read price per MTok, cached write price per MTok. " +
  "Include ALL versions: Opus 4.6, 4.5, 4.1, 4, Sonnet 4.6, 4.5, 4, Haiku 4.5, 3.5, 3.";

const MODELS_PROMPT =
  "Extract ALL Claude model information. For each: exact API model ID (e.g. claude-opus-4-6-20250219), " +
  "context window in tokens (e.g. 200000 or 1000000), max output tokens, and capabilities: " +
  "vision, extended thinking, tool use, PDF input, citations, code execution, batch API.";

export class AnthropicPricingScraper extends BaseCollector {
  readonly collectorId = "anthropic-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractFromMultipleUrls([
        {
          url: PRICING_URL,
          providerHint: "anthropic",
          prompt: PRICING_PROMPT,
          waitFor: 5000,
          timeout: 120000,
        },
        {
          url: MODELS_URL,
          providerHint: "anthropic",
          prompt: MODELS_PROMPT,
          waitFor: 5000,
          timeout: 120000,
        },
      ]);

      const models: RawModel[] = extracted.map(m => ({
        collectorId: this.collectorId,
        confidence: "scrape_unverified" as const,
        sourceUrl: PRICING_URL,
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
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          vision: m.supportsVision ?? false,
          thinking: m.supportsThinking ?? false,
          tools: m.supportsTools ?? true,
          streaming: m.supportsStreaming ?? true,
          jsonMode: m.supportsJsonMode ?? false,
          pdfInput: m.supportsPdf ?? false,
          batchApi: false,
          structuredOutput: false,
          citations: false,
          codeExecution: false,
          fineTuning: false,
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
