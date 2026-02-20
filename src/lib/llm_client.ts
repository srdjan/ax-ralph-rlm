import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string; // JSON string
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ChatCompletion = {
  content: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason: "end" | "tool_use" | "max_tokens" | "unknown";
};

export type ChatConfig = {
  temperature?: number;
  maxTokens?: number;
};

export type LLMClient = {
  chat(
    messages: readonly ChatMessage[],
    options?: {
      tools?: readonly ToolDefinition[];
      config?: ChatConfig;
    },
  ): Promise<ChatCompletion>;
  readonly model: string;
  readonly provider: "anthropic" | "openai";
};

// ---------------------------------------------------------------------------
// Anthropic implementation
// ---------------------------------------------------------------------------

function anthropicToolDefs(
  tools: readonly ToolDefinition[],
): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(
  messages: readonly ChatMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled separately

    if (msg.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      // Tool result - must be attached to previous user message or standalone
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
          },
        ],
      });
      continue;
    }

    // user
    out.push({ role: "user", content: msg.content });
  }

  return out;
}

function mapAnthropicStopReason(
  reason: string | null | undefined,
): ChatCompletion["stopReason"] {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "unknown";
  }
}

export function makeAnthropicClient(
  apiKey: string,
  model: string,
): LLMClient {
  const client = new Anthropic({ apiKey });

  return {
    model,
    provider: "anthropic",

    async chat(messages, options) {
      const systemMessages = messages.filter((m) => m.role === "system");
      const system = systemMessages.length > 0
        ? systemMessages.map((m) => m.content).join("\n\n")
        : undefined;

      const anthropicMessages = toAnthropicMessages(messages);

      const params: Anthropic.MessageCreateParams = {
        model,
        messages: anthropicMessages,
        max_tokens: options?.config?.maxTokens ?? 4096,
      };

      if (system) {
        params.system = system;
      }
      if (options?.config?.temperature !== undefined) {
        params.temperature = options.config.temperature;
      }
      if (options?.tools && options.tools.length > 0) {
        params.tools = anthropicToolDefs(options.tools);
      }

      const response = await client.messages.create(params);

      let textContent: string | null = null;
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textContent = (textContent ?? "") + block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      return {
        content: textContent,
        toolCalls,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens +
            response.usage.output_tokens,
        },
        stopReason: mapAnthropicStopReason(response.stop_reason),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI implementation
// ---------------------------------------------------------------------------

function openaiToolDefs(
  tools: readonly ToolDefinition[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function toOpenAIMessages(
  messages: readonly ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const param: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: msg.content ?? null,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        param.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      out.push(param);
      continue;
    }

    if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: msg.toolCallId ?? "",
        content: msg.content,
      });
      continue;
    }

    // user
    out.push({ role: "user", content: msg.content });
  }

  return out;
}

function mapOpenAIFinishReason(
  reason: string | null | undefined,
): ChatCompletion["stopReason"] {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "unknown";
  }
}

export function makeOpenAIClient(
  apiKey: string,
  model: string,
): LLMClient {
  const client = new OpenAI({ apiKey });

  return {
    model,
    provider: "openai",

    async chat(messages, options) {
      const params: OpenAI.ChatCompletionCreateParams = {
        model,
        messages: toOpenAIMessages(messages),
      };

      if (options?.config?.temperature !== undefined) {
        params.temperature = options.config.temperature;
      }
      if (options?.config?.maxTokens !== undefined) {
        params.max_tokens = options.config.maxTokens;
      }
      if (options?.tools && options.tools.length > 0) {
        params.tools = openaiToolDefs(options.tools);
        params.tool_choice = "auto";
      }

      const response = await client.chat.completions.create(params);
      const choice = response.choices[0];
      const msg = choice?.message;

      const toolCalls: ToolCall[] = [];
      if (msg?.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }

      return {
        content: msg?.content ?? null,
        toolCalls,
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
        stopReason: mapOpenAIFinishReason(choice?.finish_reason),
      };
    },
  };
}
