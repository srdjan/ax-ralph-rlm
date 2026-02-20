import type { HardValidation, TaskOut } from "./types.ts";

const MIN_OUTPUT_CHARS = 50;
const MIN_MEMORY_UPDATE_CHARS = 20;

export function taskHardValidate(
  brief: string,
  out: TaskOut,
): HardValidation {
  const issues: string[] = [];

  if (brief.trim().length === 0) {
    issues.push("DocReader returned empty brief.");
  }

  if (out.output.trim().length === 0) {
    issues.push("output is empty.");
  } else if (out.output.trim().length < MIN_OUTPUT_CHARS) {
    issues.push(
      `output is too short (${out.output.trim().length} chars, minimum ${MIN_OUTPUT_CHARS}).`,
    );
  }

  if (out.memoryUpdate.trim().length === 0) {
    issues.push("memoryUpdate is empty.");
  } else if (out.memoryUpdate.trim().length < MIN_MEMORY_UPDATE_CHARS) {
    issues.push(
      `memoryUpdate is too short (${out.memoryUpdate.trim().length} chars, minimum ${MIN_MEMORY_UPDATE_CHARS}).`,
    );
  }

  return { ok: issues.length === 0, issues };
}
