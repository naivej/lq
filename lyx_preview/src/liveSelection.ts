/** Read-first Live selection record (DL134). One payload for LM, MCP, and JSON. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LiveToken } from "./previewSession";

export const NO_LIVE_SELECTION = "no Live selection";
export const LM_TOOL_NAME = "lyx-preview_get_live_selection";
export const LM_TOOL_REF = "lyxSelection";
export const MCP_TOOL_NAME = "get_live_selection";
export const LIVE_SELECTION_ENV = "LQ_LIVE_SELECTION_PATH";
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
  return {
    file: ctx.file,
    diskHash: ctx.diskHash,
    stale: ctx.stale,
    mode: ctx.mode,
    selector: token.bundle.selector,
    coords: token.bundle.coords ?? null,
    selectedText,
    changeId: id.startsWith("change-") ? id : null,
    multi,
    capturedAt: ctx.capturedAt ?? new Date().toISOString(),
  };
}

function coordsKey(coords: LiveSelectionCoords | null | undefined): string {
  if (!coords) return "";
  return `${coords.row}:${coords.column}`;
}

export function rematchSelection(
  previous: LiveSelectionRecord,
  tokens: LiveToken[],
  file: string,
  diskHash: string,
  stale: boolean,
): LiveSelectionRecord {
  const match = previous.changeId
    ? tokens.find((t) => t.id === previous.changeId)
    : tokens.find((t) =>
      t.bundle.selector === previous.selector &&
      coordsKey(t.bundle.coords) === coordsKey(previous.coords)
    );
  if (!match) {
    return { ...previous, file, diskHash, stale: true };
  }
  return {
    ...previous,
    file,
    diskHash,
    stale,
    selector: match.bundle.selector,
    coords: match.bundle.coords ?? null,
    changeId: match.id.startsWith("change-") ? match.id : null,
  };
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

  markStale(): LiveSelectionRecord | undefined {
    if (this.record) this.record = { ...this.record, stale: true };
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
  return text;
}

export function resolveLiveSelectionPath(opts: {
  env?: NodeJS.ProcessEnv;
  workspaceFolder?: string;
  globalStoragePath?: string;
  cwd?: string;
}): string {
  const override = opts.env?.[LIVE_SELECTION_ENV]?.trim();
  if (override) return override;
  if (opts.workspaceFolder) {
    return join(opts.workspaceFolder, ".lq", LIVE_SELECTION_FILENAME);
  }
  if (opts.globalStoragePath) {
    return join(opts.globalStoragePath, LIVE_SELECTION_FILENAME);
  }
  return join(opts.cwd ?? process.cwd(), ".lq", LIVE_SELECTION_FILENAME);
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
  return {
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
