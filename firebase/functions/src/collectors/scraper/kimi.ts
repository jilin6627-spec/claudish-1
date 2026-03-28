import { BaseCollector } from "../base-collector.js";
import type { CollectorResult } from "../../schema.js";

/**
 * Kimi/Moonshot pricing scraper — NO-OP.
 *
 * Experimental results showed Kimi's pricing page requires WeChat
 * authentication and cannot be scraped programmatically. Kimi pricing data
 * is sourced from OpenRouter and OpenCode Zen API collectors instead.
 */
export class KimiScraper extends BaseCollector {
  readonly collectorId = "kimi-pricing-scrape";

  async collect(): Promise<CollectorResult> {
    return this.makeResult(
      [],
      "Kimi pricing requires WeChat authentication — using OpenRouter/Zen data"
    );
  }
}
