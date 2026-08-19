/**
 * Live reader projection: lq-owned HTML for a saved .lyx file.
 *
 * The response is the M1 Live contract (dev log 129). LyX XHTML is not used
 * here; it is a development oracle in xhtml_oracle.ts.
 */
import type { BlockNode, DocumentNode, Node } from "./ast.ts";
import { hashFile } from "./cache.ts";
import {
  advanceTraversalState,
  createTraversalState,
  enterTraversalState,
  isInvisibleInset,
  traversalRegion,
  type TraversalState,
} from "./text_utils.ts";
import * as path from "@std/path";

export const LIVE_CONTRACT = "lyx-preview/live-1";
export const LIVE_PROJECTION = "live";
export const LIVE_HASH_ALGORITHM = "sha256";
export const LIVE_HASH_INPUT = "raw-file-bytes";

export const LIVE_UNAVAILABLE_CAPABILITIES = {
  review: false,
  mapping: false,
  outline: false,
  editing: false,
  sourceReveal: false,
} as const;

/** Fields later milestones may add. M1 must not emit them. */
export const LIVE_DEFERRED_FIELDS = [
  "tokens",
  "changes",
  "mapping",
  "outline",
  "editTargets",
  "reviewRegions",
  "mode",
] as const;

export type LineEnding = "lf" | "crlf" | "mixed";

export interface LiveSourceIdentity {
  path: string;
  hashAlgorithm: typeof LIVE_HASH_ALGORITHM;
  hashInput: typeof LIVE_HASH_INPUT;
  diskHash: string;
  lineEnding: LineEnding;
  lineCount: number;
  fresh: true;
}

export interface LiveDiagnostic {
  code: string;
  message: string;
}

export type LiveCapabilities = typeof LIVE_UNAVAILABLE_CAPABILITIES;

export interface LivePreviewResponse {
  contract: typeof LIVE_CONTRACT;
  projection: typeof LIVE_PROJECTION;
  html: string;
  source: LiveSourceIdentity;
  capabilities: LiveCapabilities;
  diagnostics: LiveDiagnostic[];
}

export interface LiveRenderResult {
  response: LivePreviewResponse;
  warnings: string[];
}

export class LiveContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveContractError";
  }
}

export function escapeLiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function detectLineEnding(text: string): LineEnding {
  const crlf = text.includes("\r\n");
  const loneLf = text.replaceAll("\r\n", "").includes("\n");
  if (crlf && loneLf) return "mixed";
  if (crlf) return "crlf";
  return "lf";
}

export function countLines(text: string): number {
  if (text.length === 0) return 1;
  return text.split(/\r?\n/).length;
}

export function validateLiveResponse(value: unknown): LivePreviewResponse {
  if (value === null || typeof value !== "object") {
    throw new LiveContractError("Live response must be a JSON object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.contract !== LIVE_CONTRACT) {
    throw new LiveContractError(`contract must be '${LIVE_CONTRACT}'.`);
  }
  if (obj.projection !== LIVE_PROJECTION) {
    throw new LiveContractError(`projection must be '${LIVE_PROJECTION}'.`);
  }
  if (typeof obj.html !== "string") {
    throw new LiveContractError("html must be a string.");
  }
  for (const field of LIVE_DEFERRED_FIELDS) {
    if (field in obj) {
      throw new LiveContractError(`M1 Live response must omit '${field}'.`);
    }
  }
  const source = obj.source;
  if (source === null || typeof source !== "object") {
    throw new LiveContractError("source must be an object.");
  }
  const src = source as Record<string, unknown>;
  if (typeof src.path !== "string" || src.path.length === 0) {
    throw new LiveContractError("source.path must be a non-empty string.");
  }
  if (src.hashAlgorithm !== LIVE_HASH_ALGORITHM) {
    throw new LiveContractError(`source.hashAlgorithm must be '${LIVE_HASH_ALGORITHM}'.`);
  }
  if (src.hashInput !== LIVE_HASH_INPUT) {
    throw new LiveContractError(`source.hashInput must be '${LIVE_HASH_INPUT}'.`);
  }
  if (typeof src.diskHash !== "string" || !/^[0-9a-f]{64}$/.test(src.diskHash)) {
    throw new LiveContractError("source.diskHash must be a 64-char lowercase SHA-256 hex digest.");
  }
  if (src.lineEnding !== "lf" && src.lineEnding !== "crlf" && src.lineEnding !== "mixed") {
    throw new LiveContractError("source.lineEnding must be lf, crlf, or mixed.");
  }
  if (typeof src.lineCount !== "number" || !Number.isInteger(src.lineCount) || src.lineCount < 1) {
    throw new LiveContractError("source.lineCount must be a positive integer.");
  }
  if (src.fresh !== true) {
    throw new LiveContractError("source.fresh must be true: lq always reads the saved file.");
  }
  const caps = obj.capabilities;
  if (caps === null || typeof caps !== "object") {
    throw new LiveContractError("capabilities must be an object.");
  }
  const c = caps as Record<string, unknown>;
  for (const key of Object.keys(LIVE_UNAVAILABLE_CAPABILITIES) as (keyof LiveCapabilities)[]) {
    if (c[key] !== false) {
      throw new LiveContractError(`capabilities.${key} must be false in this slice.`);
    }
  }
  if (!Array.isArray(obj.diagnostics)) {
    throw new LiveContractError("diagnostics must be an array.");
  }
  for (const d of obj.diagnostics) {
    if (d === null || typeof d !== "object") {
      throw new LiveContractError("each diagnostic must be an object.");
    }
    const diag = d as Record<string, unknown>;
    if (typeof diag.code !== "string" || typeof diag.message !== "string") {
      throw new LiveContractError("each diagnostic needs string code and message.");
    }
  }
  if ("warnings" in obj && !Array.isArray(obj.warnings)) {
    throw new LiveContractError("warnings, when present, must be an array of strings.");
  }
  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) {
      if (typeof w !== "string") {
        throw new LiveContractError("warnings must contain only strings.");
      }
    }
  }
  return obj as unknown as LivePreviewResponse;
}

