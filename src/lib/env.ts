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
