# System Design Document

A high-level guide to the Ralph Loop + RLM system for new developers joining the
project.

---

## 1. What this system does

The system takes a user query and a document, then produces a structured answer
grounded in the document's actual content. It does this through two nested
feedback loops:

- The **outer loop** (Ralph loop for QA, Task loop for general tasks) generates
  a candidate output, validates it with both deterministic checks and an LLM
  judge, and retries with targeted feedback if validation fails.
- The **inner loop** (RLM mode) runs inside a sandboxed JavaScript runtime. The
  LLM writes and executes code to explore the document incrementally, calling
  `llmQuery` sub-queries for semantic analysis rather than stuffing the entire
  document into its context window.

The system uses a two-model split: Claude (Anthropic) handles generation, GPT
(OpenAI) handles validation. This separation prevents the generator from gaming
its own judge.

---

## 2. Two operating modes

### QA mode (`--mode qa`)

Produces a structured answer with verbatim evidence. The output has two fields:
`answer` (3-7 bullet lines) and `evidence` (3-8 exact quotes from the
document). Each evidence quote must be a verbatim substring - character-for-
character - of the source document.

### Task mode (`--mode task`, the default)

Reads a document, reasons about a general task, and iteratively improves the
output with persistent memory across iterations. The output has two fields:
`output` (the task completion) and `memoryUpdate` (findings persisted for the
next iteration).

Both modes share the same outer-loop structure: generate, validate, feedback,
retry.

---

## 3. Data flow

### QA mode

```
                         +-----------------------------+
                         |      Ralph Loop (outer)     |
                         |   ralph.ts / up to maxIters |
                         +-----------------------------+
                                      |
                    +-----------------+-----------------+
                    |                                   |
                    v                                   v
          +------------------+               +-------------------+
          |  Worker Agent    |               |  Judge Agent      |
          |  (Claude + RLM)  |               |  (GPT)            |
          |  rlm_agent.ts    |               |  agent.ts         |
          +------------------+               +-------------------+
                    |                                   |
    +---------------+---------------+                   |
    |               |               |                   |
    v               v               v                   v
 sandbox       llmQuery        code exec          semantic check:
 (Deno Worker)  (Claude)      (sloppy eval)     "is each bullet
                                                  supported by
                                                  evidence?"
```

Step by step:

1. `main.ts` parses CLI arguments, creates Claude and GPT `LLMClient` objects,
   constructs agent configurations, and calls `runRalphLoop`.

2. `ralph.ts` runs the outer loop. On each iteration it calls the worker agent
   to generate a candidate, then validates the output.

3. The worker agent (`worker.ts`) uses `rlmAgentForward` to run the inner RLM
   loop. This spawns a Deno Worker sandbox, loads the document as a context
   variable, and lets Claude write JavaScript code to explore the document. The
   LLM calls `llmQuery` inside the sandbox to ask semantic questions about
   document slices.

4. Hard validation (`hard_validate.ts`) checks deterministic rules: bullet
   count, evidence count, quote length, no duplicates, each quote is a verbatim
   substring of the document.

5. If hard validation passes, evidence contexts are built (220-char windows
   around each cited quote) and sent to the semantic judge. The GPT judge
   (`judge.ts`) checks whether each answer bullet is supported by the evidence.

6. If validation fails, the issues are formatted as explicit constraints and
   appended to the next iteration's prompt.

### Task mode

```
                       +-------------------------------+
                       |      Task Loop (outer)        |
                       |  task_loop.ts / up to maxIters|
                       +-------------------------------+
                                     |
               +---------------------+---------------------+
               |                     |                     |
               v                     v                     v
     +------------------+   +------------------+   +------------------+
     |  DocReader Agent  |   | TaskReasoner     |   | TaskJudge Agent  |
     |  (Claude + RLM)   |   | (Claude)         |   | (GPT)            |
     |  rlm_agent.ts     |   | agent.ts         |   | agent.ts         |
     +------------------+   +------------------+   +------------------+
               |                     |                     |
               v                     v                     v
       extract & summarize     reason about brief     semantic check:
       relevant info from      to complete the task   "does the output
       doc + accumulated       and produce findings   substantively
       memory into a brief     for memory             complete the task?"
               ^                                           |
               |          docReaderHints                    |
               +-------------------------------------------+
                    (derived from judge/hard issues)
```

Step by step:

1. `task_loop.ts` reads the persistent memory file and derives
   `docReaderHints` from the previous iteration's feedback (empty on the first
   iteration), then calls the DocReader agent.

