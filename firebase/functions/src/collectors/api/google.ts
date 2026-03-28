import { defineSecret } from "firebase-functions/params";
import { BaseCollector } from "../base-collector.js";
import type { CollectorResult, RawModel } from "../../schema.js";

const GOOGLE_GEMINI_API_KEY = defineSecret("GOOGLE_GEMINI_API_KEY");

interface GoogleModel {
  name: string;                  // e.g. "models/gemini-2.0-flash"
  baseModelId?: string;
  version?: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTemperature?: number;
  thinking?: boolean;
}

interface GoogleListResponse {
  models: GoogleModel[];
  nextPageToken?: string;
}

export class GoogleCollector extends BaseCollector {
  readonly collectorId = "google-api";

  async collect(): Promise<CollectorResult> {
    const models: RawModel[] = [];

    try {
      let pageToken: string | undefined;
      do {
        const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
        url.searchParams.set("key", GOOGLE_GEMINI_API_KEY.value());
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const resp = await fetch(url.toString());

        if (!resp.ok) {
          throw new Error(`Google API ${resp.status}: ${await resp.text()}`);
        }

        const data = await resp.json() as GoogleListResponse;

        for (const m of data.models ?? []) {
          // Extract model ID from the resource name (e.g., "models/gemini-2.0-flash" -> "gemini-2.0-flash")
          const externalId = m.name.replace(/^models\//, "");

          // Only include generative models
          const supportsMethods = m.supportedGenerationMethods ?? [];
          const isGenerative =
            supportsMethods.includes("generateContent") ||
            supportsMethods.includes("streamGenerateContent");
          if (!isGenerative) continue;

          // All Gemini models that support generateContent support vision (multimodal)
          const supportsGenerateContent = supportsMethods.includes("generateContent");

          // Prompt caching: API provides createCachedContent method
          const supportsPromptCaching = supportsMethods.includes("createCachedContent");

          // Batch API: API provides batchGenerateContent method
          const supportsBatch = supportsMethods.includes("batchGenerateContent");

          // Thinking: explicit field from API, or check model ID as fallback
          const supportsThinking = m.thinking === true || externalId.includes("thinking");

          models.push({
            collectorId: this.collectorId,
            confidence: "api_official",
            sourceUrl: "https://generativelanguage.googleapis.com/v1beta/models",
            externalId,
            canonicalId: externalId,
            displayName: m.displayName,
            description: m.description,
            apiVersion: m.version,
            provider: "google",
            contextWindow: m.inputTokenLimit,
            maxOutputTokens: m.outputTokenLimit,
            capabilities: {
              // All models with generateContent support are multimodal (vision)
              vision: supportsGenerateContent,
              tools: supportsGenerateContent,
              streaming: supportsMethods.includes("streamGenerateContent"),
              jsonMode: supportsGenerateContent,
              structuredOutput: supportsGenerateContent,
              thinking: supportsThinking,
              batchApi: supportsBatch,
              promptCaching: supportsPromptCaching,
              citations: false,
              codeExecution: true,
              pdfInput: false,
              fineTuning: false,
            },
            status: "active",
          });
        }

        pageToken = data.nextPageToken;
      } while (pageToken);

      return this.makeResult(models);
    } catch (err) {
      return this.makeResult([], String(err));
    }
  }
}
