#!/usr/bin/env bun

/**
 * Claudish MCP Server
 *
 * Exposes OpenRouter models as MCP tools for Claude Code.
 * Run with: claudish-mcp (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  setupSession,
  runModels,
  judgeResponses,
  getStatus,
  validateSessionPath,
} from "./team-orchestrator.js";

// Load environment variables
config();

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths - use ~/.claudish/ for writable cache (binaries can't write to __dirname)
const RECOMMENDED_MODELS_PATH = join(__dirname, "../recommended-models.json");
const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
const ALL_MODELS_CACHE_PATH = join(CLAUDISH_CACHE_DIR, "all-models.json");
const CACHE_MAX_AGE_DAYS = 2;

// Types
interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  pricing?: {
    input: string;
    output: string;
    average: string;
  };
  context?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
}

interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Load recommended models from JSON
 */
function loadRecommendedModels(): ModelInfo[] {
  if (existsSync(RECOMMENDED_MODELS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(RECOMMENDED_MODELS_PATH, "utf-8"));
      return data.models || [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Load or fetch all models from OpenRouter
 */
async function loadAllModels(forceRefresh = false): Promise<any[]> {
  // Check cache
  if (!forceRefresh && existsSync(ALL_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        return cacheData.models || [];
      }
    } catch {
      // Cache invalid, fetch fresh
    }
  }

  // Fetch from OpenRouter
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const data = await response.json();
    const models = data.data || [];

    // Cache result - ensure directory exists
    mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
    writeFileSync(
      ALL_MODELS_CACHE_PATH,
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        models,
      }),
      "utf-8"
    );

    return models;
  } catch (error) {
    // Return cached data if available, even if stale
    if (existsSync(ALL_MODELS_CACHE_PATH)) {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_CACHE_PATH, "utf-8"));
      return cacheData.models || [];
    }
    return [];
  }
}

/**
 * Run a prompt through OpenRouter
 */
async function runPrompt(
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number
): Promise<{ content: string; usage?: { input: number; output: number } }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY environment variable not set");
  }

  const messages: Array<{ role: string; content: string }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish MCP",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data: OpenRouterResponse = await response.json();

  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage
    ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    : undefined;

  return { content, usage };
}

/**
 * Fuzzy search score
 */
function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerText === lowerQuery) return 1;
  if (lowerText.includes(lowerQuery)) return 0.8;

  // Simple character match
  let score = 0;
  let queryIndex = 0;
  for (const char of lowerText) {
    if (queryIndex < lowerQuery.length && char === lowerQuery[queryIndex]) {
      score++;
      queryIndex++;
    }
  }

  return queryIndex === lowerQuery.length ? score / lowerText.length : 0;
}

/**
 * Format team run results with rich error context for failed models.
 */
function formatTeamResult(
  status: import("./team-orchestrator.js").TeamStatus,
  sessionPath: string
): string {
  const entries = Object.entries(status.models);
  const failed = entries.filter(([, m]) => m.state === "FAILED" || m.state === "TIMEOUT");
  const succeeded = entries.filter(([, m]) => m.state === "COMPLETED");

  let result = JSON.stringify(status, null, 2);

  if (failed.length > 0) {
    result += "\n\n---\n## Failures Detected\n\n";
    result += `${succeeded.length}/${entries.length} models succeeded, ${failed.length} failed.\n\n`;

    for (const [id, m] of failed) {
      result += `### Model ${id}: ${m.state}\n`;
      if (m.error) {
        result += `- **Model:** ${m.error.model}\n`;
        result += `- **Command:** \`${m.error.command}\`\n`;
        result += `- **Exit code:** ${m.exitCode}\n`;
        if (m.error.stderrSnippet) {
          result += `- **Error output:**\n\`\`\`\n${m.error.stderrSnippet}\n\`\`\`\n`;
        }
        result += `- **Full error log:** ${m.error.errorLogPath}\n`;
        result += `- **Working directory:** ${m.error.workDir}\n`;
      }
      result += "\n";
    }

    result += "---\n";
    result += "**To help claudish devs fix this**, use the `report_error` tool with:\n";
    result += '- `error_type`: "provider_failure" or "team_failure"\n';
    result += `- \`session_path\`: "${sessionPath}"\n`;
    result += "- Copy the stderr snippet above into `stderr_snippet`\n";
    result += "- Set `auto_send: true` to suggest enabling automatic reporting\n";
  }

  return result;
}

/**
 * Create and start the MCP server
 */
