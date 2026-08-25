/** Process-generation and last-valid-render state for the Live preview adapter. */

export const LIVE_CONTRACT = "lyx-preview/live-1";

/** Live capability flags. `outline: true` since DL131 Phase B (M2.7); `mapping: true` since DL134. */
export const LIVE_CAPABILITIES = {
  review: false,
  mapping: true,
  outline: true,
  editing: false,
  sourceReveal: false,
} as const;

/** Provenance when the owner lives in an included child `.lyx` (DL136). */
export interface LiveTokenVia {
  file: string;
  selector: string;
}

/** Read-first lq bundle: selector path. Not a mutation selector. */
export interface LiveTokenBundle {
  selector: string;
  /** Edit-target file when different from the previewed master (included child). */
  file?: string;
  /** SHA-256 of `file` when `file` is set. */
  diskHash?: string;
  /** Master/parent Include that inlined this owner. */
  via?: LiveTokenVia;
}

/** One mapped Live owner (HTML id/`data-ref` equals token id). */
export interface LiveToken {
  id: string;
  bundle: LiveTokenBundle;
}

export interface LiveSourceIdentity {
  path: string;
  hashAlgorithm: "sha256";
  hashInput: "raw-file-bytes";
  diskHash: string;
  lineEnding: "lf" | "crlf" | "mixed";
  lineCount: number;
  fresh: true;
}

export interface LiveDiagnostic {
  code: string;
  message: string;
}

export interface LiveOutlineEntry {
  level: number;
  number: string;
  text: string;
  id: string;
}

export interface LiveNavEntry {
  kind: string;
  number: string;
  text: string;
  id: string;
  name?: string;
  /** 0-based source line when the extension could locate it in the buffer. */
  line?: number;
}

/** One rendered tracked-change region (DL133). */
export interface LiveChangeEntry {
  ordinal: number;
  type: "inserted" | "deleted";
  author: string;
  ts: string;
  anchorId: string;
  snippet: string;
}

export interface LiveNavigate {
  figures: LiveNavEntry[];
  tables: LiveNavEntry[];
  equations: LiveNavEntry[];
  labels: LiveNavEntry[];
  listings: LiveNavEntry[];
  algorithms: LiveNavEntry[];
}

export interface LiveRender {
  contract: typeof LIVE_CONTRACT;
  projection: "live";
  html: string;
  source: LiveSourceIdentity;
  capabilities: typeof LIVE_CAPABILITIES;
  diagnostics: LiveDiagnostic[];
  outline: LiveOutlineEntry[];
  navigate: LiveNavigate;
  changes: LiveChangeEntry[];
  /** Read-first mapping tokens (DL134). HTML `id`/`data-ref` equals `token.id`. */
  tokens: LiveToken[];
  warnings?: string[];
}

export function emptyNavigate(): LiveNavigate {
  return {
    figures: [],
    tables: [],
    equations: [],
    labels: [],
    listings: [],
    algorithms: [],
  };
}

export type AdapterFailureCode =
  | "MISSING_BINARY"
  | "TIMEOUT"
  | "CANCELLED"
  | "OUTPUT_LIMIT"
  | "MALFORMED_JSON"
  | "PARSE_ERROR"
  | "PROCESS_ERROR"
  | "CONTRACT";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Field names later milestones may add. `tokens` is on the wire (DL134); `mapping` remains an unused field name. */
const DEFERRED = ["mapping", "editTargets", "reviewRegions", "mode"];

