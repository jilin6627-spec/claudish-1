import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";

const PROMPT =
  "Extract ALL DeepSeek model pricing and capabilities. For each: model ID, input price per million tokens USD, " +
  "output price per million tokens USD, cached input price, context window in tokens (e.g. 128000), " +
  "max output tokens, capabilities (reasoning/thinking, function calling, vision, code). Note cache discounts.";

export class DeepSeekScraper extends BaseCollector {
  readonly collectorId = "deepseek-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "deepseek",
        PROMPT,
        8000,
        120000
      );

      const models: RawModel[] = extracted.map(m => ({
        collectorId: this.collectorId,
        confidence: "scrape_unverified" as const,
        sourceUrl: SOURCE_URL,
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
      }));

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
