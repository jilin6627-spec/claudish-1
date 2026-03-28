import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

interface AnthropicCapabilityEntry {
  supported: boolean;
}

interface AnthropicEffortLevel {
  supported: boolean;
}

interface AnthropicThinkingTypes {
  enabled?: { supported: boolean };
  adaptive?: { supported: boolean };
}

interface AnthropicModel {
  id: string;
  display_name: string;
  created_at: string;
  type: string;
  capabilities?: {
    batch?: AnthropicCapabilityEntry;
    citations?: AnthropicCapabilityEntry;
    code_execution?: AnthropicCapabilityEntry;
    context_management?: AnthropicCapabilityEntry;
    effort?: {
      supported: boolean;
      low?: AnthropicEffortLevel;
      medium?: AnthropicEffortLevel;
      high?: AnthropicEffortLevel;
      max?: AnthropicEffortLevel;
    };
    image_input?: AnthropicCapabilityEntry;
    pdf_input?: AnthropicCapabilityEntry;
    structured_outputs?: AnthropicCapabilityEntry;
    thinking?: {
      supported: boolean;
      types?: AnthropicThinkingTypes;
    };
    // Legacy field names (kept for backwards compat)
    vision?: AnthropicCapabilityEntry;
    tool_use?: AnthropicCapabilityEntry;
    batch_processing?: AnthropicCapabilityEntry;
  };
  max_input_tokens?: number;
  max_output_tokens?: number;
}

interface AnthropicListResponse {
  data: AnthropicModel[];
  has_more: boolean;
  last_id?: string;
}

export class AnthropicCollector extends BaseCollector {
  readonly collectorId = "anthropic-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      // Paginate through all pages
      let nextPageToken: string | undefined;
      do {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "100");
        if (nextPageToken) url.searchParams.set("after_id", nextPageToken);

        const resp = await fetch(url.toString(), {
          headers: {
            "x-api-key": ANTHROPIC_API_KEY.value(),
            "anthropic-version": "2023-06-01",
          },
        });

        if (!resp.ok) {
          throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
        }

        const data = await resp.json() as AnthropicListResponse;

        for (const m of data.data) {
          const cap = m.capabilities ?? {};

          // Determine vision: new field is image_input, legacy is vision
          const hasVision = cap.image_input?.supported ?? cap.vision?.supported ?? false;

          // Determine batch: new field is batch, legacy is batch_processing
          const hasBatch = cap.batch?.supported ?? cap.batch_processing?.supported ?? false;

          // Determine tools: new field is tool_use (kept as legacy)
          const hasTools = cap.tool_use?.supported ?? true;

          // Determine thinking and adaptive thinking
          const hasThinking = cap.thinking?.supported ?? false;
          const hasAdaptiveThinking = cap.thinking?.types?.adaptive?.supported ?? false;

          // Collect effort levels that are supported
          const effortLevels: string[] = [];
          if (cap.effort?.supported) {
            if (cap.effort.low?.supported) effortLevels.push("low");
            if (cap.effort.medium?.supported) effortLevels.push("medium");
            if (cap.effort.high?.supported) effortLevels.push("high");
            if (cap.effort.max?.supported) effortLevels.push("max");
          }

          // Convert created_at ISO string to date-only string
          const releaseDate = m.created_at ? m.created_at.split("T")[0] : undefined;

          models.push({
            collectorId: this.collectorId,
            confidence: "api_official",
            sourceUrl: "https://api.anthropic.com/v1/models",
            externalId: m.id,
            canonicalId: m.id,
            displayName: m.display_name,
            provider: "anthropic",
            contextWindow: m.max_input_tokens,
            maxOutputTokens: m.max_output_tokens,
            releaseDate,
            capabilities: {
              vision: hasVision,
              thinking: hasThinking,
              tools: hasTools,
              streaming: true,
              batchApi: hasBatch,
              citations: cap.citations?.supported ?? false,
              codeExecution: cap.code_execution?.supported ?? false,
              pdfInput: cap.pdf_input?.supported ?? false,
              structuredOutput: cap.structured_outputs?.supported ?? false,
              jsonMode: false,
              fineTuning: false,
              contextManagement: cap.context_management?.supported ?? false,
              adaptiveThinking: hasAdaptiveThinking,
              ...(effortLevels.length > 0 ? { effortLevels } : {}),
            },
            status: "active",
          });
        }

        nextPageToken = data.has_more ? data.last_id : undefined;
      } while (nextPageToken);

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
