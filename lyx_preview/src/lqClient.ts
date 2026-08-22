import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export { runLivePreview } from "./lqRunner";

/**
 * Development-only fallback: binaries produced by `deno task build` in the lq
 * repo. Consulted only when neither lqPath nor PATH finds an lq binary.
 */
const DEV_LQ_BIN_DIR = join(homedir(), "Github", "lq_dev", "lq", "bin");

export function discoverLqBinary(documentUri: vscode.Uri): string {
  const configured = vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("lqPath")
    ?.trim();
  if (configured) return configured;
  const onPath = findOnPath("lq");
  if (onPath) return onPath;
  const devBinary = findLqInDir(DEV_LQ_BIN_DIR);
  if (devBinary) return devBinary;
  return "lq";
}

/** Absolute path of the first executable named `command` on PATH, if any. */
function findOnPath(command: string): string | undefined {
  const pathVar = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".com"]
    : [""];
  for (const dir of pathVar.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      const stat = statSync(candidate, { throwIfNoEntry: false });
      if (stat?.isFile()) return candidate;
    }
  }
  return undefined;
}

/** First `lq*` entry (not a .map) inside `dir`, if the directory exists. */
function findLqInDir(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const match = readdirSync(dir).find((name: string) => /^lq/i.test(name) && !name.endsWith(".map"));
  return match ? join(dir, match) : undefined;
}
