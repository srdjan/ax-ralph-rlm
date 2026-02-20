import { MaxStepsError } from "./agent.ts";
import { getEnvInt } from "./env.ts";
import type { WorkerError, WorkerStepRecord } from "./types.ts";

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export async function runWithHeartbeat<T>(
  iter: number,
  maxIters: number,
  phaseLabel: string,
  heartbeatMs: number,
  task: () => Promise<T>,
  logPrefix = "Ralph",
): Promise<{ value: T; durationMs: number }> {
  const startedAt = Date.now();
  const timer = heartbeatMs > 0
    ? setInterval(() => {
      const elapsed = Date.now() - startedAt;
      console.error(
        `[${logPrefix}][iter ${iter}/${maxIters}] ${phaseLabel} still running (${
          formatDuration(elapsed)
        } elapsed)...`,
      );
    }, heartbeatMs)
    : undefined;

  try {
    const value = await task();
    return { value, durationMs: Date.now() - startedAt };
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

export function classifyWorkerError(
  err: unknown,
  steps: WorkerStepRecord[],
): WorkerError | null {
  if (!(err instanceof MaxStepsError)) return null;

  const lastStep = steps.at(-1);
  const stepsCompleted = lastStep ? lastStep.stepIndex + 1 : 0;
  const maxSteps = getEnvInt("WORKER_MAX_STEPS", 80);
  const totalTokensUsed = lastStep?.totalTokens ?? 0;

  return {
    tag: "max-steps-reached",
    message: err.message,
    stepsCompleted,
    maxSteps,
    totalTokensUsed,
    steps,
    suggestions: [
      `Increase WORKER_MAX_STEPS (current: ${maxSteps}). Try ${
        maxSteps * 2
      }.`,
      "Increase WORKER_MAX_LLM_CALLS proportionally.",
      "Simplify the query or reduce document length.",
    ],
  };
}
