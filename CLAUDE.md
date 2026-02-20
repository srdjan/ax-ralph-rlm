# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Commands

```bash
# Run the demo (primary entry point)
deno task demo -- --query "..." --doc docs/long.txt

# QA mode (evidence-backed answers)
deno task demo -- --mode qa --query "..." --doc docs/long.txt

# Task mode (default - general task completion)
deno task demo -- --query "..." --doc docs/long.txt

# Full flag set
deno task demo -- --query "..." --doc docs/long.txt --maxIters 6 --out out --progressMs 5000 --memFile out/context.md

# Type-check
deno task check

# Format
deno task fmt

# Lint
deno task lint
```

There are no automated tests. Validation is done at runtime via the Ralph loop
itself.

## Environment

Copy `.env.example` to `.env` and fill in the two required keys:

- `ANTHROPIC_APIKEY` - used by the generation agent (Claude)
- `OPENAI_APIKEY` - used by the judge agent (GPT)

Optional overrides: `AX_GENERATE_MODEL`, `AX_VALIDATE_MODEL`, `AX_MAX_ITERS`,
`AX_WORKER_MAX_STEPS`, `AX_WORKER_MAX_LLM_CALLS`, `AX_PROGRESS_HEARTBEAT_MS`,
`AX_OUT_DIR`.

## Architecture

This is a Deno application using the Anthropic and OpenAI SDKs directly. No
framework intermediary - the LLM calling protocol, agent loops, and JS sandbox
are implemented in-house.

### Two modes

**QA mode** (`--mode qa`): generates structured answers with verbatim evidence
quotes. Pipeline: Worker (RLM) -> Hard Validate -> Semantic Judge -> feedback
loop. Orchestrated by `src/lib/ralph.ts`.

**Task mode** (default): general task completion with iterative reasoning.
Pipeline: DocReader (RLM) -> TaskReasoner -> Hard Validate -> TaskJudge ->
memory append -> feedback loop. Orchestrated by `src/lib/task_loop.ts`.

### Module map

```
src/main.ts                  Entry point, CLI arg parsing, mode routing
src/lib/
  llm_client.ts              LLMClient interface + Anthropic/OpenAI SDK wrappers
  ai.ts                      Client factories (makeClaudeAI, makeGptAI)
  agent.ts                   Non-RLM agent loop, MaxStepsError, output schema builders
  rlm_agent.ts               RLM agent: sandbox + llmQuery + code execution loop
  rlm_runtime.ts             Deno Worker sandbox host (spawns/manages worker)
  rlm_worker_script.ts       Worker script (eval, console capture, fn-call proxy)
  rlm_prompt.ts              RLM system prompt template + truncation helpers
  worker.ts                  QA worker agent config (uses rlm_agent)
  doc_reader.ts              Task-mode doc reader config (uses rlm_agent)
  judge.ts                   QA semantic judge config (uses agent)
  task_reasoner.ts           Task-mode reasoner config (uses agent)
  task_judge.ts              Task-mode judge config (uses agent)
  ralph.ts                   QA outer loop orchestration
  task_loop.ts               Task outer loop orchestration
  hard_validate.ts           Deterministic QA validation (bullets, quotes, substrings)
  task_validate.ts           Deterministic task validation (non-empty, min length)
  loop_helpers.ts            Heartbeat timer, error classification, duration formatting
  types.ts                   Shared types (GenerateOut, JudgeOut, IterTrace, etc.)
  env.ts                     Environment variable helpers
  memory.ts                  Persistent memory with budget trimming
  git_memory.ts              Session trace indexing and archival
```

### Key abstractions

**LLMClient** (`llm_client.ts`): unified chat interface over both SDKs. Handles
message format translation, tool definitions, and token usage extraction.
`makeAnthropicClient` and `makeOpenAIClient` are the two implementations.

**Non-RLM agents** (`agent.ts`): `agentForward()` runs a tool-based structured
output loop. The LLM is given a single output tool matching the desired schema
and loops until it calls it. `MaxStepsError` is thrown on budget exhaustion.
`buildOutputTool()` converts `OutputField[]` to JSON Schema tool definitions.

**RLM agents** (`rlm_agent.ts`): `rlmAgentForward()` extends the agent loop with
a persistent JS sandbox. The output tool includes `javascriptCode` and
`resultReady` helper fields. Code is executed in the sandbox via
`rlm_runtime.ts`. `llmQuery` is proxied from the sandbox back to the host for
semantic sub-queries (single or batched with concurrency limiting). A fallback
extractor attempts to salvage partial results on step-budget exhaustion.

**Sandbox** (`rlm_runtime.ts` + `rlm_worker_script.ts`): a Deno Worker running
sloppy-mode eval so `var` declarations persist across calls. Console output is
captured as execution results. The async fn-call/fn-result message protocol
bridges `llmQuery` between the worker and host.

### Two-model split

- Worker/DocReader agents use Claude via `makeClaudeAI()` for generation.
- Judge agents use GPT via `makeGptAI()` for validation.

### Validation is two-stage

1. Hard validation (local, deterministic): format checks, count ranges, quote
   verification (exact substring match against source document).
2. Semantic judge (GPT): evaluates whether the output is supported by the
   evidence or adequately completes the task.

### Data flow

`main.ts` parses CLI args, constructs both AI clients and the relevant agents,
then calls `runRalphLoop` (QA) or `runTaskLoop` (task). Both return
`{ ok, output, traces }`. Per-iteration traces are written to `out/iter-XX.json`
and archived under `out/sessions/<session-id>/`.

### Dependencies

Runtime deps (via deno.json import map):

- `@anthropic-ai/sdk` - Anthropic Messages API
- `openai` - OpenAI Chat Completions API
- `@std/dotenv` - .env file loading
- `@std/cli` - CLI argument parsing

No framework dependencies. The agent loop, RLM sandbox, and prompt templates are
implemented directly.
