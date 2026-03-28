import { BaseCollector } from "../base-collector.js";
import type { CollectorResult } from "../../schema.js";

/**
 * MiniMax pricing scraper — NO-OP.
 *
 * Experimental results showed MiniMax's platform pages are unreliable for
 * pricing extraction: pricing is in CNY with a confusing page structure that
 * Firecrawl cannot consistently parse. MiniMax pricing data is sourced from
 * OpenRouter and OpenCode Zen API collectors instead.
 */
export class MiniMaxScraper extends BaseCollector {
  readonly collectorId = "minimax-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    return this.makeResult(
      [],
      "MiniMax pricing page structure unreliable — using OpenRouter/Zen data"
    );
  }
}
