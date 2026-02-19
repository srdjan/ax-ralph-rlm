// Load .env into Deno.env (safe no-op if no .env file exists)
import "jsr:@std/dotenv/load";

import { parseArgs } from "jsr:@std/cli/parse-args";
import { getEnv } from "./lib/env.ts";
import { makeClaudeAI, makeGptAI } from "./lib/ai.ts";
import { makeWorkerAgent } from "./lib/worker.ts";
import { makeJudgeAgent } from "./lib/judge.ts";
import { runRalphLoop } from "./lib/ralph.ts";
import { makeSessionId } from "./lib/git_memory.ts";

const args = parseArgs(Deno.args, {
  string: ["query", "doc", "out", "maxIters"],
  default: {},
});

const query = args.query ??
  "Explain Ralph loop and RLM and how they work together";
const docPath = args.doc ?? "docs/long.txt";
const maxIters = Number(args.maxIters ?? getEnv("AX_MAX_ITERS", "4"));
const outDir = args.out ?? getEnv("AX_OUT_DIR", "out");
const sessionId = makeSessionId(query);

console.error(`Session: ${sessionId}`);

const doc = await Deno.readTextFile(docPath);

const claudeAI = makeClaudeAI();
const gptAI = makeGptAI();

const worker = makeWorkerAgent();
const judge = makeJudgeAgent();

const result = await runRalphLoop(
  { worker, judge, claudeAI, gptAI },
  { query, doc, maxIters, outDir, sessionId },
);

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  Deno.exitCode = 2;
}