interface FlowItem {
  layout: string;
  depth: number;
  node: BlockNode;
}

interface RenderCtx {
  warnings: string[];
  diagnostics: LiveDiagnostic[];
  footnote: number;
  figure: number;
  table: number;
}

const HEADING: Record<string, { tag: string; level: number }> = {
  Part: { tag: "h1", level: -1 },
  Chapter: { tag: "h1", level: 0 },
  Section: { tag: "h2", level: 1 },
  "Section*": { tag: "h2", level: 1 },
  Subsection: { tag: "h3", level: 2 },
  "Subsection*": { tag: "h3", level: 2 },
  Subsubsection: { tag: "h4", level: 3 },
  "Subsubsection*": { tag: "h4", level: 3 },
  Paragraph: { tag: "h5", level: 4 },
  Subparagraph: { tag: "h6", level: 5 },
};

const LIST: Record<string, { tag: string; item: string }> = {
  Itemize: { tag: "ul", item: "li" },
  Enumerate: { tag: "ol", item: "li" },
  Description: { tag: "dl", item: "dd" },
};

const ENV: Record<string, { tag: string; item: string }> = {
  Quote: { tag: "blockquote", item: "div" },
  Quotation: { tag: "blockquote", item: "div" },
  Verse: { tag: "blockquote", item: "p" },
  Verbatim: { tag: "pre", item: "NONE" },
  "Verbatim*": { tag: "pre", item: "NONE" },
  "LyX-Code": { tag: "pre", item: "NONE" },
};

const SKIP_LAYOUT_PROPS = new Set([
  "align",
  "noindent",
  "indent",
  "start_of_appendix",
  "leftindent",
  "paragraph_spacing",
  "labelwidthstring",
  "labeling_width",
]);

const SPECIAL_CHAR: Record<string, string> = {
  LyX: "LyX",
  TeX: "TeX",
  LaTeX: "LaTeX",
  lyx: "lyx",
  tex: "tex",
  latex: "latex",
  ldots: "…",
  dots: "…",
  endash: "–",
  emdash: "—",
  slash: "/",
  hyphenation: "\u00ad",
  noboundry: "",
  noboundary: "",
  allowbreak: "",
  "menu-separator": "\u25b8",
};

function layoutSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "standard";
}

function findBody(ast: DocumentNode): Node[] {
  const doc = ast.children.find((n): n is BlockNode => n.type === "block" && n.tag === "document");
  const body = doc?.children.find((n): n is BlockNode => n.type === "block" && n.tag === "body");
  return body ? body.children : ast.children;
}

function flattenFlow(children: Node[], depth: number): FlowItem[] {
  const out: FlowItem[] = [];
  for (const child of children) {
    if (child.type !== "block") continue;
    if (child.tag === "deeper") {
      out.push(...flattenFlow(child.children, depth + 1));
    } else if (child.tag === "layout") {
      out.push({ layout: (child.args ?? "").trim(), depth, node: child });
    }
  }
  return out;
}

