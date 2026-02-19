import { ai, AxAIAnthropicModel, AxAIOpenAIModel } from "npm:@ax-llm/ax";
import { getEnv, mustGetEnv } from "./env.ts";

const DEFAULT_ANTHROPIC_MODEL = AxAIAnthropicModel.Claude4Sonnet;
const DEFAULT_OPENAI_MODEL = AxAIOpenAIModel.GPT4OMini;

function resolveAnthropicModel(raw: string): AxAIAnthropicModel {
  if (raw === AxAIAnthropicModel.Claude35Sonnet) {
    console.error(
      `AX_GENERATE_MODEL=${raw} is legacy; using ${DEFAULT_ANTHROPIC_MODEL} instead.`,
    );
    return DEFAULT_ANTHROPIC_MODEL;
  }

  const allowed = new Set<string>(Object.values(AxAIAnthropicModel));
  if (!allowed.has(raw)) {
    console.error(
      `AX_GENERATE_MODEL=${raw} is not recognized; using ${DEFAULT_ANTHROPIC_MODEL}.`,
    );
    return DEFAULT_ANTHROPIC_MODEL;
  }

  return raw as AxAIAnthropicModel;
}

function resolveOpenAIModel(raw: string): AxAIOpenAIModel {
  const allowed = new Set<string>(Object.values(AxAIOpenAIModel));
  if (!allowed.has(raw)) {
    console.error(
      `AX_VALIDATE_MODEL=${raw} is not recognized; using ${DEFAULT_OPENAI_MODEL}.`,
    );
    return DEFAULT_OPENAI_MODEL;
  }

  return raw as AxAIOpenAIModel;
}

export function makeClaudeAI() {
  const apiKey = mustGetEnv("ANTHROPIC_APIKEY");
  const configured = getEnv("AX_GENERATE_MODEL", DEFAULT_ANTHROPIC_MODEL);
  const model = resolveAnthropicModel(configured);
  console.error(`Generate model: ${model}`);
  return ai({
    name: "anthropic",
    apiKey,
    config: { model },
  });
}

export function makeGptAI() {
  const apiKey = mustGetEnv("OPENAI_APIKEY");
  const configured = getEnv("AX_VALIDATE_MODEL", DEFAULT_OPENAI_MODEL);
  const model = resolveOpenAIModel(configured);
  console.error(`Validate model: ${model}`);
  return ai({
    name: "openai",
    apiKey,
    config: { model },
  });
}
