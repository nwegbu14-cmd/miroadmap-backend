import {
  ROADMAP_TAILOR_OUTPUT_SCHEMA,
  ROADMAP_TAILOR_SYSTEM_PROMPT,
  parseRoadmapAiOutput,
  type RoadmapAiOutput,
} from "../domain/roadmap-ai.ts";

type AnthropicMessageResult = {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
  error?: { type?: string; message?: string };
};

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly blockedReason?: string,
  ) {
    super(message);
  }
}

export function getRoadmapAiProviderConfig() {
  return {
    configured: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
  };
}

function outputText(result: AnthropicMessageResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function createRoadmapAiResponse(input: unknown): Promise<{
  output: RoadmapAiOutput;
  inputTokens: number;
  outputTokens: number;
  model: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const { model } = getRoadmapAiProviderConfig();
  if (!apiKey) throw new AiProviderError("Roadmap AI is not configured yet", 503);

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2_000,
        system: ROADMAP_TAILOR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(input) }],
        thinking: { type: "disabled" },
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: ROADMAP_TAILOR_OUTPUT_SCHEMA,
          },
        },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new AiProviderError(error instanceof Error ? error.message : "Could not reach Anthropic");
  }

  const result = await response.json().catch(() => ({})) as AnthropicMessageResult;
  if (!response.ok) {
    throw new AiProviderError(
      result.error?.message ?? "Anthropic rejected the request",
      response.status === 429 ? 429 : response.status === 400 ? 400 : 502,
    );
  }
  if (result.stop_reason === "refusal") {
    throw new AiProviderError(
      "Roadmap Copilot could not process that request. Rephrase it as a roadmap-planning request.",
      400,
      "CLAUDE_REFUSAL",
    );
  }
  if (result.stop_reason === "max_tokens") {
    throw new AiProviderError("Anthropic's response exceeded the configured output limit");
  }

  const text = outputText(result);
  if (!text) throw new AiProviderError("Anthropic returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiProviderError("Anthropic returned invalid structured data");
  }
  const output = parseRoadmapAiOutput(parsed);
  if (output.safetyStatus === "BLOCKED") {
    throw new AiProviderError(output.assistantMessage, 400, "CLAUDE_SAFETY_BLOCK");
  }

  return {
    output,
    inputTokens: result.usage?.input_tokens ?? 0,
    outputTokens: result.usage?.output_tokens ?? 0,
    model,
  };
}
