# Ax + Ralph Loop + RLM (Deno PoC)

This proof-of-concept demonstrates:

- **Ralph loop** (outer quality loop): generate → validate → feedback → retry
- **RLM mode** in **AxAgent** (inner long-context pattern): keep a long document
  in a sandboxed runtime and query slices as needed
- **Two-model split**:
  - **Claude** (Anthropic) = generation
  - **GPT** (OpenAI) = validation/judging

Ax docs note that `AxJSRuntime` works across Node/Bun, **Deno**, and browsers,
and is used for RLM sessions.\
See: https://axllm.dev/axagent/ and https://axllm.dev/llm.txt

---

## Prerequisites

- **Deno** (recent version)
- API keys:
  - `ANTHROPIC_APIKEY` for Claude generation
  - `OPENAI_APIKEY` for GPT validation

## Setup

```bash
cp .env.example .env
# fill in OPENAI_APIKEY and ANTHROPIC_APIKEY
```

## Run

```bash
deno task demo -- --query "Explain Ralph loop and RLM and how they work together" --doc docs/long.txt
```

### What you get

- A JSON result printed to stdout:
  - `answer` (3–7 bullet lines)
  - `evidence` (3–8 verbatim quotes that must appear in the document)
- Per-iteration traces written to `out/iter-XX.json`

---

## How the loop works

1. **Generate (Claude + RLM)**
   - The worker agent runs with `rlm.mode="inline"` and loads `context` into an
     interpreter session.
   - It must output bullets + verbatim evidence quotes.

2. **Validate**
   - **Hard checks (local):** format, counts, evidence is substring of the doc.
   - **Semantic judge (GPT):** checks whether each bullet is supported by the
     provided evidence contexts.

3. **Feedback + retry**
   - Validation failures are converted into explicit constraints and appended to
     the next generation request.

---

## Useful flags

```bash
deno task demo -- --query "..." --doc docs/long.txt --maxIters 6 --out out
```

---

## Notes / Tips

- If your model names differ, override them in `.env`:
  - `AX_GENERATE_MODEL`
  - `AX_VALIDATE_MODEL`
- Keep the doc large to see RLM’s value. Replace `docs/long.txt` with a bigger
  corpus.

---

## Sources

- Ax Agent + RLM guide: https://axllm.dev/axagent/
- Ax `llm.txt` (mentions Deno compatibility for AxJSRuntime):
  https://axllm.dev/llm.txt
- Ax repo: https://github.com/ax-llm/ax
