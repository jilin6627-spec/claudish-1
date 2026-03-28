import { BaseCollector } from "../base-collector.js";
import type { CollectorResult } from "../../schema.js";

/**
 * Qwen/Alibaba pricing scraper — NO-OP.
 *
 * Experimental results showed the Alibaba Cloud model studio page did not
 * render content that Firecrawl could extract. Qwen pricing data is sourced
 * from OpenRouter API collector instead.
 */
export class QwenScraper extends BaseCollector {
  readonly collectorId = "qwen-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    return this.makeResult(
      [],
      "Qwen/Alibaba pricing page did not render — using OpenRouter data"
    );
  }
}
