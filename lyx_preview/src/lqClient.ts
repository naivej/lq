import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

export { runLivePreview } from "./lqRunner";

export function discoverLqBinary(documentUri: vscode.Uri): string {
  const configured = vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("lqPath")
    ?.trim();
  if (configured) return configured;
  const env = process.env.LQ_PATH?.trim();
  if (env) return env;
  const folder = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath;
  if (folder) {
    for (const rel of ["lq/bin", "bin"]) {
      const dir = join(folder, rel);
      if (!existsSync(dir)) continue;
      const match = readdirSync(dir).find((name: string) => /^lq/i.test(name) && !name.endsWith(".map"));
      if (match) return join(dir, match);
    }
  }
  return "lq";
}
