import type { StepHooks } from "./agent.ts";
import { type RLMAgentConfig, rlmAgentForward } from "./rlm_agent.ts";
import type { LLMClient } from "./llm_client.ts";
import { resolveWorkerBudgets } from "./env.ts";

export type DocReaderAgent = {
  forward(
    client: LLMClient,
    inputs: Record<string, string>,
    options?: { stepHooks?: StepHooks },
  ): Promise<Record<string, unknown>>;
};

export function makeDocReaderAgent(): DocReaderAgent {
  const budgets = resolveWorkerBudgets();

  const config: RLMAgentConfig = {
    name: "docReader",
    description:
      "Extracts and summarises information relevant to the task from a document and accumulated memory using RLM mode.",
    maxSteps: budgets.maxSteps,
    chatConfig: { temperature: 0.2 },
    contextFields: ["doc", "memory"],
    outputFields: [
      { name: "brief", type: "string" },
    ],
    rlm: {
      maxLlmCalls: budgets.maxLlmCalls,
      maxRuntimeChars: 2_000,
      maxBatchedLlmQueryConcurrency: 6,
    },
    definition: [
      "You are a document extraction specialist. Your ONLY job is to find and summarise",
      "information relevant to the task. Do not complete the task. Do not reason about",
      "what the answer should be. Extract, quote, and summarise.",
      "",
      "The runtime gives you two variables: `doc` (the reference document, may be empty)",
      "and `memory` (accumulated findings from prior iterations, may be empty).",
      "",
      "Use llmQuery to retrieve relevant slices from each. Combine what you find into a",
      "compact, structured brief that a reasoning agent can work from.",
      "",
      "If `docReaderHints` is provided (non-empty), treat it as additional extraction",
      "targets alongside the task. These hints come from a prior iteration where the",
      "output was judged insufficient - extract the specific detail requested.",
      "",
      "Output in `brief`: the most relevant extracted content, clearly structured.",
    ].join("\n"),
  };

  return {
    forward(client, inputs, options) {
      return rlmAgentForward(client, config, inputs, options);
    },
  };
}
