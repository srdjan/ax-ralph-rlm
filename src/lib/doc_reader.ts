import { agent, AxJSRuntime, AxJSRuntimePermission } from "npm:@ax-llm/ax";
import { resolveWorkerBudgets } from "./env.ts";

export function makeDocReaderAgent() {
  const budgets = resolveWorkerBudgets();

  return agent(
    "doc:string, memory:string, task:string -> brief:string",
    {
      name: "docReader",
      description:
        "Extracts and summarises information relevant to the task from a document and accumulated memory using RLM mode.",
      maxSteps: budgets.maxSteps,
      modelConfig: {
        temperature: 0.2,
      },
      rlm: {
        mode: "inline",
        language: "javascript",
        contextFields: ["doc", "memory"],
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
        "Output in `brief`: the most relevant extracted content, clearly structured.",
      ].join("\n"),
    },
  );
}