export function parseLiveStdout(stdout: string): LiveRender {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AdapterError("MALFORMED_JSON", "lq returned invalid JSON.");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new AdapterError("MALFORMED_JSON", "lq returned a non-object JSON payload.");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.code === "string") {
    const message = typeof obj.message === "string" ? obj.message : obj.code;
    throw new AdapterError(obj.code === "PARSE_ERROR" ? "PARSE_ERROR" : "PROCESS_ERROR", message);
  }
  if (obj.contract !== LIVE_CONTRACT || obj.projection !== "live" || typeof obj.html !== "string") {
    throw new AdapterError("CONTRACT", "lq preview returned an incompatible Live contract.");
  }
  for (const field of DEFERRED) {
    if (field in obj) {
      throw new AdapterError("CONTRACT", `lq preview emitted deferred field '${field}'.`);
    }
  }
  const caps = obj.capabilities;
  if (caps === null || typeof caps !== "object") {
    throw new AdapterError("CONTRACT", "lq preview omitted capabilities.");
  }
  const c = caps as Record<string, unknown>;
  for (const key of Object.keys(LIVE_CAPABILITIES) as (keyof typeof LIVE_CAPABILITIES)[]) {
    if (c[key] !== LIVE_CAPABILITIES[key]) {
      throw new AdapterError(
        "CONTRACT",
        `capabilities.${key} must be ${LIVE_CAPABILITIES[key]}.`,
      );
    }
  }
  if (!Array.isArray(obj.outline)) {
    throw new AdapterError("CONTRACT", "lq preview omitted outline.");
  }
  for (const entry of obj.outline) {
    if (entry === null || typeof entry !== "object") {
      throw new AdapterError("CONTRACT", "outline entries must be objects.");
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.level !== "number" ||
      typeof e.number !== "string" ||
      typeof e.text !== "string" ||
      typeof e.id !== "string"
    ) {
      throw new AdapterError("CONTRACT", "outline entry needs level/number/text/id.");
    }
  }
  if (obj.navigate === null || typeof obj.navigate !== "object") {
    throw new AdapterError("CONTRACT", "lq preview omitted navigate.");
  }
  const nav = obj.navigate as Record<string, unknown>;
  for (const key of ["figures", "tables", "equations", "labels", "listings", "algorithms"]) {
    if (!Array.isArray(nav[key])) {
      throw new AdapterError("CONTRACT", `navigate.${key} must be an array.`);
    }
  }
  if (!Array.isArray(obj.changes)) {
    throw new AdapterError("CONTRACT", "lq preview omitted changes.");
  }
  for (const entry of obj.changes) {
    if (entry === null || typeof entry !== "object") {
      throw new AdapterError("CONTRACT", "change entries must be objects.");
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.ordinal !== "number" ||
      (e.type !== "inserted" && e.type !== "deleted") ||
      typeof e.author !== "string" ||
      typeof e.ts !== "string" ||
      typeof e.anchorId !== "string" ||
      typeof e.snippet !== "string"
    ) {
      throw new AdapterError("CONTRACT", "change entry needs ordinal/type/author/ts/anchorId/snippet.");
    }
  }
  if (!Array.isArray(obj.tokens)) {
    throw new AdapterError("CONTRACT", "lq preview omitted tokens.");
  }
  const seenTokenIds = new Set<string>();
  for (const entry of obj.tokens) {
    if (entry === null || typeof entry !== "object") {
      throw new AdapterError("CONTRACT", "each token must be an object.");
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.length === 0) {
      throw new AdapterError("CONTRACT", "token.id must be a non-empty string.");
    }
    if (seenTokenIds.has(t.id)) {
      throw new AdapterError("CONTRACT", `token.id '${t.id}' is not unique.`);
    }
    seenTokenIds.add(t.id);
    if (t.bundle === null || typeof t.bundle !== "object") {
      throw new AdapterError("CONTRACT", "token.bundle must be an object.");
    }
    const b = t.bundle as Record<string, unknown>;
    if (typeof b.selector !== "string" || b.selector.length === 0) {
      throw new AdapterError("CONTRACT", "token.bundle.selector must be a non-empty string.");
    }
    if ("file" in b && b.file !== undefined && b.file !== null) {
      if (typeof b.file !== "string" || b.file.length === 0) {
        throw new AdapterError("CONTRACT", "token.bundle.file must be a non-empty string when present.");
      }
      if (typeof b.diskHash !== "string" || b.diskHash.length === 0) {
        throw new AdapterError("CONTRACT", "token.bundle.diskHash must be a non-empty string when file is set.");
      }
    }
    if ("via" in b && b.via !== undefined && b.via !== null) {
      if (typeof b.via !== "object") {
        throw new AdapterError("CONTRACT", "token.bundle.via must be an object when present.");
      }
      const v = b.via as Record<string, unknown>;
      if (typeof v.file !== "string" || v.file.length === 0) {
        throw new AdapterError("CONTRACT", "token.bundle.via.file must be a non-empty string.");
      }
      if (typeof v.selector !== "string" || v.selector.length === 0) {
        throw new AdapterError("CONTRACT", "token.bundle.via.selector must be a non-empty string.");
      }
    }
    // DL138 J3 override: leftover coords are ignored, not part of the contract.
    if ("coords" in b) delete b.coords;
  }
  return obj as unknown as LiveRender;
}

/** Format a LyX change timestamp (unix seconds) as local `YYYY-MM-DD HH:MM`. */
export function formatChangeTime(ts: string): string {
  const n = Number.parseInt(ts, 10);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  const pad = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class PreviewSession {
  generation = 0;
  lastValid: LiveRender | undefined;
  stale = false;

  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  markStale(): void {
    this.stale = true;
  }

  applySuccess(generation: number, render: LiveRender): boolean {
    if (generation !== this.generation) return false;
    this.lastValid = render;
    this.stale = false;
    return true;
  }

  applyFailure(generation: number): boolean {
    return generation === this.generation;
  }
}
