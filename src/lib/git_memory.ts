import type { IterTrace } from "./types.ts";

export type StoreResult =
  | { ok: true }
  | { ok: false; error: string };

type SessionIteration = {
  iter: number;
  tracePath: string;
  sourcePath: string;
  storedAt: string;
};

type SessionRecord = {
  createdAt: string;
  updatedAt: string;
  iterations: SessionIteration[];
};

type SessionIndex = {
  version: 1;
  sessions: Record<string, SessionRecord>;
};

const INDEX_FILE_NAME = "session-index.json";

function currentLocalDateString(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function dirname(path: string): string {
  const normalized = toPosixPath(path);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return idx === 0 ? "/" : ".";
  }
  return normalized.slice(0, idx);
}

function makeEmptyIndex(): SessionIndex {
  return {
    version: 1,
    sessions: {},
  };
}

async function readIndex(outDir: string): Promise<SessionIndex> {
  const indexPath = `${outDir}/${INDEX_FILE_NAME}`;

  try {
    const raw = await Deno.readTextFile(indexPath);
    const parsed = JSON.parse(raw) as Partial<SessionIndex>;

    if (
      parsed.version !== 1 || typeof parsed.sessions !== "object" ||
      !parsed.sessions
    ) {
      return makeEmptyIndex();
    }

    return {
      version: 1,
      sessions: parsed.sessions,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return makeEmptyIndex();
    }

    throw error;
  }
}

async function writeIndexAtomic(
  outDir: string,
  index: SessionIndex,
): Promise<void> {
  const indexPath = `${outDir}/${INDEX_FILE_NAME}`;
  const tmpPath = `${indexPath}.tmp`;

  await Deno.writeTextFile(tmpPath, JSON.stringify(index, null, 2));
  await Deno.rename(tmpPath, indexPath);
}

function archivePathFor(
  tracePath: string,
  sessionId: string,
  iter: number,
): string {
  const outDir = dirname(tracePath);
  const iterName = `iter-${String(iter).padStart(2, "0")}.json`;
  return `${outDir}/sessions/${sessionId}/${iterName}`;
}

export function makeSessionId(query: string): string {
  const date = currentLocalDateString();
  const hash = djb2Hex(query);
  return `${date}/ralph-${hash}`;
}

export async function storeIterTrace(
  trace: IterTrace,
  tracePath: string,
  sessionId: string,
): Promise<StoreResult> {
  try {
    const outDir = dirname(tracePath);
    const archivePath = archivePathFor(tracePath, sessionId, trace.iter);

    await Deno.mkdir(dirname(archivePath), { recursive: true });
    await Deno.copyFile(tracePath, archivePath);

    const index = await readIndex(outDir);
    const now = new Date().toISOString();

    const existingSession = index.sessions[sessionId];
    const session: SessionRecord = existingSession
      ? {
        ...existingSession,
        iterations: [...existingSession.iterations],
      }
      : {
        createdAt: now,
        updatedAt: now,
        iterations: [],
      };

    const nextEntry: SessionIteration = {
      iter: trace.iter,
      tracePath: toPosixPath(archivePath),
      sourcePath: toPosixPath(tracePath),
      storedAt: now,
    };

    const otherIters = session.iterations.filter((entry) =>
      entry.iter !== trace.iter
    );
    session.iterations = [...otherIters, nextEntry].sort((a, b) =>
      a.iter - b.iter
    );
    session.updatedAt = now;

    index.sessions[sessionId] = session;

    await writeIndexAtomic(outDir, index);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function querySessionTraces(
  sessionId: string,
  outDir = "out",
): Promise<IterTrace[]> {
  try {
    const index = await readIndex(outDir);
    const session = index.sessions[sessionId];
    if (!session) {
      return [];
    }

    const traces: IterTrace[] = [];
    const ordered = [...session.iterations].sort((a, b) => a.iter - b.iter);

    for (const item of ordered) {
      try {
        const raw = await Deno.readTextFile(item.tracePath);
        const parsed = JSON.parse(raw) as IterTrace;
        traces.push(parsed);
      } catch {
        // Skip missing or malformed files so the rest of the session remains queryable.
        continue;
      }
    }

    return traces;
  } catch {
    return [];
  }
}
