import { ai } from "npm:@ax-llm/ax";
import { getEnv, mustGetEnv } from "./env.ts";

export function makeClaudeAI() {
  const apiKey = mustGetEnv("ANTHROPIC_APIKEY");
  const model = getEnv("AX_GENERATE_MODEL", "claude-3-5-sonnet-latest");
  return ai({
    name: "anthropic",
    apiKey,
    config: { model },
  });
}

export function makeGptAI() {
  const apiKey = mustGetEnv("OPENAI_APIKEY");
  const model = getEnv("AX_VALIDATE_MODEL", "gpt-4o-mini");
  return ai({
    name: "openai",
    apiKey,
    config: { model },
  });
}
