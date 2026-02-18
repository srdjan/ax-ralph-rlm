import type { GenerateOut, IterTrace, JudgeOut } from "./types.ts";
import { buildEvidenceContexts, hardValidate } from "./hard_validate.ts";
import type { makeWorkerAgent } from "./worker.ts";
import type { makeJudgeAgent } from "./judge.ts";
import type { makeClaudeAI, makeGptAI } from "./ai.ts";

type RalphLoopDeps = {
  worker: ReturnType<typeof makeWorkerAgent>;
  judge: ReturnType<typeof makeJudgeAgent>;
  claudeAI: ReturnType<typeof makeClaudeAI>;
  gptAI: ReturnType<typeof makeGptAI>;
};

type RalphLoopArgs = {
  query: string;
  doc: string;
  maxIters: number;
  outDir: string;
};

function baseConstraints(): string {
  return [
    "Produce JSON fields exactly as the signature requires.",
    "answer: 3–7 bullet lines starting with '- '.",
    "evidence: 3–8 verbatim quotes copied from the document.",
    "Evidence quotes must be exact substrings; keep them short (<=160 chars).",
  ].join("\n");
}

function feedbackConstraints(
  iter: number,
  prev: GenerateOut,
  hardIssues: string[],
  judgeIssues: string[],
): string {
  const lines: string[] = [];
  lines.push(baseConstraints());
  lines.push("");
  lines.push(`Iteration ${iter} feedback:`);
  for (const i of hardIssues) lines.push(`- HARD: ${i}`);
  for (const i of judgeIssues) lines.push(`- JUDGE: ${i}`);
  lines.push("");
  lines.push("Previous attempt (fix, don't repeat mistakes):");
  lines.push(prev.answer);
  return lines.join("\n");
}

export async function runRalphLoop(
  deps: RalphLoopDeps,
  args: RalphLoopArgs,
): Promise<{ ok: boolean; output: GenerateOut; traces: IterTrace[] }> {
  await Deno.mkdir(args.outDir, { recursive: true });

  let constraints = baseConstraints();
  let last: GenerateOut = { answer: "", evidence: [] };
  const traces: IterTrace[] = [];

  for (let iter = 1; iter <= args.maxIters; iter++) {
    // .forward() returns a broad type from Ax; cast to the expected output shape
    const generated = await deps.worker.forward(deps.claudeAI, {
      context: args.doc,
      query: args.query,
      constraints,
    }) as GenerateOut;

    const hard = hardValidate(generated, args.doc);

    const evidenceContext = buildEvidenceContexts(args.doc, generated.evidence);

    const judge: JudgeOut = hard.ok
      ? await deps.judge.forward(deps.gptAI, {
        query: args.query,
        answer: generated.answer,
        evidence: generated.evidence,
        evidenceContext,
      }) as JudgeOut
      : { ok: "no", issues: [] };

    const passed = hard.ok && judge.ok === "yes" && judge.issues.length === 0;

    const trace: IterTrace = {
      iter,
      query: args.query,
      constraints,
      generated,
      hard,
      evidenceContext,
      judge,
      passed,
    };
    traces.push(trace);

    const tracePath = `${args.outDir}/iter-${
      String(iter).padStart(2, "0")
    }.json`;
    await Deno.writeTextFile(tracePath, JSON.stringify(trace, null, 2));

    last = generated;

    if (passed) {
      return { ok: true, output: generated, traces };
    }

    constraints = feedbackConstraints(
      iter,
      generated,
      hard.issues,
      judge.issues,
    );
  }

  return { ok: false, output: last, traces };
}
