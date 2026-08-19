/**
 * Development-only LyX XHTML oracle (dev log 129, minimal M3.2–M3.3).
 *
 * Not imported by the Live renderer or the shipped CLI preview path.
 * Tests and acceptance tooling invoke this helper when a LyX binary is present.
 */
import * as path from "@std/path";
import { normalizeReaderHtml, type SemNode } from "./preview.ts";

export interface XhtmlExportResult {
  body: string;
  sanitized: string;
  normalized: SemNode;
  elapsedMs: number;
  outputPath: string;
}

export class XhtmlOracleError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "XhtmlOracleError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

const BODY_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const HAZARD_TAG_RE = /<\/?(?:iframe|object|embed|form|link|meta|base|svg)\b[^>]*>/gi;
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi;
const JS_HREF_RE = /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi;

export function extractXhtmlBody(html: string): string {
  const match = BODY_RE.exec(html);
  if (!match) {
    throw new XhtmlOracleError("LYX_EXPORT_NO_BODY", "LyX HTML export contained no <body> element.");
  }
  return match[1];
}

/** Strip scripts, event handlers, styles, and other unsafe export material. */
export function sanitizeXhtmlBody(body: string): string {
  return body
    .replace(COMMENT_RE, "")
    .replace(SCRIPT_RE, "")
    .replace(STYLE_RE, "")
    .replace(HAZARD_TAG_RE, "")
    .replace(EVENT_ATTR_RE, "")
    .replace(JS_HREF_RE, "");
}

export function assertSanitized(body: string): void {
  if (/<script\b/i.test(body)) throw new XhtmlOracleError("UNSAFE_HTML", "Sanitized body still contains <script>.");
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(body)) {
    throw new XhtmlOracleError("UNSAFE_HTML", "Sanitized body still contains an event handler.");
  }
  if (/<[a-z][^>]*(?:href|src)\s*=\s*["']javascript:/i.test(body)) {
    throw new XhtmlOracleError("UNSAFE_HTML", "Sanitized body still contains a javascript: URL.");
  }
  if (/<style\b/i.test(body)) throw new XhtmlOracleError("UNSAFE_HTML", "Sanitized body still contains <style>.");
}

export async function findLyxBinary(layoutsDir?: string): Promise<string | null> {
  const env = Deno.env.get("LYX_BINARY") ?? Deno.env.get("LYX_PATH");
  if (env) {
    try {
      const st = await Deno.stat(env);
      if (st.isFile) return env;
    } catch { /* keep looking */ }
  }
  const candidates: string[] = [];
  if (layoutsDir) {
    const installRoot = path.resolve(layoutsDir, "..", "..");
    candidates.push(
      path.join(installRoot, "bin", "LyX.exe"),
      path.join(installRoot, "bin", "lyx.exe"),
      path.join(installRoot, "bin", "lyx"),
    );
  }
  const localApp = Deno.env.get("LOCALAPPDATA");
  const programFiles = Deno.env.get("PROGRAMFILES");
  for (const base of [localApp ? path.join(localApp, "Programs") : null, programFiles].filter(Boolean) as string[]) {
    try {
      for await (const entry of Deno.readDir(base)) {
        if (!entry.isDirectory || !/^LyX /.test(entry.name)) continue;
        candidates.push(
          path.join(base, entry.name, "bin", "LyX.exe"),
          path.join(base, entry.name, "bin", "lyx.exe"),
        );
      }
    } catch { /* skip unreadable bases */ }
  }
  for (const c of candidates) {
    try {
      const st = await Deno.stat(c);
      if (st.isFile) return c;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Run LyX headlessly (`-E xhtml <temp> <file>`), extract and sanitize the body,
 * then delete the artifact. Always kills the process on timeout.
 */
export async function exportSanitizedXhtml(
  lyxBinary: string,
  filePath: string,
  options: { timeoutMs?: number } = {},
): Promise<XhtmlExportResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const outputPath = await Deno.makeTempFile({ prefix: "lq-oracle-", suffix: ".xhtml" });
  try {
    let process: Deno.ChildProcess;
    try {
      process = new Deno.Command(lyxBinary, {
        args: ["-E", "xhtml", outputPath, path.resolve(filePath)],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      throw new XhtmlOracleError(
        "LYX_EXPORT_SPAWN",
        `Could not start LyX for HTML export: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const timer = setTimeout(() => {
      try {
        process.kill();
      } catch { /* already gone */ }
    }, timeoutMs);
    let output: Deno.CommandOutput;
    try {
      output = await process.output();
    } finally {
      clearTimeout(timer);
    }
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr).slice(0, 2000);
      throw new XhtmlOracleError(
        "LYX_EXPORT_FAILED",
        `LyX export exited with code ${output.code}.${stderr ? ` ${stderr}` : ""}`,
        { exitCode: output.code, stderr },
      );
    }
    let html: string;
    try {
      html = await Deno.readTextFile(outputPath);
    } catch {
      throw new XhtmlOracleError(
        "LYX_EXPORT_NO_OUTPUT",
        "LyX reported success but produced no XHTML output; the document may fail to parse.",
      );
    }
    const body = extractXhtmlBody(html);
    const sanitized = sanitizeXhtmlBody(body);
    assertSanitized(sanitized);
    return {
      body,
      sanitized,
      normalized: normalizeReaderHtml(sanitized),
      elapsedMs: Date.now() - started,
      outputPath,
    };
  } finally {
    try {
      await Deno.remove(outputPath);
    } catch { /* best-effort */ }
  }
}
