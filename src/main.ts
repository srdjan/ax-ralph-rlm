// Load .env into Deno.env (safe no-op if no .env file exists)
import "@std/dotenv/load";

import { parseArgs } from "@std/cli/parse-args";
import { getEnv, getEnvInt } from "./lib/env.ts";
import { makeClaudeAI, makeGptAI } from "./lib/ai.ts";
import { makeWorkerAgent } from "./lib/worker.ts";
import { makeJudgeAgent } from "./lib/judge.ts";
import { runRalphLoop } from "./lib/ralph.ts";
import { makeSessionId } from "./lib/git_memory.ts";
import { makeDocReaderAgent } from "./lib/doc_reader.ts";
import { makeTaskReasonerAgent } from "./lib/task_reasoner.ts";
import { makeTaskJudgeAgent } from "./lib/task_judge.ts";
import { runTaskLoop } from "./lib/task_loop.ts";

function resolvePositiveIntArg(
  argValue: unknown,
  fallback: number,
  argName: string,
): number {
  if (argValue === undefined) return fallback;
  const parsed = Number(argValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--${argName}=${argValue} is invalid; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

const args = parseArgs(Deno.args, {
  string: ["query", "doc", "out", "maxIters", "progressMs", "mode", "memFile"],
  default: {},
});

const mode = args.mode ?? "task";
if (mode !== "task" && mode !== "qa") {
  console.error(
    `--mode must be "task" or "qa" (got "${mode}"); defaulting to "task".`,
  );
}
const resolvedMode = mode === "qa" ? "qa" : "task";

const query = args.query ??
  "Explain Ralph loop and RLM and how they work together";
const maxIters = Number(args.maxIters ?? getEnv("MAX_ITERS", "4"));
const outDir = args.out ?? getEnv("OUT_DIR", "out");
const defaultProgressHeartbeatMs = getEnvInt(
  "PROGRESS_HEARTBEAT_MS",
  8_000,
);
const progressHeartbeatMs = resolvePositiveIntArg(
  args.progressMs,
  defaultProgressHeartbeatMs,
  "progressMs",
);
const sessionId = makeSessionId(query, resolvedMode);

console.error(`Session: ${sessionId}`);
console.error(`Mode: ${resolvedMode}`);

const claudeAI = makeClaudeAI();
const gptAI = makeGptAI();

let result: { ok: boolean };

try {
  if (resolvedMode === "qa") {
    // QA mode: existing pipeline, unchanged
    const docPath = args.doc ?? "docs/long.txt";
    const doc = await Deno.readTextFile(docPath);

    const worker = makeWorkerAgent();
    const judge = makeJudgeAgent();

    result = await runRalphLoop(
      { worker, judge, claudeAI, gptAI },
      { query, doc, maxIters, outDir, sessionId, progressHeartbeatMs },
    );
  } else {
    // Task mode: DocReader + TaskReasoner + TaskJudge
    let doc = "";
    if (args.doc !== undefined) {
      doc = await Deno.readTextFile(args.doc);
    }

    const memFile = args.memFile ?? `${outDir}/context.md`;
    const docReader = makeDocReaderAgent();
    const taskReasoner = makeTaskReasonerAgent();
    const taskJudge = makeTaskJudgeAgent();

    result = await runTaskLoop(
      { docReader, taskReasoner, judge: taskJudge, claudeAI, gptAI },
      {
        task: query,
        doc,
        memFile,
        maxIters,
        outDir,
        sessionId,
        progressHeartbeatMs,
      },
    );
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[${resolvedMode === "qa" ? "Ralph" : "Task"}] Fatal error: ${msg}`,
  );
  Deno.exitCode = 1;
  Deno.exit();
}

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  Deno.exitCode = 2;
}