2. The DocReader (`doc_reader.ts`) uses RLM mode to explore the document and
   accumulated memory, producing a compact `brief`. If `docReaderHints` is
   non-empty, the agent treats the hints as additional extraction targets -
   addressing specific gaps identified by a prior iteration's validation.

3. The TaskReasoner (`task_reasoner.ts`) is a non-RLM agent. It receives the
   brief, the task, and any constraints, then produces `output` and
   `memoryUpdate`.

4. The `memoryUpdate` is appended to the persistent memory file
   (`memory.ts`). Memory is budget-trimmed: when it exceeds 1500 characters,
   the oldest blocks are dropped.

5. Hard validation (`task_validate.ts`) checks that `output` and `memoryUpdate`
   are non-empty and meet minimum length thresholds. The log output includes
   `briefLen` and `outputLen` so thin briefs can be distinguished from
   underperforming reasoning.

6. If hard validation passes, the TaskJudge (GPT) evaluates whether the output
   substantively completes the task.

---

## 4. Layer architecture

The system has four layers. Each layer depends only on the one below it.

### Layer 1: LLM Client (`llm_client.ts`)

The foundation. Defines a unified `LLMClient` interface with a single `chat`
method. Two implementations exist: `makeAnthropicClient` (Claude via
`@anthropic-ai/sdk`) and `makeOpenAIClient` (GPT via `openai`).

The interface abstracts over the significant differences between the two APIs:

- Anthropic separates system messages from the message array, uses content
  blocks for tool_use responses, and reports `input_tokens`/`output_tokens`.
- OpenAI inlines system messages, uses function_calling with a different tool
  schema shape, and reports `prompt_tokens`/`completion_tokens`.

Key types:

- `ChatMessage` - role + content + optional tool call data
- `ToolDefinition` - name, description, JSON Schema parameters
- `ChatCompletion` - content, tool calls, token usage, stop reason
- `LLMClient` - the unified interface

### Layer 2: Agent abstractions (`agent.ts`, `rlm_agent.ts`)

Two agent patterns built on top of `LLMClient`:

**Non-RLM agent** (`agentForward` in `agent.ts`): a loop that sends a system
prompt and user input to the LLM with a single "output tool" defined via JSON
Schema. The LLM must call this tool to return structured output. If it doesn't,
the agent nudges it and retries up to `maxSteps`. Used by the judge,
task reasoner, and task judge.

**RLM agent** (`rlmAgentForward` in `rlm_agent.ts`): extends the basic agent
with a persistent JavaScript sandbox. The output tool has two extra helper
fields: `javascriptCode` (code to execute) and `resultReady` (boolean signal for
completion). On each step the LLM can either execute code in the sandbox (to
explore the document, slice data, run computations) or declare its result. The
sandbox proxies `llmQuery` calls back to the host for semantic sub-queries.

The RLM agent also tracks `llmQuery` call count against a budget. When 80% of
calls are used it appends a warning. When the budget is exhausted, it returns an
error message telling the LLM to wrap up.

If the step budget is exhausted before `resultReady: true`, a fallback extractor
runs: a single LLM call with the accumulated code trajectory attempts to extract
the best available output.

### Layer 3: Agent configurations (worker, judge, doc_reader, etc.)

Each agent is configured by defining:

- A `definition` string (the domain-specific system prompt)
- Output fields with their types (`string`, `string[]`, `class` with enum
  values)
- Budget parameters (`maxSteps`, `maxLlmCalls`, `temperature`)

For example, the QA worker agent (`worker.ts`) is configured with:

- `contextFields: ["context"]` (the document, loaded into the sandbox)
- `outputFields: [answer: string, evidence: string[]]`
- A definition that instructs the LLM to be a "strict technical writer" and
  follow specific output rules

These configuration modules are thin: they define constants and call the
appropriate agent forward function.

### Layer 4: Orchestration loops (`ralph.ts`, `task_loop.ts`)

The outer loops wire everything together. They:

- Manage iteration state and constraint accumulation
- Handle worker step-budget errors gracefully (classify via
  `classifyWorkerError`, log diagnostics, continue to next iteration)
- Run hard validation then semantic validation
- Write per-iteration trace files (`out/iter-XX.json`)
- Archive traces to session directories via `git_memory.ts`
- Log progress with configurable heartbeat intervals

---

## 5. The sandbox: how RLM code execution works

The sandbox is the most mechanically complex part of the system. Here is how it
works:

