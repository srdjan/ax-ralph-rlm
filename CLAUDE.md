# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Commands

```bash
# Run the demo (primary entry point)
deno task demo -- --query "..." --doc docs/long.txt

# Full flag set
deno task demo -- --query "..." --doc docs/long.txt --maxIters 6 --out out --progressMs 5000

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

This is a Deno proof-of-concept using the `@ax-llm/ax` library. The system
implements two nested loops over a document.

**Outer loop - Ralph loop** (`src/lib/ralph.ts`): iterates up to `maxIters`
times. Each iteration generates an answer, validates it, and either returns it
or feeds failures back as constraints for the next attempt. Per-iteration traces
are written to `out/iter-XX.json`.

**Inner loop - RLM mode** (`src/lib/worker.ts`): the worker agent runs with
`rlm.mode="inline"`, which loads the document into a sandboxed `AxJSRuntime`
(JavaScript interpreter). The agent can query slices of the document from within
the runtime rather than stuffing the full text into its context window.

**Two-model split:**

- Worker agent (`claudeWorker`) uses Claude via `makeClaudeAI()` for generation.
- Judge agent (`gptJudge`) uses GPT via `makeGptAI()` for semantic validation.

**Validation is two-stage:**

1. Hard validation (`src/lib/hard_validate.ts`): local, deterministic checks -
   bullet count (3-7), evidence count (3-8), quote length (<= 160 chars), no
   duplicates, each quote must be a verbatim substring of the document.
2. Semantic judge (`src/lib/judge.ts`): GPT agent receives evidence contexts
   (220-char windows around each cited quote) and decides whether each answer
   bullet is supported.

**Data flow:** `main.ts` wires everything together - parses CLI args, constructs
both AI clients and both agents, then calls `runRalphLoop`. The result shape is
`{ ok, output: GenerateOut, traces: IterTrace[] }`.

**Types** (`src/lib/types.ts`): `GenerateOut` (answer + evidence[]),
`HardValidation`, `JudgeOut`, `IterTrace` are the shared contract across all
modules.
