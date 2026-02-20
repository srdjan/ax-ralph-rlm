import type { GenerateOut, IterTrace, JudgeOut, WorkerError } from "./types.ts";
import { buildEvidenceContexts, hardValidate } from "./hard_validate.ts";
import { makeStepCollector, type makeWorkerAgent } from "./worker.ts";
import type { makeJudgeAgent } from "./judge.ts";
import type { makeClaudeAI, makeGptAI } from "./ai.ts";
import { storeIterTrace } from "./git_memory.ts";
import {
  classifyWorkerError,
  formatDuration,
  runWithHeartbeat,
} from "./loop_helpers.ts";

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
  sessionId: string;
  progressHeartbeatMs: number;
};

function countBullets(answer: string): number {
  return answer
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("- ")).length;
}

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
  console.error(
    `[Ralph] Starting session ${args.sessionId} (maxIters=${args.maxIters}, outDir=${args.outDir}, heartbeatMs=${args.progressHeartbeatMs})`,
  );

  let constraints = baseConstraints();
  let last: GenerateOut = { answer: "", evidence: [] };
  const traces: IterTrace[] = [];

  for (let iter = 1; iter <= args.maxIters; iter++) {
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Generating candidate output...`,
    );

    const collector = makeStepCollector();
    let generated: GenerateOut;
    let workerError: WorkerError | undefined;

    try {
      const {
        value,
        durationMs: generateDurationMs,
      } = await runWithHeartbeat(
        iter,
        args.maxIters,
        "Generation",
        args.progressHeartbeatMs,
        async () =>
          await deps.worker.forward(deps.claudeAI, {
            context: args.doc,
            query: args.query,
            constraints,
          }, { stepHooks: collector.hooks }) as GenerateOut,
      );
      generated = value;
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Generated answer bullets=${
          countBullets(generated.answer)
        }, evidence=${generated.evidence.length}, duration=${
          formatDuration(generateDurationMs)
        }`,
      );
    } catch (err: unknown) {
      const classified = classifyWorkerError(err, collector.steps);
      if (classified === null) throw err;

      workerError = classified;
      generated = { answer: "", evidence: [] };

      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Worker exhausted step budget ` +
          `(${workerError.stepsCompleted}/${workerError.maxSteps} steps).`,
      );
      console.error(`  Tokens used: ${workerError.totalTokensUsed}`);
      for (const pct of [0.25, 0.5, 0.75, 1.0]) {
        const idx = Math.min(
          Math.floor(workerError.steps.length * pct) - 1,
          workerError.steps.length - 1,
        );
        if (idx >= 0) {
          const s = workerError.steps[idx];
          console.error(
            `  After step ${s.stepIndex + 1}: ${s.totalTokens} tokens`,
          );
        }
      }
      for (const s of workerError.suggestions) {
        console.error(`  -> ${s}`);
      }
    }

    if (workerError !== undefined) {
      const trace: IterTrace = {
        iter,
        query: args.query,
        constraints,
        generated,
        hard: { ok: false, issues: ["Worker exhausted step budget"] },
        evidenceContext: [],
        passed: false,
        workerError,
      };
      traces.push(trace);

      const tracePath = `${args.outDir}/iter-${
        String(iter).padStart(2, "0")
      }.json`;
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Writing trace ${tracePath}`,
      );
      await Deno.writeTextFile(tracePath, JSON.stringify(trace, null, 2));
      const storeResult = await storeIterTrace(
        trace,
        tracePath,
        args.sessionId,
      );
      if (!storeResult.ok) {
        console.error(
          `Warning: failed to index iteration trace ${tracePath}: ${storeResult.error}`,
        );
      }

      last = generated;
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Skipping validation (no output produced).`,
      );
      continue;
    }

    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Running hard validation...`,
    );
    const hard = hardValidate(generated, args.doc);
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Hard validation ok=${hard.ok}, issues=${hard.issues.length}`,
    );

    const evidenceContext = buildEvidenceContexts(args.doc, generated.evidence);

    let judge: JudgeOut;
    if (hard.ok) {
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Running semantic judge...`,
      );
      const { value: raw, durationMs: judgeDurationMs } =
        await runWithHeartbeat(
          iter,
          args.maxIters,
          "Semantic judge",
          args.progressHeartbeatMs,
          async () =>
            await deps.judge.forward(deps.gptAI, {
              query: args.query,
              answer: generated.answer,
              evidence: generated.evidence,
              evidenceContext,
            }) as Partial<JudgeOut>,
        );
      judge = {
        ok: raw.ok ?? "no",
        issues: Array.isArray(raw.issues) ? raw.issues : [],
      };
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Semantic judge completed in ${
          formatDuration(judgeDurationMs)
        }.`,
      );
    } else {
      console.error(
        `[Ralph][iter ${iter}/${args.maxIters}] Skipping semantic judge (hard validation failed).`,
      );
      judge = { ok: "no", issues: [] };
    }

    const passed = hard.ok && judge.ok === "yes" && judge.issues.length === 0;
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Judge ok=${judge.ok}, issues=${judge.issues.length}, passed=${passed}`,
    );

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
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Writing trace ${tracePath}`,
    );
    await Deno.writeTextFile(tracePath, JSON.stringify(trace, null, 2));
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Indexing trace for session ${args.sessionId}`,
    );
    const storeResult = await storeIterTrace(
      trace,
      tracePath,
      args.sessionId,
    );
    if (!storeResult.ok) {
      console.error(
        `Warning: failed to index iteration trace ${tracePath}: ${storeResult.error}`,
      );
    } else {
      console.error(`[Ralph][iter ${iter}/${args.maxIters}] Trace indexed.`);
    }

    last = generated;

    if (passed) {
      console.error(`[Ralph] Completed successfully at iteration ${iter}.`);
      return { ok: true, output: generated, traces };
    }
    console.error(
      `[Ralph][iter ${iter}/${args.maxIters}] Continuing with feedback constraints.`,
    );

    constraints = feedbackConstraints(
      iter,
      generated,
      hard.issues,
      judge.issues,
    );
  }

  console.error(
    `[Ralph] Reached max iterations (${args.maxIters}) without a passing output.`,
  );
  return { ok: false, output: last, traces };
}
