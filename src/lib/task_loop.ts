import type { JudgeOut, TaskIterTrace, TaskOut, WorkerError } from "./types.ts";
import type { DocReaderAgent } from "./doc_reader.ts";
import type { TaskReasonerAgent } from "./task_reasoner.ts";
import type { TaskJudgeAgent } from "./task_judge.ts";
import type { LLMClient } from "./llm_client.ts";
import { makeStepCollector } from "./worker.ts";
import { storeIterTrace } from "./git_memory.ts";
import { appendToMemory, readMemory } from "./memory.ts";
import { taskHardValidate } from "./task_validate.ts";
import {
  classifyWorkerError,
  formatDuration,
  runWithHeartbeat,
} from "./loop_helpers.ts";

type TaskLoopDeps = {
  docReader: DocReaderAgent;
  taskReasoner: TaskReasonerAgent;
  judge: TaskJudgeAgent;
  claudeAI: LLMClient;
  gptAI: LLMClient;
};

type TaskLoopArgs = {
  task: string;
  doc: string;
  memFile: string;
  maxIters: number;
  outDir: string;
  sessionId: string;
  progressHeartbeatMs: number;
};

/** Maximum number of prior iterations to include verbatim in feedback. */
const MAX_FEEDBACK_HISTORY = 2;

type IterFeedback = {
  iter: number;
  output: string;
  memoryUpdate: string;
  hardIssues: string[];
  judgeIssues: string[];
};

function baseTaskConstraints(): string {
  return [
    "Complete the task fully.",
    "output must not be empty.",
    "memoryUpdate must record findings concretely.",
  ].join("\n");
}

function deriveDocReaderHints(history: IterFeedback[]): string {
  if (history.length === 0) return "";
  const last = history[history.length - 1];
  if (last.judgeIssues.length === 0 && last.hardIssues.length === 0) return "";
  const issues = [...last.hardIssues, ...last.judgeIssues];
  return [
    "Prior judge raised issues with the output. Extract additional detail",
    "to address these specifically:",
    ...issues.map((i) => `- ${i}`),
  ].join("\n");
}

function feedbackTaskConstraints(history: IterFeedback[]): string {
  const lines: string[] = [];
  lines.push(baseTaskConstraints());

  // Only include the most recent MAX_FEEDBACK_HISTORY iterations
  const recent = history.slice(-MAX_FEEDBACK_HISTORY);

  for (const entry of recent) {
    lines.push("");
    lines.push(`Iter ${entry.iter} feedback:`);
    for (const i of entry.hardIssues) lines.push(`- ${i}`);
    for (const i of entry.judgeIssues) lines.push(`- ${i}`);
    lines.push("");
    lines.push("Previous output (improve on this):");
    lines.push(entry.output);
    if (entry.memoryUpdate.trim().length > 0) {
      lines.push("");
      lines.push("Memory already recorded (do not repeat):");
      lines.push(entry.memoryUpdate);
    }
  }

  if (history.length > MAX_FEEDBACK_HISTORY) {
    const omitted = history.length - MAX_FEEDBACK_HISTORY;
    lines.push("");
    lines.push(
      `(${omitted} earlier iteration${omitted > 1 ? "s" : ""} omitted)`,
    );
  }

  return lines.join("\n");
}

