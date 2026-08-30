/**
 * Cross-platform build script for lq.
 *
 * Resolves binary names using git tags (e.g. v0.7.0 -> 0_7_0) or commit SHAs,
 * avoiding reliance on platform-specific shell tools like `sed`.
 *
 * Usage:
 *   deno run -A tools/build.ts           # Native host binary → bin/
 *   deno run -A tools/build.ts --release # All six targets → bin/ + release/ stable names + SHA256SUMS
 */

export function resolveBuildName(): string {
  try {
    const tagCmd = new Deno.Command("git", {
      args: ["describe", "--tags", "--exact-match", "HEAD"],
      stderr: "null",
    }).outputSync();
    if (tagCmd.success) {
      const tag = new TextDecoder().decode(tagCmd.stdout).trim();
      if (tag) {
        return tag.replace(/^v/, "").replaceAll(".", "_");
      }
    }
  } catch {
    // git command not available or failed
  }

  try {
    const revCmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stderr: "null",
    }).outputSync();
    if (revCmd.success) {
      const rev = new TextDecoder().decode(revCmd.stdout).trim();
      if (rev) return rev;
    }
  } catch {
    // git rev-parse failed
  }

  return "dev";
}

/** Host-native suffix for local `deno task build` (not the Release asset name). */
function getHostSuffix(): string {
  if (Deno.build.os === "windows") return "_win.exe";
  if (Deno.build.os === "darwin") return "_mac";
  return "_linux";
}

export interface CompileTarget {
  target: string;
  /** Filename suffix under bin/lq_${buildName}${suffix} */
  suffix: string;
  /** Stable GitHub Release asset name (DL155). */
  releaseName: string;
}

/** Six release targets: x86 + arm for win/mac/linux (DL155). */
export const ALL_TARGETS: CompileTarget[] = [
  { target: "x86_64-pc-windows-msvc", suffix: "_win64.exe", releaseName: "lq_win64.exe" },
  { target: "aarch64-pc-windows-msvc", suffix: "_win_arm64.exe", releaseName: "lq_win_arm64.exe" },
  { target: "x86_64-apple-darwin", suffix: "_mac64", releaseName: "lq_mac64" },
  { target: "aarch64-apple-darwin", suffix: "_mac_arm64", releaseName: "lq_mac_arm64" },
  { target: "x86_64-unknown-linux-gnu", suffix: "_linux64", releaseName: "lq_linux64" },
  { target: "aarch64-unknown-linux-gnu", suffix: "_linux_arm64", releaseName: "lq_linux_arm64" },
];

async function compileBinary(name: string, config: { target?: string; suffix: string }): Promise<void> {
  const outputPath = `bin/lq_${name}${config.suffix}`;
  const args = ["compile", "-A", "--bundle", "--minify"];
  if (config.target) {
    args.push("--target", config.target);
  }
  args.push("--output", outputPath, "main.ts");

  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });

  const process = cmd.spawn();
  const status = await process.status;
  if (!status.success) {
    Deno.exit(status.code);
  }
}

async function sha256File(path: string): Promise<string> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Copy multi-target outputs to release/ with stable names + SHA256SUMS. */
export async function stageRelease(buildName: string): Promise<void> {
  await Deno.mkdir("release", { recursive: true });
  const lines: string[] = [];
  for (const t of ALL_TARGETS) {
    const src = `bin/lq_${buildName}${t.suffix}`;
    const dest = `release/${t.releaseName}`;
    try {
      await Deno.stat(src);
    } catch {
      console.error(`Missing build output: ${src}`);
      Deno.exit(1);
    }
    await Deno.copyFile(src, dest);
    const hash = await sha256File(dest);
    lines.push(`${hash}  ${t.releaseName}`);
    console.log(`staged ${dest}`);
  }
  const sumsPath = "release/SHA256SUMS";
  await Deno.writeTextFile(sumsPath, lines.join("\n") + "\n");
  console.log(`wrote ${sumsPath}`);
}

if (import.meta.main) {
  const isRelease = Deno.args.includes("--release") || Deno.args.includes("-r");
  const buildName = resolveBuildName();

  if (isRelease) {
    for (const target of ALL_TARGETS) {
      await compileBinary(buildName, target);
    }
    await stageRelease(buildName);
  } else {
    await compileBinary(buildName, { suffix: getHostSuffix() });
  }
}
