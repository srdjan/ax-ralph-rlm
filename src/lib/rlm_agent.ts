import {
  type ChatConfig,
  type ChatMessage,
  type LLMClient,
  type ToolDefinition,
} from "./llm_client.ts";
import {
  buildOutputTool,
  MaxStepsError,
  type OutputField,
  type StepHooks,
} from "./agent.ts";
import { createSandboxSession, type RuntimeSession } from "./rlm_runtime.ts";
import {
  buildContextMetadata,
  buildRLMPrompt,
  buildRLMTrajectory,
  truncate,
} from "./rlm_prompt.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type RLMAgentConfig = {
  name: string;
  description: string;
  definition: string;
  contextFields: readonly string[];
  outputFields: readonly OutputField[];
  maxSteps: number;
  chatConfig: ChatConfig;
  rlm: {
    maxLlmCalls: number;
    maxRuntimeChars: number;
    maxBatchedLlmQueryConcurrency: number;
  };
};

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

export async function rlmAgentForward(
  client: LLMClient,
  config: RLMAgentConfig,
  inputs: Record<string, string>,
  options?: { stepHooks?: StepHooks },
): Promise<Record<string, unknown>> {
  // 1. Separate context fields from user input fields
  const contextValues: Record<string, string> = {};
  const userInputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (config.contextFields.includes(k)) {
      contextValues[k] = v;
    } else {
      userInputs[k] = v;
    }
  }

  // 2. Build llmQuery function with call-count tracking
  let llmCallCount = 0;
  const maxLlmCalls = config.rlm.maxLlmCalls;
  const maxRuntimeChars = config.rlm.maxRuntimeChars;
  const maxBatchConcurrency = config.rlm.maxBatchedLlmQueryConcurrency;
  const warnThreshold = Math.floor(maxLlmCalls * 0.8);
  const codeTrajectory: { code: string; output: string }[] = [];

  async function singleLlmQuery(
    query: string,
    context?: string,
  ): Promise<string> {
    llmCallCount++;
    if (llmCallCount > maxLlmCalls) {
      return `[ERROR] Sub-query budget exhausted (${maxLlmCalls}/${maxLlmCalls}). Use the data you have already accumulated to produce your final answer.`;
    }

    const truncatedCtx = context
      ? truncate(context, maxRuntimeChars)
      : undefined;

    const msgs: ChatMessage[] = [
      {
        role: "system",
        content: "Answer the query based on the provided context.",
      },
      {
        role: "user",
        content: truncatedCtx
          ? `Context:\n${truncatedCtx}\n\nQuery: ${query}`
          : query,
      },
    ];

    const completion = await client.chat(msgs);
    const result = completion.content ?? "";

    if (llmCallCount === warnThreshold) {
      return `${result}\n[WARNING] ${llmCallCount}/${maxLlmCalls} sub-queries used. Plan to wrap up soon.`;
    }
    return result;
  }

  async function llmQuery(
    queryOrBatch: unknown,
    context?: unknown,
  ): Promise<unknown> {
    // Single { query, context? } object
    if (
      !Array.isArray(queryOrBatch) && typeof queryOrBatch === "object" &&
      queryOrBatch !== null && "query" in queryOrBatch
    ) {
      const obj = queryOrBatch as { query: string; context?: string };
      return await singleLlmQuery(
        obj.query,
        obj.context ?? (context ? String(context) : undefined),
      );
    }

    // Batched: array of { query, context? }
    if (Array.isArray(queryOrBatch)) {
      return await batchedLlmQuery(
        queryOrBatch as { query: string; context?: string }[],
        maxBatchConcurrency,
      );
    }

    // Single string query
    return await singleLlmQuery(
      String(queryOrBatch),
      context ? String(context) : undefined,
    );
  }

  async function batchedLlmQuery(
    items: { query: string; context?: string }[],
    concurrency: number,
  ): Promise<string[]> {
    if (items.length === 0) return [];
    const results = new Array<string>(items.length);
    let nextIdx = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= items.length) return;
          const item = items[idx];
          try {
            results[idx] = await singleLlmQuery(
              item.query,
              item.context,
            );
          } catch (err: unknown) {
            results[idx] = `[ERROR] ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  // 3. Create sandbox session
  let session: RuntimeSession = createSandboxSession(
    contextValues,
    { llmQuery },
    { timeout: 30_000 },
  );
  let sessionTimedOut = false;

  const RESTART_MSG =
    "[The javascript runtime was restarted; all global state was lost and must be recreated if needed.]";
  const reservedNames = ["llmQuery", ...config.contextFields];

  async function executeCode(code: string): Promise<string> {
    try {
      const raw = await session.execute(code, { reservedNames });
      const output = truncate(raw || "(no output)", maxRuntimeChars);
      codeTrajectory.push({ code, output });
      return output;
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "Execution timed out") {
        sessionTimedOut = true;
      }
      if (
        err instanceof Error &&
        (err.message === "Session is closed" ||
          err.message === "Execution timed out")
      ) {
        if (sessionTimedOut) {
          // Restart the session
          sessionTimedOut = false;
          session = createSandboxSession(
            contextValues,
            { llmQuery },
            { timeout: 30_000 },
          );
          try {
            const raw = await session.execute(code, { reservedNames });
            const output = truncate(
              `${RESTART_MSG}\n${raw || "(no output)"}`,
              maxRuntimeChars,
            );
            codeTrajectory.push({ code, output });
            return output;
          } catch (retryErr: unknown) {
            if (
              retryErr instanceof Error &&
              retryErr.message === "Execution timed out"
            ) {
              sessionTimedOut = true;
            }
            const output = truncate(
              `${RESTART_MSG}\nError: ${
                retryErr instanceof Error ? retryErr.message : String(retryErr)
              }`,
              maxRuntimeChars,
            );
            codeTrajectory.push({ code, output });
            return output;
          }
        }
        const output = truncate(`Error: ${err.message}`, maxRuntimeChars);
        codeTrajectory.push({ code, output });
        return output;
      }
      throw err;
    }
  }

  // 4. Build the output tool (all fields optional for intermediate steps)
  const rlmOutputFields: { name: string; schema: Record<string, unknown> }[] =
    [];
  for (const field of config.outputFields) {
    switch (field.type) {
      case "string":
        rlmOutputFields.push({
          name: field.name,
          schema: { type: "string" },
        });
        break;
      case "string[]":
        rlmOutputFields.push({
          name: field.name,
          schema: { type: "array", items: { type: "string" } },
        });
        break;
      case "class":
        rlmOutputFields.push({
          name: field.name,
          schema: { type: "string", enum: field.values },
        });
        break;
    }
  }

  // Add RLM helper fields
  const properties: Record<string, unknown> = {};
  for (const f of rlmOutputFields) {
    properties[f.name] = f.schema;
  }
  properties["javascriptCode"] = {
    type: "string",
    description: "javascript code to execute in runtime session",
  };
  properties["resultReady"] = {
    type: "boolean",
    description:
      "Emit only true when final output fields are complete; otherwise omit this field",
  };

  const outputTool: ToolDefinition = {
    name: `${config.name}_output`,
    description: "Provide the structured output for this task.",
    parameters: {
      type: "object",
      properties,
      // All fields optional so model can emit subsets per step
    },
  };

  // 5. Build system prompt
  const contextFieldInfos = config.contextFields.map((name) => ({
    name,
    typeLabel: typeof contextValues[name] === "string" ? "string" : "unknown",
  }));
  const systemPrompt = buildRLMPrompt(config.definition, contextFieldInfos, {
    maxLlmCalls,
    codeFieldName: "javascriptCode",
  });

  // 6. Build initial user message
  const contextMeta = buildContextMetadata(contextValues);
  const userContent = [
    ...Object.entries(userInputs).map(([k, v]) => `${k}: ${v}`),
    `contextMetadata: ${contextMeta}`,
  ].join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  // 7. Main loop
  try {
    for (let step = 0; step < config.maxSteps; step++) {
      const completion = await client.chat(messages, {
        tools: [outputTool],
        config: config.chatConfig,
      });

      options?.stepHooks?.afterStep?.({
        stepIndex: step,
        usage: completion.usage,
      });

      // Parse tool call
      const outputCall = completion.toolCalls.find(
        (tc) => tc.name === outputTool.name,
      );

      if (!outputCall) {
        // No tool call - append response and nudge
        messages.push({
          role: "assistant",
          content: completion.content ?? "",
          toolCalls: completion.toolCalls.length > 0
            ? completion.toolCalls
            : undefined,
        });

        for (const tc of completion.toolCalls) {
          messages.push({
            role: "tool",
            content: "OK",
            toolCallId: tc.id,
          });
        }

        if (completion.toolCalls.length === 0) {
          messages.push({
            role: "user",
            content:
              `Please use the "${outputTool.name}" tool to provide your output. Use the javascriptCode field to execute code, or set resultReady: true with your final output fields.`,
          });
        }
        continue;
      }

      const parsed = JSON.parse(outputCall.arguments) as Record<
        string,
        unknown
      >;

      // Check resultReady
      if (isResultReady(parsed["resultReady"])) {
        session.close();
        return stripHelperFields(parsed);
      }

      // Execute code if present
      const code = parsed["javascriptCode"];
      let codeOutput = "";
      if (typeof code === "string" && code.trim().length > 0) {
        codeOutput = `Code Executed: ${await executeCode(code)}`;
      }

      // Build the conversation turn
      messages.push({
        role: "assistant",
        content: completion.content ?? "",
        toolCalls: completion.toolCalls,
      });

      messages.push({
        role: "tool",
        content: codeOutput || "OK",
        toolCallId: outputCall.id,
      });
    }

    // Max steps - attempt fallback extraction
    const fallbackResult = await attemptFallbackExtraction(
      client,
      config,
      userInputs,
      contextValues,
      codeTrajectory,
    );
    if (fallbackResult) {
      session.close();
      return fallbackResult;
    }

    session.close();
    throw new MaxStepsError(
      `Max steps reached: ${config.maxSteps} steps exhausted for agent "${config.name}"`,
    );
  } catch (err) {
    session.close();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fallback extraction
// ---------------------------------------------------------------------------

async function attemptFallbackExtraction(
  client: LLMClient,
  config: RLMAgentConfig,
  userInputs: Record<string, string>,
  contextValues: Record<string, unknown>,
  trajectory: { code: string; output: string }[],
): Promise<Record<string, unknown> | null> {
  const fallbackTool = buildOutputTool(
    `${config.name}_output`,
    [...config.outputFields],
  );

  const trajectoryText = buildRLMTrajectory(trajectory);
  const variablesInfo = buildContextMetadata(contextValues);

  const fallbackSystemPrompt = [
    config.definition,
    "",
    "You are completing a fallback extraction because the RLM loop reached its max steps.",
    "Use the RLM trajectory and variable metadata below to extract the best final outputs.",
    "",
    "Rules:",
    "- Prefer evidence from the latest successful code outputs.",
    "- If information is partial, provide the best possible answer grounded in trajectory.",
    "- Do not mention fallback mode in final outputs.",
    "- Use the input fields `rlmVariablesInfo` and `rlmTrajectory` as your primary evidence.",
    "",
    `You MUST respond using the "${fallbackTool.name}" tool to provide structured output.`,
  ].join("\n");

  const fallbackUserContent = [
    ...Object.entries(userInputs).map(([k, v]) => `${k}: ${v}`),
    `rlmVariablesInfo: ${variablesInfo}`,
    `rlmTrajectory: ${trajectoryText}`,
  ].join("\n\n");

  try {
    const completion = await client.chat(
      [
        { role: "system", content: fallbackSystemPrompt },
        { role: "user", content: fallbackUserContent },
      ],
      { tools: [fallbackTool], config: config.chatConfig },
    );

    const outputCall = completion.toolCalls.find(
      (tc) => tc.name === fallbackTool.name,
    );
    if (outputCall) {
      return JSON.parse(outputCall.arguments) as Record<string, unknown>;
    }
  } catch {
    // Fallback failed, return null to trigger MaxStepsError
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isResultReady(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

function stripHelperFields(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...parsed };
  delete result["javascriptCode"];
  delete result["resultReady"];
  return result;
}
