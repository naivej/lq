import * as path from "@std/path";

export type StateScope = "local" | "global";

export interface StatePaths {
  scope: StateScope;
  root: string;
  config: string;
  cache: string;
  undo: string;
}

interface Environment {
  get(name: string): string | undefined;
}

/** Return the user's home directory using a path format native to the host OS. */
export function getUserHomeDir(
  env: Environment = Deno.env,
): string | null {
  const home = env.get("HOME");
  const userProfile = env.get("USERPROFILE");

  if (Deno.build.os !== "windows") return home || userProfile || null;

  // Git Bash exports HOME as /c/Users/name. @std/path treats that as a
  // rooted path on the current drive (\\c\\Users\\name), not C:\\Users\\name.
  const msysHome = home?.match(/^\/([A-Za-z])(?:\/(.*))?$/);
  if (msysHome) {
    const rest = msysHome[2] ? `\\${msysHome[2].replaceAll("/", "\\")}` : "\\";
    return `${msysHome[1].toUpperCase()}:${rest}`;
  }

  // Prefer an explicitly native HOME override, then Windows' canonical
  // profile variable. A non-drive HOME value is not a usable Windows path.
  if (home && /^[A-Za-z]:[\\/]/.test(home)) return home;
  return userProfile || home || null;
}

function createStatePaths(scope: StateScope, root: string): StatePaths {
  return {
    scope,
    root,
    config: path.join(root, "config.json"),
    cache: path.join(root, "cache"),
    undo: path.join(root, "undo"),
  };
}

function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return Deno.build.os === "windows"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function getCanonicalWindowsHomeDir(env: Environment): string | null {
  if (Deno.build.os !== "windows") return null;
  const drive = env.get("HOMEDRIVE");
  const homePath = env.get("HOMEPATH");
  return drive && homePath ? `${drive}${homePath}` : null;
}

/** Find the nearest local `.lq` directory without creating one. */
export async function findLocalStateRoot(
  cwd: string = Deno.cwd(),
  env: Environment = Deno.env,
): Promise<string | null> {
  let current = path.resolve(cwd);
  const globalHomes = [getUserHomeDir(env), getUserHomeDir(), getCanonicalWindowsHomeDir(Deno.env)]
    .filter((home): home is string => home !== null);
  while (true) {
    const root = path.join(current, ".lq");
    if (!globalHomes.some(home => isSamePath(current, home))) {
      try {
        const stat = await Deno.stat(root);
        if (stat.isDirectory) return root;
      } catch { /* continue toward the filesystem root */ }
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolve the global state root, or null when no home directory is available. */
export function getGlobalStatePaths(env: Environment = Deno.env): StatePaths | null {
  const homeDir = getUserHomeDir(env);
  return homeDir ? createStatePaths("global", path.join(homeDir, ".lq")) : null;
}

/** Resolve the ordinary local-or-global state scope for one invocation. */
export async function resolveStatePaths(
  cwd: string = Deno.cwd(),
  env: Environment = Deno.env,
): Promise<StatePaths | null> {
  const localRoot = await findLocalStateRoot(cwd, env);
  if (localRoot) return createStatePaths("local", localRoot);
  return getGlobalStatePaths(env);
}

/** Resolve the target for init; local init creates its marker only after this returns. */
export async function resolveInitStatePaths(
  useGlobal: boolean,
  cwd: string = Deno.cwd(),
  env: Environment = Deno.env,
): Promise<StatePaths | null> {
  if (useGlobal) return getGlobalStatePaths(env);
  const localRoot = await findLocalStateRoot(cwd, env);
  const root = localRoot ?? path.join(path.resolve(cwd), ".lq");
  return createStatePaths("local", root);
}
