import {
  type AgentConfig,
  agentForward,
  buildOutputTool,
  type StepHooks,
} from "./agent.ts";
import type { LLMClient } from "./llm_client.ts";

const reasonerOutputTool = buildOutputTool("taskReasoner_output", [
  { name: "output", type: "string" },
  { name: "memoryUpdate", type: "string" },
]);

const reasonerConfig: AgentConfig = {
  name: "taskReasoner",
  description:
    "Reasons about extracted brief content to complete a task and produce findings for memory.",
  definition: [
    "You are a task completion agent. You receive a brief extracted from source material.",
    "Reason about it. Complete the task. Write findings to memory.",
    "",
    "Rules:",
    "- output: complete the task as fully as possible given the brief. Any format that fits.",
    "- memoryUpdate: write specific findings, partial results, and notes. Future iterations",
    "  will query this via RLM - be concrete and structured, not vague.",
    "- Follow all constraints exactly.",
  ].join("\n"),
  outputTool: reasonerOutputTool,
  maxSteps: 15,
  chatConfig: { temperature: 0.2 },
};

export type TaskReasonerAgent = {
  forward(
    client: LLMClient,
    inputs: Record<string, unknown>,
    options?: { stepHooks?: StepHooks },
  ): Promise<Record<string, unknown>>;
};

export function makeTaskReasonerAgent(): TaskReasonerAgent {
  return {
    forward(client, inputs, options) {
      return agentForward(client, reasonerConfig, inputs, options);
    },
  };
}
