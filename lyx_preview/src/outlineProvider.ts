/** Outline + navigate cache shared by Live preview and Explorer LyX Navigate tree. */

import type { LiveNavigate, LiveOutlineEntry } from "./previewSession";
import { emptyNavigate } from "./previewSession";

interface CachedNav {
  outline: LiveOutlineEntry[];
  navigate: LiveNavigate;
}

const cacheByPath = new Map<string, CachedNav>();

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
  if (direct) return direct;
  for (const [p, entries] of cacheByPath) {
    if (sameFsPath(p, filePath)) return entries;
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
}

export function getCachedOutline(filePath: string): LiveOutlineEntry[] | undefined {
  return lookup(filePath)?.outline;
}

export function getCachedNavigate(filePath: string): LiveNavigate | undefined {
  return lookup(filePath)?.navigate;
}

export function forgetOutline(filePath: string): void {
  cacheByPath.delete(normalizeFsPath(filePath));
}
