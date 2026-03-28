import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenAIListResponse {
  data: OpenAIModel[];
  object: string;
}

export class OpenAICollector extends BaseCollector {
  readonly collectorId = "openai-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY.value()}`,
        },
      });

      if (!resp.ok) {
        throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as OpenAIListResponse;

      for (const m of data.data) {
        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://api.openai.com/v1/models",
          externalId: m.id,
          canonicalId: m.id,
          provider: "openai",
          releaseDate,
          status: "active",
        });
      }

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
