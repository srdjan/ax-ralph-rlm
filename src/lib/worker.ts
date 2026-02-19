import {
  agent,
  AxJSRuntime,
  AxJSRuntimePermission,
  type AxStepHooks,
} from "npm:@ax-llm/ax";
import { getEnvInt } from "./env.ts";
import type { WorkerStepRecord } from "./types.ts";

export type StepCollector = {
  steps: WorkerStepRecord[];
  hooks: AxStepHooks;
};

export function makeStepCollector(): StepCollector {
  const steps: WorkerStepRecord[] = [];
  const hooks: AxStepHooks = {
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

function resolveWorkerBudgets(): { maxSteps: number; maxLlmCalls: number } {
  const maxSteps = Math.max(getEnvInt("AX_WORKER_MAX_STEPS", 80), 2);
  const requestedMaxLlmCalls = getEnvInt("AX_WORKER_MAX_LLM_CALLS", 60);
  const maxLlmCalls = Math.min(requestedMaxLlmCalls, maxSteps - 1);

  if (maxLlmCalls !== requestedMaxLlmCalls) {
    console.error(
      `AX_WORKER_MAX_LLM_CALLS=${requestedMaxLlmCalls} exceeds max allowed for maxSteps=${maxSteps}; using ${maxLlmCalls}.`,
    );
  }

  return { maxSteps, maxLlmCalls };
}

export function makeWorkerAgent() {
  const budgets = resolveWorkerBudgets();

  return agent(
    "context:string, query:string, constraints:string -> answer:string, evidence:string[]",
    {
      name: "claudeWorker",
      description:
        "Generates a short, structured answer with verbatim evidence quotes from a long document using RLM mode.",
      maxSteps: budgets.maxSteps,
      modelConfig: {
        temperature: 0.2,
      },
      // RLM mode lets the agent analyze 'context' inside a sandboxed JS runtime.
      rlm: {
        mode: "inline",
        language: "javascript",
        contextFields: ["context"],
        runtime: new AxJSRuntime({
          permissions: [
            AxJSRuntimePermission.NETWORK,
            AxJSRuntimePermission.TIMING,
          ],
        }),
        maxLlmCalls: budgets.maxLlmCalls,
        maxRuntimeChars: 2_000,
        maxBatchedLlmQueryConcurrency: 6,
      },
      definition: [
        "You are a strict technical writer.",
        "You MUST follow constraints and output shape exactly.",
        "",
        "Output rules:",
        "- answer must be 3–7 bullet lines, each line starts with '- '.",
        "- evidence must be 3–8 SHORT verbatim quotes copied from the document (the field 'context').",
        "- Every evidence quote must be an EXACT substring of context (no paraphrase).",
        "- Keep evidence quotes <= 160 chars each.",
        "",
        "Use RLM: the document is available in the runtime (context field).",
        "Prefer to locate and copy exact sentences from the document as evidence.",
      ].join("\n"),
    },
  );
}
