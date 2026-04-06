import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://open.bigmodel.cn/pricing";

const PROMPT =
  "Extract ALL GLM/Zhipu AI text and chat model pricing. Prices are in Chinese Yuan (CNY). " +
  "Convert to USD using 1 CNY = 0.14 USD. For each model: model ID (GLM-5, GLM-5-Turbo, GLM-4.7, " +
  "GLM-4.5, GLM-4-Plus, GLM-4-Air, GLM-4-Flash, GLM-4.6V, etc.), input price per million tokens in USD, " +
  "output price per million tokens in USD, context window in tokens, and whether free or paid. " +
  "Vision model flag for GLM-4.6V variants. ONLY text/chat models, NOT image generation.";

export class GLMScraper extends BaseCollector {
  readonly collectorId = "glm-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "zhipu glm",
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
        provider: "glm",
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
            : m.tier === "free"
            ? "active"
            : "active",
      }));

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
