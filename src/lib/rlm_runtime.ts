// Host-side sandbox management using Deno Workers.
//
// Spawns a Worker from rlm_worker_script.ts, manages the message protocol
// for code execution and async function proxying.

export type RuntimeSession = {
  execute(
    code: string,
    options?: { reservedNames?: readonly string[] },
  ): Promise<string>;
  close(): void;
};

type PendingExecution = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export function createSandboxSession(
  globals: Record<string, unknown>,
  fnProxies: Record<string, (...args: unknown[]) => Promise<unknown>>,
  options?: { timeout?: number },
): RuntimeSession {
  const timeout = options?.timeout ?? 30_000;
  let execId = 0;
  let closed = false;
  const pending = new Map<number, PendingExecution>();

  // Spawn the worker
  const workerUrl = new URL("./rlm_worker_script.ts", import.meta.url);
  const worker = new Worker(workerUrl.href, {
    type: "module",
    // @ts-ignore Deno-specific
    deno: { permissions: { net: true } },
  });

  // Handle messages from the worker
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;

    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error !== undefined) {
          p.reject(new Error(String(msg.error)));
        } else {
          p.resolve(msg.value);
        }
      }
      return;
    }

    if (msg.type === "fn-call") {
      const fn = fnProxies[msg.name];
      if (!fn) {
        worker.postMessage({
          type: "fn-result",
          id: msg.id,
          error: `Function "${msg.name}" not found`,
        });
        return;
      }

      const args = Array.isArray(msg.args) ? msg.args : [];
      Promise.resolve()
        .then(() => fn(...args))
        .then((value) => {
          if (!closed) {
            worker.postMessage({ type: "fn-result", id: msg.id, value });
          }
        })
        .catch((err: unknown) => {
          if (!closed) {
            const message = err instanceof Error ? err.message : String(err);
            worker.postMessage({
              type: "fn-result",
              id: msg.id,
              error: message,
            });
          }
        });
    }
  };

  worker.onerror = (err) => {
    // Reject all pending executions
    for (const p of pending.values()) {
      p.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    pending.clear();
  };

  // Extract serializable globals (strings, numbers, booleans, arrays, plain objects)
  const serializableGlobals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(globals)) {
    if (typeof v === "function") continue;
    serializableGlobals[k] = v;
  }

  // Send init message
  worker.postMessage({
    type: "init",
    globals: serializableGlobals,
    fnNames: Object.keys(fnProxies),
  });

  function terminate() {
    closed = true;
    worker.terminate();
    for (const p of pending.values()) {
      p.reject(new Error("Worker terminated"));
    }
    pending.clear();
  }

  return {
    execute(code, opts) {
      if (closed) return Promise.reject(new Error("Session is closed"));

      // Check for reserved name reassignment
      if (opts?.reservedNames) {
        for (const name of opts.reservedNames) {
          const pattern = new RegExp(
            `(?:^|[;\\n])\\s*(?:(?:var|let|const)\\s+)?${name}\\s*=`,
          );
          if (pattern.test(code)) {
            return Promise.resolve(
              `[ERROR] Cannot reassign reserved variable '${name}'. Use a different variable name.`,
            );
          }
        }
      }

      // Check for "use strict"
      if (/['"]use strict['"]/.test(code)) {
        return Promise.resolve(
          '[ERROR] "use strict" is not allowed in the runtime session. Remove it and try again.',
        );
      }

      const id = ++execId;

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          terminate();
          reject(new Error("Execution timed out"));
        }, timeout);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(formatValue(value));
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });

        worker.postMessage({ type: "execute", id, code });
      });
    },

    close() {
      terminate();
    },
  };
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(no output)";
  if (typeof value === "string") return value || "(no output)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
