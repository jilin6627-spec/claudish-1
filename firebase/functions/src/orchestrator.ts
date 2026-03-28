import type { CollectorResult } from "./schema.js";
import type { BaseCollector } from "./collectors/base-collector.js";
import { AnthropicCollector } from "./collectors/api/anthropic.js";
import { OpenAICollector } from "./collectors/api/openai.js";
import { GoogleCollector } from "./collectors/api/google.js";
import { OpenRouterCollector } from "./collectors/api/openrouter.js";
import { TogetherAICollector } from "./collectors/api/together-ai.js";
import { MistralCollector } from "./collectors/api/mistral.js";
import { DeepSeekCollector } from "./collectors/api/deepseek.js";
import { FireworksCollector } from "./collectors/api/fireworks.js";
import { OpenCodeZenCollector } from "./collectors/api/opencode-zen.js";
import { AnthropicPricingScraper } from "./collectors/scraper/anthropic-pricing.js";
import { OpenAIPricingScraper } from "./collectors/scraper/openai-pricing.js";
import { GooglePricingScraper } from "./collectors/scraper/google-pricing.js";
import { MiniMaxScraper } from "./collectors/scraper/minimax.js";
import { KimiScraper } from "./collectors/scraper/kimi.js";
import { GLMScraper } from "./collectors/scraper/glm.js";
import { QwenScraper } from "./collectors/scraper/qwen.js";
import { OpenCodeZenPricingScraper } from "./collectors/scraper/opencode-zen-pricing.js";
import { DeepSeekScraper } from "./collectors/scraper/deepseek.js";
import { XAIScraper } from "./collectors/scraper/xai.js";
import { MistralPricingScraper } from "./collectors/scraper/mistral-pricing.js";

export class CollectorOrchestrator {
  private collectors: BaseCollector[] = [
    // API collectors — highest confidence, run in parallel
    new AnthropicCollector(),
    new OpenAICollector(),
    new GoogleCollector(),
    new OpenRouterCollector(),
    new TogetherAICollector(),
    new MistralCollector(),
    new DeepSeekCollector(),
    new FireworksCollector(),
    new OpenCodeZenCollector(),
    // Scraper collectors — run concurrently with API collectors
    // Active scrapers (proven URLs)
    new AnthropicPricingScraper(),
    new OpenAIPricingScraper(),
    new GooglePricingScraper(),
    new GLMScraper(),
    new OpenCodeZenPricingScraper(),
    new DeepSeekScraper(),
    new XAIScraper(),
    new MistralPricingScraper(),
    // NO-OP scrapers — pages unreliable/gated; rely on API collectors
    new MiniMaxScraper(),
    new KimiScraper(),
    new QwenScraper(),
  ];

  async runAll(): Promise<CollectorResult[]> {
    const start = Date.now();
    console.log(`[catalog] running ${this.collectors.length} collectors in parallel`);

    const results = await Promise.allSettled(
      this.collectors.map(c => c.collect())
    );

    const collected: CollectorResult[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const result of results) {
      if (result.status === "fulfilled") {
        collected.push(result.value);
        if (result.value.error) {
          errorCount++;
          console.warn(
            `[catalog] collector ${result.value.collectorId} partial failure:`,
            result.value.error
          );
        } else {
          successCount++;
        }
      } else {
        errorCount++;
        console.error("[catalog] collector threw unexpectedly:", result.reason);
      }
    }

    const duration = Date.now() - start;
    const totalModels = collected.reduce((sum, r) => sum + r.models.length, 0);
    console.log(
      `[catalog] collection complete: ${successCount} ok, ${errorCount} failed, ` +
      `${totalModels} raw models, ${duration}ms`
    );

    return collected;
  }
}