### Host side (`rlm_runtime.ts`)

`createSandboxSession` spawns a Deno Worker from `rlm_worker_script.ts`. It
sends an `init` message with two things:

- **Serializable globals**: context variables (like the document text) are sent
  as-is.
- **Function proxy names**: `llmQuery` is not serialized. Instead, the worker
  creates an async stub that posts a `fn-call` message to the host, which
  resolves the actual LLM call and posts `fn-result` back.

The `execute(code)` method sends an `execute` message to the worker and returns
a Promise. While waiting, it handles incoming `fn-call` messages by calling the
registered proxy function and posting results back.

### Worker side (`rlm_worker_script.ts`)

The worker script handles three message types:

- `init`: sets globals on `globalThis`, creates async proxy functions for each
  registered function name.
- `fn-result`: resolves pending Promises from proxy function calls.
- `execute`: captures console output, detects whether the code contains `await`
  (async path) or not (sync path), runs the code, and posts the result back.

Key implementation details:

- **Sloppy-mode eval**: `var` declarations persist across `execute` calls
  because the worker uses indirect eval `(0, eval)(code)` without "use strict".
  This is essential: the LLM builds up state across steps by assigning variables.
- **Console capture**: `console.log`, `console.info`, `console.warn`,
  `console.error`, and `print` are temporarily redirected to capture output.
  Console output takes priority over the eval return value.
- **Async detection**: if the code contains the word `await`, it's wrapped in an
  `AsyncFunction` constructor (async IIFE equivalent). Otherwise it uses
  synchronous eval.
- **Auto-return**: for async code, the last expression line is automatically
  wrapped in `return (...)` so the LLM doesn't need explicit return statements.

### Message protocol summary

```
Host -> Worker:
  { type: "init", globals: {...}, fnNames: ["llmQuery"] }
  { type: "execute", id: 1, code: "var n = context.length; n" }
  { type: "fn-result", id: 42, value: "The document discusses..." }

Worker -> Host:
  { type: "result", id: 1, value: "12345" }
  { type: "fn-call", id: 42, name: "llmQuery", args: ["Summarize this", "..."] }
```

---

## 6. Validation pipeline

Validation is two-stage in both modes:

### Hard validation (deterministic, local)

QA mode (`hard_validate.ts`):

- Answer must have 3-7 bullet lines starting with `- `
- Evidence must have 3-8 quotes
- Each quote must be <= 160 characters
- No duplicate quotes
- Each quote must be a verbatim substring of the document (exact match via
  `String.includes`)

Task mode (`task_validate.ts`):

- `output` and `memoryUpdate` must be non-empty
- Both must exceed minimum length thresholds

### Semantic validation (LLM judge)

Only runs if hard validation passes. The judge is a non-RLM agent (GPT) that
returns structured output: `ok: "yes" | "no"` and `issues: string[]`.

QA mode: the judge receives the query, the answer, the evidence quotes, and
220-character windows around each quote from the document. It checks whether each
answer bullet is supported by the evidence contexts.

Task mode: the judge receives the task, the output, the brief, and accumulated
memory. It evaluates whether the output substantively completes the task.

---

## 7. Trace output and session management

Every iteration writes a JSON trace file to `out/iter-XX.json`. The trace
includes the query/task, constraints used, generated output, hard validation
results, judge results, and pass/fail status.

`git_memory.ts` provides session-level trace management:

- `makeSessionId(query, mode)` generates a deterministic session ID in the
  format `YYYY-MM-DD/<mode>-<hash8>`.
- `storeIterTrace` copies each trace into a session directory
  (`out/sessions/<sessionId>/iter-XX.json`) and updates a session index file
  (`out/session-index.json`).
- `querySessionTraces` retrieves all traces for a session, sorted by iteration.

---

## 8. Memory system (Task mode only)

`memory.ts` provides persistent memory across task-loop iterations:

- `readMemory(path)` returns the file contents or empty string if missing.
- `appendToMemory(path, update, iter)` appends a timestamped block (headed by
  `## Iter N - <timestamp>`).
- `trimMemory(content)` enforces a 1500-character budget. When exceeded, the
  oldest blocks are dropped from the front and a `[trimmed N blocks]` marker is
  prepended.

This creates a sliding window of the most recent findings. The memory is passed
to the DocReader as a context variable, so each iteration builds on prior
iterations' discoveries.

---

## 9. Configuration and environment

The system is configured through environment variables and CLI flags. CLI flags
take precedence.

