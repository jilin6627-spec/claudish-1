import { BaseCollector } from "../base-collector.js";
import { extractModelsWithFirecrawl } from "./firecrawl.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const SOURCE_URL = "https://ai.google.dev/pricing";

const PROMPT =
  "Extract ALL Google Gemini model pricing. Include model IDs, input/output prices per million tokens USD, " +
  "context window sizes in tokens, and capabilities (vision, thinking, tools, audio, video, code). " +
  "Include free tier limits. Include all Gemini models: Pro, Flash, Nano, etc.";

export class GooglePricingScraper extends BaseCollector {
  readonly collectorId = "google-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    try {
      const extracted = await extractModelsWithFirecrawl(
        SOURCE_URL,
        "google gemini",
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
        provider: "google",
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
          audioInput: m.supportsAudio ?? false,
          videoInput: m.supportsAudio ?? false,
          codeExecution: false,
          batchApi: false,
          structuredOutput: false,
          citations: false,
          pdfInput: m.supportsPdf ?? false,
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
