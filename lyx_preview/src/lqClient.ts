import * as vscode from "vscode";
import { AdapterError } from "./previewSession";
import { ensureManagedLq, LqEnsureError } from "./lqEnsure";
import {
  formatUnmanagedLqLoadedMessage,
  managedEnsureTarget,
  resolveLqBinary,
} from "./lqResolve";

export { formatUnmanagedLqLoadedMessage, managedEnsureTarget } from "./lqResolve";
export type { LqResolveResult } from "./lqResolve";
export { resolveLqBinary };

/** Read `lyx-preview.lqPath` (workspace/folder-aware when uri given). */
export function readLqPathSetting(documentUri?: vscode.Uri): string {
  return vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("lqPath")
    ?.trim() ?? "";
}

/** Read `lyx-preview.unmanagedLqPath` (workspace/folder-aware when uri given). */
export function readUnmanagedLqPathSetting(documentUri?: vscode.Uri): string {
  return vscode.workspace
    .getConfiguration("lyx-preview", documentUri)
    .get<string>("unmanagedLqPath")
    ?.trim() ?? "";
}

/**
 * Path to spawn for Live preview (DL155 / DL035).
 * Throws AdapterError MISSING_BINARY when unmanaged file is missing and `lqPath` is empty.
 */
export function discoverLqBinary(documentUri?: vscode.Uri): string {
  const resolved = resolveLqBinary(
    readLqPathSetting(documentUri),
    readUnmanagedLqPathSetting(documentUri),
  );
  if (resolved.kind === "unset") {
    throw new AdapterError(
      "MISSING_BINARY",
      "Set lyx-preview.lqPath to a file path. LyX Preview will download and update the lq binary at that path.",
    );
  }
  return resolved.path;
}

let ensureFlight: Promise<void> | undefined;
let unmanagedLoadedToastShown = false;

/**
 * When `lqPath` is set, ensure that file matches GitHub latest (hash), even if
 * Live will spawn the unmanaged binary (DL034 / DL035). Empty `lqPath` → no download.
 * Soft-fail: if ensure fails while spawn would be unmanaged, toast only (preview continues).
 * Single-flight across activate / config / preview.
 */
export async function ensureCompanionLq(documentUri?: vscode.Uri): Promise<void> {
  if (ensureFlight) return ensureFlight;
  ensureFlight = (async () => {
    const lqPath = readLqPathSetting(documentUri);
    const resolved = resolveLqBinary(lqPath, readUnmanagedLqPathSetting(documentUri));

    if (resolved.kind === "unmanaged" && !unmanagedLoadedToastShown) {
      unmanagedLoadedToastShown = true;
      void vscode.window.showInformationMessage(formatUnmanagedLqLoadedMessage(resolved.path));
    }

    const target = managedEnsureTarget(lqPath);
    if (!target) return;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "LyX Preview",
          cancellable: false,
        },
        async (progress) => {
          const result = await ensureManagedLq(target, {
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
      if (resolved.kind === "unmanaged") return;
      throw error;
    }
  })().finally(() => {
    ensureFlight = undefined;
  });
  return ensureFlight;
}
