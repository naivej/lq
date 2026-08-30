import * as vscode from "vscode";
import { AdapterError } from "./previewSession";
import { ensureManagedLq, LqEnsureError } from "./lqEnsure";
import { resolveLqBinary } from "./lqResolve";

export { DEV_LQ_BIN_DIR, findLqInDir } from "./lqResolve";
export type { LqResolveResult } from "./lqResolve";
export { resolveLqBinary };

/** Read `lyx-preview.lqPath` (workspace/folder-aware when uri given). */
export function readLqPathSetting(documentUri?: vscode.Uri): string {
  return vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("lqPath")
    ?.trim() ?? "";
}

/**
 * Path to spawn for Live preview (DL155).
 * Throws AdapterError MISSING_BINARY when unset and no dev binary.
 */
export function discoverLqBinary(documentUri?: vscode.Uri): string {
  const resolved = resolveLqBinary(readLqPathSetting(documentUri));
  if (resolved.kind === "unset") {
    throw new AdapterError(
      "MISSING_BINARY",
      "Set lyx-preview.lqPath to a file path. LyX Preview will download and update the lq binary at that path.",
    );
  }
  return resolved.path;
}

let ensureFlight: Promise<void> | undefined;

/**
 * If resolve is managed, ensure the binary matches GitHub latest (hash).
 * Dev / unset → no-op. Single-flight across activate / config / preview.
 */
export async function ensureCompanionLq(documentUri?: vscode.Uri): Promise<void> {
  if (ensureFlight) return ensureFlight;
  ensureFlight = (async () => {
    const resolved = resolveLqBinary(readLqPathSetting(documentUri));
    if (resolved.kind !== "managed") return;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "LyX Preview",
          cancellable: false,
        },
        async (progress) => {
          const result = await ensureManagedLq(resolved.path, {
            onProgress: (message) => progress.report({ message }),
          });
          if (result.updated) {
            void vscode.window.showInformationMessage("lq ready");
          }
        },
      );
    } catch (error) {
      const message = error instanceof LqEnsureError
        ? error.message
        : error instanceof Error
        ? error.message
        : String(error);
      void vscode.window.showErrorMessage(`lq update failed: ${message}`);
      throw error;
    }
  })().finally(() => {
    ensureFlight = undefined;
  });
  return ensureFlight;
}
