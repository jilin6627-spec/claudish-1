import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const FIREWORKS_API_KEY = defineSecret("FIREWORKS_API_KEY");

interface FireworksModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  public?: boolean;
  supports_image_input?: boolean;
  supports_tools?: boolean;
}

interface FireworksListResponse {
  object?: string;
  data: FireworksModel[];
}

export class FireworksCollector extends BaseCollector {
  readonly collectorId = "fireworks-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.fireworks.ai/inference/v1/models", {
        headers: {
          Authorization: `Bearer ${FIREWORKS_API_KEY.value()}`,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`Fireworks API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as FireworksListResponse;

      for (const m of data.data ?? []) {
        // Only include public models
        if (m.public === false) continue;

        // Extract canonical ID from the fireworks account path
        // e.g. "accounts/fireworks/models/llama-v3p1-70b-instruct" -> "llama-v3p1-70b-instruct"
        const canonicalId = m.id.replace(/^accounts\/[^/]+\/models\//, "");

        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        const modelIdLower = m.id.toLowerCase();
        const isReasoner = modelIdLower.includes("r1") || modelIdLower.includes("reasoner") ||
          modelIdLower.includes("thinking");

        models.push({
          collectorId: this.collectorId,
          confidence: "aggregator_reported",
          sourceUrl: "https://api.fireworks.ai/inference/v1/models",
          externalId: m.id,
          canonicalId,
          provider: "fireworks",
          contextWindow: m.context_length,
          releaseDate,
          capabilities: {
            vision: m.supports_image_input ?? false,
            tools: m.supports_tools ?? false,
            streaming: true,
            jsonMode: true,
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
