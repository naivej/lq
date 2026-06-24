import { DocumentNode } from "./ast.ts";
import * as path from "@std/path";

const MAX_CACHE_ENTRIES = 50;

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

function getCacheDir(): string | null {
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) return null;
  return path.join(homeDir, ".lq", "cache");
}

function getCachePath(hash: string): string | null {
  const dir = getCacheDir();
  if (!dir) return null;
  return path.join(dir, hash + ".cst");
}

/** Try to load a cached CST for the given file. Returns null on miss or error. */
export async function getCachedAst(filePath: string): Promise<DocumentNode | null> {
  try {
    const hash = await hashFile(filePath);
    const cachePath = getCachePath(hash);
    if (!cachePath) return null;
    const json = await Deno.readTextFile(cachePath);
    return JSON.parse(json) as DocumentNode;
  } catch {
    return null; // Any failure (missing, corrupt, permissions) → cache miss
  }
}

/** Store a CST in the cache under the given content hash. */
export async function setCachedAst(hash: string, ast: DocumentNode): Promise<void> {
  try {
    const cachePath = getCachePath(hash);
    if (!cachePath) return;

    // Ensure cache directory exists
    const dir = getCacheDir()!;
    await Deno.mkdir(dir, { recursive: true });

    // Atomic write: temp file + rename
    const tmpPath = cachePath + ".tmp";
    const json = JSON.stringify(ast);
    await Deno.writeTextFile(tmpPath, json);
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
    if (entries.length <= MAX_CACHE_ENTRIES) return;

    // Sort by access time (oldest first), delete excess
    entries.sort((a, b) => (a.atime ?? 0) - (b.atime ?? 0));
    const toDelete = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
    for (const entry of toDelete) {
      try {
        await Deno.remove(path.join(dir, entry.name));
      } catch { /* ignore */ }
    }
  } catch {
    // Pruning failures are non-fatal
  }
}
