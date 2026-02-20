# Ralph Loop + RLM (Deno)

A Deno proof-of-concept demonstrating two nested LLM loops for grounded,
evidence-backed document analysis:

- **Ralph loop** (outer quality loop): generate, validate, feedback, retry
- **RLM mode** (inner long-context pattern): load a document into a sandboxed
  Deno Worker and query slices via `llmQuery` rather than stuffing the full text
  into the context window
- **Two-model split**: Claude (Anthropic) for generation, GPT (OpenAI) for
  validation

The system uses `@anthropic-ai/sdk` and `openai` directly - no framework
intermediary.

---

## Prerequisites

- **Deno** (v2.0+)
- API keys:
  - `ANTHROPIC_APIKEY` for Claude generation
  - `OPENAI_APIKEY` for GPT validation

## Setup

```bash
cp .env.example .env
# fill in OPENAI_APIKEY and ANTHROPIC_APIKEY
```

## Modes

The system supports two modes: **QA** (question-answering with evidence) and
**Task** (general task completion with iterative reasoning).

### QA mode

Generates a structured answer with verbatim evidence quotes from a document.

```bash
deno task demo -- --mode qa --query "Explain Ralph loop and RLM" --doc docs/long.txt
```

Output: `answer` (3-7 bullet lines) + `evidence` (3-8 verbatim quotes that must
appear in the document).

### Task mode (default)

Reads a document, reasons about a task, and iteratively improves the output
using accumulated memory.

```bash
deno task demo -- --query "Summarize the key architectural decisions" --doc docs/long.txt
```

Output: `output` (task completion) + `memoryUpdate` (findings persisted across
iterations).

### Full flag set

```bash
deno task demo -- \
  --mode qa \
  --query "..." \
  --doc docs/long.txt \
  --maxIters 6 \
  --out out \
  --progressMs 5000 \
  --memFile out/context.md
```

---

## How the QA loop works

1. **Generate (Claude + RLM)**: the worker agent loads the document into a
   sandboxed JS runtime. It explores the document using code execution and
   `llmQuery` sub-calls, then produces bullet-point answers with verbatim
   evidence quotes.

2. **Validate**:
   - **Hard checks (local):** format, bullet count (3-7), evidence count (3-8),
     quote length (<= 160 chars), no duplicates, each quote is a verbatim
     substring of the document.
   - **Semantic judge (GPT):** checks whether each bullet is supported by the
     provided evidence contexts (220-char windows around each cited quote).

3. **Feedback + retry**: validation failures become explicit constraints
   appended to the next generation request, up to `maxIters` attempts.

## How the Task loop works

1. **DocReader (Claude + RLM)**: extracts and summarizes relevant information
   from the document and accumulated memory into a compact brief.

2. **TaskReasoner (Claude)**: reasons about the brief to complete the task and
   produces findings for memory.

3. **Validate**:
   - **Hard checks (local):** output and memoryUpdate must be non-empty and meet
     minimum length thresholds.
   - **TaskJudge (GPT):** evaluates whether the output substantively completes
     the task given the available brief and memory.

4. **Memory + retry**: the reasoner's `memoryUpdate` is appended to a persistent
   memory file. Failures produce feedback constraints for the next iteration.

---

## Architecture

```
src/
  main.ts                    CLI entry point, wires both modes
  lib/
    llm_client.ts            Unified LLMClient interface + Anthropic/OpenAI implementations
    ai.ts                    Client factories with model validation
    agent.ts                 Non-RLM agent: tool-based structured output loop
    rlm_agent.ts             RLM agent: sandbox + llmQuery + code execution loop
    rlm_runtime.ts           Deno Worker sandbox host side
    rlm_worker_script.ts     Worker script (runs inside sandbox)
    rlm_prompt.ts            RLM system prompt builder
    worker.ts                QA worker agent config (RLM)
    doc_reader.ts            Task-mode document reader agent config (RLM)
    judge.ts                 QA semantic judge agent config
    task_reasoner.ts         Task-mode reasoning agent config
    task_judge.ts            Task-mode validation judge config
    ralph.ts                 QA outer loop orchestration
    task_loop.ts             Task-mode outer loop orchestration
    hard_validate.ts         Deterministic QA validation rules
    task_validate.ts         Deterministic task validation rules
    loop_helpers.ts          Shared loop utilities (heartbeat, error classification)
    types.ts                 Shared type definitions
    env.ts                   Environment variable helpers
    memory.ts                Persistent memory read/write with budget trimming
    git_memory.ts            Session trace indexing and archival
```

### LLM client layer

`llm_client.ts` defines a `LLMClient` type that both Anthropic and OpenAI
implementations satisfy. It handles message format translation (Anthropic
separates system messages, uses content blocks for tool_use; OpenAI uses
function_calling), tool definition mapping, and token usage extraction.

### Agent layer

Non-RLM agents (`agent.ts`) run a simple loop: send messages with a structured
output tool, parse the tool call response, retry up to `maxSteps`. Used by the
judge, task reasoner, and task judge.

RLM agents (`rlm_agent.ts`) extend this with a persistent Deno Worker sandbox.
The LLM emits `javascriptCode` to execute in the sandbox and `resultReady: true`
when done. The sandbox proxies `llmQuery` calls back to the host for semantic
sub-queries. A fallback extractor attempts to salvage partial results if the
step budget is exhausted.

### Sandbox

`rlm_runtime.ts` spawns a Deno Worker from `rlm_worker_script.ts`. The worker
uses sloppy-mode eval so `var` declarations persist across execution calls.
Console output is captured as the execution result. Async function proxying (for
`llmQuery`) uses a message-based protocol: the worker posts `fn-call`, the host
resolves it and posts `fn-result` back.

---

## Trace output

- Per-iteration traces: `out/iter-XX.json`
- Session archives: `out/sessions/<session-id>/iter-XX.json`
- Session index: `out/session-index.json`

Query traces programmatically:

```ts
import { querySessionTraces } from "./src/lib/git_memory.ts";
const traces = await querySessionTraces("2026-02-20/ralph-d8eb40c5");
```

---

## Environment variables

| Variable                   | Default                    | Description                              |
| -------------------------- | -------------------------- | ---------------------------------------- |
| `ANTHROPIC_APIKEY`         | (required)                 | Anthropic API key                        |
| `OPENAI_APIKEY`            | (required)                 | OpenAI API key                           |
| `GENERATE_MODEL`        | `claude-sonnet-4-20250514` | Claude model for generation              |
| `VALIDATE_MODEL`        | `gpt-4o-mini`              | OpenAI model for validation              |
| `MAX_ITERS`             | `4`                        | Max outer loop iterations                |
| `WORKER_MAX_STEPS`      | `80`                       | Max RLM agent steps per iteration        |
| `WORKER_MAX_LLM_CALLS`  | `60`                       | Max llmQuery sub-calls per iteration     |
| `PROGRESS_HEARTBEAT_MS` | `8000`                     | Progress log interval during long phases |
| `OUT_DIR`               | `out`                      | Output directory for traces              |

## Troubleshooting

- **Worker step-budget errors**: increase `WORKER_MAX_STEPS` (try doubling)
  and `WORKER_MAX_LLM_CALLS` proportionally.
- **Long silent pauses**: reduce `PROGRESS_HEARTBEAT_MS` or pass
  `--progressMs 3000`.
- **Model not recognized**: check the allowed model sets in `src/lib/ai.ts`. The
  system falls back to defaults for unrecognized model names.
