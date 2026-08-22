import { DocumentNode } from "./ast.ts";
import { StatePaths } from "./paths.ts";
import * as path from "@std/path";

let maxCacheEntries = 50;

/** Set the maximum number of cached CST entries (default 50). */
export function setMaxCacheEntries(n: number): void {
  if (n >= 0) maxCacheEntries = n;
}

/** Compute SHA-256 hash of a file's content. */
export async function hashFile(filePath: string): Promise<string> {
  const data = await Deno.readFile(filePath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute SHA-256 hash of a string (for write-through, avoids re-reading). */
export async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCachePath(hash: string, statePaths: StatePaths): string {
  return path.join(statePaths.cache, hash + ".cst");
}

/** Try to load a cached CST for the given file. Returns null on miss, error, or cache disabled. */
export async function getCachedAst(
  filePath: string,
  statePaths: StatePaths,
  contentHash?: string,
): Promise<DocumentNode | null> {
  if (maxCacheEntries === 0) return null;
  try {
    // The cache key is the file-content hash, so a real external modification
    // always misses (different hash → different file). Staleness guards are
    // unnecessary by construction (dev log 81).
    const hash = contentHash ?? await hashFile(filePath);
    const cachePath = getCachePath(hash, statePaths);
    const json = await Deno.readTextFile(cachePath);
    const ast = JSON.parse(json) as DocumentNode;
    // Validate the shape — old {mtime, ast} envelope files fail this and
    // degrade to a re-parse, which then rewrites them in the plain format.
    if (!ast || ast.type !== "document" || !Array.isArray(ast.children)) return null;
    return ast;
  } catch {
    return null; // Any failure (missing, corrupt, permissions) → cache miss
  }
}

/** Store a CST in the cache under the given content hash. No-op when cache is disabled. */
export async function setCachedAst(hash: string, ast: DocumentNode, statePaths: StatePaths): Promise<void> {
  if (maxCacheEntries === 0) return;
  try {
    const cachePath = getCachePath(hash, statePaths);

    // Ensure cache directory exists
    const dir = statePaths.cache;
    await Deno.mkdir(dir, { recursive: true });

    // Atomic write: temp file + rename
    const tmpPath = cachePath + ".tmp";
    await Deno.writeTextFile(tmpPath, JSON.stringify(ast));
    await Deno.rename(tmpPath, cachePath);

    // Prune old entries if over limit
    await pruneCache(dir);
  } catch {
    // Cache failures are non-fatal
  }
}

/** Remove least recently accessed cache entries if over the limit. */
async function pruneCache(dir: string): Promise<void> {
  try {
    const entries: { name: string; atime: number | null }[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".cst")) {
        try {
          const stat = await Deno.stat(path.join(dir, entry.name));
          entries.push({ name: entry.name, atime: stat.atime?.getTime() ?? null });
        } catch {
          entries.push({ name: entry.name, atime: null });
        }
      }
    }
    if (entries.length <= maxCacheEntries) return;

    // Sort by access time (oldest first), delete excess
    entries.sort((a, b) => (a.atime ?? 0) - (b.atime ?? 0));
    const toDelete = entries.slice(0, entries.length - maxCacheEntries);
    for (const entry of toDelete) {
      try {
        await Deno.remove(path.join(dir, entry.name));
      } catch { /* ignore */ }
    }
  } catch {
    // Pruning failures are non-fatal
  }
}
