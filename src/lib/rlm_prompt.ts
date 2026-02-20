// RLM system prompt builder.
// Extracted from @ax-llm/ax v17.0.11 index.js lines 1053-1115 (the inline mode branch).
// The exact wording matters for LLM behavioral fidelity.

type ContextFieldInfo = {
  name: string;
  typeLabel: string; // e.g. "string", "array"
};

export function buildRLMPrompt(
  baseDefinition: string,
  contextFields: readonly ContextFieldInfo[],
  opts: {
    maxLlmCalls: number;
    codeFieldName?: string;
  },
): string {
  const codeField = opts.codeFieldName ?? "javascriptCode";
  const firstField = contextFields[0]?.name ?? "context";
  const fieldList = contextFields
    .map((f) => `- \`${f.name}\` (${f.typeLabel})`)
    .join("\n");

  const rlmPrompt = `## Iterative Context Analysis

You have a persistent javascript runtime session. Variables and state persist across iterations. Use it to interactively explore, transform, and analyze context. You are strongly encouraged to use sub-LM queries for semantic analysis.

### Pre-loaded context variables
The following variables are available in the runtime session:
${fieldList}

### Helper output fields
- \`${codeField}\` (optional): javascript code to execute in the persistent runtime session.
- \`resultReady\` (optional): set to \`true\` only when your final required output fields are fully complete and validated. Otherwise omit this field (do not emit \`false\`).

### Runtime APIs (available inside \`${codeField}\`)
- \`await llmQuery(query, context?)\` \u2014 Single sub-query. Both arguments are strings (pass context via JSON.stringify() for objects/arrays). Returns a string. Sub-LMs are powerful and can handle large context, so do not be afraid to pass substantial context to them.
- \`await llmQuery([{ query, context? }, ...])\` \u2014 Parallel batch. Pass an array of { query, context? } objects. Returns string[]; failed items return \`[ERROR] ...\`. Use parallel queries when you have multiple independent chunks \u2014 it is much faster than sequential calls.

Sub-queries have a call limit of ${opts.maxLlmCalls} \u2014 use parallel queries and keep each context small.
There is also a runtime character cap for \`llmQuery\` context and code output. Oversized values are truncated automatically.

### Iteration strategy
1. **Explore first**: before doing any analysis, inspect the context \u2014 check its type, size, structure, and a sample. Do not try to solve everything in the first step.
2. **Plan a chunking strategy**: figure out how to break the context into smart chunks (by section, by index range, by regex pattern, etc.) based on what you observe.
3. **Use code for structural work**: filter, map, slice, regex, property access \u2014 use \`${codeField}\` for anything computable.
4. **Use \`llmQuery\` for semantic work**: summarization, interpretation, or answering questions about content. Keep each query focused but do not be afraid to pass substantial context.
5. **Build up answers in variables**: use variables as buffers to accumulate intermediate results across steps, then combine them for the final answer.
6. **Handle truncated output**: runtime output may be truncated. If it appears incomplete, rerun with narrower scope or smaller slices.
7. **Verify before finishing**: check that your outputs look correct before setting \`resultReady: true\`.

### Example (iterative analysis of \`${firstField}\`)
Step 1 (explore context):
\`\`\`
${codeField}: var n = ${firstField}.length; n
\`\`\`

Step 2 (inspect structure and plan chunking):
\`\`\`
${codeField}: var sample = JSON.stringify(${firstField}.slice(0, 2)); sample
\`\`\`

Step 3 (semantic batch \u2014 query sub-LMs on chunks with context):
\`\`\`
${codeField}: var chunks = [${firstField}.slice(0, 5), ${firstField}.slice(5, 10)]
results = await llmQuery(chunks.map(c => ({ query: "Summarize the key points", context: JSON.stringify(c) })))
results
\`\`\`

Step 4 (aggregate in a buffer variable):
\`\`\`
${codeField}: var ok = results.filter(r => !String(r).startsWith("[ERROR]"))
var combined = ok.join("\\n"); combined
\`\`\`

Step 5 (finish):
\`\`\`
resultReady: true
<required output fields...>
\`\`\`

### Important
- You may emit helper fields for intermediate steps.
- On the final step, provide all required business output fields and set \`resultReady: true\`.
- Do not emit \`resultReady: false\`; omit \`resultReady\` until it is true.
- Do not include helper fields in the final business answer unless you are still iterating.

### Runtime-specific usage notes
- State is session-scoped: \`var\` declarations persist across calls (sloppy-mode eval). Prefer \`var\` over \`let\`/\`const\` for cross-call variables.
- Bare assignment (e.g. \`x = 1\`) also persists via \`globalThis\`.
- Stdout mode is enabled: \`console.log(...)\` and \`print(...)\` output is captured as the execution result.
- Use \`console.log(...)\` to inspect intermediate values between steps.`;

  return baseDefinition ? `${rlmPrompt}\n\n${baseDefinition}` : rlmPrompt;
}

// ---------------------------------------------------------------------------
// Helpers used by the RLM agent
// ---------------------------------------------------------------------------

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n...[truncated ${s.length - maxChars} chars]`;
}

export function buildContextMetadata(
  contextValues: Record<string, unknown>,
): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(contextValues)) {
    const typeLabel = Array.isArray(value) ? "array" : typeof value;
    let sizeLabel: string;
    if (typeof value === "string") {
      sizeLabel = `${value.length} chars`;
    } else if (Array.isArray(value)) {
      sizeLabel = `${value.length} items`;
    } else if (value && typeof value === "object") {
      sizeLabel = `${Object.keys(value).length} keys`;
    } else {
      sizeLabel = "n/a";
    }
    lines.push(`- ${name}: type=${typeLabel}, size=${sizeLabel}`);
  }
  return lines.join("\n");
}

export function buildRLMTrajectory(
  steps: readonly { code: string; output: string }[],
): string {
  if (steps.length === 0) return "(no interpreter steps captured)";
  return steps
    .map(
      (s, i) => `Step ${i + 1}\nCode:\n${s.code}\nOutput:\n${s.output}`,
    )
    .join("\n\n");
}
