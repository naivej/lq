/** Outline + navigate cache shared by Live preview and Explorer LyX Navigate tree. */

import type { LiveNavigate, LiveOutlineEntry } from "./previewSession";
import { emptyNavigate } from "./previewSession";

interface CachedNav {
  outline: LiveOutlineEntry[];
  navigate: LiveNavigate;
}

const cacheByPath = new Map<string, CachedNav>();

/** Bound on the module-level outline cache (DL132 P7). */
const MAX_CACHE_ENTRIES = 32;

function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function sameFsPath(a: string, b: string): boolean {
  const na = normalizeFsPath(a);
  const nb = normalizeFsPath(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function lookup(filePath: string): CachedNav | undefined {
  const key = normalizeFsPath(filePath);
  const direct = cacheByPath.get(key);
  if (direct) {
    // LRU touch: re-insert so eviction drops the least recently used path.
    cacheByPath.delete(key);
    cacheByPath.set(key, direct);
    return direct;
  }
  for (const [p, entries] of cacheByPath) {
    if (sameFsPath(p, filePath)) {
      cacheByPath.delete(p);
      cacheByPath.set(p, entries);
      return entries;
    }
  }
  return undefined;
}

export function rememberOutline(
  filePath: string,
  outline: LiveOutlineEntry[],
  navigate?: LiveNavigate,
): void {
  const prev = lookup(filePath);
  cacheByPath.set(normalizeFsPath(filePath), {
    outline,
    navigate: navigate ?? prev?.navigate ?? emptyNavigate(),
  });
  while (cacheByPath.size > MAX_CACHE_ENTRIES) {
    const oldest = cacheByPath.keys().next().value;
    if (oldest === undefined) break;
    cacheByPath.delete(oldest);
  }
}

export function getCachedOutline(filePath: string): LiveOutlineEntry[] | undefined {
  return lookup(filePath)?.outline;
}

export function getCachedNavigate(filePath: string): LiveNavigate | undefined {
  return lookup(filePath)?.navigate;
}

export function forgetOutline(filePath: string): void {
  const stale: string[] = [];
  for (const [p] of cacheByPath) {
    if (sameFsPath(p, filePath)) stale.push(p);
  }
  for (const p of stale) cacheByPath.delete(p);
}
