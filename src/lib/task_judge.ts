import {
  type AgentConfig,
  agentForward,
  buildOutputTool,
  type StepHooks,
} from "./agent.ts";
import type { LLMClient } from "./llm_client.ts";

const taskJudgeOutputTool = buildOutputTool("taskJudge_output", [
  { name: "ok", type: "class", values: ["yes", "no"] },
  { name: "issues", type: "string[]" },
]);

const taskJudgeConfig: AgentConfig = {
  name: "taskJudge",
  description:
    "Validates that the task output is a complete and substantive response given the available brief and accumulated memory.",
  definition: [
    "You are a strict validator.",
    "Given a task, the output produced, the brief that was available to the reasoner,",
    "and the accumulated memory from prior iterations, decide if the output is a",
    "complete and substantive response to the task.",
    "",
    "Rules:",
    "- The output should address the task fully given the information in the brief AND memory.",
    "- The reasoner legitimately draws on both the brief and memory - evaluate accordingly.",
    "- If the output is vague, incomplete, or does not address the task, ok='no'.",
    "- Issues must be actionable (reference what is missing or wrong).",
    "",
    "Return:",
    "- ok: 'yes' only if the output substantively completes the task.",
    "- issues: empty array when ok='yes'.",
  ].join("\n"),
  outputTool: taskJudgeOutputTool,
  maxSteps: 10,
  chatConfig: { temperature: 0.0 },
};

export type TaskJudgeAgent = {
  forward(
    client: LLMClient,
    inputs: Record<string, unknown>,
    options?: { stepHooks?: StepHooks },
  ): Promise<Record<string, unknown>>;
};

export function makeTaskJudgeAgent(): TaskJudgeAgent {
  return {
    forward(client, inputs, options) {
      return agentForward(client, taskJudgeConfig, inputs, options);
    },
  };
}
