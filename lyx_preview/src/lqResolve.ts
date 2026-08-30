import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Development preference: binaries from `deno task build` in the lq repo.
 * Unmanaged (no GitHub download) — DL155 §4.2.
 */
export const DEV_LQ_BIN_DIR = join(homedir(), "Github", "lq_dev", "lq", "bin");

export type LqResolveResult =
  | { kind: "dev"; path: string }
  | { kind: "managed"; path: string }
  | { kind: "unset" };

/** Newest `lq*` entry (not a .map) inside `dir`, if any. */
export function findLqInDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let newest: { full: string; mtimeMs: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!/^lq/i.test(name) || name.endsWith(".map")) continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { full, mtimeMs: stat.mtimeMs };
    }
  }
  return newest?.full;
}

/**
 * Resolve which lq binary to use (DL155):
 * 1. Dev `lq/bin` if present (unmanaged)
 * 2. Else `lqPath` setting if set (managed)
 * 3. Else unset — no PATH fallback
 */
export function resolveLqBinary(
  lqPathSetting: string | undefined,
  devBinDir: string = DEV_LQ_BIN_DIR,
): LqResolveResult {
  const devBinary = findLqInDir(devBinDir);
  if (devBinary) return { kind: "dev", path: devBinary };
  const configured = lqPathSetting?.trim();
  if (configured) return { kind: "managed", path: configured };
  return { kind: "unset" };
}