function warnOnce(ctx: RenderCtx, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
}

function diagnostic(ctx: RenderCtx, code: string, message: string): void {
  if (!ctx.diagnostics.some((d) => d.code === code && d.message === message)) {
    ctx.diagnostics.push({ code, message });
  }
}

export function renderLiveHtml(ast: DocumentNode): { html: string; warnings: string[]; diagnostics: LiveDiagnostic[] } {
  const ctx: RenderCtx = { warnings: [], diagnostics: [], footnote: 0, figure: 0, table: 0 };
  const inner = renderFlowItems(flattenFlow(findBody(ast), 0), ctx);
  return {
    html: `<article class="lyx-live">${inner}</article>`,
    warnings: ctx.warnings,
    diagnostics: ctx.diagnostics,
  };
}

export async function buildLiveResponse(
  filePath: string,
  ast: DocumentNode,
  text: string,
): Promise<LiveRenderResult> {
  const rendered = renderLiveHtml(ast);
  const resolved = path.resolve(filePath);
  const response: LivePreviewResponse = {
    contract: LIVE_CONTRACT,
    projection: LIVE_PROJECTION,
    html: rendered.html,
    source: {
      path: resolved,
      hashAlgorithm: LIVE_HASH_ALGORITHM,
      hashInput: LIVE_HASH_INPUT,
      diskHash: await hashFile(resolved),
      lineEnding: detectLineEnding(text),
      lineCount: countLines(text),
      fresh: true,
    },
    capabilities: { ...LIVE_UNAVAILABLE_CAPABILITIES },
    diagnostics: rendered.diagnostics,
  };
  return { response, warnings: rendered.warnings };
}

function headingNumber(layout: string, level: number, counters: Map<number, number>): string {
  if (layout.endsWith("*") || level > 3) return "";
  counters.set(level, (counters.get(level) ?? 0) + 1);
  for (const key of [...counters.keys()]) {
    if (key > level) counters.delete(key);
  }
  const start = level >= 1 ? 1 : level;
  const parts: number[] = [];
  for (let l = start; l <= level; l++) parts.push(counters.get(l) ?? 1);
  return `${parts.join(".")} `;
}

