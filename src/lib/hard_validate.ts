import type { GenerateOut, HardValidation } from "./types.ts";

function bulletLines(s: string): string[] {
  return s
    .split(/\r?\n/g)
    .map((l) => l.trimEnd())
    .filter((l) => /^[-*]\s+/.test(l.trimStart()));
}

export function hardValidate(
  out: GenerateOut,
  doc: string,
): HardValidation {
  const issues: string[] = [];

  const bullets = bulletLines(out.answer);
  if (bullets.length < 3 || bullets.length > 7) {
    issues.push(
      `answer must contain 3–7 bullet lines starting with "- " (found ${bullets.length}).`,
    );
  }

  const ev = Array.isArray(out.evidence) ? out.evidence : [];
  if (ev.length < 3 || ev.length > 8) {
    issues.push(`evidence must contain 3–8 quotes (found ${ev.length}).`);
  }

  const seen = new Set<string>();
  for (const [i, q] of ev.entries()) {
    const quote = (q ?? "").trim();
    if (quote.length === 0) {
      issues.push(`evidence[${i}] is empty.`);
      continue;
    }
    if (quote.length > 160) {
      issues.push(`evidence[${i}] is too long (${quote.length} chars); keep quotes short.`);
    }
    if (seen.has(quote)) {
      issues.push(`evidence[${i}] is a duplicate quote.`);
    }
    seen.add(quote);
    if (!doc.includes(quote)) {
      issues.push(`evidence[${i}] is not a verbatim substring of the document.`);
    }
  }

  const text = out.answer.toLowerCase();
  if (!text.includes("ralph") || !text.includes("rlm")) {
    issues.push(`answer must mention both "Ralph" and "RLM".`);
  }

  return { ok: issues.length === 0, issues };
}

export function buildEvidenceContexts(doc: string, evidence: string[]): string[] {
  const ctx: string[] = [];
  for (const q of evidence) {
    const quote = (q ?? "").trim();
    const idx = doc.indexOf(quote);
    if (idx < 0) {
      ctx.push(`(missing quote) ${quote}`);
      continue;
    }
    const start = Math.max(0, idx - 220);
    const end = Math.min(doc.length, idx + quote.length + 220);
    ctx.push(doc.slice(start, end));
  }
  return ctx;
}
