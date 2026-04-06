import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://docs.x.ai/docs/models";

const PROMPT =
  "Extract all xAI/Grok model information. Include model IDs, pricing per million tokens, " +
  "context window sizes, max output tokens, and capabilities (vision, tools, reasoning/thinking). " +
  "Include all Grok models and note which support function calling or extended reasoning.";

export class XAIScraper extends BaseCollector {
  readonly collectorId = "xai-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "xai grok",
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
