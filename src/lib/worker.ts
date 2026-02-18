import { agent, AxJSRuntime, AxJSRuntimePermission } from "npm:@ax-llm/ax";

export function makeWorkerAgent() {
  return agent(
    "context:string, query:string, constraints:string -> answer:string, evidence:string[]",
    {
      name: "claudeWorker",
      description:
        "Generates a short, structured answer with verbatim evidence quotes from a long document using RLM mode.",
      maxSteps: 18,
      temperature: 0.2,
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
        maxLlmCalls: 28,
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
