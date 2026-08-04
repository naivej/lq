import { Node, BlockNode, DocumentNode } from "./ast.ts";
import { serialize } from "./serializer.ts";
import { hashText, setCachedAst } from "./cache.ts";
import { getHeader } from "./tracked_changes.ts";
import * as path from "@std/path";

export interface SnapshotEntry {
  /** Index path from the document root to the node whose children were
   *  snapshotted ([] = the document root itself). Captured pre-mutation.
   *  For mutations that add/remove siblings (insert before/after, untracked
   *  delete) the path addresses the PARENT container, not the matched node. */
  path: number[];
  /** Pre-mutation children of the node at `path` */
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
 * Returns null if no snapshot exists, on any error, or if the file predates
 * the path-based entry format (the caller must report that snapshot restore is
 * unavailable rather than silently changing undo modes).
 */
export async function loadSnapshot(fileHash: string): Promise<SnapshotFile | null> {
  try {
    const snapshotPath = getSnapshotPath(fileHash);
    if (!snapshotPath) return null;
    const json = await Deno.readTextFile(snapshotPath);
    const snapshot = JSON.parse(json) as SnapshotFile;
    if (!snapshot || !Array.isArray(snapshot.entries)) return null;
    const valid = snapshot.entries.every(e =>
      e && Array.isArray(e.path) && Array.isArray(e.children)
    );
    return valid ? snapshot : null;
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

/** Compute the index path from the document root to a node, or null. */
export function findNodePath(root: Node[], target: Node): number[] | null {
  for (let i = 0; i < root.length; i++) {
    if (root[i] === target) return [i];
    if (root[i].type === "block") {
      const sub = findNodePath((root[i] as BlockNode).children, target);
      if (sub) return [i, ...sub];
    }
  }
  return null;
}

/** Resolve an index path to a node; [] resolves to the document root. */
export function nodeAtPath(ast: DocumentNode, path: number[]): DocumentNode | BlockNode | null {
  let current: DocumentNode | BlockNode = ast;
  for (const i of path) {
    const next: Node | undefined = current.children[i];
    if (!next || next.type !== "block") return null;
    current = next;
  }
  return current;
}

/**
 * Snapshot the pre-mutation children of each matched node (mode "self") or
 * of its parent container (mode "parent" — for mutations that add/remove
 * siblings, like insert before/after or untracked delete). Non-block nodes
 * (text, property) always fall back to the parent container: their own
 * text/value is part of the parent's child list.
 */
export function collectSnapshots(ast: DocumentNode, nodes: Node[], mode: "self" | "parent"): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const nodePath = findNodePath(ast.children, node);
    if (!nodePath) continue;
    const path = (mode === "parent" || node.type !== "block") ? nodePath.slice(0, -1) : nodePath;
    const key = path.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const target = nodeAtPath(ast, path);
    if (!target) continue;
    entries.push({ path, children: structuredClone(target.children) });
  }
  // Always include the document header in the snapshot (dev log 84 F2):
  // tracked mutations write \author / \tracking_changes into the header, so
  // undo must restore it to be byte-exact. Callers capture snapshots BEFORE
  // those header mutations run, so this records the pre-mutation header. For
  // untracked mutations the header is unchanged — the restore path counts
  // only content-changing entries, so this stays an invisible no-op.
  const header = getHeader(ast);
  if (header) {
    const headerPath = findNodePath(ast.children, header);
    const headerKey = headerPath ? headerPath.join(",") : "";
    if (headerPath && !seen.has(headerKey)) {
      seen.add(headerKey);
      entries.push({ path: headerPath, children: structuredClone(header.children) });
    }
  }
  return entries;
}

/**
 * Persist a mutation: serialize, save the pre-mutation snapshot keyed by the
 * post-mutation content hash, write the file, update the parse cache.
 */
export async function commitMutation(filePath: string, ast: DocumentNode, preSnapshots: SnapshotEntry[]): Promise<void> {
  const newFileText = serialize(ast);
  const postHash = await hashText(newFileText);
  await saveSnapshot(path.resolve(filePath), preSnapshots, postHash);
  await Deno.writeTextFile(filePath, newFileText);
  try { await setCachedAst(postHash, ast); } catch { /* non-fatal */ }
}
