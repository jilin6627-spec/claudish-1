import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const MISTRAL_API_KEY = defineSecret("MISTRAL_API_KEY");

interface MistralModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  description?: string;
  max_context_length?: number;
  aliases?: string[];
  deprecation?: string | null;
  capabilities?: {
    completion_chat?: boolean;
    completion_fim?: boolean;
    function_calling?: boolean;
    fine_tuning?: boolean;
    vision?: boolean;
  };
  type?: string;
}

interface MistralListResponse {
  object?: string;
  data: MistralModel[];
}

export class MistralCollector extends BaseCollector {
  readonly collectorId = "mistral-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.mistral.ai/v1/models", {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY.value()}`,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`Mistral API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as MistralListResponse;

      for (const m of data.data ?? []) {
        // Skip embedding/moderation models
        if (m.type && m.type !== "base" && m.type !== "chat" && m.type !== "finetuned") {
          if (m.id.includes("embed") || m.id.includes("moderation")) continue;
        }

        const isDeprecated = !!m.deprecation;

        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        // Detect reasoning/thinking models (Mistral has no thinking field — use ID heuristics)
        const modelIdLower = m.id.toLowerCase();
        const isThinking = modelIdLower.includes("thinking") || modelIdLower.includes("magistral");

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://api.mistral.ai/v1/models",
          externalId: m.id,
          canonicalId: m.id,
          displayName: m.name ?? m.id,
          description: m.description,
          provider: "mistral",
          contextWindow: m.max_context_length,
          aliases: m.aliases ?? [],
          releaseDate,
          capabilities: {
            vision: m.capabilities?.vision ?? false,
            tools: m.capabilities?.function_calling ?? false,
            streaming: true,
            jsonMode: true,
            structuredOutput: true,
            thinking: isThinking,
            batchApi: false,
            citations: false,
            codeExecution: false,
            pdfInput: false,
            fineTuning: m.capabilities?.fine_tuning ?? false,
          },
          status: isDeprecated ? "deprecated" : "active",
        });
      }

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
