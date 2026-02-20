# Ralph Loop + RLM: How It Works and Why

---

## The problem this solves

You have a long document - a research report, a legal brief, a technical spec -
and a question about it. You want an answer you can trust, grounded in what the
document actually says, not what an LLM confidently makes up.

The naive approach is to paste the document into an LLM's context window and
ask. This breaks down in several ways:

**The document is too long.** Most real documents exceed what fits comfortably
in a single LLM call. Even when they fit, long-context performance degrades:
LLMs tend to miss information in the middle and over-weight the beginning and
end.

**You can't verify the answer.** When an LLM says "the report concludes X," you
have no way to tell whether X is a faithful reading, a paraphrase that shifted
meaning, or an outright hallucination. There is no audit trail.

**One shot is not enough.** A single LLM call either succeeds or fails silently.
If the answer is incomplete or wrong, you don't know, and there's no mechanism
to improve it.

**RAG doesn't fully solve it either.** Retrieval-augmented generation retrieves
fixed-size chunks by embedding similarity. This works for lookup questions but
fails when the answer requires synthesizing information spread across a document,
or when the relevant chunk is surrounded by text that makes it ambiguous without
broader context. Retrieval is a blunt instrument.

This system takes a different approach to all three problems.

---

## The core idea: the LLM writes code to read the document

Instead of pasting the document into the LLM's context and hoping for the best,
this system gives the LLM a JavaScript sandbox with the document loaded as a
variable. The LLM writes code to explore the document - search for terms,
extract slices, scan sections, count occurrences - and calls a `llmQuery`
function for targeted semantic questions about the slices it has found.

The key insight is that code is a precise instrument. An LLM writing
`context.indexOf("revenue guidance")` will find that exact phrase if it exists,
or get a definitive -1 if it doesn't. It can then slice out 500 characters
around the match and call `llmQuery("What does this passage say about future
revenue?", slice)` to get focused semantic analysis on a small piece of text
rather than a vague summary of the whole document.

This is the RLM (Recursive Language Models) pattern: the LLM reasons
through code, using language model calls as a tool within that reasoning
process, rather than trying to hold the entire document in its attention at
once.

---

## How the feedback loop works

The system runs in iterations. On each iteration:

1. An agent explores the document and produces a candidate output.
2. The output is validated - first with fast deterministic rules, then with a
   separate LLM judge.
3. If validation fails, the specific issues are formatted as explicit constraints
   and the next iteration starts with those constraints as hard requirements.

This is the outer loop: generate, validate, improve. It runs up to `maxIters`
times. By the second or third iteration, the agent has already seen exactly what
was wrong and has concrete instructions for fixing it.

The judge matters here. The system uses two different LLMs from two different
providers: Claude (Anthropic) for generation, GPT (OpenAI) for validation. A
model cannot game a judge it doesn't share weights with. If you used the same
model to evaluate its own output, it would be easy for the generator to produce
text that the validator rates highly but that is actually wrong. Cross-model
validation is an adversarial check that is much harder to fool.

---

## Two modes

### QA mode

QA mode produces a structured answer with attached verbatim evidence. The output
has two fields: an answer (3-7 bullet points) and evidence (3-8 exact quotes).
Every quote must be a character-for-character substring of the source document -
not a paraphrase, not a close match, but the exact text.

This constraint is what makes the output auditable. A reader can search for
every quote in the document and verify it exists. The answer cannot include
claims that aren't anchored to a real passage.

The GPT judge receives the answer, the evidence quotes, and a 220-character
window of surrounding text for each quote. It checks whether each answer bullet
is actually supported by the evidence it's paired with. Hallucinated bullets
that aren't covered by any quote get caught here.

### Task mode

Task mode is for open-ended work: summarize this document, extract all the
action items, compare these two sections. The output doesn't need verbatim
quotes because the task is completion, not fact lookup.

Task mode adds a persistent memory file. Each iteration appends a block of
findings to a text file. The next iteration reads that memory before exploring
the document, so it can build on what prior iterations discovered rather than
starting from scratch. Memory is budget-trimmed at 1500 characters: when it
gets too long, the oldest blocks are dropped.

Task mode also splits the work between two agents: a DocReader (RLM) that
extracts relevant information from the document into a compact brief, and a
TaskReasoner (non-RLM) that reasons over the brief to produce the final output.
This separation keeps the reasoning agent focused on thinking rather than
document mechanics.

When the judge flags problems with the TaskReasoner's output, those issues flow
back to the DocReader as `docReaderHints` on the next iteration. If the judge
says "the output doesn't address the timeline," the DocReader is told to
specifically extract timeline information. This closes a feedback loop that most
systems leave open: if the extracted information was insufficient, the next
extraction is targeted at exactly what was missing.

---

## The sandbox in detail

The sandbox is a Deno Worker - a separate thread running an isolated JavaScript
environment. When an RLM agent starts, it spawns this worker and sends it the
document text as a global variable called `context`.

On each agent step, the LLM returns JavaScript code. The host sends that code to
the worker, which runs it and returns the output. `var` declarations persist
across calls (the sandbox uses sloppy-mode eval, not strict mode) so the LLM
can assign intermediate results and use them in later steps.

`llmQuery` is available inside the sandbox but is not a real function in the
worker. It is a proxy: when the worker's code calls `llmQuery(prompt, text)`,
the worker posts a message to the host, the host makes an actual LLM call with
Claude, and posts the result back. This happens asynchronously and transparently.
From the LLM's perspective, it writes code that calls `llmQuery` and gets back
a string. The plumbing is invisible.