export async function runTaskLoop(
  deps: TaskLoopDeps,
  args: TaskLoopArgs,
): Promise<{ ok: boolean; output: TaskOut; traces: TaskIterTrace[] }> {
  await Deno.mkdir(args.outDir, { recursive: true });
  console.error(
    `[Task] Starting session ${args.sessionId} (maxIters=${args.maxIters}, outDir=${args.outDir}, memFile=${args.memFile})`,
  );

  let constraints = baseTaskConstraints();
  let last: TaskOut = { output: "", memoryUpdate: "" };
  const traces: TaskIterTrace[] = [];
  const feedbackHistory: IterFeedback[] = [];

  for (let iter = 1; iter <= args.maxIters; iter++) {
    // --- Phase 1: DocReader (RLM) ---
    console.error(
      `[Task][iter ${iter}/${args.maxIters}] Reading memory and running DocReader...`,
    );

    const memory = await readMemory(args.memFile);
    const docReaderHints = deriveDocReaderHints(feedbackHistory);
    const collector = makeStepCollector();
    let brief = "";
    let workerError: WorkerError | undefined;

    try {
      const docReaderInputs: Record<string, string> = {
        doc: args.doc,
        memory,
        task: args.task,
      };
      if (docReaderHints.length > 0) {
        docReaderInputs.docReaderHints = docReaderHints;
      }

      const { value, durationMs } = await runWithHeartbeat(
        iter,
        args.maxIters,
        "DocReader",
        args.progressHeartbeatMs,
        async () =>
          await deps.docReader.forward(
            deps.claudeAI,
            docReaderInputs,
            { stepHooks: collector.hooks },
          ) as { brief: string },
        "Task",
      );
      brief = value.brief ?? "";
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] DocReader completed in ${
          formatDuration(durationMs)
        }, brief length=${brief.length}`,
      );
    } catch (err: unknown) {
      const classified = classifyWorkerError(err, collector.steps);
      if (classified === null) throw err;

      workerError = classified;
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] DocReader exhausted step budget ` +
          `(${workerError.stepsCompleted}/${workerError.maxSteps} steps).`,
      );
      for (const s of workerError.suggestions) {
        console.error(`  -> ${s}`);
      }
    }

    if (workerError !== undefined) {
      const trace: TaskIterTrace = {
        iter,
        task: args.task,
        constraints,
        brief,
        generated: last,
        hard: { ok: false, issues: ["DocReader exhausted step budget"] },
        passed: false,
        workerError,
      };
      traces.push(trace);
      await writeAndStoreTrace(trace, iter, args);
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] Skipping reasoning (no brief produced).`,
      );
      continue;
    }

    // --- Phase 2: TaskReasoner ---
    console.error(
      `[Task][iter ${iter}/${args.maxIters}] Running TaskReasoner...`,
    );

    let generated: TaskOut;
    try {
      const reasonerResult = await deps.taskReasoner.forward(deps.claudeAI, {
        brief,
        task: args.task,
        constraints,
      }) as Partial<TaskOut>;

      generated = {
        output: reasonerResult.output ?? "",
        memoryUpdate: reasonerResult.memoryUpdate ?? "",
      };
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] TaskReasoner done, output length=${generated.output.length}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] TaskReasoner failed: ${msg}`,
      );
      const trace: TaskIterTrace = {
        iter,
        task: args.task,
        constraints,
        brief,
        generated: last,
        hard: { ok: false, issues: [`TaskReasoner error: ${msg}`] },
        passed: false,
      };
      traces.push(trace);
      await writeAndStoreTrace(trace, iter, args);
      continue;
    }

    // Append to memory (non-fatal on failure)
    if (generated.memoryUpdate.trim().length > 0) {
      try {
        await appendToMemory(args.memFile, generated.memoryUpdate, iter);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Task][iter ${iter}/${args.maxIters}] Warning: failed to write memory: ${msg}`,
        );
      }
    }

    // --- Phase 3: Validation ---
    const hard = taskHardValidate(brief, generated);
    console.error(
      `[Task][iter ${iter}/${args.maxIters}] Hard validation ok=${hard.ok}, ` +
        `issues=${hard.issues.length}, briefLen=${brief.length}, outputLen=${generated.output.length}`,
    );

    let judge: JudgeOut;
    if (hard.ok) {
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] Running task judge...`,
      );
      try {
        const { value: raw, durationMs: judgeDurationMs } =
          await runWithHeartbeat(
            iter,
            args.maxIters,
            "Task judge",
            args.progressHeartbeatMs,
            async () =>
              await deps.judge.forward(deps.gptAI, {
                task: args.task,
                output: generated.output,
                brief,
                memory,
              }) as Partial<JudgeOut>,
            "Task",
          );
        judge = {
          ok: raw.ok ?? "no",
          issues: Array.isArray(raw.issues) ? raw.issues : [],
        };
        console.error(
          `[Task][iter ${iter}/${args.maxIters}] Judge completed in ${
            formatDuration(judgeDurationMs)
          }.`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Task][iter ${iter}/${args.maxIters}] Judge failed: ${msg}`,
        );
        judge = { ok: "no", issues: [`Judge error: ${msg}`] };
      }
    } else {
      console.error(
        `[Task][iter ${iter}/${args.maxIters}] Skipping judge (hard validation failed).`,
      );
      judge = { ok: "no", issues: [] };
    }

    const passed = hard.ok && judge.ok === "yes" && judge.issues.length === 0;
    console.error(
      `[Task][iter ${iter}/${args.maxIters}] Judge ok=${judge.ok}, issues=${judge.issues.length}, passed=${passed}`,
    );

    const trace: TaskIterTrace = {
      iter,
      task: args.task,
      constraints,
      brief,
      generated,
      hard,
      judge,
      passed,
    };
    traces.push(trace);
    await writeAndStoreTrace(trace, iter, args);

    last = generated;

    if (passed) {
      console.error(`[Task] Completed successfully at iteration ${iter}.`);
      return { ok: true, output: generated, traces };
    }

    console.error(
      `[Task][iter ${iter}/${args.maxIters}] Continuing with feedback constraints.`,
    );
    feedbackHistory.push({
      iter,
      output: generated.output,
      memoryUpdate: generated.memoryUpdate,
      hardIssues: hard.issues,
      judgeIssues: judge.issues,
    });
    constraints = feedbackTaskConstraints(feedbackHistory);
  }

  console.error(
    `[Task] Reached max iterations (${args.maxIters}) without a passing output.`,
  );
  return { ok: false, output: last, traces };
}

async function writeAndStoreTrace(
  trace: TaskIterTrace,
  iter: number,
  args: { outDir: string; sessionId: string },
): Promise<void> {
  const tracePath = `${args.outDir}/iter-${String(iter).padStart(2, "0")}.json`;
  console.error(`[Task] Writing trace ${tracePath}`);
  await Deno.writeTextFile(tracePath, JSON.stringify(trace, null, 2));
  const storeResult = await storeIterTrace(trace, tracePath, args.sessionId);
  if (!storeResult.ok) {
    console.error(
      `Warning: failed to index iteration trace ${tracePath}: ${storeResult.error}`,
    );
  }
}
