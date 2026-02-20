import type {
  ChatConfig,
  ChatMessage,
  LLMClient,
  TokenUsage,
  ToolDefinition,
} from "./llm_client.ts";

// ---------------------------------------------------------------------------
// Output field schema helpers
// ---------------------------------------------------------------------------

export type OutputField =
  | { name: string; type: "string" }
  | { name: string; type: "string[]" }
  | { name: string; type: "class"; values: string[] };

export function buildOutputTool(
  name: string,
  fields: readonly OutputField[],
): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of fields) {
    required.push(field.name);
    switch (field.type) {
      case "string":
        properties[field.name] = { type: "string" };
        break;
      case "string[]":
        properties[field.name] = {
          type: "array",
          items: { type: "string" },
        };
        break;
      case "class":
        properties[field.name] = {
          type: "string",
          enum: field.values,
        };
        break;
    }
  }

  return {
    name,
    description: "Provide the structured output for this task.",
    parameters: {
      type: "object",
      properties,
      required,
    },
  };
}

// ---------------------------------------------------------------------------
// Step hooks (matches the shape used by worker.ts StepCollector)
// ---------------------------------------------------------------------------

export type StepHookContext = {
  stepIndex: number;
  usage: TokenUsage;
};

export type StepHooks = {
  afterStep?: (ctx: StepHookContext) => void;
};

// ---------------------------------------------------------------------------
// Agent config and forward
// ---------------------------------------------------------------------------

export type AgentConfig = {
  name: string;
  description: string;
  definition: string;
  outputTool: ToolDefinition;
  maxSteps: number;
  chatConfig: ChatConfig;
};

export class MaxStepsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaxStepsError";
  }
}

export async function agentForward(
  client: LLMClient,
  config: AgentConfig,
  inputs: Record<string, unknown>,
  options?: { stepHooks?: StepHooks },
): Promise<Record<string, unknown>> {
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(config),
  };

  const userContent = Object.entries(inputs)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    })
    .join("\n\n");

  const messages: ChatMessage[] = [
    systemMessage,
    { role: "user", content: userContent },
  ];

  for (let step = 0; step < config.maxSteps; step++) {
    const completion = await client.chat(messages, {
      tools: [config.outputTool],
      config: config.chatConfig,
    });

    options?.stepHooks?.afterStep?.({
      stepIndex: step,
      usage: completion.usage,
    });

    // Check for tool call with our output tool
    const outputCall = completion.toolCalls.find(
      (tc) => tc.name === config.outputTool.name,
    );

    if (outputCall) {
      return JSON.parse(outputCall.arguments) as Record<string, unknown>;
    }

    // If there is text content, try to extract JSON from it
    if (completion.content) {
      const extracted = tryExtractJSON(completion.content);
      if (extracted !== null) return extracted;
    }

    // If we got a response but no tool call, add it and continue
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: completion.content ?? "",
      toolCalls: completion.toolCalls.length > 0
        ? completion.toolCalls
        : undefined,
    };
    messages.push(assistantMsg);

    // If there were non-output tool calls, provide empty results to keep the loop going
    for (const tc of completion.toolCalls) {
      messages.push({
        role: "tool",
        content: "OK",
        toolCallId: tc.id,
      });
    }

    // If no tool calls at all, nudge the model
    if (completion.toolCalls.length === 0) {
      messages.push({
        role: "user",
        content:
          `Please use the "${config.outputTool.name}" tool to provide your structured output.`,
      });
    }
  }

  throw new MaxStepsError(
    `Max steps reached: ${config.maxSteps} steps exhausted for agent "${config.name}"`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(config: AgentConfig): string {
  return [
    config.definition,
    "",
    `You MUST respond using the "${config.outputTool.name}" tool to provide structured output.`,
    "Do not respond with plain text - always use the tool.",
  ].join("\n");
}

function tryExtractJSON(text: string): Record<string, unknown> | null {
  // Try to find JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not valid JSON
  }
  return null;
}
