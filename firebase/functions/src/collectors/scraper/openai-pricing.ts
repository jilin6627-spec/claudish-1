import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://openai.com/api/pricing";

const PROMPT =
  "Extract ALL OpenAI models and their pricing. Include EVERY model: GPT-5.4, GPT-5.4 Pro, GPT-5.4 Mini, " +
  "GPT-5.4 Nano, GPT-5.3, GPT-5.2, GPT-5.1, GPT-5, GPT-4o, GPT-4o mini, o3, o3 mini, o4-mini, " +
  "Codex, Realtime, embedding, image, audio models. For each: model ID, input price per million tokens USD, " +
  "output price per million tokens USD, cached input price, context window in tokens, max output tokens, " +
  "capabilities (vision, tools, thinking/reasoning).";

export class OpenAIPricingScraper extends BaseCollector {
  readonly collectorId = "openai-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "openai",
        PROMPT,
        10000,
        90000
      );

      const models: RawModel[] = extracted.map(m => ({
        collectorId: this.collectorId,
        confidence: "scrape_unverified" as const,
        sourceUrl: SOURCE_URL,
        externalId: m.modelId,
        canonicalId: m.modelId,
        displayName: m.displayName ?? m.modelId,
        provider: "openai",
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
          structuredOutput: m.supportsJsonMode ?? false,
          audioInput: m.supportsAudio ?? false,
          imageOutput: m.supportsImages ?? false,
          batchApi: false,
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
