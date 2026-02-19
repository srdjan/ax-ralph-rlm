import type { IterTrace } from "./types.ts";

export type CommitResult =
  | { ok: true; hash: string }
  | { ok: false; error: string };

type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

const BODY_WRAP = 72;

function currentLocalDateString(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function wrapText(
  text: string,
  width: number,
  firstPrefix = "",
  nextPrefix = firstPrefix,
): string[] {
  const words = normalizeWhitespace(text).split(" ").filter(Boolean);
  if (words.length === 0) return [firstPrefix.trimEnd()];

  const lines: string[] = [];
  let line = firstPrefix;
  let lineLength = firstPrefix.length;

  for (const word of words) {
    const separator = lineLength > firstPrefix.length && line.trim().length > 0
      ? 1
      : 0;

    if (lineLength + separator + word.length <= width) {
      line += `${separator ? " " : ""}${word}`;
      lineLength += separator + word.length;
      continue;
    }

    lines.push(line.trimEnd());
    line = `${nextPrefix}${word}`;
    lineLength = nextPrefix.length + word.length;
  }

  lines.push(line.trimEnd());
  return lines;
}

function countBullets(answer: string): number {
  return answer
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("- ")).length;
}

function buildContextJson(trace: IterTrace): string {
  const judgeOk: "yes" | "no" | null = trace.judge?.ok ?? null;
  const context = {
    iter: trace.iter,
    passed: trace.passed,
    hard_ok: trace.hard.ok,
    judge_ok: judgeOk,
    hard_issues: trace.hard.issues.length,
    judge_issues: trace.judge?.issues.length ?? 0,
    bullet_count: countBullets(trace.generated.answer),
    evidence_count: trace.generated.evidence.length,
  };

  return JSON.stringify(context);
}

function buildCommitMessage(
  trace: IterTrace,
  tracePath: string,
  sessionId: string,
): string {
  const iterLabel = `iter-${String(trace.iter).padStart(2, "0")}`;
  const statusLabel = trace.passed ? "passed" : "failed";
  const header = `chore(ralph-loop): ${iterLabel} ${statusLabel}`;

  const bodyLines: string[] = [];
  const queryPreview = normalizeWhitespace(trace.query).slice(0, 100);
  bodyLines.push(...wrapText(`Query: ${queryPreview}`, BODY_WRAP));
  bodyLines.push("");

  if (trace.passed) {
    bodyLines.push("All validations passed.");
  } else {
    const hardIssues = trace.hard.issues.map((issue) =>
      `HARD: ${normalizeWhitespace(issue)}`
    );
    const judgeIssues = (trace.judge?.issues ?? []).map((issue) =>
      `JUDGE: ${normalizeWhitespace(issue)}`
    );
    const allIssues = [...hardIssues, ...judgeIssues];

    bodyLines.push(
      ...wrapText(
        `Validation failed with ${allIssues.length} issue(s):`,
        BODY_WRAP,
      ),
    );

    for (const issue of allIssues) {
      bodyLines.push(...wrapText(issue, BODY_WRAP, "  - ", "    "));
    }
  }

  const trailerLines = [
    "Intent: explore",
    "Scope: ralph-loop/iteration",
    `Session: ${sessionId}`,
    `Refs: ${tracePath}`,
    `Context: ${buildContextJson(trace)}`,
  ];

  return [header, "", ...bodyLines, "", ...trailerLines].join("\n");
}

async function runGit(args: string[]): Promise<GitResult> {
  try {
    const output = await new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();

    const stdout = new TextDecoder().decode(output.stdout).trim();
    const stderr = new TextDecoder().decode(output.stderr).trim();

    return {
      ok: output.success,
      stdout,
      stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout: "",
      stderr: message,
    };
  }
}

export function makeSessionId(query: string): string {
  const date = currentLocalDateString();
  const hash = djb2Hex(query);
  return `${date}/ralph-${hash}`;
}

export async function commitIterTrace(
  trace: IterTrace,
  tracePath: string,
  sessionId: string,
): Promise<CommitResult> {
  const addResult = await runGit(["add", "--", tracePath]);
  if (!addResult.ok) {
    return {
      ok: false,
      error: addResult.stderr || addResult.stdout || "git add failed",
    };
  }

  const message = buildCommitMessage(trace, tracePath, sessionId);
  const commitResult = await runGit([
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ]);

  if (!commitResult.ok) {
    return {
      ok: false,
      error: commitResult.stderr || commitResult.stdout || "git commit failed",
    };
  }

  const hashResult = await runGit(["rev-parse", "--short", "HEAD"]);
  if (!hashResult.ok || !hashResult.stdout) {
    return {
      ok: false,
      error: hashResult.stderr || hashResult.stdout || "git rev-parse failed",
    };
  }

  return {
    ok: true,
    hash: hashResult.stdout,
  };
}

export async function querySessionTraces(
  sessionId: string,
): Promise<IterTrace[]> {
  const hashesResult = await runGit([
    "log",
    "--all",
    "--reverse",
    `--grep=Session: ${sessionId}`,
    "--format=%H",
  ]);

  if (!hashesResult.ok || !hashesResult.stdout) {
    return [];
  }

  const hashes = hashesResult.stdout.split("\n").map((line) => line.trim())
    .filter(
      Boolean,
    );

  const traces: IterTrace[] = [];

  for (const hash of hashes) {
    const refsResult = await runGit([
      "log",
      "-1",
      "--format=%(trailers:key=Refs,valueonly)",
      hash,
    ]);

    if (!refsResult.ok || !refsResult.stdout) {
      continue;
    }

    const refPath = refsResult.stdout.split("\n").map((line) => line.trim())
      .find(
        Boolean,
      );
    if (!refPath) {
      continue;
    }

    try {
      const raw = await Deno.readTextFile(refPath);
      const parsed = JSON.parse(raw) as IterTrace;
      traces.push(parsed);
    } catch {
      // Skip unreadable or malformed traces and continue assembling history.
      continue;
    }
  }

  return traces;
}