function renderFlowItems(items: FlowItem[], ctx: RenderCtx): string {
  let i = 0;
  let html = "";
  const openLevels: number[] = [];
  const counters = new Map<number, number>();

  const closeSections = (level: number) => {
    while (openLevels.length > 0 && openLevels[openLevels.length - 1] >= level) {
      html += "</section>";
      openLevels.pop();
    }
  };

  while (i < items.length) {
    const item = items[i];
    const heading = HEADING[item.layout];
    if (heading) {
      closeSections(heading.level);
      const number = headingNumber(item.layout, heading.level, counters);
      html += `<section><${heading.tag}>${number}${renderLayoutInline(item.node, ctx)}</${heading.tag}>`;
      openLevels.push(heading.level);
      i++;
      continue;
    }
    if (LIST[item.layout]) {
      const [chunk, next] = renderList(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    if (ENV[item.layout]) {
      const [chunk, next] = renderEnv(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    const inner = renderLayoutInline(item.node, ctx);
    if (inner.trim().length === 0 && !ENV[item.layout]) {
      i++;
      continue;
    }
    if (/^<figure\b[\s\S]*<\/figure>$/.test(inner.trim())) {
      html += inner;
    } else {
      html += `<div class="${layoutSlug(item.layout)}">${inner}</div>`;
    }
    i++;
  }
  closeSections(-999);
  return html;
}

function renderList(items: FlowItem[], start: number, ctx: RenderCtx): [string, number] {
  const first = items[start];
  const spec = LIST[first.layout];
  const depth = first.depth;
  let i = start;
  let html = `<${spec.tag}>`;
  while (i < items.length) {
    const item = items[i];
    if (item.depth < depth) break;
    if (item.depth === depth) {
      if (item.layout !== first.layout) break;
      if (first.layout === "Description") {
        const { label, rest } = splitDescription(item.node, ctx);
        html += `<dt>${label}</dt><dd>${rest}`;
        i++;
        if (i < items.length && items[i].depth > depth && LIST[items[i].layout]) {
          const [nested, next] = renderList(items, i, ctx);
          html += nested;
          i = next;
        }
        html += "</dd>";
      } else {
        html += `<${spec.item}>${renderLayoutInline(item.node, ctx)}`;
        i++;
        if (i < items.length && items[i].depth > depth && LIST[items[i].layout]) {
          const [nested, next] = renderList(items, i, ctx);
          html += nested;
          i = next;
        }
        html += `</${spec.item}>`;
      }
    } else if (LIST[item.layout]) {
      const [nested, next] = renderList(items, i, ctx);
      html += nested;
      i = next;
    } else {
      break;
    }
  }
  html += `</${spec.tag}>`;
  return [html, i];
}

function renderEnv(items: FlowItem[], start: number, ctx: RenderCtx): [string, number] {
  const first = items[start];
  const spec = ENV[first.layout];
  let i = start;
  if (spec.item === "NONE") {
    let body = "";
    while (i < items.length && items[i].layout === first.layout && items[i].depth === first.depth) {
      if (body) body += "\n";
      body += renderLayoutInline(items[i].node, ctx);
      i++;
    }
    return [`<${spec.tag}>${body}</${spec.tag}>`, i];
  }
  let html = `<${spec.tag}>`;
  while (i < items.length && items[i].layout === first.layout && items[i].depth === first.depth) {
    html += `<${spec.item}>${renderLayoutInline(items[i].node, ctx)}</${spec.item}>`;
    i++;
  }
  html += `</${spec.tag}>`;
  return [html, i];
}

function splitDescription(layout: BlockNode, _ctx: RenderCtx): { label: string; rest: string } {
  const raw = collectVisibleText(layout);
  const cut = raw.search(/[\t ]/);
  if (cut === -1) return { label: escapeLiveHtml(raw), rest: "" };
  return {
    label: escapeLiveHtml(raw.slice(0, cut)),
    rest: escapeLiveHtml(raw.slice(cut + 1)),
  };
}

function renderLayoutInline(layout: BlockNode, ctx: RenderCtx): string {
  return renderChildren(layout.children, createTraversalState(), ctx);
}

function renderChildren(children: Node[], state: TraversalState, ctx: RenderCtx): string {
  let html = "";
  const open: string[] = [];

  const closeAll = () => {
    while (open.length) html += `</${open.pop()}>`;
  };

  const setInline = (tag: string | null, want: boolean) => {
    const idx = open.lastIndexOf(tag ?? "");
    if (want && tag && idx === -1) {
      html += `<${tag}>`;
      open.push(tag);
    } else if (!want && tag && idx !== -1) {
      while (open.length > idx) {
        const t = open.pop()!;
        html += `</${t}>`;
      }
    }
  };

  const syncFont = () => {
    const p = state.properties;
    setInline("em", p.emph === "on" || p.shape === "italic" || p.shape === "slanted");
    setInline("strong", p.series === "bold");
    setInline("u", p.bar === "under" || p.uuline === "on");
    setInline("s", p.strikeout === "on" || p.xout === "on");
  };

  for (const child of children) {
    if (child.type === "property") {
      if (SKIP_LAYOUT_PROPS.has(child.key)) continue;
      if (child.key === "SpecialChar") {
        if (traversalRegion(state) === "deleted") continue;
        html += escapeLiveHtml(SPECIAL_CHAR[child.value ?? ""] ?? (child.value ?? ""));
        continue;
      }
      if (child.key === "backslash") {
        if (traversalRegion(state) === "deleted") continue;
        html += escapeLiveHtml("\\");
        continue;
      }
      advanceTraversalState(state, child.key, child.value);
      if (
        child.key === "emph" || child.key === "series" || child.key === "shape" ||
        child.key === "bar" || child.key === "strikeout" || child.key === "xout" ||
        child.key === "uuline" || child.key === "noun"
      ) {
        syncFont();
      }
      continue;
    }
    if (traversalRegion(state) === "deleted") continue;
    if (child.type === "text") {
      html += escapeLiveHtml(child.text);
      continue;
    }
    if (child.type === "block") {
      html += renderInset(child, state, ctx);
    }
  }
  closeAll();
  return html;
}

function insetKind(block: BlockNode): string {
  return (block.args ?? "").trim();
}

function renderInset(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  if (block.tag !== "inset") {
    if (block.tag === "layout") {
      return renderChildren(block.children, enterTraversalState(parentState), ctx);
    }
    return renderChildren(block.children, enterTraversalState(parentState), ctx);
  }
  const kind = insetKind(block);
  if (kind === "ERT") {
    warnOnce(ctx, "ERT is omitted from the Live projection (native XHTML drops it).");
    diagnostic(ctx, "ERT_OMITTED", "An ERT inset was omitted from the Live projection.");
    return "";
  }
  if (isInvisibleInset(block)) return "";
  if (kind === "Note Greyedout" || kind.startsWith("Note Greyedout")) {
    return `<aside class="note-greyedout">${renderInsetLayouts(block, parentState, ctx)}</aside>`;
  }
  if (kind === "Foot" || kind.startsWith("Foot ")) {
    ctx.footnote += 1;
    const n = ctx.footnote;
    return `<span class="foot"><span class="foot_label">${n}</span><span class="foot_inner">${renderInsetLayouts(block, parentState, ctx)}</span></span>`;
  }
  if (kind === "Formula" || kind.startsWith("Formula ") || kind.startsWith("Formula")) {
    const source = formulaSource(block);
    return `<span class="formula">${escapeLiveHtml(source)}</span>`;
  }
  if (kind === "Tabular") return renderTabular(block, parentState, ctx);
  if (kind.startsWith("Float ")) return renderFloat(block, kind, parentState, ctx);
  if (kind === "Graphics") return renderGraphics(block);
  if (kind === "Caption" || kind.startsWith("Caption ")) {
    return renderInsetLayouts(block, parentState, ctx);
  }
  if (kind.startsWith("CommandInset ")) return renderCommandInset(block, kind);
  if (kind === "Newline" || kind.startsWith("Newline ")) return "<br>";
  if (kind.startsWith("Quotes ")) {
    return escapeLiveHtml(quoteChar(kind));
  }
  if (kind.startsWith("space ") || kind === "space") return "\u00a0";
  if (kind.startsWith("Index ") || kind === "Index") return "";
  if (kind === "Text") return renderInsetLayouts(block, parentState, ctx);
  if (kind.startsWith("Flex ") || kind.startsWith("Box ") || kind.startsWith("Branch ")) {
    return renderInsetLayouts(block, parentState, ctx);
  }
  warnOnce(ctx, `Unknown inset '${kind}' rendered as an escaped fallback.`);
  diagnostic(ctx, "UNKNOWN_INSET", `Unknown inset '${kind}' rendered as an escaped fallback.`);
  const fallback = collectVisibleText(block);
  return `<span class="unknown-inset">${escapeLiveHtml(fallback)}</span>`;
}

function renderInsetLayouts(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length > 0) {
    return renderFlowItems(nested, ctx);
  }
  return renderChildren(block.children, enterTraversalState(parentState), ctx);
}

function formulaSource(block: BlockNode): string {
  const args = insetKind(block);
  if (args.startsWith("Formula") && args.length > "Formula".length) {
    return args.slice("Formula".length).trim();
  }
  return block.children
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function renderCell(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length === 0) return renderChildren(block.children, enterTraversalState(parentState), ctx);
  return nested.map((item) => renderLayoutInline(item.node, ctx)).join("");
}

function renderTabular(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const meta = block.children
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const rows = Number(/rows="(\d+)"/.exec(meta)?.[1] ?? 0);
  const cols = Number(/columns="(\d+)"/.exec(meta)?.[1] ?? 0);
  const cells = collectBlocks(block, (b) => b.tag === "inset" && insetKind(b) === "Text");
  let html = "<table><tbody>";
  const count = rows > 0 && cols > 0 ? rows * cols : cells.length;
  const usedCols = cols > 0 ? cols : Math.max(1, cells.length);
  for (let i = 0; i < count; i++) {
    if (i % usedCols === 0) html += "<tr>";
    const cell = cells[i];
    html += `<td>${cell ? renderCell(cell, parentState, ctx) : ""}</td>`;
    if (i % usedCols === usedCols - 1) html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

function renderFloat(block: BlockNode, kind: string, parentState: TraversalState, ctx: RenderCtx): string {
  const variant = kind.slice("Float ".length).trim() || "figure";
  const caption = collectBlocks(block, (b) => b.tag === "inset" && insetKind(b).startsWith("Caption"));
  const tabular = collectBlocks(block, (b) => b.tag === "inset" && insetKind(b) === "Tabular");
  const graphics = collectBlocks(block, (b) => b.tag === "inset" && insetKind(b) === "Graphics");
  let body = "";
  for (const g of graphics) body += renderGraphics(g);
  for (const t of tabular) body += renderTabular(t, parentState, ctx);
  let cap = "";
  for (const c of caption) cap += renderInsetLayouts(c, parentState, ctx);
  let prefix = "";
  if (variant === "figure") {
    ctx.figure += 1;
    prefix = `Figure ${ctx.figure}: `;
  } else if (variant === "table") {
    ctx.table += 1;
    prefix = `Table ${ctx.table}: `;
  }
  const capHtml = cap ? `<figcaption>${prefix}${cap}</figcaption>` : "";
  return `<figure class="float-${layoutSlug(variant)}">${body}${capHtml}</figure>`;
}

function renderGraphics(block: BlockNode): string {
  const filename = findProperty(block, "filename") ?? "";
  const base = filename.split(/[/\\]/).pop() ?? filename;
  return `<img data-filename="${escapeLiveHtml(base)}" alt="">`;
}

function renderCommandInset(block: BlockNode, kind: string): string {
  const subtype = kind.slice("CommandInset ".length).trim();
  const name = findProperty(block, "name") ?? "";
  const key = findProperty(block, "key") ?? "";
  if (subtype === "citation") {
    return `<span class="citation">${escapeLiveHtml(key || name)}</span>`;
  }
  if (subtype === "ref" || subtype === "pageref" || subtype === "formatted") {
    return `<span class="ref">${escapeLiveHtml(name)}</span>`;
  }
  if (subtype === "label" || subtype === "index_print" || subtype === "toc" || subtype === "nomenclature_print") {
    return "";
  }
  if (subtype === "href") {
    const target = findProperty(block, "target") ?? name;
    return `<span class="href">${escapeLiveHtml(target)}</span>`;
  }
  const visible = key || name;
  return visible ? `<span class="command-inset">${escapeLiveHtml(visible)}</span>` : "";
}

function quoteChar(kind: string): string {
  if (kind.includes("eld") || kind.includes("els")) return "‘";
  if (kind.includes("erd") || kind.includes("ers")) return "’";
  if (kind.includes("gld") || kind.includes("gls")) return "“";
  if (kind.includes("grd") || kind.includes("grs")) return "”";
  if (kind.includes("ald")) return "«";
  if (kind.includes("ard")) return "»";
  return "\"";
}

function findProperty(block: BlockNode, key: string): string | undefined {
  for (const child of block.children) {
    if (child.type === "property" && child.key === key) return child.value;
    if (child.type === "text") {
      const m = child.text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s+"?([^"\\n]+)"?`));
      if (m) return m[1].trim();
    }
    if (child.type === "block") {
      const inner = findProperty(child, key);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

function collectBlocks(root: BlockNode, pred: (b: BlockNode) => boolean): BlockNode[] {
  const out: BlockNode[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "block") {
        if (pred(n)) out.push(n);
        else walk(n.children);
      }
    }
  };
  walk(root.children);
  return out;
}

function collectVisibleText(block: BlockNode): string {
  let out = "";
  const walk = (nodes: Node[], state: TraversalState) => {
    for (const n of nodes) {
      if (n.type === "property") {
        advanceTraversalState(state, n.key, n.value);
        continue;
      }
      if (traversalRegion(state) === "deleted") continue;
      if (n.type === "text") out += n.text;
      else if (n.type === "block") {
        if (n.tag === "inset" && (insetKind(n) === "ERT" || isInvisibleInset(n))) continue;
        walk(n.children, enterTraversalState(state));
      }
    }
  };
  walk(block.children, createTraversalState());
  return out;
}

// --- Semantic comparison (shared by tests and the development oracle) ---

export interface SemNode {
  role: string;
  text?: string;
  attrs?: Record<string, string>;
  children: SemNode[];
}

const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input"]);

export function normalizeReaderHtml(html: string): SemNode {
  const parsed = parseFragment(html);
  return collapse(mapRole(parsed));
}

export function semanticEqual(a: SemNode, b: SemNode): boolean {
  return JSON.stringify(stripEmpty(a)) === JSON.stringify(stripEmpty(b));
}

export function formatSem(node: SemNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const attr = node.attrs
    ? " " + Object.entries(node.attrs).map(([k, v]) => `${k}=${v}`).join(" ")
    : "";
  const text = node.text ? ` "${node.text}"` : "";
  const lines = [`${pad}${node.role}${attr}${text}`];
  for (const c of node.children) lines.push(formatSem(c, indent + 1));
  return lines.join("\n");
}

function stripEmpty(node: SemNode): SemNode {
  const children = node.children.map(stripEmpty).filter((c) => {
    if (c.role === "text" && !c.text) return false;
    return true;
  });
  const next: SemNode = { role: node.role, children };
  if (node.text) next.text = node.text;
  if (node.attrs && Object.keys(node.attrs).length) next.attrs = node.attrs;
  return next;
}

function collapse(node: SemNode): SemNode {
  let children = node.children.map(collapse).flatMap((c) => {
    if (c.role === "wrap") return c.children;
    if (c.role === "text" && !(c.text ?? "").trim() && node.role !== "pre") return [];
    if ((node.role === "cell" || node.role === "figure") && c.role === "paragraph") return c.children;
    if (node.role === "caption" && c.role === "paragraph") return c.children;
    return [c];
  });
  if (node.role === "figure") {
    children = children.map((c) => {
      if (c.role !== "text" || !c.text) return c;
      const stripped = c.text.replace(/^(Figure|Table)\s+\d+:\s*/i, "");
      if (stripped === c.text) return c;
      return { role: "caption", children: [{ role: "text", text: stripped, children: [] }] };
    });
  }
  if (node.role === "caption") {
    for (const c of children) {
      if (c.role === "text" && c.text) {
        c.text = c.text.replace(/^(Figure|Table)\s+\d+:\s*/i, "");
      }
    }
  }
  const merged: SemNode[] = [];
  for (const c of children) {
    const last = merged[merged.length - 1];
    if (c.role === "text" && last?.role === "text") {
      last.text = (last.text ?? "") + (c.text ?? "");
    } else {
      merged.push(c);
    }
  }
  if (node.role !== "pre") {
    for (const cur of merged) {
      if (cur.role === "text" && cur.text) cur.text = collapseWs(cur.text, false);
    }
    const blocky = new Set(["list", "table", "figure", "section", "quote"]);
    if (merged[0]?.role === "text" && merged[0].text) merged[0].text = merged[0].text.trimStart();
    const last = merged[merged.length - 1];
    if (last?.role === "text" && last.text) last.text = last.text.trimEnd();
    for (let i = 0; i < merged.length; i++) {
      const cur = merged[i];
      if (cur.role !== "text" || !cur.text) continue;
      if (i > 0 && blocky.has(merged[i - 1].role)) cur.text = cur.text.trimStart();
      if (i + 1 < merged.length && blocky.has(merged[i + 1].role)) cur.text = cur.text.trimEnd();
    }
  }
  const next: SemNode = { role: node.role, children: merged };
  if (node.text) next.text = node.role === "formula" ? normalizeFormula(node.text) : collapseWs(node.text, node.role === "pre");
  if (node.attrs && Object.keys(node.attrs).length) next.attrs = node.attrs;
  if (next.text && next.role !== "pre" && next.role !== "formula") next.text = collapseWs(next.text, false);
  for (const c of next.children) {
    if (c.role === "text" && c.text && next.role !== "pre") c.text = collapseWs(c.text, false);
  }
  return next;
}

function normalizeFormula(source: string): string {
  let t = source.trim();
  if (t.startsWith("$$") && t.endsWith("$$")) {
    t = t.slice(2, -2);
  } else if (t.startsWith("\\[") && t.endsWith("\\]")) {
    t = t.slice(2, -2);
  } else if (t.startsWith("$") && t.endsWith("$") && t.length >= 2) {
    t = t.slice(1, -1);
  }
  return t.trim();
}

function collapseWs(text: string, preserve: boolean): string {
  if (preserve) return text;
  return text.replace(/[ \t\r\n]+([.,;:!?])/g, "$1").replace(/[ \t\r\n]+/g, " ");
}

function mapRole(node: SemNode): SemNode {
  const tag = node.role;
  const cls = node.attrs?.class ?? "";
  const children = node.children.map(mapRole);
  if (tag === "root") {
    if (children.length === 1 && children[0].role === "document") return children[0];
    return { role: "document", children };
  }
  if (tag === "article") return { role: "document", children };
  if (tag === "section") return { role: "section", children };
  if (/^h[1-6]$/.test(tag)) {
    return { role: "heading", attrs: { level: tag.slice(1) }, children };
  }
  if (tag === "blockquote") return { role: "quote", children };
  if (tag === "pre") return { role: "pre", children };
  if (tag === "ul") return { role: "list", attrs: { kind: "ul" }, children };
  if (tag === "ol") return { role: "list", attrs: { kind: "ol" }, children };
  if (tag === "dl") return { role: "list", attrs: { kind: "dl" }, children };
  if (tag === "li" || tag === "dd") return { role: "item", children };
  if (tag === "dt") return { role: "term", children };
  if (tag === "table") return { role: "table", children };
  if (tag === "tbody" || tag === "thead" || tag === "tfoot") return { role: "wrap", children };
  if (tag === "tr") return { role: "row", children };
  if (tag === "td" || tag === "th") return { role: "cell", children };
  if (tag === "figure") return { role: "figure", children };
  if (tag === "figcaption" || tag === "caption") return { role: "caption", children };
  if (tag === "math" || cls.split(/\s+/).includes("formula") || cls.split(/\s+/).includes("math")) {
    return { role: "formula", text: normalizeFormula(collectText({ role: tag, children, text: node.text })), children: [] };
  }
  if (cls.split(/\s+/).includes("foot") || cls.split(/\s+/).includes("foot_inner")) {
    if (cls.split(/\s+/).includes("foot_label")) {
      return { role: "footnote-label", children };
    }
    if (cls.split(/\s+/).includes("foot_inner")) {
      return { role: "footnote-body", children };
    }
    return { role: "footnote", children };
  }
  if (tag === "img") {
    const src = node.attrs?.["data-filename"] || basenameAttr(node.attrs?.src ?? "");
    return { role: "image", attrs: src ? { filename: src } : undefined, children: [] };
  }
  if (tag === "br") return { role: "break", children: [] };
  if (tag === "em" || tag === "i") return { role: "emphasis", children };
  if (tag === "strong" || tag === "b") return { role: "strong", children };
  if (tag === "u") return { role: "underline", children };
  if (tag === "s" || tag === "del") return { role: "strike", children };
  if (tag === "aside") return { role: "note", children };
  if (tag === "p" || tag === "div") {
    const classes = cls.split(/\s+/).filter(Boolean);
    if (classes.includes("float-figure") || classes.includes("float-table")) {
      return { role: "figure", children };
    }
    return { role: "paragraph", children };
  }
  if (tag === "span") {
    if (cls.split(/\s+/).includes("citation")) return { role: "citation", children };
    if (cls.split(/\s+/).includes("ref")) return { role: "ref", children };
    return { role: "wrap", children };
  }
  if (tag === "text") return { role: "text", text: node.text, children: [] };
  return { role: "wrap", children };
}

function collectText(node: SemNode): string {
  if (node.text) return node.text;
  return node.children.map(collectText).join("");
}

function basenameAttr(src: string): string {
  const clean = src.split(/[?#]/)[0];
  const base = clean.split(/[/\\]/).pop() ?? "";
  const hashed = /^(?:[a-z0-9]+_)?[a-f0-9]{8,}_(.+)$/i.exec(base);
  return hashed ? hashed[1] : base;
}

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

function parseFragment(html: string): SemNode {
  const root: SemNode = { role: "root", children: [] };
  const stack: SemNode[] = [root];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? html.length : end + 3;
        continue;
      }
      const gt = html.indexOf(">", i + 1);
      if (gt === -1) break;
      const raw = html.slice(i + 1, gt);
      const tag = parseTag(raw);
      i = gt + 1;
      if (tag.closing) {
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].role === tag.name) {
            stack.length = s;
            break;
          }
        }
        continue;
      }
      const node: SemNode = { role: tag.name, attrs: tag.attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) stack.push(node);
      continue;
    }
    const next = html.indexOf("<", i);
    const text = html.slice(i, next === -1 ? html.length : next);
    i = next === -1 ? html.length : next;
    if (text.length === 0) continue;
    stack[stack.length - 1].children.push({
      role: "text",
      text: decodeEntities(text),
      children: [],
    });
  }
  return root;
}

function parseTag(raw: string): ParsedTag {
  let s = raw.trim();
  const closing = s.startsWith("/");
  if (closing) s = s.slice(1).trim();
  const selfClosing = s.endsWith("/");
  if (selfClosing) s = s.slice(0, -1).trim();
  const m = /^([a-zA-Z][\w:-]*)/.exec(s);
  const name = (m?.[1] ?? "span").toLowerCase();
  const attrs: Record<string, string> = {};
  const rest = s.slice(name.length);
  const re = /([:@]?[\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let am: RegExpExecArray | null;
  while ((am = re.exec(rest))) {
    attrs[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
  }
  return { name, attrs, closing, selfClosing };
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", "\u00a0")
    .replaceAll("&amp;", "&");
}

