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
