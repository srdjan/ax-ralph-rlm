import {
  type AgentConfig,
  agentForward,
  buildOutputTool,
  type StepHooks,
} from "./agent.ts";
import type { LLMClient } from "./llm_client.ts";

const judgeOutputTool = buildOutputTool("gptJudge_output", [
  { name: "ok", type: "class", values: ["yes", "no"] },
  { name: "issues", type: "string[]" },
]);

const judgeConfig: AgentConfig = {
  name: "gptJudge",
  description:
    "Validates that the answer is supported by the evidence contexts and returns concrete issues if not.",
  definition: [
    "You are a strict validator.",
    "Given a query, an answer (bullets), and evidence contexts (short snippets around the cited quotes), decide if the answer is supported.",
    "",
    "Rules:",
    "- If any bullet is not supported by the provided evidenceContext snippets, ok='no' and add a concrete issue.",
    "- Evidence must be relevant; if evidence appears unrelated, flag it.",
    "- Do NOT invent new evidence. Only use evidenceContext.",
    "- Issues must be actionable (reference bullet number and what to change).",
    "",
    "Return:",
    "- ok: 'yes' only if every bullet is supported.",
    "- issues: empty array when ok='yes'.",
  ].join("\n"),
  outputTool: judgeOutputTool,
  maxSteps: 10,
  chatConfig: { temperature: 0.0 },
};

export type JudgeAgent = {
  forward(
    client: LLMClient,
    inputs: Record<string, unknown>,
    options?: { stepHooks?: StepHooks },
  ): Promise<Record<string, unknown>>;
};

export function makeJudgeAgent(): JudgeAgent {
  return {
    forward(client, inputs, options) {
      return agentForward(client, judgeConfig, inputs, options);
    },
  };
}
