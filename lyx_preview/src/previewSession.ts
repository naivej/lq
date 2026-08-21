/** Process-generation and last-valid-render state for the Live preview adapter. */

export const LIVE_CONTRACT = "lyx-preview/live-1";

/** Live capability flags. `outline: true` since DL131 Phase B (M2.7). */
export const LIVE_CAPABILITIES = {
  review: false,
  mapping: false,
  outline: true,
  editing: false,
  sourceReveal: false,
} as const;

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

const DEFERRED = ["tokens", "changes", "mapping", "editTargets", "reviewRegions", "mode"];

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
  return obj as unknown as LiveRender;
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
