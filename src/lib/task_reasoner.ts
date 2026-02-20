import { agent } from "npm:@ax-llm/ax";

export function makeTaskReasonerAgent() {
  return agent(
    "brief:string, task:string, constraints:string -> output:string, memoryUpdate:string",
    {
      name: "taskReasoner",
      description:
        "Reasons about extracted brief content to complete a task and produce findings for memory.",
      maxSteps: 15,
      modelConfig: {
        temperature: 0.2,
      },
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
    },
  );
}