This architecture means the LLM can run multiple `llmQuery` calls in a loop -
querying dozens of document slices, aggregating answers, refining - without any
of those calls appearing in the primary conversation history. Each sub-query is
a separate targeted API call.

---

## Validation in detail

Validation is two-stage and happens every iteration.

**Hard validation** runs first and is fully local - no API calls, instant. It
enforces structural rules: the right number of bullets, the right number of
evidence quotes, no duplicates, each quote is short enough to be precise, each
quote is a verbatim substring of the document. Any hard validation failure
generates a specific error message that goes into the next iteration's
constraints. The agent gets told exactly which quote wasn't found in the
document, not just "validation failed."

**Semantic validation** runs only if hard validation passes. The GPT judge
evaluates whether the output is actually good, not just structurally correct. In
QA mode it checks whether each answer bullet is supported by its evidence. In
task mode it checks whether the output substantively completes the task.

Running semantic validation after hard validation is deliberate. It avoids
wasting API calls judging outputs that are structurally broken. The hard check
is cheap; the LLM check is not.

---

## Why no framework

Most LLM application frameworks are built around abstractions for orchestrating
chains of LLM calls. This system doesn't use one. The LLM client interface is a
single `chat` method, implemented twice: once for Anthropic's SDK, once for
OpenAI's. The agent loops are plain TypeScript functions. The sandbox is a Deno
Worker with 150 lines of message handling.

The reason is control. Frameworks abstract over the LLM calling protocol, which
is exactly the part of the system that needs to be precise: how tool calls are
formatted, how messages are accumulated, how the stop reason is interpreted, how
token counts are tracked. Abstracting over that means debugging through two
layers of indirection when something goes wrong. For a system where the calling
protocol is load-bearing, that is a bad trade.

The other reason is that this system needs to bridge two different APIs with
different wire formats. Wrapping both in a thin `LLMClient` interface is cleaner
than depending on a framework's multi-provider support and hoping it handles both
correctly.

---

## Architecture layers

The system is organized into four layers, each depending only on the one below.

**Layer 1: LLMClient** (`llm_client.ts`). A `chat` method, two implementations.
Handles the translation between Anthropic's and OpenAI's different message
formats, tool schemas, and token reporting conventions.

**Layer 2: Agent loops** (`agent.ts`, `rlm_agent.ts`). Two patterns. The basic
agent sends a system prompt and user input with a single output tool, loops
until the LLM calls the tool, and nudges it if it wanders. The RLM agent extends
this with the sandbox: on each step the LLM can submit code to execute or
declare it's done. Both loops manage budgets (max steps, max LLM calls) and
handle exhaustion gracefully - a fallback extractor runs a single summarization
call over the accumulated trajectory when the budget runs out.

**Layer 3: Agent configurations** (`worker.ts`, `doc_reader.ts`, `judge.ts`,
`task_reasoner.ts`, `task_judge.ts`). Thin modules that define each agent's
system prompt, output schema, and budget parameters. No logic here, just
configuration.

**Layer 4: Orchestration loops** (`ralph.ts`, `task_loop.ts`). The outer loops
that wire everything together: manage iteration state, accumulate constraints,
run validation, write trace files, archive sessions.

---

## Module map

```
src/
  main.ts                    CLI entry point, parses args, wires everything

  lib/
    llm_client.ts            Layer 1: unified LLMClient + Anthropic/OpenAI impls
    ai.ts                    Client factories (makeClaudeAI, makeGptAI)

    agent.ts                 Layer 2: basic agent loop + output tool builder
    rlm_agent.ts             Layer 2: RLM agent loop (sandbox + llmQuery + code execution)
    rlm_runtime.ts           Sandbox: Deno Worker host management
    rlm_worker_script.ts     Sandbox: worker script (sloppy eval, console capture, fn proxying)
    rlm_prompt.ts            RLM system prompt template + truncation helpers

    worker.ts                Layer 3: QA worker agent (RLM)
    doc_reader.ts            Layer 3: task-mode document reader (RLM)
    judge.ts                 Layer 3: QA semantic judge
    task_reasoner.ts         Layer 3: task-mode reasoning agent
    task_judge.ts            Layer 3: task-mode judge

    ralph.ts                 Layer 4: QA outer loop
    task_loop.ts             Layer 4: task outer loop

    hard_validate.ts         QA deterministic validation
    task_validate.ts         task deterministic validation
    loop_helpers.ts          heartbeat timer, error classification, duration formatting
    types.ts                 shared types (GenerateOut, IterTrace, etc.)
    env.ts                   environment variable helpers
    memory.ts                persistent memory read/write with budget trimming
    git_memory.ts            session trace indexing and archival
```

---

## Configuration reference

The system is configured through environment variables. CLI flags take
precedence when provided.

| Variable                   | Default                    | Purpose                              |
| -------------------------- | -------------------------- | ------------------------------------ |
| `ANTHROPIC_APIKEY`      | (required)                 | Anthropic API key for Claude         |
| `OPENAI_APIKEY`         | (required)                 | OpenAI API key for GPT               |
| `GENERATE_MODEL`        | `claude-sonnet-4-20250514` | Claude model for generation          |
| `VALIDATE_MODEL`        | `gpt-4o-mini`              | OpenAI model for validation          |
| `MAX_ITERS`             | `4`                        | Max outer loop iterations            |
| `WORKER_MAX_STEPS`      | `80`                       | Max RLM agent steps per iteration    |
| `WORKER_MAX_LLM_CALLS`  | `60`                       | Max llmQuery sub-calls per iteration |
| `PROGRESS_HEARTBEAT_MS` | `8000`                     | Progress log interval (ms)           |
| `OUT_DIR`               | `out`                      | Output directory for traces          |
