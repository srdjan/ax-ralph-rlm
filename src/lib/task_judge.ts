import { agent } from "npm:@ax-llm/ax";

export function makeTaskJudgeAgent() {
  return agent(
    'task:string, output:string, brief:string, memory:string -> ok:class "yes,no", issues:string[]',
    {
      name: "taskJudge",
      description:
        "Validates that the task output is a complete and substantive response given the available brief and accumulated memory.",
      modelConfig: {
        temperature: 0.0,
      },
      maxSteps: 10,
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
    },
  );
}
