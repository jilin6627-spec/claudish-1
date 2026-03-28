import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const TOGETHER_API_KEY = defineSecret("TOGETHER_API_KEY");

interface TogetherModel {
  id: string;
  object?: string;
  created?: number;
  type?: string;
  display_name?: string;
  organization?: string;
  link?: string;
  license?: string;
  context_length?: number;
  pricing?: {
    input?: number;    // USD per million tokens
    output?: number;
    base?: number;
    finetune?: number;
  };
  config?: {
    chat_template?: string;
    stop?: string[];
    bos_token?: string;
    eos_token?: string;
  };
}

export class TogetherAICollector extends BaseCollector {
  readonly collectorId = "together-ai-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      const resp = await fetch("https://api.together.xyz/v1/models", {
        headers: {
          Authorization: `Bearer ${TOGETHER_API_KEY.value()}`,
          "Accept": "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`Together AI API ${resp.status}: ${await resp.text()}`);
      }

      const data = await resp.json() as TogetherModel[];

      for (const m of (Array.isArray(data) ? data : [])) {
        const modelType = m.type?.toLowerCase() ?? "";

        // Convert Unix timestamp to ISO date string
        const releaseDate = m.created
          ? new Date(m.created * 1000).toISOString().split("T")[0]
          : undefined;

        const pricing =
          m.pricing?.input !== undefined && m.pricing?.output !== undefined
            ? {
                input: m.pricing.input,
                output: m.pricing.output,
              }
            : undefined;

        // Normalize provider slug from organization field
        const provider = m.organization
          ? m.organization.toLowerCase().replace(/\s+/g, "-")
          : "together-ai";

        models.push({
          collectorId: this.collectorId,
          confidence: "api_official",
          sourceUrl: "https://api.together.xyz/v1/models",
          externalId: m.id,
          canonicalId: m.id,
          displayName: m.display_name ?? m.id,
          provider,
          pricing,
          contextWindow: m.context_length,
          releaseDate,
          capabilities: {
            vision: false,
            tools: modelType.includes("chat"),
            streaming: true,
            jsonMode: modelType.includes("chat"),
            structuredOutput: false,
            thinking: m.id.toLowerCase().includes("reasoner") || m.id.toLowerCase().includes("r1"),
            batchApi: false,
            citations: false,
            codeExecution: false,
            pdfInput: false,
            fineTuning: m.pricing?.finetune !== undefined,
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
