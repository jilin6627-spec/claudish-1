import type { CollectorResult } from "../schema.js";

export abstract class BaseCollector {
  abstract readonly collectorId: string;

  /** Run collection. Never throws — errors are captured in result.error. */
  abstract collect(): Promise<CollectorResult>;

  protected makeResult(
    models: CollectorResult["models"],
    error?: string
  ): CollectorResult {
    return {
      collectorId: this.collectorId,
      models,
      error,
      fetchedAt: new Date(),
    };
  }
}
