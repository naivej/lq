/** Host-aware filesystem path compare for the LyX Preview extension. */

export function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when `a` and `b` name the same file path on this host. */
export function sameFsPath(a: string, b: string): boolean {
  const na = normalizeFsPath(a);
  const nb = normalizeFsPath(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}
