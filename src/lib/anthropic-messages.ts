import {
  ROADMAP_TAILOR_OUTPUT_SCHEMA,
  ROADMAP_TAILOR_SYSTEM_PROMPT,
  parseRoadmapAiOutput,
  type RoadmapAiOutput,
} from "../domain/roadmap-ai.ts";

type AnthropicMessageResult = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
  error?: { type?: string; message?: string };
  request_id?: string;
};

export type AiProviderErrorDetails = {
  stage?: "configuration" | "network" | "response" | "validation" | "safety";
  upstreamStatus?: number;
  upstreamType?: string;
  upstreamRequestId?: string;
  publicMessage?: string;
};

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly blockedReason?: string,
    readonly details: AiProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  get publicMessage() {
    return this.details.publicMessage ?? "Roadmap Copilot is temporarily unavailable. Please try again.";
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

function publicProviderFailure(status: number) {
  if (status === 429) return "Roadmap Copilot is busy right now. Please try again in a minute.";
  return "Roadmap Copilot is temporarily unavailable. Please try again.";
}

function applicationStatusForProviderFailure(status: number) {
  if (status === 429) return 429;
  if (status === 504) return 504;
  if ([401, 402, 403, 404].includes(status)) return 503;
  return 502;
}

export async function createRoadmapAiResponse(input: unknown): Promise<{
  output: RoadmapAiOutput;
  inputTokens: number;
  outputTokens: number;
  model: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const { model } = getRoadmapAiProviderConfig();
  if (!apiKey) {
    throw new AiProviderError("ANTHROPIC_API_KEY is not configured", 503, undefined, {
      stage: "configuration",
      publicMessage: "Roadmap AI is not configured yet.",
    });
  }

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
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new AiProviderError(
      error instanceof Error ? error.message : "Could not reach Anthropic",
      timedOut ? 504 : 503,
      undefined,
      { stage: "network" },
    );
  }

  const result = await response.json().catch(() => ({})) as AnthropicMessageResult;
  if (!response.ok) {
    const upstreamStatus = response.status;
    const upstreamRequestId = response.headers.get("request-id") ?? result.request_id;
    throw new AiProviderError(
      result.error?.message ?? "Anthropic rejected the request",
      applicationStatusForProviderFailure(upstreamStatus),
      undefined,
      {
        stage: "response",
        upstreamStatus,
        upstreamType: result.error?.type ?? result.type,
        upstreamRequestId,
        publicMessage: publicProviderFailure(upstreamStatus),
      },
    );
  }
  if (result.stop_reason === "refusal") {
    throw new AiProviderError(
      "Roadmap Copilot could not process that request. Rephrase it as a roadmap-planning request.",
      400,
      "CLAUDE_REFUSAL",
      {
        stage: "safety",
        upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
        publicMessage: "Roadmap Copilot could not process that request. Rephrase it as a roadmap-planning request.",
      },
    );
  }
  if (result.stop_reason === "max_tokens") {
    throw new AiProviderError("Anthropic's response exceeded the configured output limit", 502, undefined, {
      stage: "validation",
      upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
    });
  }

  const text = outputText(result);
  if (!text) {
    throw new AiProviderError("Anthropic returned an empty response", 502, undefined, {
      stage: "validation",
      upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiProviderError("Anthropic returned invalid structured data", 502, undefined, {
      stage: "validation",
      upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
    });
  }
  let output: RoadmapAiOutput;
  try {
    output = parseRoadmapAiOutput(parsed);
  } catch (error) {
    throw new AiProviderError(
      error instanceof Error ? error.message : "Anthropic returned data that did not match the roadmap schema",
      502,
      undefined,
      {
        stage: "validation",
        upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
      },
    );
  }
  if (output.safetyStatus === "BLOCKED") {
    throw new AiProviderError(output.assistantMessage, 400, "CLAUDE_SAFETY_BLOCK", {
      stage: "safety",
      upstreamRequestId: response.headers.get("request-id") ?? result.request_id,
      publicMessage: output.assistantMessage,
    });
  }

  return {
    output,
    inputTokens: result.usage?.input_tokens ?? 0,
    outputTokens: result.usage?.output_tokens ?? 0,
    model,
  };
}
