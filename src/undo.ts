import { Node } from "./ast.ts";
import * as path from "@std/path";

export interface SnapshotEntry {
  /** The selector used to target the node */
  selector: string;
  /** Index of this node within the selector's match list */
  index: number;
  /** Pre-mutation children of the matched block node */
  children: Node[];
}

export interface SnapshotFile {
  /** Absolute path of the file this snapshot belongs to (for 1-level pruning) */
  filePath: string;
  /** Snapshot entries, one per mutated node */
  entries: SnapshotEntry[];
}

function getUndoDir(): string | null {
  const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!homeDir) return null;
  return path.join(homeDir, ".lq", "undo");
}

function getSnapshotPath(hash: string): string | null {
  const dir = getUndoDir();
  if (!dir) return null;
  return path.join(dir, hash + ".json");
}

/**
 * Save a pre-mutation snapshot before writing the mutated file.
 *
 * 1-level enforcement: before saving, scan the undo directory and delete
 * any existing snapshot whose filePath matches (same file, different hash).
 */
export async function saveSnapshot(
  filePath: string,
  entries: SnapshotEntry[],
  postHash: string,
): Promise<void> {
  try {
    const dir = getUndoDir();
    if (!dir) return;
    await Deno.mkdir(dir, { recursive: true });

    // 1-level enforcement: prune old snapshots for the same filePath
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const existingPath = path.join(dir, entry.name);
      try {
        const json = await Deno.readTextFile(existingPath);
        const existing = JSON.parse(json) as SnapshotFile;
        if (existing && existing.filePath === filePath) {
          await Deno.remove(existingPath);
        }
      } catch {
        // Corrupt or unreadable — remove it
        try { await Deno.remove(existingPath); } catch { /* ignore */ }
      }
    }

    const snapshot: SnapshotFile = { filePath, entries };
    const snapshotPath = getSnapshotPath(postHash);
    if (!snapshotPath) return;

    // Atomic write: temp file + rename
    const tmpPath = snapshotPath + ".tmp";
    await Deno.writeTextFile(tmpPath, JSON.stringify(snapshot));
    await Deno.rename(tmpPath, snapshotPath);
  } catch {
    // Snapshot failures are non-fatal
  }
}

/**
 * Load a pre-mutation snapshot by post-mutation content hash.
 * Returns null if no snapshot exists or on any error.
 */
export async function loadSnapshot(fileHash: string): Promise<SnapshotFile | null> {
  try {
    const snapshotPath = getSnapshotPath(fileHash);
    if (!snapshotPath) return null;
    const json = await Deno.readTextFile(snapshotPath);
    const snapshot = JSON.parse(json) as SnapshotFile;
    if (!snapshot || !snapshot.entries || !Array.isArray(snapshot.entries)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Delete a snapshot by its post-mutation content hash.
 * No-op if the snapshot doesn't exist or on any error.
 */
export async function clearSnapshot(fileHash: string): Promise<void> {
  try {
    const snapshotPath = getSnapshotPath(fileHash);
    if (!snapshotPath) return;
    await Deno.remove(snapshotPath);
  } catch {
    // Already gone or permissions — non-fatal
  }
}
