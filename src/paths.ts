/** Return the user's home directory using a path format native to the host OS. */
export function getUserHomeDir(
  env: { get(name: string): string | undefined } = Deno.env,
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
