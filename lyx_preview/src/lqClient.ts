import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export { runLivePreview } from "./lqRunner";

/**
 * Development preference: binaries produced by `deno task build` in the lq
 * repo. Consulted first so a freshly built lq always wins over configured or
 * PATH binaries.
 */
const DEV_LQ_BIN_DIR = join(homedir(), "Github", "lq_dev", "lq", "bin");

export function discoverLqBinary(documentUri: vscode.Uri): string {
  const devBinary = findLqInDir(DEV_LQ_BIN_DIR);
  if (devBinary) return devBinary;
  const configured = vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("lqPath")
    ?.trim();
  if (configured) return configured;
  const onPath = findOnPath("lq");
  if (onPath) return onPath;
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

/** Newest `lq*` entry (not a .map) inside `dir`, if the directory exists. */
function findLqInDir(dir: string): string | undefined {
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