| Variable                   | Default                    | Purpose                              |
| -------------------------- | -------------------------- | ------------------------------------ |
| `ANTHROPIC_APIKEY`         | (required)                 | Anthropic API key for Claude         |
| `OPENAI_APIKEY`            | (required)                 | OpenAI API key for GPT               |
| `AX_GENERATE_MODEL`        | `claude-sonnet-4-20250514` | Claude model for generation          |
| `AX_VALIDATE_MODEL`        | `gpt-4o-mini`              | OpenAI model for validation          |
| `AX_MAX_ITERS`             | `4`                        | Max outer loop iterations            |
| `AX_WORKER_MAX_STEPS`      | `80`                       | Max RLM agent steps per iteration    |
| `AX_WORKER_MAX_LLM_CALLS`  | `60`                       | Max llmQuery sub-calls per iteration |
| `AX_PROGRESS_HEARTBEAT_MS` | `8000`                     | Progress log interval                |
| `AX_OUT_DIR`               | `out`                      | Output directory for traces          |

Model names are validated against allowlists in `ai.ts`. Unrecognized names fall
back to defaults.

---

## 10. Module map

```
src/
  main.ts                    CLI entry point, parses args, wires everything

  lib/
    llm_client.ts            Layer 1: LLMClient interface + Anthropic/OpenAI impls
    ai.ts                    Client factories (makeClaudeAI, makeGptAI)

    agent.ts                 Layer 2: Non-RLM agent loop + MaxStepsError + output tool builder
    rlm_agent.ts             Layer 2: RLM agent loop (sandbox + llmQuery + code execution)
    rlm_runtime.ts           Sandbox: Deno Worker host-side management
    rlm_worker_script.ts     Sandbox: Worker script (sloppy eval, console capture, fn proxying)
    rlm_prompt.ts            RLM system prompt template + truncation helpers

    worker.ts                Layer 3: QA worker agent config (RLM)
    doc_reader.ts            Layer 3: Task-mode document reader config (RLM)
    judge.ts                 Layer 3: QA semantic judge config
    task_reasoner.ts         Layer 3: Task-mode reasoning agent config
    task_judge.ts            Layer 3: Task-mode validation judge config

    ralph.ts                 Layer 4: QA outer loop orchestration
    task_loop.ts             Layer 4: Task outer loop orchestration

    hard_validate.ts         QA deterministic validation rules
    task_validate.ts         Task deterministic validation rules
    loop_helpers.ts          Shared: heartbeat, error classification, formatting
    types.ts                 Shared type definitions (GenerateOut, IterTrace, etc.)
    env.ts                   Environment variable helpers
    memory.ts                Persistent memory read/write with budget trimming
    git_memory.ts            Session trace indexing and archival
```

---

## 11. Key design decisions

**Two-model split.** The generator and validator use different LLMs from
different providers. This prevents the generator from learning to produce outputs
that fool a validator it implicitly understands. GPT judges Claude's work and
vice versa.

**Tool-based structured output.** Rather than asking the LLM to produce JSON in
free text and parsing it out, the system uses the native tool/function calling
APIs. The LLM is given a tool whose parameters are a JSON Schema matching the
desired output shape. This constrains the output format at the API level.

**Sloppy-mode eval for state persistence.** The sandbox uses indirect eval
without "use strict" so `var` declarations attach to `globalThis` and persist
across execution calls. This lets the LLM build up state incrementally: explore
the document in step 1, store intermediate results in step 2, aggregate in step
3, etc.

**Feedback as constraints.** Failed validation doesn't just retry blindly. The
specific issues (both hard and semantic) are formatted as constraints and
appended to the next iteration's prompt. Previous output is included so the LLM
can see exactly what went wrong and improve on it. In task mode, feedback flows
to both agents: `constraints` steer the TaskReasoner, while `docReaderHints`
(derived from the same issues) steer the DocReader to extract additional detail
that was missing in prior iterations.

**Budget-based resource control.** Every expensive operation has a budget:
`maxIters` for the outer loop, `maxSteps` for the inner agent loop,
`maxLlmCalls` for sub-queries, `maxRuntimeChars` for output truncation,
`MEMORY_BUDGET_CHARS` for persistent memory. When budgets are exceeded, the
system degrades gracefully with warnings and fallback extraction rather than
crashing.

**No framework dependency.** The system uses `@anthropic-ai/sdk` and `openai`
directly, with a thin `LLMClient` abstraction. This gives full control over the
LLM calling protocol and eliminates a large transitive dependency tree.
