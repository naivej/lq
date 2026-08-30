/** Stable GitHub Release asset names (DL155). */
export type LqReleaseAsset =
  | "lq_win64.exe"
  | "lq_win_arm64.exe"
  | "lq_mac64"
  | "lq_mac_arm64"
  | "lq_linux64"
  | "lq_linux_arm64";

export const GITHUB_RELEASES_REPO = "naivej/lq";

/** Map Node platform/arch to the stable Release asset name, if supported. */
export function releaseAssetForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LqReleaseAsset | undefined {
  if (platform === "win32") {
    if (arch === "x64") return "lq_win64.exe";
    if (arch === "arm64") return "lq_win_arm64.exe";
    return undefined;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "lq_mac64";
    if (arch === "arm64") return "lq_mac_arm64";
    return undefined;
  }
  if (platform === "linux") {
    if (arch === "x64") return "lq_linux64";
    if (arch === "arm64") return "lq_linux_arm64";
    return undefined;
  }
  return undefined;
}

/** Latest-release download URL for a named asset. */
export function latestDownloadUrl(asset: string, repo = GITHUB_RELEASES_REPO): string {
  return `https://github.com/${repo}/releases/latest/download/${asset}`;
}
