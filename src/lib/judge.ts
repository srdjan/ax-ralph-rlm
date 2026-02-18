import { agent } from "npm:@ax-llm/ax";

export function makeJudgeAgent() {
  return agent(
    "query:string, answer:string, evidence:string[], evidenceContext:string[] -> ok:class \"yes,no\", issues:string[]",
    {
      name: "gptJudge",
      description:
        "Validates that the answer is supported by the evidence contexts and returns concrete issues if not.",
      temperature: 0.0,
      maxSteps: 10,
      definition:
        [
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
    },
  );
}
