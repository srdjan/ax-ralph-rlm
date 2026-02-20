import { getEnv, mustGetEnv } from "./env.ts";
import {
  type LLMClient,
  makeAnthropicClient,
  makeOpenAIClient,
} from "./llm_client.ts";

const ANTHROPIC_MODELS = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-opus-latest",
]);

const OPENAI_MODELS = new Set([
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4",
  "gpt-3.5-turbo",
  "o1",
  "o1-mini",
  "o3-mini",
]);

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const LEGACY_ANTHROPIC_MODEL = "claude-3-5-sonnet-latest";

function resolveAnthropicModel(raw: string): string {
  if (raw === LEGACY_ANTHROPIC_MODEL) {
    console.error(
      `GENERATE_MODEL=${raw} is legacy; using ${DEFAULT_ANTHROPIC_MODEL} instead.`,
    );
    return DEFAULT_ANTHROPIC_MODEL;
  }

  if (!ANTHROPIC_MODELS.has(raw)) {
    console.error(
      `GENERATE_MODEL=${raw} is not recognized; using ${DEFAULT_ANTHROPIC_MODEL}.`,
    );
    return DEFAULT_ANTHROPIC_MODEL;
  }

  return raw;
}

function resolveOpenAIModel(raw: string): string {
  if (!OPENAI_MODELS.has(raw)) {
    console.error(
      `VALIDATE_MODEL=${raw} is not recognized; using ${DEFAULT_OPENAI_MODEL}.`,
    );
    return DEFAULT_OPENAI_MODEL;
  }

  return raw;
}

export function makeClaudeAI(): LLMClient {
  const apiKey = mustGetEnv("ANTHROPIC_APIKEY");
  const configured = getEnv("GENERATE_MODEL", DEFAULT_ANTHROPIC_MODEL);
  const model = resolveAnthropicModel(configured);
  console.error(`Generate model: ${model}`);
  return makeAnthropicClient(apiKey, model);
}

export function makeGptAI(): LLMClient {
  const apiKey = mustGetEnv("OPENAI_APIKEY");
  const configured = getEnv("VALIDATE_MODEL", DEFAULT_OPENAI_MODEL);
  const model = resolveOpenAIModel(configured);
  console.error(`Validate model: ${model}`);
  return makeOpenAIClient(apiKey, model);
}
