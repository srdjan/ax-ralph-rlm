export function mustGetEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v || v.trim().length === 0) {
    throw new Error(
      `Missing required env var ${name}. Set it in your environment or .env file.`,
    );
  }
  return v.trim();
}

export function getEnv(name: string, fallback: string): string {
  const v = Deno.env.get(name);
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

export function getEnvInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw || raw.trim().length === 0) return fallback;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(
      `${name}=${raw} is invalid; using ${fallback}. Expected a positive integer.`,
    );
    return fallback;
  }

  return parsed;
}

export function resolveWorkerBudgets(): {
  maxSteps: number;
  maxLlmCalls: number;
} {
  const maxSteps = Math.max(getEnvInt("WORKER_MAX_STEPS", 80), 2);
  const requestedMaxLlmCalls = getEnvInt("WORKER_MAX_LLM_CALLS", 60);
  const maxLlmCalls = Math.min(requestedMaxLlmCalls, maxSteps - 1);

  if (maxLlmCalls !== requestedMaxLlmCalls) {
    console.error(
      `WORKER_MAX_LLM_CALLS=${requestedMaxLlmCalls} exceeds max allowed for maxSteps=${maxSteps}; using ${maxLlmCalls}.`,
    );
  }

  return { maxSteps, maxLlmCalls };
}
