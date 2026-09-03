import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Development preference: Cargo release binary in the lq repo.
 * Preferred for Live spawn; never overwritten by GitHub download (DL155 §4.2 / DL034).
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
 * Resolve which lq binary to spawn (DL155 / DL034):
 * 1. Dev `lq/target/release` Cargo binary if present
 * 2. Else `lqPath` setting if set
 * 3. Else unset — no PATH fallback
 *
 * Management of `lqPath` is independent: when the setting is non-empty,
 * the extension still hash-checks / downloads that file (DL034).
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

/** Non-empty `lqPath` is the managed download target (even when spawn is `dev`). */
export function managedEnsureTarget(lqPathSetting: string | undefined): string | undefined {
  const configured = lqPathSetting?.trim();
  return configured || undefined;
}

/**
 * Home-relative display path for the dev-loaded toast (strip `.exe`; use `~/…`).
 * Example: `~/Github/lq_dev/lq/target/release/lq is detected and loaded`
 */
export function formatDevLqLoadedMessage(
  absolutePath: string,
  home: string = homedir(),
): string {
  const normPath = absolutePath.replace(/\\/g, "/");
  const normHome = home.replace(/\\/g, "/").replace(/\/$/, "");
  let display = normPath;
  if (normPath.toLowerCase().startsWith(normHome.toLowerCase() + "/")) {
    display = `~/${normPath.slice(normHome.length + 1)}`;
  } else if (normPath.toLowerCase() === normHome.toLowerCase()) {
    display = "~";
  }
  display = display.replace(/\.exe$/i, "");
  return `${display} is detected and loaded`;
}
