import type { StepHooks } from "./agent.ts";
import { type RLMAgentConfig, rlmAgentForward } from "./rlm_agent.ts";
import type { LLMClient } from "./llm_client.ts";
import { resolveWorkerBudgets } from "./env.ts";
import type { WorkerStepRecord } from "./types.ts";

export type StepCollector = {
  steps: WorkerStepRecord[];
  hooks: StepHooks;
};

export function makeStepCollector(): StepCollector {
  const steps: WorkerStepRecord[] = [];
  const hooks: StepHooks = {
    afterStep(ctx) {
      steps.push({
        stepIndex: ctx.stepIndex,
        promptTokens: ctx.usage.promptTokens,
        completionTokens: ctx.usage.completionTokens,
        totalTokens: ctx.usage.totalTokens,
      });
    },
  };
  return { steps, hooks };
}

export type WorkerAgent = {
  forward(
    client: LLMClient,
    inputs: Record<string, string>,
    options?: { stepHooks?: StepHooks },
  ): Promise<Record<string, unknown>>;
};

export function makeWorkerAgent(): WorkerAgent {
  const budgets = resolveWorkerBudgets();

  const config: RLMAgentConfig = {
    name: "claudeWorker",
    description:
      "Generates a short, structured answer with verbatim evidence quotes from a long document using RLM mode.",
    maxSteps: budgets.maxSteps,
    chatConfig: { temperature: 0.2 },
    contextFields: ["context"],
    outputFields: [
      { name: "answer", type: "string" },
      { name: "evidence", type: "string[]" },
    ],
    rlm: {
      maxLlmCalls: budgets.maxLlmCalls,
      maxRuntimeChars: 2_000,
      maxBatchedLlmQueryConcurrency: 6,
    },
    definition: [
      "You are a strict technical writer.",
      "You MUST follow constraints and output shape exactly.",
      "",
      "Output rules:",
      "- answer must be 3-7 bullet lines, each line starts with '- '.",
      "- evidence must be 3-8 SHORT verbatim quotes copied from the document (the field 'context').",
      "- Every evidence quote must be an EXACT substring of context (no paraphrase).",
      "- Keep evidence quotes <= 160 chars each.",
      "",
      "Use RLM: the document is available in the runtime (context field).",
      "Prefer to locate and copy exact sentences from the document as evidence.",
    ].join("\n"),
  };

  return {
    forward(client, inputs, options) {
      return rlmAgentForward(client, config, inputs, options);
    },
  };
}
