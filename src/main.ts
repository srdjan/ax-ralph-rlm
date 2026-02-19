// Load .env into Deno.env (safe no-op if no .env file exists)
import "jsr:@std/dotenv/load";

import { parseArgs } from "jsr:@std/cli/parse-args";
import { getEnv, getEnvInt } from "./lib/env.ts";
import { makeClaudeAI, makeGptAI } from "./lib/ai.ts";
import { makeWorkerAgent } from "./lib/worker.ts";
import { makeJudgeAgent } from "./lib/judge.ts";
import { runRalphLoop } from "./lib/ralph.ts";
import { makeSessionId } from "./lib/git_memory.ts";

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
  string: ["query", "doc", "out", "maxIters", "progressMs"],
  default: {},
});

const query = args.query ??
  "Explain Ralph loop and RLM and how they work together";
const docPath = args.doc ?? "docs/long.txt";
const maxIters = Number(args.maxIters ?? getEnv("AX_MAX_ITERS", "4"));
const outDir = args.out ?? getEnv("AX_OUT_DIR", "out");
const defaultProgressHeartbeatMs = getEnvInt("AX_PROGRESS_HEARTBEAT_MS", 8_000);
const progressHeartbeatMs = resolvePositiveIntArg(
  args.progressMs,
  defaultProgressHeartbeatMs,
  "progressMs",
);
const sessionId = makeSessionId(query);

console.error(`Session: ${sessionId}`);

const doc = await Deno.readTextFile(docPath);

const claudeAI = makeClaudeAI();
const gptAI = makeGptAI();

const worker = makeWorkerAgent();
const judge = makeJudgeAgent();

const result = await runRalphLoop(
  { worker, judge, claudeAI, gptAI },
  { query, doc, maxIters, outDir, sessionId, progressHeartbeatMs },
);

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  Deno.exitCode = 2;
}
