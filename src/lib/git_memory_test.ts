import { assertEquals, assertMatch } from "@std/assert";
import {
  makeSessionId,
  querySessionTraces,
  storeIterTrace,
} from "./git_memory.ts";
import type { IterTrace } from "./types.ts";

function makeTrace(iter: number, answer = "- sample bullet"): IterTrace {
  return {
    iter,
    query: "What is Ralph loop?",
    constraints: "answer must be bullets",
    generated: {
      answer,
      evidence: ["evidence quote"],
    },
    hard: {
      ok: true,
      issues: [],
    },
    evidenceContext: ["context snippet"],
    judge: {
      ok: "yes",
      issues: [],
    },
    passed: true,
  };
}

async function writeIterFile(
  outDir: string,
  trace: IterTrace,
): Promise<string> {
  const path = `${outDir}/iter-${String(trace.iter).padStart(2, "0")}.json`;
  await Deno.writeTextFile(path, JSON.stringify(trace, null, 2));
  return path;
}

Deno.test("makeSessionId returns expected format", () => {
  const sessionId = makeSessionId("What is Ralph loop?");
  assertMatch(sessionId, /^\d{4}-\d{2}-\d{2}\/ralph-[a-f0-9]{8}$/);
});

Deno.test("storeIterTrace archives trace and querySessionTraces returns it", async () => {
  const root = await Deno.makeTempDir();
  const outDir = `${root}/out`;
  await Deno.mkdir(outDir, { recursive: true });

  const sessionId = "2026-02-19/ralph-deadbeef";
  const trace = makeTrace(1);
  const tracePath = await writeIterFile(outDir, trace);

  const result = await storeIterTrace(trace, tracePath, sessionId);
  assertEquals(result.ok, true);

  const traces = await querySessionTraces(sessionId, outDir);
  assertEquals(traces.length, 1);
  assertEquals(traces[0].iter, 1);
  assertEquals(traces[0].generated.answer, "- sample bullet");
});

Deno.test("querySessionTraces returns sorted traces and supports iter upsert", async () => {
  const root = await Deno.makeTempDir();
  const outDir = `${root}/out`;
  await Deno.mkdir(outDir, { recursive: true });

  const sessionId = "2026-02-19/ralph-c0ffee00";

  const trace2 = makeTrace(2, "- iter 2");
  const trace2Path = await writeIterFile(outDir, trace2);
  await storeIterTrace(trace2, trace2Path, sessionId);

  const trace1 = makeTrace(1, "- iter 1 old");
  const trace1Path = await writeIterFile(outDir, trace1);
  await storeIterTrace(trace1, trace1Path, sessionId);

  const trace1Updated = makeTrace(1, "- iter 1 new");
  const trace1UpdatedPath = await writeIterFile(outDir, trace1Updated);
  await storeIterTrace(trace1Updated, trace1UpdatedPath, sessionId);

  const traces = await querySessionTraces(sessionId, outDir);
  assertEquals(traces.map((t) => t.iter), [1, 2]);
  assertEquals(traces[0].generated.answer, "- iter 1 new");

  const indexRaw = await Deno.readTextFile(`${outDir}/session-index.json`);
  const index = JSON.parse(indexRaw) as {
    sessions: Record<string, { iterations: Array<{ iter: number }> }>;
  };
  const iter1Entries = index.sessions[sessionId].iterations.filter((i) =>
    i.iter === 1
  );
  assertEquals(iter1Entries.length, 1);
});

Deno.test("querySessionTraces skips missing archived files", async () => {
  const root = await Deno.makeTempDir();
  const outDir = `${root}/out`;
  await Deno.mkdir(outDir, { recursive: true });

  const sessionId = "2026-02-19/ralph-feedf00d";
  const trace = makeTrace(1, "- iter 1");
  const tracePath = await writeIterFile(outDir, trace);
  await storeIterTrace(trace, tracePath, sessionId);

  const indexRaw = await Deno.readTextFile(`${outDir}/session-index.json`);
  const index = JSON.parse(indexRaw) as {
    sessions: Record<string, { iterations: Array<{ tracePath: string }> }>;
  };
  const archivedPath = index.sessions[sessionId].iterations[0].tracePath;
  await Deno.remove(archivedPath);

  const traces = await querySessionTraces(sessionId, outDir);
  assertEquals(traces.length, 0);
});
