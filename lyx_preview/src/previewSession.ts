/** Process-generation and last-valid-render state for the Live preview adapter. */

export const LIVE_CONTRACT = "lyx-preview/live-1";

export const LIVE_UNAVAILABLE_CAPABILITIES = {
  review: false,
  mapping: false,
  outline: false,
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

export interface LiveRender {
  contract: typeof LIVE_CONTRACT;
  projection: "live";
  html: string;
  source: LiveSourceIdentity;
  capabilities: typeof LIVE_UNAVAILABLE_CAPABILITIES;
  diagnostics: LiveDiagnostic[];
  warnings?: string[];
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

const DEFERRED = ["tokens", "changes", "mapping", "outline", "editTargets", "reviewRegions", "mode"];

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
  for (const key of Object.keys(LIVE_UNAVAILABLE_CAPABILITIES)) {
    if (c[key] !== false) {
      throw new AdapterError("CONTRACT", `capabilities.${key} must be unavailable.`);
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
