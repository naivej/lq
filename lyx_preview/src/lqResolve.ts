import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Development preference: Cargo release binary in the lq repo.
 * Unmanaged (no GitHub download) — DL155 §4.2, 0.8.0 Rust CLI.
 */
export const DEV_LQ_BIN_DIR = join(
  homedir(),
  "Github",
  "lq_dev",
  "lq",
  "target",
  "release",
);

export type LqResolveResult =
  | { kind: "dev"; path: string }
  | { kind: "managed"; path: string }
  | { kind: "unset" };

const CARGO_JUNK = /\.(d|pdb|rlib|rmeta|map)$/i;

/** Cargo `lq.exe` / `lq`, else newest `lq*` that is not a build sidecar. */
export function findLqInDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of ["lq.exe", "lq"]) {
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (stat?.isFile()) return full;
  }
  let newest: { full: string; mtimeMs: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!/^lq/i.test(name) || CARGO_JUNK.test(name)) continue;
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
 * 1. Dev `lq/target/release` Cargo binary if present (unmanaged)
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
