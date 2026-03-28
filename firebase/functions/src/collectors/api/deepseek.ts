import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const DEEPSEEK_API_KEY = defineSecret("DEEPSEEK_API_KEY");

interface DeepSeekModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

interface DeepSeekListResponse {
  object?: string;
  data: DeepSeekModel[];
}

export class DeepSeekCollector extends BaseCollector {
  readonly collectorId = "deepseek-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.deepseek.com/v1/models", {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY.value()}`,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`DeepSeek API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as DeepSeekListResponse;

      for (const m of data.data ?? []) {
        const modelIdLower = m.id.toLowerCase();
        const isReasoner = modelIdLower.includes("reasoner") || modelIdLower.includes("r1");

        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://api.deepseek.com/v1/models",
          externalId: m.id,
          canonicalId: m.id,
          provider: "deepseek",
          releaseDate,
          capabilities: {
            vision: false,
            tools: !isReasoner,
            streaming: true,
            jsonMode: !isReasoner,
            structuredOutput: false,
            thinking: isReasoner,
            batchApi: false,
            citations: false,
            codeExecution: false,
            pdfInput: false,
            fineTuning: false,
          },
          status: "active",
        });
      }

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
