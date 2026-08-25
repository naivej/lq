/** Read-first Live selection record (DL134). One payload for LM tool and JSON. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LiveToken, LiveTokenVia } from "./previewSession";

export const NO_LIVE_SELECTION = "no Live selection";
export const LM_TOOL_NAME = "lyx-preview_get_live_selection";
export const LM_TOOL_REF = "lyxSelection";
export const LIVE_SELECTION_FILENAME = "live-selection.json";

export type LiveViewMode = "original" | "tracked" | "clean";

export interface LiveSelectionCoords {
  row: number;
  column: number;
}

/** Published pointer. Not a mutation selector. */
export interface LiveSelectionRecord {
  file: string;
  diskHash: string;
  stale: boolean;
  mode: LiveViewMode;
  selector: string;
  coords: LiveSelectionCoords | null;
  selectedText: string;
  changeId: string | null;
  multi: boolean;
  capturedAt: string;
  /** Present when `file` is an included child shown via a parent Include (DL136). */
  via?: LiveTokenVia;
}

export interface SelectMessage {
  id: string;
  selectedText: string;
  multi: boolean;
}

export function parseSelectMessage(msg: unknown): SelectMessage | undefined {
  if (msg === null || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;
  if (m.type !== "select") return undefined;
  if (typeof m.id !== "string" || m.id.length === 0) return undefined;
  return {
    id: m.id,
    selectedText: typeof m.selectedText === "string" ? m.selectedText : "",
    multi: m.multi === true,
  };
}

function sameFsPath(a: string, b: string): boolean {
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  return norm(a) === norm(b);
}

export function resolveSelection(
  tokens: LiveToken[],
  id: string,
  selectedText: string,
  multi: boolean,
  ctx: {
    file: string;
    diskHash: string;
    stale: boolean;
    mode: LiveViewMode;
    capturedAt?: string;
  },
): LiveSelectionRecord | undefined {
  const token = tokens.find((t) => t.id === id);
  if (!token) return undefined;
  const foreign = typeof token.bundle.file === "string" && token.bundle.file.length > 0;
  const file = foreign ? token.bundle.file! : ctx.file;
  const diskHash = foreign ? (token.bundle.diskHash ?? ctx.diskHash) : ctx.diskHash;
  // J3: stale tracks the edit-target file. Master dirtiness does not stale a child pointer.
  const stale = foreign ? false : ctx.stale;
  const record: LiveSelectionRecord = {
    file,
    diskHash,
    stale,
    mode: ctx.mode,
    selector: token.bundle.selector,
    coords: token.bundle.coords ?? null,
    selectedText,
    changeId: id.startsWith("change-") ? id : null,
    multi,
    capturedAt: ctx.capturedAt ?? new Date().toISOString(),
  };
  if (token.bundle.via) {
    record.via = { file: token.bundle.via.file, selector: token.bundle.via.selector };
  }
  return record;
}

function coordsKey(coords: LiveSelectionCoords | null | undefined): string {
  if (!coords) return "";
  return `${coords.row}:${coords.column}`;
}

function tokenEditFile(token: LiveToken, previewFile: string): string {
  return token.bundle.file ?? previewFile;
}

export function rematchSelection(
  previous: LiveSelectionRecord,
  tokens: LiveToken[],
  previewFile: string,
  previewDiskHash: string,
  stale: boolean,
): LiveSelectionRecord {
  const match = previous.changeId
    ? tokens.find((t) => t.id === previous.changeId)
    : tokens.find((t) =>
      tokenEditFile(t, previewFile) === previous.file &&
      t.bundle.selector === previous.selector &&
      coordsKey(t.bundle.coords) === coordsKey(previous.coords)
    );
  if (!match) {
    return { ...previous, stale: true };
  }
  const foreign = typeof match.bundle.file === "string" && match.bundle.file.length > 0;
  const file = foreign ? match.bundle.file! : previewFile;
  const diskHash = foreign ? (match.bundle.diskHash ?? previous.diskHash) : previewDiskHash;
  const next: LiveSelectionRecord = {
    ...previous,
    file,
    diskHash,
    stale: foreign ? false : stale,
    selector: match.bundle.selector,
    coords: match.bundle.coords ?? null,
    changeId: match.id.startsWith("change-") ? match.id : null,
  };
  if (match.bundle.via) {
    next.via = { file: match.bundle.via.file, selector: match.bundle.via.selector };
  } else {
    delete next.via;
  }
  return next;
}

export class LiveSelectionStore {
  private record: LiveSelectionRecord | undefined;

  get(): LiveSelectionRecord | undefined {
    return this.record;
  }

  set(record: LiveSelectionRecord | undefined): void {
    this.record = record;
  }

  applySelect(
    tokens: LiveToken[],
    id: string,
    selectedText: string,
    multi: boolean,
    ctx: {
      file: string;
      diskHash: string;
      stale: boolean;
      mode: LiveViewMode;
      capturedAt?: string;
    },
  ): LiveSelectionRecord | undefined {
    const next = resolveSelection(tokens, id, selectedText, multi, ctx);
    if (next) this.record = next;
    return this.record;
  }

  /**
   * Mark stale when the previewed master buffer is dirty.
   * Foreign (included-child) pointers are left alone (DL136 J3).
   */
  markStale(previewFile?: string): LiveSelectionRecord | undefined {
    if (!this.record) return undefined;
    if (previewFile && !sameFsPath(this.record.file, previewFile)) {
      return this.record;
    }
    this.record = { ...this.record, stale: true };
    return this.record;
  }

  rematch(
    tokens: LiveToken[],
    file: string,
    diskHash: string,
    stale: boolean,
  ): LiveSelectionRecord | undefined {
    if (!this.record) return undefined;
    this.record = rematchSelection(this.record, tokens, file, diskHash, stale);
    return this.record;
  }

  clear(): void {
    this.record = undefined;
  }
}

export function formatLiveSelectionJson(record: LiveSelectionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function invokeLiveSelection(record: LiveSelectionRecord | undefined): string {
  if (!record) return NO_LIVE_SELECTION;
  return formatLiveSelectionJson(record);
}

export function compactSelector(record: LiveSelectionRecord): string {
  let text = record.selector;
  if (record.coords) text += ` [${record.coords.row},${record.coords.column}]`;
  if (record.multi) text += " +";
  if (record.via) text += " via";
  return text;
}

export function resolveLiveSelectionPath(opts: {
  workspaceFolder?: string;
  globalStoragePath?: string;
}): string {
  if (opts.workspaceFolder) {
    return join(opts.workspaceFolder, ".lq", LIVE_SELECTION_FILENAME);
  }
  if (opts.globalStoragePath) {
    return join(opts.globalStoragePath, LIVE_SELECTION_FILENAME);
  }
  return join(process.cwd(), ".lq", LIVE_SELECTION_FILENAME);
}

export function parseLiveSelectionJson(raw: string): LiveSelectionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.file !== "string" || typeof o.diskHash !== "string") return undefined;
  if (typeof o.stale !== "boolean") return undefined;
  if (o.mode !== "original" && o.mode !== "tracked" && o.mode !== "clean") return undefined;
  if (typeof o.selector !== "string" || o.selector.length === 0) return undefined;
  if (typeof o.selectedText !== "string") return undefined;
  if (typeof o.multi !== "boolean" || typeof o.capturedAt !== "string") return undefined;
  let coords: LiveSelectionCoords | null = null;
  if (o.coords !== null && o.coords !== undefined) {
    if (typeof o.coords !== "object") return undefined;
    const c = o.coords as Record<string, unknown>;
    if (typeof c.row !== "number" || typeof c.column !== "number") return undefined;
    coords = { row: c.row, column: c.column };
  }
  const changeId = o.changeId === null ? null : typeof o.changeId === "string" ? o.changeId : null;
  let via: LiveTokenVia | undefined;
  if (o.via !== null && o.via !== undefined) {
    if (typeof o.via !== "object") return undefined;
    const v = o.via as Record<string, unknown>;
    if (typeof v.file !== "string" || v.file.length === 0) return undefined;
    if (typeof v.selector !== "string" || v.selector.length === 0) return undefined;
    via = { file: v.file, selector: v.selector };
  }
  const record: LiveSelectionRecord = {
    file: o.file,
    diskHash: o.diskHash,
    stale: o.stale,
    mode: o.mode,
    selector: o.selector,
    coords,
    selectedText: o.selectedText,
    changeId,
    multi: o.multi,
    capturedAt: o.capturedAt,
  };
  if (via) record.via = via;
  return record;
}

export async function writeLiveSelectionFile(
  path: string,
  record: LiveSelectionRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatLiveSelectionJson(record), "utf8");
}

export async function readLiveSelectionFile(path: string): Promise<LiveSelectionRecord | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return parseLiveSelectionJson(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
