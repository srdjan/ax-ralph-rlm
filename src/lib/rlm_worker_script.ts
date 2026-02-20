// This file is loaded as the source for a Deno Worker.
// It provides a sandboxed JS execution environment with async function proxying.
//
// Protocol:
//   Host -> Worker:
//     { type: "init", globals: Record<string, unknown>, fnNames: string[] }
//     { type: "execute", id: number, code: string }
//     { type: "fn-result", id: number, value?: unknown, error?: string }
//
//   Worker -> Host:
//     { type: "result", id: number, value?: unknown, error?: string }
//     { type: "fn-call", id: number, name: string, args: unknown[] }

const _fnPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let _fnCallId = 0;

function _formatOutputArg(arg: unknown): string {
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;

  if (msg.type === "init") {
    // Create async proxy functions for each named function
    const createFnProxy = (name: string) => (...args: unknown[]) => {
      const id = ++_fnCallId;
      return new Promise((resolve, reject) => {
        _fnPending.set(id, { resolve, reject });
        self.postMessage({ type: "fn-call", id, name, args });
      });
    };

    // Set globals on globalThis (sloppy mode: var persists)
    if (msg.globals && typeof msg.globals === "object") {
      for (const [k, v] of Object.entries(msg.globals)) {
        (globalThis as Record<string, unknown>)[k] = v;
      }
    }

    // Create function proxies
    if (msg.fnNames && Array.isArray(msg.fnNames)) {
      for (const name of msg.fnNames) {
        if (typeof name === "string") {
          (globalThis as Record<string, unknown>)[name] = createFnProxy(name);
        }
      }
    }

    return;
  }

  if (msg.type === "fn-result") {
    const pending = _fnPending.get(msg.id);
    if (pending) {
      _fnPending.delete(msg.id);
      if (msg.error !== undefined) {
        pending.reject(new Error(String(msg.error)));
      } else {
        pending.resolve(msg.value);
      }
    }
    return;
  }

  if (msg.type === "execute") {
    const { id, code } = msg;
    const output: string[] = [];

    // Capture console.log output
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;

    const pushOutput = (...args: unknown[]) => {
      output.push(args.map(_formatOutputArg).join(" "));
    };

    console.log = pushOutput;
    console.info = pushOutput;
    console.warn = pushOutput;
    console.error = pushOutput;

    // Also provide a print function
    (globalThis as Record<string, unknown>).print = pushOutput;

    try {
      let result: unknown;

      if (/\bawait\b/.test(code)) {
        // Async path: wrap in async IIFE
        // Auto-return trailing expression if no explicit return
        let asyncCode = code;
        try {
          asyncCode = injectAsyncAutoReturn(code);
        } catch {
          asyncCode = code;
        }
        const AsyncFunction = Object.getPrototypeOf(
          async function () {},
        ).constructor;
        const fn = new AsyncFunction(asyncCode);
        result = await fn();
      } else {
        // Sync path: sloppy eval so var persists on globalThis
        // Rewrite top-level return to expression
        const syncCode = rewriteTopLevelReturn(code);
        result = (0, eval)(syncCode);
      }

      // In stdout mode: console output takes priority
      const stdout = output.join("\n").trim();
      const value = stdout || result;

      try {
        self.postMessage({ type: "result", id, value });
      } catch {
        // Not structured-cloneable, fall back to string
        self.postMessage({ type: "result", id, value: String(value) });
      }
    } catch (err: unknown) {
      const isCodeError = err instanceof SyntaxError ||
        err instanceof TypeError ||
        err instanceof RangeError ||
        err instanceof ReferenceError ||
        err instanceof EvalError ||
        err instanceof URIError;

      if (isCodeError) {
        const name = err instanceof Error ? err.name : "Error";
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({
          type: "result",
          id,
          value: `${name}: ${message}`,
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: "result", id, error: message });
      }
    } finally {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
      delete (globalThis as Record<string, unknown>).print;
    }
  }
};

// ---------------------------------------------------------------------------
// Code transform helpers
// ---------------------------------------------------------------------------

function injectAsyncAutoReturn(code: string): string {
  // If code already has an explicit return, use it as-is
  if (/(?:^|\n)\s*return\b/.test(code)) return code;
  // Otherwise try to make the last expression a return value
  const lines = code.split("\n");
  const lastIdx = findLastExpressionLine(lines);
  if (lastIdx >= 0) {
    const line = lines[lastIdx].trimStart();
    // Don't auto-return var/let/const declarations, if/for/while, or assignments to known vars
    if (
      !/^(var|let|const|if|for|while|do|switch|try|function|class)\b/.test(line)
    ) {
      lines[lastIdx] = `return (${lines[lastIdx].trim()})`;
    }
  }
  return lines.join("\n");
}

function findLastExpressionLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0 && !trimmed.startsWith("//")) return i;
  }
  return -1;
}

function rewriteTopLevelReturn(code: string): string {
  // Simple rewrite: replace `return <expr>` at top level with just `<expr>`
  return code.replace(/(?:^|\n)\s*return\s+/g, "\n");
}
