import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { AdapterError, parseLiveStdout, type LiveRender } from "./previewSession";

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

export function runLivePreview(
  lqPath: string,
  filePath: string,
  timeoutMs: number,
): Promise<LiveRender> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = spawn(lqPath, ["preview", filePath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new AdapterError("MISSING_BINARY", missingBinaryMessage(lqPath, error)));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(new AdapterError("TIMEOUT", `lq preview timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.on("error", (error: Error) => {
      finish(new AdapterError("MISSING_BINARY", missingBinaryMessage(lqPath, error)));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(parseLiveStdout(stdout));
      } catch (error) {
        reject(error instanceof Error ? error : new AdapterError("PROCESS_ERROR", String(error)));
      }
    });

    function finish(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const extra = stderr.trim();
      if (extra && !error.message.includes(extra.slice(0, 80))) {
        error.message = `${error.message} (${extra.slice(0, 200)})`;
      }
      reject(error);
    }
  });
}

function missingBinaryMessage(lqPath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not start lq at '${lqPath}'. Set lyx-preview.lqPath to the compiled lq binary. ${detail}`;
}
