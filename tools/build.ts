/**
 * Cross-platform build script for lq.
 *
 * Resolves binary names using git tags (e.g. v0.7.0 -> 0_7_0) or commit SHAs,
 * avoiding reliance on platform-specific shell tools like `sed`.
 *
 * Usage:
 *   deno run -A tools/build.ts          # Build native host binary
 *   deno run -A tools/build.ts --all    # Cross-compile for Windows, macOS, and Linux
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

function getHostSuffix(): string {
  if (Deno.build.os === "windows") return "_win64.exe";
  if (Deno.build.os === "darwin") return "_mac";
  return "_linux";
}

interface CompileTarget {
  target?: string;
  suffix: string;
}

const ALL_TARGETS: CompileTarget[] = [
  { target: "x86_64-pc-windows-msvc", suffix: "_win64.exe" },
  { target: "x86_64-apple-darwin", suffix: "_mac" },
  { target: "x86_64-unknown-linux-gnu", suffix: "_linux" },
];

async function compileBinary(name: string, config: CompileTarget): Promise<void> {
  const outputPath = `bin/lq_${name}${config.suffix}`;
  const args = ["compile", "-A"];
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

if (import.meta.main) {
  const isAll = Deno.args.includes("--all") || Deno.args.includes("-a");
  const buildName = resolveBuildName();

  if (isAll) {
    for (const target of ALL_TARGETS) {
      await compileBinary(buildName, target);
    }
  } else {
    await compileBinary(buildName, { suffix: getHostSuffix() });
  }
}
