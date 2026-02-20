/**
 * Memory budget in characters. The RLM runtime caps contextFields at
 * maxRuntimeChars (2000). We leave headroom for the doc field by keeping
 * memory well under that ceiling. When memory exceeds this budget,
 * the oldest blocks are dropped and a "[trimmed]" marker is prepended.
 */
const MEMORY_BUDGET_CHARS = 1500;

export async function readMemory(memPath: string): Promise<string> {
  try {
    return await Deno.readTextFile(memPath);
  } catch (err: unknown) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

/**
 * Split memory into blocks delimited by `## Iter` headers.
 * Returns blocks in document order (oldest first).
 */
function splitMemoryBlocks(content: string): string[] {
  const parts = content.split(/(?=\n## Iter )/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Trim memory to fit within MEMORY_BUDGET_CHARS by dropping the oldest
 * blocks first. Returns the trimmed content. If nothing was dropped,
 * returns the original content unchanged.
 */
export function trimMemory(content: string): {
  trimmed: string;
  blocksDropped: number;
} {
  if (content.length <= MEMORY_BUDGET_CHARS) {
    return { trimmed: content, blocksDropped: 0 };
  }

  const blocks = splitMemoryBlocks(content);
  let dropped = 0;
  const prefixReserve = 30; // room for "[trimmed N blocks]\n\n"

  // Drop oldest blocks (front of array) until remaining fits
  while (blocks.length > 1) {
    blocks.shift();
    dropped++;
    const joined = blocks.join("\n\n");
    if (joined.length <= MEMORY_BUDGET_CHARS - prefixReserve) break;
  }

  if (dropped === 0) {
    return { trimmed: content, blocksDropped: 0 };
  }

  const prefix = `[trimmed ${dropped} older block${
    dropped > 1 ? "s" : ""
  }]\n\n`;
  return { trimmed: prefix + blocks.join("\n\n"), blocksDropped: dropped };
}

export async function appendToMemory(
  memPath: string,
  update: string,
  iter: number,
): Promise<void> {
  const dir = memPath.replaceAll("\\", "/");
  const lastSlash = dir.lastIndexOf("/");
  if (lastSlash > 0) {
    await Deno.mkdir(dir.slice(0, lastSlash), { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const block = `\n\n## Iter ${iter} - ${timestamp}\n\n${update.trim()}`;

  // Read existing content, append, then trim if over budget
  let existing = "";
  try {
    existing = await Deno.readTextFile(memPath);
  } catch (err: unknown) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const combined = existing + block;
  const { trimmed, blocksDropped } = trimMemory(combined);

  if (blocksDropped > 0) {
    console.error(
      `[Memory] Trimmed ${blocksDropped} older block${
        blocksDropped > 1 ? "s" : ""
      } to stay within ${MEMORY_BUDGET_CHARS}-char budget (was ${combined.length} chars).`,
    );
    // Rewrite the file with trimmed content
    await Deno.writeTextFile(memPath, trimmed);
  } else {
    // Just append as before
    await Deno.writeTextFile(memPath, block, { append: true });
  }
}
