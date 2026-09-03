import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LqResolveResult =
  | { kind: "unmanaged"; path: string }
  | { kind: "managed"; path: string }
  | { kind: "unset" };

export type LqResolveDeps = {
  home?: string;
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
};

function defaultIsFile(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ?? false;
}

/** Expand a leading `~/` or `~\\` to `home`. Other paths are unchanged. */
export function expandUserPath(input: string, home: string = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Unmanaged spawn candidate (DL035): empty/missing → undefined.
 * Windows: if `path` is missing, try `path.exe` (unless already `.exe`).
 */
export function resolveUnmanagedFile(
  unmanagedSetting: string | undefined,
  deps: LqResolveDeps = {},
): string | undefined {
  const raw = unmanagedSetting?.trim();
  if (!raw) return undefined;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const isFile = deps.isFile ?? defaultIsFile;
  const expanded = expandUserPath(raw, home);
  if (isFile(expanded)) return expanded;
  if (platform === "win32" && !/\.exe$/i.test(expanded)) {
    const withExe = `${expanded}.exe`;
    if (isFile(withExe)) return withExe;
  }
  return undefined;
}

/**
 * Resolve which lq binary to spawn (DL035 / DL034):
 * 1. Unmanaged file if the setting is non-empty and the file exists
 * 2. Else `lqPath` setting if set
 * 3. Else unset — no PATH fallback
 *
 * Management of `lqPath` is independent: when the setting is non-empty,
 * the extension still hash-checks / downloads that file (DL034).
 */
export function resolveLqBinary(
  lqPathSetting: string | undefined,
  unmanagedSetting: string | undefined,
  deps: LqResolveDeps = {},
): LqResolveResult {
  const unmanaged = resolveUnmanagedFile(unmanagedSetting, deps);
  if (unmanaged) return { kind: "unmanaged", path: unmanaged };
  const configured = lqPathSetting?.trim();
  if (configured) return { kind: "managed", path: configured };
  return { kind: "unset" };
}

/** Non-empty `lqPath` is the managed download target (even when spawn is unmanaged). */
export function managedEnsureTarget(lqPathSetting: string | undefined): string | undefined {
  const configured = lqPathSetting?.trim();
  return configured || undefined;
}

/**
 * Home-relative display path for the unmanaged-loaded toast (strip `.exe`; use `~/…`).
 * Example: `~/Github/lq_dev/lq/target/release/lq is detected and loaded`
 */
export function formatUnmanagedLqLoadedMessage(
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