async function main() {
  const server = new McpServer({
    name: "claudish",
    version: "2.5.0",
  });

  const toolMode = (process.env.CLAUDISH_MCP_TOOLS || "all").toLowerCase();
  const isLowLevel = toolMode === "all" || toolMode === "low-level";
  const isAgentic = toolMode === "all" || toolMode === "agentic";

  console.error(`[claudish] MCP server started (tools: ${toolMode})`);

  if (isLowLevel) {
  // Tool: run_prompt - Run a prompt through an OpenRouter model
  server.tool(
    "run_prompt",
    "Run a prompt through an OpenRouter model (Grok, GPT-5, Gemini, etc.)",
    {
      model: z
        .string()
        .describe("OpenRouter model ID (e.g., 'x-ai/grok-code-fast-1', 'openai/gpt-5.1-codex')"),
      prompt: z.string().describe("The prompt to send to the model"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      max_tokens: z.number().optional().describe("Maximum tokens in response (omit to let model decide)"),
    },
    async ({ model, prompt, system_prompt, max_tokens }) => {
      try {
        const result = await runPrompt(model, prompt, system_prompt, max_tokens);

        let response = result.content;
        if (result.usage) {
          response += `\n\n---\nTokens: ${result.usage.input} input, ${result.usage.output} output`;
        }

        return { content: [{ type: "text", text: response }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: list_models - List recommended models
  server.tool("list_models", "List recommended models for coding tasks", {}, async () => {
    const models = loadRecommendedModels();

    if (models.length === 0) {
      return {
        content: [
          { type: "text", text: "No recommended models found. Try search_models instead." },
        ],
      };
    }

    let output = "# Recommended Models\n\n";
    output += "| Model | Provider | Pricing | Context | Tools | Reasoning | Vision |\n";
    output += "|-------|----------|---------|---------|-------|-----------|--------|\n";

    for (const model of models) {
      const tools = model.supportsTools ? "✓" : "·";
      const reasoning = model.supportsReasoning ? "✓" : "·";
      const vision = model.supportsVision ? "✓" : "·";
      output += `| ${model.id} | ${model.provider} | ${model.pricing?.average || "N/A"} | ${model.context || "N/A"} | ${tools} | ${reasoning} | ${vision} |\n`;
    }

    output += "\n## Quick Picks\n";
    output += "- **Budget**: `minimax-m2.5` ($0.75/1M)\n";
    output += "- **Large context**: `gemini-3.1-pro-preview` (1M tokens)\n";
    output += "- **Most advanced**: `gpt-5.4` ($8.75/1M)\n";
    output += "- **Vision + coding**: `kimi-k2.5` ($1.32/1M)\n";
    output += "- **Agentic**: `glm-5` ($1.68/1M)\n";
    output += "- **Multimodal**: `qwen3.5-plus-02-15` ($1.40/1M)\n";

    return { content: [{ type: "text", text: output }] };
  });

  // Tool: search_models - Search all OpenRouter models
  server.tool(
    "search_models",
    "Search all OpenRouter models by name, provider, or capability",
    {
      query: z.string().describe("Search query (e.g., 'grok', 'vision', 'free')"),
      limit: z.number().optional().describe("Maximum results to return (default: 10)"),
    },
    async ({ query, limit }) => {
      const maxResults = limit || 10;
      const allModels = await loadAllModels();

      if (allModels.length === 0) {
        return {
          content: [
            { type: "text", text: "Failed to load models. Check your internet connection." },
          ],
          isError: true,
        };
      }

      // Search with fuzzy matching
      const results = allModels
        .map((model) => {
          const nameScore = fuzzyScore(model.name || "", query);
          const idScore = fuzzyScore(model.id || "", query);
          const descScore = fuzzyScore(model.description || "", query) * 0.5;
          return { model, score: Math.max(nameScore, idScore, descScore) };
        })
        .filter((item) => item.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No models found matching "${query}"` }],
        };
      }

      let output = `# Search Results for "${query}"\n\n`;
      output += "| Model | Provider | Pricing | Context |\n";
      output += "|-------|----------|---------|----------|\n";

      for (const { model } of results) {
        const provider = model.id.split("/")[0];
        const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
        const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
        const avgPrice = (promptPrice + completionPrice) / 2;
        const pricing =
          avgPrice > 0 ? `$${avgPrice.toFixed(2)}/1M` : avgPrice < 0 ? "varies" : "FREE";
        const context = model.context_length
          ? `${Math.round(model.context_length / 1000)}K`
          : "N/A";

        output += `| ${model.id} | ${provider} | ${pricing} | ${context} |\n`;
      }

      output += `\nUse with: run_prompt(model="${results[0].model.id}", prompt="your prompt")`;

      return { content: [{ type: "text", text: output }] };
    }
  );

  // Tool: compare_models - Run same prompt through multiple models
  server.tool(
    "compare_models",
    "Run the same prompt through multiple models and compare responses",
    {
      models: z.array(z.string()).describe("List of model IDs to compare"),
      prompt: z.string().describe("The prompt to send to all models"),
      system_prompt: z.string().optional().describe("Optional system prompt"),
      max_tokens: z.number().optional().describe("Maximum tokens in response (omit to let model decide)"),
    },
    async ({ models, prompt, system_prompt, max_tokens }) => {
      const results: Array<{
        model: string;
        response: string;
        error?: string;
        tokens?: { input: number; output: number };
      }> = [];

      for (const model of models) {
        try {
          const result = await runPrompt(model, prompt, system_prompt, max_tokens);
          results.push({
            model,
            response: result.content,
            tokens: result.usage,
          });
        } catch (error) {
          results.push({
            model,
            response: "",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let output = "# Model Comparison\n\n";
      output += `**Prompt:** ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}\n\n`;

      for (const result of results) {
        output += `## ${result.model}\n\n`;
        if (result.error) {
          output += `**Error:** ${result.error}\n\n`;
        } else {
          output += result.response + "\n\n";
          if (result.tokens) {
            output += `*Tokens: ${result.tokens.input} in, ${result.tokens.output} out*\n\n`;
          }
        }
        output += "---\n\n";
      }

      return { content: [{ type: "text", text: output }] };
    }
  );
  } // isLowLevel

  if (isAgentic) {
  // Tool: team - Multi-model orchestration with anonymized blind evaluation
  server.tool(
    "team",
    "Run AI models on a task with anonymized outputs and optional blind judging. Modes: 'run' (execute models), 'judge' (blind-vote on existing outputs), 'run-and-judge' (full pipeline), 'status' (check progress).",
    {
      mode: z
        .enum(["run", "judge", "run-and-judge", "status"])
        .describe("Operation mode"),
      path: z.string().describe("Session directory path (must be within current working directory)"),
      models: z
        .array(z.string())
        .optional()
        .describe("Model IDs to run (required for 'run' and 'run-and-judge' modes)"),
      judges: z
        .array(z.string())
        .optional()
        .describe("Model IDs to use as judges (default: same as runners)"),
      input: z
        .string()
        .optional()
        .describe("Task prompt text (or place input.md in the session directory before calling)"),
      timeout: z.number().optional().describe("Per-model timeout in seconds (default: 300)"),
    },
    async ({ mode, path, models, judges, input, timeout }) => {
      try {
        const resolved = validateSessionPath(path);

        switch (mode) {
          case "run": {
            if (!models?.length) throw new Error("'models' is required for 'run' mode");
            setupSession(resolved, models, input);
            const status = await runModels(resolved, { timeout });
            return { content: [{ type: "text", text: formatTeamResult(status, resolved) }] };
          }
          case "judge": {
            const verdict = await judgeResponses(resolved, { judges });
            return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }] };
          }
          case "run-and-judge": {
            if (!models?.length) throw new Error("'models' is required for 'run-and-judge' mode");
            setupSession(resolved, models, input);
            await runModels(resolved, { timeout });
            const verdict = await judgeResponses(resolved, { judges });
            return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }] };
          }
          case "status": {
            const status = getStatus(resolved);
            return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
          }
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool: report_error - Send anonymized error data to claudish devs
  server.tool(
    "report_error",
    "Report a claudish error to developers. IMPORTANT: Ask the user for consent BEFORE calling this tool. Show them what data will be sent (sanitized). All data is anonymized: API keys, user paths, and emails are stripped. Set auto_send=true to suggest the user enables automatic future reporting.",
    {
      error_type: z
        .enum(["provider_failure", "team_failure", "stream_error", "adapter_error", "other"])
        .describe("Category of the error"),
      model: z.string().optional().describe("Model ID that failed (anonymized in report)"),
      command: z.string().optional().describe("Command that was run"),
      stderr_snippet: z.string().optional().describe("First 500 chars of stderr output"),
      exit_code: z.number().optional().describe("Process exit code"),
      error_log_path: z.string().optional().describe("Path to full error log file"),
      session_path: z.string().optional().describe("Path to team session directory"),
      additional_context: z.string().optional().describe("Any extra context about the error"),
      auto_send: z
        .boolean()
        .optional()
        .describe("If true, suggest the user enable automatic error reporting"),
    },
    async ({
      error_type,
      model,
      command,
      stderr_snippet,
      exit_code,
      error_log_path,
      session_path,
      additional_context,
      auto_send,
    }) => {
      // Sanitize: strip API keys, paths with usernames, env vars
      function sanitize(text: string | undefined): string {
        if (!text) return "";
        return text
          .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "sk-***REDACTED***")
          .replace(/Bearer [a-zA-Z0-9_.-]+/g, "Bearer ***REDACTED***")
          .replace(/\/Users\/[^/\s]+/g, "/Users/***")
          .replace(/\/home\/[^/\s]+/g, "/home/***")
          .replace(/[A-Z_]+_API_KEY=[^\s]+/g, "***_API_KEY=REDACTED")
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "***@***.***");
      }

      // Read stderr from log file — include full content, not just snippet
      let stderrFull = stderr_snippet || "";
      if (error_log_path) {
        try {
          stderrFull = readFileSync(error_log_path, "utf-8");
        } catch {
          // log file may not exist
        }
      }

      // Read session data if session_path provided (status, manifest, response outputs)
      let sessionData: Record<string, string> = {};
      if (session_path) {
        const sp = session_path;
        for (const file of ["status.json", "manifest.json", "input.md"]) {
          try { sessionData[file] = readFileSync(join(sp, file), "utf-8"); } catch {}
        }
        try {
          const errorDir = join(sp, "errors");
          if (existsSync(errorDir)) {
            for (const f of readdirSync(errorDir)) {
              if (f.endsWith(".log")) {
                try { sessionData[`errors/${f}`] = readFileSync(join(errorDir, f), "utf-8"); } catch {}
              }
            }
          }
        } catch {}
        try {
          for (const f of readdirSync(sp)) {
            if (f.startsWith("response-") && f.endsWith(".md")) {
              try {
                const content = readFileSync(join(sp, f), "utf-8");
                sessionData[f] = content.slice(0, 200) + (content.length > 200 ? "... (truncated)" : "");
              } catch {}
            }
          }
        } catch {}
      }

      // Read claudish version
      let version = "unknown";
      try {
        const pkgPath = join(__dirname, "../package.json");
        if (existsSync(pkgPath)) {
          version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
        }
      } catch {}

      const report = {
        version,
        timestamp: new Date().toISOString(),
        error_type,
        model: model || "unknown",
        command: sanitize(command),
        stderr: sanitize(stderrFull),
        exit_code: exit_code ?? null,
        platform: process.platform,
        arch: process.arch,
        runtime: `bun ${process.version}`,
        context: sanitize(additional_context),
        session: Object.fromEntries(
          Object.entries(sessionData).map(([k, v]) => [k, sanitize(v)])
        ),
      };

      const reportSummary = JSON.stringify(report, null, 2);
      const autoSendHint = auto_send
        ? "\n\n**Suggestion:** Enable automatic error reporting so future errors are sent without asking. Run `claudish config` → Privacy → toggle Telemetry, or set `CLAUDISH_TELEMETRY=1`."
        : "";

      const REPORT_URL = "https://api.claudish.com/v1/error-reports";

      try {
        const response = await fetch(REPORT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          return { content: [{ type: "text", text: `Error report sent successfully.\n\n**Sanitized data sent:**\n\`\`\`json\n${reportSummary}\n\`\`\`${autoSendHint}` }] };
        } else {
          return { content: [{ type: "text", text: `Error report endpoint returned ${response.status}. Report was NOT sent.\n\n**Data that would have been sent (all sanitized):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nYou can manually report this at https://github.com/anthropics/claudish/issues${autoSendHint}` }] };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Could not reach error reporting endpoint (${err instanceof Error ? err.message : "network error"}).\n\n**Sanitized error data (for manual reporting):**\n\`\`\`json\n${reportSummary}\n\`\`\`\n\nReport manually at https://github.com/anthropics/claudish/issues${autoSendHint}` }] };
      }
    }
  );
  } // isAgentic

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Entry point for MCP server mode
 * Called from index.ts when --mcp flag is used
 */
export function startMcpServer() {
  main().catch((error) => {
    console.error("[claudish] MCP fatal error:", error);
    process.exit(1);
  });
}
