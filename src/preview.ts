/**
 * Live reader projection: lq-owned HTML for a saved .lyx file.
 *
 * The response is the M1 Live contract (dev log 129). LyX XHTML is not used
 * here; it is a development oracle in tools/xhtml_oracle.ts.
 */
import type { BlockNode, DocumentNode, Node } from "./ast.ts";
import { parse } from "./parser.ts";
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
import { formatBibliographyEntry, parseBibtex, type Citation } from "./bib.ts";
import {
  parseNewcommands,
  planFormulaLines,
  renderFormulaHtml,
  type MathMacroMap,
} from "./latex_math.ts";
import {
  extractDocumentLayoutContext,
  findLayoutFile,
  getLayoutHtmlForClass,
  getLyxUserLayoutsDir,
  resolveLayoutSearchPaths,
  type LayoutFont,
  type LayoutHtml,
} from "./schema.ts";
import {
  bindDirFromLayouts,
  imagesDirFromLayouts,
  loadShortcutMapMerged,
  lookupShortcut,
  type ShortcutMap,
} from "./bind.ts";

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
  titleFoot: number;
  figure: number;
  table: number;
  algorithm: number;
  listing: number;
  equation: number;
  chapterLabel: string;
  inTitle: boolean;
  inWrap: boolean;
  filePath?: string;
  systemDocDir?: string;
  /** `{Resources}/images` for Info icon PNG/SVGZ lookup. */
  systemImagesDir?: string;
  magickPath?: string;
  labels: Map<string, string>;
  /** Plain title/caption text for `nameref` (heading or float caption). */
  labelTitles: Map<string, string>;
  bib: Map<string, Citation>;
  citedKeys: string[];
  bibfiles: string;
  btprint: string;
  biboptions: string;
  outline: OutlineEntry[];
  layoutHtml: Map<string, LayoutHtml> | null;
  /** LFUN → key display strings from system cua.bind (Info shortcuts). */
  shortcuts: ShortcutMap | null;
  /** Preamble `\newcommand` macros for formula conversion (DL130 Step 5). */
  mathMacros: MathMacroMap | null;
  nomencl: NomenclEntry[];
  index: IndexEntry[];
  nomenclSeq: number;
  indexSeq: number;
  layoutCounters: Map<string, number>;
  /** Extra float-type counters (e.g. tableau) for FloatList / uncommon floats. */
  floatTypeCounts: Map<string, number>;
  /** Captioned floats collected during index for List of Figures/Tables. */
  floatListEntries: FloatListEntry[];
  bibitem: number;
  includeStack: string[];
  subeq: { parent: number; child: number } | null;
  /** Header `\branch` name → selected (true when `\selected 1`). */
  branches: Map<string, boolean>;
}

interface FloatListEntry {
  type: string;
  number: string;
  text: string;
  id: string;
}

interface NomenclEntry {
  symbol: string;
  desc: string;
  sort: string;
  id: string;
}

interface IndexEntry {
  terms: string[];
  see: string;
  sort: string;
  id: string;
}

type LayoutRole =
  | { kind: "heading"; tag: string; level: number }
  | { kind: "list"; tag: string; item: string }
  | { kind: "env"; tag: string; item: string }
  | { kind: "title" }
  | { kind: "front" }
  | { kind: "abstract" }
  | { kind: "omit" }
  | { kind: "flow" };

/** customHeadersFooters module — page chrome, not reader body (Live omits). */
const PAGE_CHROME = new Set([
  "Left Header",
  "Center Header",
  "Right Header",
  "Left Footer",
  "Center Footer",
  "Right Footer",
]);

interface OutlineEntry {
  level: number;
  number: string;
  text: string;
  id: string;
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
  "Enumerate-Resume": { tag: "ol", item: "li" },
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

function headingLevelFromTag(tag: string, name: string): number {
  if (tag === "h1") return name === "Part" || name === "Part*" ? -1 : 0;
  if (tag === "h2") return 1;
  if (tag === "h3") return 2;
  if (tag === "h4") return 3;
  if (tag === "h5") return 4;
  if (tag === "h6") return 5;
  return 1;
}

function roleFromHtml(name: string, spec: LayoutHtml | undefined): LayoutRole | undefined {
  if (name === "Abstract") return { kind: "abstract" };
  if (name === "Title" || spec?.htmlTitle) return { kind: "title" };
  if (PAGE_CHROME.has(name) || spec?.category === "Header/Footer") return { kind: "omit" };
  if (spec?.category === "FrontMatter") return { kind: "front" };
  const tag = spec?.htmlTag?.toLowerCase();
  if (tag && /^h[1-6]$/.test(tag)) {
    return { kind: "heading", tag, level: spec?.tocLevel ?? headingLevelFromTag(tag, name) };
  }
  if (tag === "ul" || tag === "ol" || tag === "dl") {
    return { kind: "list", tag, item: (spec?.htmlItem ?? (tag === "dl" ? "dd" : "li")).toLowerCase() };
  }
  if (tag === "blockquote" || tag === "pre") {
    return { kind: "env", tag, item: spec?.htmlItem ?? (tag === "pre" ? "NONE" : "div") };
  }
  return undefined;
}

function fallbackRole(name: string): LayoutRole {
  if (name === "Title") return { kind: "title" };
  if (name === "Abstract") return { kind: "abstract" };
  if (PAGE_CHROME.has(name)) return { kind: "omit" };
  if (name === "Author" || name === "Date" || name === "Subtitle") return { kind: "front" };
  const heading = HEADING[name];
  if (heading) return { kind: "heading", tag: heading.tag, level: heading.level };
  const list = LIST[name];
  if (list) return { kind: "list", tag: list.tag, item: list.item };
  const env = ENV[name];
  if (env) return { kind: "env", tag: env.tag, item: env.item };
  return { kind: "flow" };
}

function layoutHtmlSpec(
  name: string,
  html: Map<string, LayoutHtml> | null,
): LayoutHtml | undefined {
  if (!html) return undefined;
  return html.get(name) ??
    html.get(name.replaceAll(" ", "_")) ??
    html.get(name.replaceAll("_", " "));
}

function layoutRole(name: string, html: Map<string, LayoutHtml> | null): LayoutRole {
  return roleFromHtml(name, layoutHtmlSpec(name, html)) ?? fallbackRole(name);
}

function role(name: string, ctx: RenderCtx): LayoutRole {
  return layoutRole(name, ctx.layoutHtml);
}

function alignAttr(node: BlockNode): string {
  let value = "";
  for (const c of node.children) {
    if (c.type === "property" && c.key === "align" && c.value) {
      value = c.value.toLowerCase();
      break;
    }
  }
  if (value === "center" || value === "left" || value === "right") {
    return ` style="text-align: ${value}"`;
  }
  return "";
}

function staticLayoutLabel(name: string, ctx: RenderCtx): string {
  const spec = layoutHtmlSpec(name, ctx.layoutHtml);
  if (!spec || spec.labelType?.toLowerCase() !== "static") return "";
  let fmt = spec.labelString ?? "";
  if (fmt === name) return "";
  if (spec.labelCounter) {
    const n = (ctx.layoutCounters.get(spec.labelCounter) ?? 0) + 1;
    ctx.layoutCounters.set(spec.labelCounter, n);
    fmt = fmt.replace(/\\the[A-Za-z]+/g, String(n));
  }
  fmt = fmt.replace(/\\the[A-Za-z]+/g, "").replace(/\s+/g, " ").trim();
  if (!fmt) return "";
  return `<span class="layout-label">${escapeLiveHtml(fmt)}</span> `;
}

const LYX_COLOR: Record<string, string> = {
  red: "red",
  green: "green",
  blue: "blue",
  cyan: "cyan",
  magenta: "magenta",
  yellow: "yellow",
  black: "black",
  white: "white",
  brown: "brown",
  gray: "gray",
  grey: "gray",
  darkgray: "#404040",
  lightgray: "#c0c0c0",
  lime: "lime",
  olive: "olive",
  orange: "orange",
  pink: "pink",
  purple: "purple",
  teal: "teal",
  violet: "violet",
  darkred: "#8b0000",
  darkgreen: "#008000",
  darkblue: "#00008b",
};

function cssLyxColor(name: string): string {
  return LYX_COLOR[name.toLowerCase()] ?? name;
}

/** Map common LyX `\lang` names to HTML BCP-47 tags; unknown names pass through. */
function htmlLangFromLyx(name: string): string {
  const key = name.trim().toLowerCase();
  const map: Record<string, string> = {
    english: "en",
    american: "en-US",
    british: "en-GB",
    australian: "en-AU",
    canadian: "en-CA",
    german: "de",
    ngerman: "de",
    austrian: "de-AT",
    naustrian: "de-AT",
    french: "fr",
    francais: "fr",
    spanish: "es",
    italian: "it",
    dutch: "nl",
    portuguese: "pt",
    brazilian: "pt-BR",
    russian: "ru",
    polish: "pl",
    czech: "cs",
    slovak: "sk",
    hungarian: "hu",
    swedish: "sv",
    danish: "da",
    finnish: "fi",
    norwegian: "no",
    norsk: "no",
    nynorsk: "nn",
    greek: "el",
    hebrew: "he",
    arabic: "ar",
    chinese: "zh",
    japanese: "ja",
    korean: "ko",
    turkish: "tr",
    latin: "la",
  };
  return map[key] ?? key;
}

/** Native `fontToHtmlAttribute` size map (LyX 2.5 `output_xhtml.cpp`). */
const FONT_SIZE_CSS: Record<string, string> = {
  tiny: "x-small",
  scriptsize: "x-small",
  footnotesize: "x-small",
  small: "small",
  large: "large",
  larger: "x-large",
  largest: "x-large",
  huge: "xx-large",
  huger: "xx-large",
  increase: "larger",
  decrease: "smaller",
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
  LaTeX2e: "LaTeX2ε",
  lyx: "lyx",
  tex: "tex",
  latex: "latex",
  ldots: "…",
  dots: "…",
  endash: "–",
  emdash: "—",
  slash: "/",
  breakableslash: "\u2044",
  hyphenation: "\u00ad",
  softhyphen: "\u00ad",
  noboundry: "",
  noboundary: "",
  allowbreak: "\u200b",
  ligaturebreak: "\u200c",
  endofsentence: ".",
  menuseparator: "\u21d2",
  "menu-separator": "\u21d2",
  nobreakdash: "\u2011",
};

function specialChar(name: string): string {
  return SPECIAL_CHAR[name] ?? name;
}

function expandSpecialInText(text: string): string {
  return text.replace(/\\SpecialChar\s+(\S+)/g, (_, name: string) => specialChar(name));
}

function layoutSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "standard";
}

/** Native InsetLayout defaultCSSClass: `Flex Emph` / `Flex:Emph` → `flex_emph`. */
function flexNativeClass(kindOrName: string): string {
  const name = kindOrName.startsWith("Flex ")
    ? kindOrName.slice("Flex ".length).trim()
    : kindOrName.replace(/^Flex:/, "").trim();
  return `flex_${name
    .replace(/[()]/g, "_")
    .replace(/\./g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase()}`;
}

/** LyX `xml::cleanAttr`: non-ASCII-alnum → `_` (`sec:Section_label` → `sec_Section_label`). */
function xmlId(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_");
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

function hasStartOfAppendix(node: BlockNode): boolean {
  return node.children.some((c) => c.type === "property" && c.key === "start_of_appendix");
}

function alphabetic(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    x -= 1;
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26);
  }
  return s || "A";
}

class HeadingState {
  private readonly counts = new Map<number, number>();
  private appendix = false;
  private letterLevel: number | undefined;

  next(layout: string, level: number, startAppendix: boolean): string {
    if (layout.endsWith("*") || level > 3) return "";
    if (startAppendix && !this.appendix) {
      this.appendix = true;
      this.letterLevel = level;
      for (const key of [...this.counts.keys()]) {
        if (key >= level) this.counts.delete(key);
      }
    }
    this.counts.set(level, (this.counts.get(level) ?? 0) + 1);
    for (const key of [...this.counts.keys()]) {
      if (key > level) this.counts.delete(key);
    }
    const start = this.counts.has(0) ? 0 : this.counts.has(-1) ? -1 : 1;
    const parts: string[] = [];
    for (let l = start; l <= level; l++) {
      const n = this.counts.get(l);
      if (n === undefined) continue;
      parts.push(this.appendix && l === this.letterLevel ? alphabetic(n) : String(n));
    }
    return parts.length ? `${parts.join(".")} ` : "";
  }
}

function indexDocument(nodes: Node[], ctx: RenderCtx): void {
  const headings = new HeadingState();
  let currentHeading = "";
  let currentHeadingTitle = "";
  let currentFloatCaption = "";

  const walk = (list: Node[], floatNo: string | undefined, atBody: boolean) => {
    for (const n of list) {
      if (n.type !== "block") continue;
      if (n.tag === "deeper") {
        walk(n.children, floatNo, atBody);
        continue;
      }
      if (n.tag === "layout") {
        const layout = (n.args ?? "").trim();
        const heading = role(layout, ctx);
        if (heading.kind === "omit") continue;
        if (heading.kind === "heading") {
          currentHeading = headings.next(layout, heading.level, hasStartOfAppendix(n)).trim();
          noteChapterHeading(ctx, heading, currentHeading);
          currentHeadingTitle = headingPlainText(n);
          if (atBody) {
            const text = currentHeadingTitle;
            ctx.outline.push({
              level: heading.level,
              number: currentHeading,
              text,
              id: sectionId(currentHeading, text),
            });
          }
        }
        walk(n.children, floatNo, false);
        continue;
      }
      if (n.tag !== "inset") {
        walk(n.children, floatNo, atBody);
        continue;
      }
      const kind = insetKind(n);
      if (isInvisibleInset(n) || kind === "ERT") continue;
      if (kind.startsWith("Branch ") && !branchProducesOutput(n, ctx)) continue;
      if (kind.startsWith("Float ") || kind.startsWith("Wrap ")) {
        const variant = kind.startsWith("Float ")
          ? kind.slice("Float ".length).trim()
          : kind.slice("Wrap ".length).trim();
        const taken = takeFloatNumber(ctx, variant) ?? takeGenericFloatNumber(ctx, variant);
        noteFloatListEntry(ctx, n, variant, taken);
        const prevCap = currentFloatCaption;
        const caps = captionBlocks(n);
        // nameref for floats matches native LyXHTML ("Figure 1"), not the caption prose.
        currentFloatCaption = taken
          ? `${floatNamerefPrefix(variant)} ${taken}`
          : caps.map((c) => collectVisibleText(c)).join(" ").replace(/\s+/g, " ").trim();
        walk(n.children, taken ?? floatNo, false);
        currentFloatCaption = prevCap;
        continue;
      }
      if (kind === "listings" || kind.startsWith("listings ")) {
        const taken = listingTakesNumber(n) ? takeFloatNumber(ctx, "listing") : undefined;
        walk(n.children, taken ?? floatNo, false);
        continue;
      }
      if (kind.startsWith("CommandInset include") && includeIsListings(n)) {
        const taken = takeFloatNumber(ctx, "listing");
        const label = listingParam(findProperty(n, "lstparams") ?? "", "label");
        if (label && taken) ctx.labels.set(label, taken);
        walk(n.children, taken ?? floatNo, false);
        continue;
      }
      if (kind.startsWith("CommandInset label")) {
        const name = findProperty(n, "name");
        if (name) {
          ctx.labels.set(name, floatNo ?? currentHeading);
          const title = (currentFloatCaption || currentHeadingTitle).trim();
          if (title) ctx.labelTitles.set(name, title);
        }
        continue;
      }
      if (kind === "FormulaMacro" || kind.startsWith("FormulaMacro")) {
        continue;
      }
      if (kind.startsWith("Flex Subequations")) {
        enterSubequations(ctx);
        walkSubequationLabels(n.children, ctx);
        ctx.subeq = null;
        continue;
      }
      if (kind === "Formula" || kind.startsWith("Formula")) {
        takeFormulaNumbers(formulaSource(n), ctx);
        continue;
      }
      if (kind.startsWith("CommandInset citation")) {
        const key = findProperty(n, "key") ?? "";
        for (const k of key.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!ctx.citedKeys.includes(k)) ctx.citedKeys.push(k);
        }
      }
      if (kind.startsWith("CommandInset bibtex")) {
        ctx.bibfiles = findProperty(n, "bibfiles") ?? ctx.bibfiles;
        ctx.btprint = findProperty(n, "btprint") ?? ctx.btprint;
        ctx.biboptions = findProperty(n, "options") ?? ctx.biboptions;
      }
      if (kind === "Nomenclature" || kind.startsWith("Nomenclature ")) {
        const entry = collectNomenclEntry(n, ctx);
        if (entry.symbol || entry.desc) ctx.nomencl.push(entry);
        continue;
      }
      if (kind === "Index" || kind.startsWith("Index ")) {
        const entry = collectIndexEntry(n, ctx);
        if (entry.terms.length || entry.see) ctx.index.push(entry);
        continue;
      }
      walk(n.children, floatNo, false);
    }
  };
  walk(nodes, undefined, true);
  ctx.figure = 0;
  ctx.table = 0;
  ctx.algorithm = 0;
  ctx.listing = 0;
  ctx.equation = 0;
  ctx.chapterLabel = "";
  ctx.floatTypeCounts = new Map();
  ctx.nomenclSeq = 0;
  ctx.indexSeq = 0;
  ctx.subeq = null;
}

async function loadBibliography(ctx: RenderCtx): Promise<void> {
  if (!ctx.filePath || !ctx.bibfiles) return;
  const dir = path.dirname(ctx.filePath);
  for (const raw of ctx.bibfiles.split(/\s+/).filter(Boolean)) {
    const name = raw.toLowerCase().endsWith(".bib") ? raw : `${raw}.bib`;
    const tries = [path.resolve(dir, name)];
    if (ctx.systemDocDir) tries.push(path.resolve(ctx.systemDocDir, name));
    let loaded = false;
    for (const full of tries) {
      try {
        const parsed = parseBibtex(await Deno.readTextFile(full));
        for (const c of parsed) ctx.bib.set(c.key, c);
        loaded = true;
        break;
      } catch {
        /* try the next location */
      }
    }
    if (!loaded) warnOnce(ctx, `Could not read bibliography file '${name}'.`);
  }
}

/** Header `\branch Name` → `\selected 0|1` (missing branch = not selected). */
function documentBranches(ast: DocumentNode): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type !== "block") continue;
      if (n.tag === "branch") {
        const name = (n.args ?? "").trim();
        if (!name) continue;
        const selected = n.children.some(
          (c) => c.type === "property" && c.key === "selected" && c.value?.trim() === "1",
        );
        out.set(name, selected);
        continue;
      }
      if (n.tag === "header" || n.tag === "document") walk(n.children);
    }
  };
  walk(ast.children);
  return out;
}

/** Native `InsetBranch::producesOutput`: selected XOR inverted. */
function branchProducesOutput(block: BlockNode, ctx: RenderCtx): boolean {
  const kind = insetKind(block);
  const name = kind.startsWith("Branch ") ? kind.slice("Branch ".length).trim() : "";
  const selected = name ? (ctx.branches.get(name) ?? false) : false;
  const invertedRaw = (findProperty(block, "inverted") ?? "0").trim();
  const inverted = invertedRaw === "1" || invertedRaw.toLowerCase() === "true";
  return selected !== inverted;
}

/**
 * Require `{textclass}.layout` on the search path. Hardcoded role floor is only
 * for Styles that load but lack HTML keys — not a substitute for a missing class file.
 */
async function loadLayoutHtml(
  ast: DocumentNode,
  searchPaths: string[],
): Promise<Map<string, LayoutHtml>> {
  const ctx = extractDocumentLayoutContext(ast);
  if (!ctx.textclass) {
    throw Object.assign(
      new Error("Could not determine textclass from the document."),
      { code: "NO_TEXTCLASS" },
    );
  }
  if (searchPaths.length === 0) {
    throw Object.assign(
      new Error(
        `Layout file not found for textclass '${ctx.textclass}' (no layout search paths). ` +
          "Install LyX or set --layouts-dir / config layoutsDir.",
      ),
      { code: "LAYOUT_NOT_FOUND" },
    );
  }
  const classFile = await findLayoutFile(`${ctx.textclass}.layout`, searchPaths);
  if (!classFile) {
    throw Object.assign(
      new Error(
        `Layout file not found for textclass '${ctx.textclass}' in: ${searchPaths.join(", ")}. ` +
          "Install LyX layouts, add a LyX user-dir layout, or set layoutsDir.",
      ),
      { code: "LAYOUT_NOT_FOUND" },
    );
  }
  return await getLayoutHtmlForClass(
    ctx.textclass,
    searchPaths,
    ctx.modules,
    ctx.local,
  );
}

export async function renderLiveHtml(
  ast: DocumentNode,
  options: {
    filePath?: string;
    /** @deprecated Prefer overlayLayoutsDir; treated as sole search path when set alone for tests. */
    layoutsDir?: string;
    overlayLayoutsDir?: string;
    systemLayoutsDir?: string;
  } = {},
): Promise<{ html: string; warnings: string[]; diagnostics: LiveDiagnostic[] }> {
  let searchPaths: string[];
  let systemLayoutsDir: string | undefined;
  if (options.layoutsDir && !options.overlayLayoutsDir && !options.systemLayoutsDir) {
    // Legacy/test: single directory search path.
    searchPaths = [options.layoutsDir];
    systemLayoutsDir = options.layoutsDir;
  } else {
    try {
      const roots = await resolveLayoutSearchPaths({
        overlayLayoutsDir: options.overlayLayoutsDir,
        systemLayoutsDir: options.systemLayoutsDir,
      });
      searchPaths = roots.searchPaths;
      systemLayoutsDir = roots.system;
    } catch {
      searchPaths = [];
      systemLayoutsDir = undefined;
    }
  }
  const ctx: RenderCtx = {
    warnings: [],
    diagnostics: [],
    footnote: 0,
    titleFoot: 0,
    figure: 0,
    table: 0,
    algorithm: 0,
    listing: 0,
    equation: 0,
    chapterLabel: "",
    inTitle: false,
    inWrap: false,
    filePath: options.filePath,
    systemDocDir: systemLayoutsDir ? path.resolve(systemLayoutsDir, "..", "doc") : undefined,
    systemImagesDir: imagesDirFromLayouts(systemLayoutsDir),
    magickPath: findMagick(systemLayoutsDir),
    labels: new Map(),
    labelTitles: new Map(),
    bib: new Map(),
    citedKeys: [],
    bibfiles: "",
    btprint: "",
    biboptions: "",
    outline: [],
    layoutHtml: await loadLayoutHtml(ast, searchPaths),
    shortcuts: await loadShortcutMapMerged(
      bindDirFromLayouts(systemLayoutsDir),
      bindDirFromLayouts(await getLyxUserLayoutsDir(systemLayoutsDir)),
    ),
    mathMacros: extractMathMacros(ast),
    nomencl: [],
    index: [],
    nomenclSeq: 0,
    indexSeq: 0,
    layoutCounters: new Map(),
    floatTypeCounts: new Map(),
    floatListEntries: [],
    subeq: null,
    bibitem: 0,
    includeStack: [],
    branches: documentBranches(ast),
  };
  indexDocument(findBody(ast), ctx);
  await loadBibliography(ctx);
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
  options: { overlayLayoutsDir?: string; systemLayoutsDir?: string } = {},
): Promise<LiveRenderResult> {
  const rendered = await renderLiveHtml(ast, {
    filePath: path.resolve(filePath),
    overlayLayoutsDir: options.overlayLayoutsDir,
    systemLayoutsDir: options.systemLayoutsDir,
  });
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



function sectionId(number: string, text: string): string {
  const n = number.trim();
  if (n) return `sec-${n.replaceAll(".", "-")}`;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `sec-${slug || "x"}`;
}

function isOmittedInsetKind(kind: string): boolean {
  return (
    kind === "ERT" ||
    kind === "Index" || kind.startsWith("Index ") ||
    kind.startsWith("IndexMacro") ||
    kind === "Nomenclature" || kind.startsWith("Nomenclature ") ||
    kind === "Argument" || kind.startsWith("Argument ") ||
    kind.startsWith("CommandInset label") ||
    kind === "FormulaMacro" || kind.startsWith("FormulaMacro") ||
    kind === "Phantom" || kind.startsWith("Phantom ")
  );
}

function headingPlainText(layout: BlockNode): string {
  const short = argumentText(layout, "1");
  if (short) return short.replace(/\s+/g, " ").trim();
  let out = "";
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        if (!isStatusLine(n.text)) out += expandSpecialInText(n.text);
      } else if (n.type === "property" && n.key === "SpecialChar") out += specialChar(n.value ?? "");
      else if (n.type === "block") {
        if (n.tag === "inset" && isOmittedInsetKind(insetKind(n))) continue;
        walk(n.children);
      }
    }
  };
  walk(layout.children);
  return out.replace(/\s+/g, " ").trim();
}

function renderFlowItems(items: FlowItem[], ctx: RenderCtx): string {
  let i = 0;
  let html = "";
  const openLevels: number[] = [];
  const headings = new HeadingState();

  const closeSections = (level: number) => {
    while (openLevels.length > 0 && openLevels[openLevels.length - 1] >= level) {
      html += "</section>";
      openLevels.pop();
    }
  };

  while (i < items.length) {
    const item = items[i];
    const layout = role(item.layout, ctx);
    if (layout.kind === "omit") {
      i++;
      continue;
    }
    if (layout.kind === "title") {
      html += `<h1 class="title">${renderLayoutInline(item.node, ctx, true)}</h1>`;
      i++;
      continue;
    }
    if (layout.kind === "front") {
      html += `<div class="${layoutSlug(item.layout)}">${renderLayoutInline(item.node, ctx, true)}</div>`;
      i++;
      continue;
    }
    if (layout.kind === "abstract") {
      const [chunk, next] = renderAbstract(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    if (layout.kind === "heading") {
      closeSections(layout.level);
      const number = headings.next(item.layout, layout.level, hasStartOfAppendix(item.node));
      noteChapterHeading(ctx, layout, number);
      const text = headingPlainText(item.node);
      const id = sectionId(number, text);
      html += `<section id="${escapeLiveHtml(id)}"><${layout.tag}>${number}${renderLayoutInline(item.node, ctx)}</${layout.tag}>`;
      openLevels.push(layout.level);
      i++;
      continue;
    }
    if (layout.kind === "list") {
      const [chunk, next] = renderList(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    if (layout.kind === "env") {
      const [chunk, next] = renderEnv(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    if (item.layout === "Bibliography") {
      const [chunk, next] = renderBibEnv(items, i, ctx);
      html += chunk;
      i = next;
      continue;
    }
    if (item.layout === "Initial") {
      html += renderInitial(item.node, ctx);
      i++;
      continue;
    }
    const inner = renderLayoutInline(item.node, ctx);
    if (inner.trim().length === 0) {
      i++;
      continue;
    }
    // Promote bare figures (and DL131 disclosed floats) out of Standard wrappers.
    const trimmedInner = inner.trim();
    if (
      /^<figure\b[\s\S]*<\/figure>$/.test(trimmedInner) ||
      /^<details\b[^>]*\bfloat\b[^>]*>[\s\S]*<\/details>$/.test(trimmedInner) ||
      /^<details\b[^>]*\bwrap\b[^>]*>[\s\S]*<\/details>$/.test(trimmedInner)
    ) {
      html += inner;
    } else {
      const firstOfRun = i === 0 ||
        items[i - 1].layout !== item.layout ||
        items[i - 1].depth !== item.depth;
      const label = firstOfRun ? staticLayoutLabel(item.layout, ctx) : "";
      html += `<div class="${layoutSlug(item.layout)}"${alignAttr(item.node)}>${label}${inner}</div>`;
    }
    i++;
  }
  closeSections(-999);
  return html;
}

function isListLayout(name: string, ctx: RenderCtx): boolean {
  return role(name, ctx).kind === "list";
}

const ENUM_CLASS = ["enumi", "enumii", "enumiii", "enumiv"] as const;

function snapshotCounters(ctx: RenderCtx) {
  return {
    footnote: ctx.footnote,
    titleFoot: ctx.titleFoot,
    figure: ctx.figure,
    table: ctx.table,
    algorithm: ctx.algorithm,
    listing: ctx.listing,
    equation: ctx.equation,
    nomenclSeq: ctx.nomenclSeq,
    indexSeq: ctx.indexSeq,
    bibitem: ctx.bibitem,
    layoutCounters: new Map(ctx.layoutCounters),
    floatTypeCounts: new Map(ctx.floatTypeCounts),
    subeq: ctx.subeq ? { ...ctx.subeq } : null,
  };
}

function restoreCounters(ctx: RenderCtx, snap: ReturnType<typeof snapshotCounters>): void {
  ctx.footnote = snap.footnote;
  ctx.titleFoot = snap.titleFoot;
  ctx.figure = snap.figure;
  ctx.table = snap.table;
  ctx.algorithm = snap.algorithm;
  ctx.listing = snap.listing;
  ctx.equation = snap.equation;
  ctx.nomenclSeq = snap.nomenclSeq;
  ctx.indexSeq = snap.indexSeq;
  ctx.bibitem = snap.bibitem;
  ctx.layoutCounters = snap.layoutCounters;
  ctx.floatTypeCounts = snap.floatTypeCounts;
  ctx.subeq = snap.subeq;
}

function isSkippableFlow(item: FlowItem, ctx: RenderCtx): boolean {
  if (role(item.layout, ctx).kind !== "flow") return false;
  const snap = snapshotCounters(ctx);
  try {
    return renderLayoutInline(item.node, ctx).trim().length === 0;
  } finally {
    restoreCounters(ctx, snap);
  }
}

function listOpenTag(spec: { tag: string }, layout: string, enumDepth: number): string {
  if (layout === "Description" || spec.tag === "dl") return '<dl class="description">';
  if (spec.tag === "ol") return `<ol class="${ENUM_CLASS[Math.min(enumDepth, ENUM_CLASS.length - 1)]}">`;
  return `<${spec.tag}>`;
}

function renderList(
  items: FlowItem[],
  start: number,
  ctx: RenderCtx,
  enumDepth = 0,
): [string, number] {
  const first = items[start];
  const spec = role(first.layout, ctx);
  if (spec.kind !== "list") return ["", start];
  const depth = first.depth;
  const childEnum = spec.tag === "ol" ? enumDepth + 1 : enumDepth;
  let i = start;
  let html = listOpenTag(spec, first.layout, enumDepth);
  const nestFrom = (at: number): [string, number] => renderList(items, at, ctx, childEnum);
  while (i < items.length) {
    const item = items[i];
    if (item.depth < depth) break;
    if (item.depth === depth) {
      if (item.layout !== first.layout) {
        if (isSkippableFlow(item, ctx)) {
          i++;
          continue;
        }
        break;
      }
      if (first.layout === "Description" || spec.tag === "dl") {
        const { label, rest } = splitDescription(item.node, ctx);
        html += `<dt>${label}</dt><dd>${rest}`;
        i++;
        while (i < items.length && items[i].depth > depth) {
          if (isSkippableFlow(items[i], ctx)) {
            i++;
            continue;
          }
          if (!isListLayout(items[i].layout, ctx)) break;
          const [nested, next] = nestFrom(i);
          html += nested;
          i = next;
        }
        html += "</dd>";
      } else {
        html += `<${spec.item}>${renderLayoutInline(item.node, ctx)}`;
        i++;
        while (i < items.length && items[i].depth > depth) {
          if (isSkippableFlow(items[i], ctx)) {
            i++;
            continue;
          }
          if (!isListLayout(items[i].layout, ctx)) break;
          const [nested, next] = nestFrom(i);
          html += nested;
          i = next;
        }
        html += `</${spec.item}>`;
      }
    } else if (isSkippableFlow(item, ctx)) {
      i++;
    } else if (isListLayout(item.layout, ctx)) {
      const [nested, next] = nestFrom(i);
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
  const spec = role(first.layout, ctx);
  if (spec.kind !== "env") return ["", start];
  const cls = ` class="${layoutSlug(first.layout)}"`;
  let i = start;
  if (spec.item === "NONE") {
    let body = "";
    while (i < items.length && items[i].layout === first.layout && items[i].depth === first.depth) {
      if (body) body += "\n";
      body += renderLayoutInline(items[i].node, ctx);
      i++;
    }
    return [`<${spec.tag}${cls}>${body}</${spec.tag}>`, i];
  }
  let html = `<${spec.tag}${cls}>`;
  while (i < items.length && items[i].layout === first.layout && items[i].depth === first.depth) {
    html += `<${spec.item}>${renderLayoutInline(items[i].node, ctx)}</${spec.item}>`;
    i++;
  }
  html += `</${spec.tag}>`;
  return [html, i];
}

function splitDescription(layout: BlockNode, ctx: RenderCtx): { label: string; rest: string } {
  let label = "";
  let rest = "";
  let inRest = false;
  const walk = (nodes: Node[], state: TraversalState) => {
    for (const n of nodes) {
      if (n.type === "property") {
        if (inRest && n.key === "SpecialChar") {
          if (traversalRegion(state) !== "deleted") rest += escapeLiveHtml(specialChar(n.value ?? ""));
          continue;
        }
        if (inRest && n.key === "backslash") {
          if (traversalRegion(state) !== "deleted") rest += "\\";
          continue;
        }
        advanceTraversalState(state, n.key, n.value);
        continue;
      }
      if (traversalRegion(state) === "deleted") continue;
      if (inRest) {
        if (n.type === "text") rest += escapeLiveHtml(expandSpecialInText(n.text));
        else if (n.type === "block") rest += renderInset(n, state, ctx);
        continue;
      }
      if (n.type === "text") {
        const cut = n.text.search(/[ \t]/);
        if (cut === -1) {
          label += escapeLiveHtml(n.text);
        } else {
          label += escapeLiveHtml(n.text.slice(0, cut));
          const tail = n.text.slice(cut + 1);
          if (tail) rest += escapeLiveHtml(expandSpecialInText(tail));
          inRest = true;
        }
        continue;
      }
      if (n.type === "block") {
        const kind = n.tag === "inset" ? insetKind(n) : "";
        if (kind === "space" || kind.startsWith("space ")) {
          label += "\u00a0";
          continue;
        }
        if (n.tag === "inset" && (isOmittedInsetKind(kind) || isInvisibleInset(n))) {
          if (
            kind === "Index" || kind.startsWith("Index ") ||
            kind === "Nomenclature" || kind.startsWith("Nomenclature ")
          ) {
            label += renderInset(n, state, ctx);
          }
          continue;
        }
        if (n.tag === "inset") {
          label += renderInset(n, state, ctx);
          continue;
        }
        walk(n.children, enterTraversalState(state));
      }
    }
  };
  walk(layout.children, createTraversalState());
  return {
    label: label.replace(/^\s+|\s+$/g, ""),
    rest: rest.trim(),
  };
}

function renderAbstract(items: FlowItem[], start: number, ctx: RenderCtx): [string, number] {
  let i = start;
  let html = `<div class="abstract"><span class="abstract_label">Abstract</span>`;
  while (i < items.length && items[i].layout === "Abstract" && items[i].depth === items[start].depth) {
    html += `<div class="abstract_item">${renderLayoutInline(items[i].node, ctx, true)}</div>`;
    i++;
  }
  html += "</div>";
  return [html, i];
}

const TITLE_MARKS = ["*", "†", "‡", "§", "¶", "‖", "**", "††"];

function renderLayoutInline(layout: BlockNode, ctx: RenderCtx, inTitle = false): string {
  const prev = ctx.inTitle;
  if (inTitle) ctx.inTitle = true;
  try {
    return renderChildren(layout.children, createTraversalState(), ctx);
  } finally {
    ctx.inTitle = prev;
  }
}

function renderChildren(children: Node[], state: TraversalState, ctx: RenderCtx): string {
  let html = "";
  const open: string[] = [];

  const closeAll = () => {
    while (open.length) {
      const k = open.pop()!;
      html += (INLINE[k] ?? { close: "</span>" }).close;
    }
  };

  const INLINE: Record<string, { open: string; close: string }> = {
    em: { open: "<em>", close: "</em>" },
    strong: { open: "<strong>", close: "</strong>" },
    u: { open: "<u>", close: "</u>" },
    dline: { open: '<u class="dline">', close: "</u>" },
    wline: { open: '<u class="wline">', close: "</u>" },
    s: { open: "<s>", close: "</s>" },
    typewriter: { open: '<span class="typewriter">', close: "</span>" },
    sans: { open: '<span class="sans">', close: "</span>" },
    noun: { open: '<span class="noun">', close: "</span>" },
  };

  const setInline = (key: string, want: boolean) => {
    const spec = INLINE[key];
    if (!spec) return;
    const idx = open.lastIndexOf(key);
    if (want && idx === -1) {
      html += spec.open;
      open.push(key);
    } else if (!want && idx !== -1) {
      while (open.length > idx) {
        const k = open.pop()!;
        html += (INLINE[k] ?? { close: `</${k}>` }).close;
      }
    }
  };

  const syncFont = () => {
    const p = state.properties;
    // Native XHTML: italic → <em>; slanted → font-style:oblique; smallcaps → font-variant:small-caps
    setInline("em", p.emph === "on" || p.shape === "italic");
    setInline("strong", p.series === "bold");
    setInline("u", p.bar === "under");
    setInline("dline", p.uuline === "on");
    setInline("wline", p.uwave === "on");
    setInline("s", p.strikeout === "on" || p.xout === "on");
    setInline("typewriter", p.family === "typewriter");
    setInline("sans", p.family === "sans");
    setInline("noun", p.noun === "on");
    const langRaw = (p.lang ?? "").trim();
    const langCode = langRaw ? htmlLangFromLyx(langRaw) : "";
    const langKey = langCode ? `lang:${langCode}` : "";
    const langIdx = open.findIndex((k) => k.startsWith("lang:"));
    if (langIdx !== -1 && open[langIdx] !== langKey) {
      while (open.length > langIdx) {
        const k = open.pop()!;
        html += (INLINE[k] ?? { close: "</span>" }).close;
      }
    }
    if (langCode && !open.includes(langKey)) {
      html += `<span lang="${escapeLiveHtml(langCode)}">`;
      open.push(langKey);
    }
    const raw = (p.color ?? "").toLowerCase();
    const wantColor = raw !== "" && raw !== "none" && raw !== "inherit" && raw !== "default" && raw !== "ignore";
    const colorKey = wantColor ? `color:${raw}` : "";
    const colorIdx = open.findIndex((k) => k.startsWith("color:"));
    if (colorIdx !== -1 && open[colorIdx] !== colorKey) {
      while (open.length > colorIdx) {
        const k = open.pop()!;
        html += (INLINE[k] ?? { close: "</span>" }).close;
      }
    }
    if (wantColor && !open.includes(colorKey)) {
      html += `<span style="color: ${escapeLiveHtml(cssLyxColor(raw))}">`;
      open.push(colorKey);
    }
    const size = (p.size ?? "").toLowerCase();
    const sizeCss = FONT_SIZE_CSS[size];
    const sizeKey = sizeCss ? `size:${size}` : "";
    const sizeIdx = open.findIndex((k) => k.startsWith("size:"));
    if (sizeIdx !== -1 && open[sizeIdx] !== sizeKey) {
      while (open.length > sizeIdx) {
        const k = open.pop()!;
        html += (INLINE[k] ?? { close: "</span>" }).close;
      }
    }
    if (sizeCss && !open.includes(sizeKey)) {
      html += `<span style="font-size: ${sizeCss}">`;
      open.push(sizeKey);
    }
    const shape = (p.shape ?? "").toLowerCase();
    const shapeCss = shape === "slanted"
      ? "font-style: oblique"
      : shape === "smallcaps"
      ? "font-variant: small-caps"
      : "";
    const shapeKey = shapeCss ? `shape:${shape}` : "";
    const shapeIdx = open.findIndex((k) => k.startsWith("shape:"));
    if (shapeIdx !== -1 && open[shapeIdx] !== shapeKey) {
      while (open.length > shapeIdx) {
        const k = open.pop()!;
        html += (INLINE[k] ?? { close: "</span>" }).close;
      }
    }
    if (shapeCss && !open.includes(shapeKey)) {
      html += `<span style="${shapeCss}">`;
      open.push(shapeKey);
    }
  };

  for (const child of children) {
    if (child.type === "property") {
      if (SKIP_LAYOUT_PROPS.has(child.key)) continue;
      if (child.key === "SpecialChar") {
        if (traversalRegion(state) === "deleted") continue;
        html += escapeLiveHtml(specialChar(child.value ?? ""));
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
        child.key === "uuline" || child.key === "uwave" || child.key === "noun" ||
        child.key === "family" || child.key === "color" || child.key === "size"
      ) {
        syncFont();
      }
      continue;
    }
    if (traversalRegion(state) === "deleted") continue;
    if (child.type === "text") {
      html += escapeLiveHtml(expandSpecialInText(child.text));
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
  // Live shows Note/Comment as click-disclosable private notes (DL131); query still uses isInvisibleInset.
  if (kind === "Note Note" || kind === "Note Comment") {
    const label = kind === "Note Comment" ? "Comment" : "Note";
    const cls = kind === "Note Comment" ? "note-comment" : "note-note";
    const inner = renderInsetLayouts(block, parentState, ctx);
    return wrapDisclosure(`note ${cls}`, label, inner);
  }
  if (isInvisibleInset(block)) return "";
  if (kind === "Note Greyedout" || kind.startsWith("Note Greyedout")) {
    return `<span class="note_greyedout" style="color:#A0A0A0">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  if (kind === "Foot" || kind.startsWith("Foot ")) {
    if (ctx.inTitle) {
      const mark = TITLE_MARKS[ctx.titleFoot] ?? "*".repeat(ctx.titleFoot + 1);
      ctx.titleFoot += 1;
      return wrapDisclosure(
        "foot foot_intitle",
        mark,
        renderFootInner(block, parentState, ctx),
        { summaryClass: "foot_intitle_label", bodyClass: "foot_intitle_inner" },
      );
    }
    ctx.footnote += 1;
    const n = ctx.footnote;
    return wrapDisclosure(
      "foot",
      String(n),
      renderInsetLayouts(block, parentState, ctx),
      { summaryClass: "foot_label", bodyClass: "foot_inner" },
    );
  }
  if (kind === "FormulaMacro" || kind.startsWith("FormulaMacro")) {
    return "";
  }
  if (kind === "Formula" || kind.startsWith("Formula ") || kind.startsWith("Formula")) {
    const source = formulaSource(block);
    return renderFormulaHtml(source, takeFormulaNumbers(source, ctx), ctx.mathMacros ?? undefined);
  }
  if (
    kind === "Newpage" || kind.startsWith("Newpage ") ||
    kind === "VSpace" || kind.startsWith("VSpace ") ||
    kind === "Separator" || kind.startsWith("Separator ") ||
    kind === "Argument" || kind.startsWith("Argument ") ||
    kind === "Phantom" || kind.startsWith("Phantom ")
  ) {
    return "";
  }
  if (kind === "Info" || kind.startsWith("Info ")) {
    return renderInfo(block, ctx);
  }
  if (kind === "Tabular") return renderTabular(block, parentState, ctx);
  if (kind.startsWith("Float ")) return renderFloat(block, kind, parentState, ctx);
  if (kind === "Marginal" || kind.startsWith("Marginal ")) {
    return wrapDisclosure(
      "marginal",
      "Margin note",
      renderInsetLayouts(block, parentState, ctx),
    );
  }
  if (kind.startsWith("Wrap ")) return renderWrap(block, parentState, ctx);
  if (kind === "listings" || kind.startsWith("listings ")) {
    return renderListings(block, parentState, ctx);
  }
  if (kind === "External" || kind.startsWith("External ")) {
    return renderGraphics(block, ctx);
  }
  if (kind === "Graphics") return renderGraphics(block, ctx);
  if (kind === "Caption" || kind.startsWith("Caption ")) {
    const type = captionTypeFromKind(kind);
    const inner = renderInsetLayouts(block, parentState, ctx);
    return `<span class="float-caption-${escapeLiveHtml(type)}">${inner}</span>`;
  }
  if (kind.startsWith("CommandInset include") || kind.startsWith("CommandInset input")) {
    return renderInclude(block, ctx);
  }
  if (kind.startsWith("CommandInset ")) return renderCommandInset(block, kind, ctx);
  if (kind === "Newline" || kind.startsWith("Newline ")) return "<br>";
  if (kind.startsWith("Quotes ")) {
    return escapeLiveHtml(quoteChar(kind));
  }
  if (kind.startsWith("space ") || kind === "space") return spaceChar(kind);
  if (kind.startsWith("Index ") || kind === "Index") return renderIndexAnchor(ctx);
  if (kind.startsWith("IndexMacro ") || kind === "IndexMacro") return "";
  if (kind === "Nomenclature" || kind.startsWith("Nomenclature ")) return renderNomenclAnchor(ctx);
  if (kind === "Preview" || kind.startsWith("Preview ")) {
    return `<div class="preview">${renderInsetLayouts(block, parentState, ctx)}</div>`;
  }
  if (kind.startsWith("script ")) {
    const tag = kind.includes("superscript") ? "sup" : kind.includes("subscript") ? "sub" : "";
    if (tag) return `<${tag}>${renderFlexInline(block, ctx)}</${tag}>`;
  }
  if (kind === "Text") return renderInsetLayouts(block, parentState, ctx);
  if (kind === "Flex Noun" || kind.startsWith("Flex Noun")) {
    // logicalmkup sets HTMLClass "noun" (not the default flex_noun).
    return `<span class="noun">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind === "Flex Code" || kind.startsWith("Flex Code")) {
    return `<code class="${flexNativeClass(kind)}">${renderFlexInline(block, ctx)}</code>`;
  }
  if (kind === "Flex Emph" || kind.startsWith("Flex Emph")) {
    return `<em class="${flexNativeClass(kind)}">${renderFlexInline(block, ctx)}</em>`;
  }
  if (kind === "Flex Strong" || kind.startsWith("Flex Strong")) {
    return `<strong class="${flexNativeClass(kind)}">${renderFlexInline(block, ctx)}</strong>`;
  }
  if (kind.startsWith("Flex Multiple")) {
    const cols = argumentText(block, "1") || "2";
    const n = /^\d+$/.test(cols.trim()) ? cols.trim() : "2";
    const preface = argumentText(block, "2");
    const body = renderInsetLayouts(block, parentState, ctx);
    const head = preface ? `<div class="multicol-preface">${escapeLiveHtml(preface)}</div>` : "";
    const box = `${head}<div class="${flexNativeClass(kind)}" style="column-count: ${escapeLiveHtml(n)}">${body}</div>`;
    return wrapDisclosure("flex-container multicol", "Columns", box);
  }
  if (kind.startsWith("Flex Rotatebox")) {
    const angle = argumentText(block, "2") || "0";
    return `<span class="${flexNativeClass(kind)}" style="display:inline-block;transform:rotate(${escapeLiveHtml(angle)}deg)">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex Scalebox")) {
    const h = argumentText(block, "1") || "1";
    const v = argumentText(block, "2") || h;
    return `<span class="${flexNativeClass(kind)}" style="display:inline-block;transform:scale(${escapeLiveHtml(h)}, ${escapeLiveHtml(v)})">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex Resizebox")) {
    const w = argumentText(block, "1");
    const h = argumentText(block, "2");
    const styles: string[] = ["display:inline-block"];
    if (w) styles.push(`width:${w}`);
    if (h && h !== "!") styles.push(`height:${h}`);
    return `<span class="${flexNativeClass(kind)}" style="${escapeLiveHtml(styles.join(";"))}">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex Reflectbox")) {
    return `<span class="${flexNativeClass(kind)}" style="display:inline-block;transform:scaleX(-1)">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex Minipage")) {
    // varwidth.module MultiPar Flex — native default HTMLTag is div; Argument 2 is max width.
    const maxW = argumentText(block, "2").trim();
    const css = maxW && !maxW.startsWith("\\") ? widthToCss(maxW) : "";
    const style = css ? ` style="max-width: ${escapeLiveHtml(css)}"` : "";
    const box = `<div class="${flexNativeClass(kind)}"${style}>${renderInsetLayouts(block, parentState, ctx)}</div>`;
    return wrapDisclosure("flex-container minipage", "Minipage", box);
  }
  if (kind === "Flex URL" || kind.startsWith("Flex URL")) {
    // Native: outer span.flex_url + HTMLInnerTag a (stdinsets.inc).
    const url = flattenFlow(block.children, 0).map((item) => collectVisibleText(item.node)).join("").trim();
    return `<span class="flex_url"><a href="${escapeLiveHtml(url)}">${escapeLiveHtml(url)}</a></span>`;
  }
  // Beamer charstyles (Font Color only in layout; no HTMLTag).
  if (kind === "Flex Alert" || kind.startsWith("Flex Alert ")) {
    return `<span class="alert" style="color: #cc0000">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind === "Flex Structure" || (kind.startsWith("Flex Structure ") && !kind.startsWith("Flex Structure Tree"))) {
    return `<span class="structure" style="color: #0000aa">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind === "Flex Only" || kind.startsWith("Flex Only ")) {
    return `<span class="only">${renderFlexInline(block, ctx)}</span>`;
  }
  // Tufte charstyles / notes.
  if (kind.startsWith("Flex NewThought") || kind.startsWith("Flex SmallCaps")) {
    return `<span class="smallcaps" style="font-variant: small-caps">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex AllCaps")) {
    return `<span class="noun allcaps" style="text-transform: uppercase">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex Sidenote") || kind.startsWith("Flex Marginnote")) {
    const cls = kind.includes("Marginnote") ? "marginnote" : "sidenote";
    const label = kind.includes("Marginnote") ? "Margin note" : "Sidenote";
    const aside = `<aside class="${cls} marginal">${renderInsetLayouts(block, parentState, ctx)}</aside>`;
    return wrapDisclosure(`flex-container ${cls}`, label, aside);
  }
  // tcolorbox.module — DocBook phrase role; Live uses a bordered box.
  if (kind.startsWith("Flex ") && kind.includes("Color Box")) {
    const box = `<div class="color-box">${renderInsetLayouts(block, parentState, ctx)}</div>`;
    return wrapDisclosure("flex-container color-box", "Color Box", box);
  }
  // Literate / specialty Flex insets — semantic wrappers (not UNKNOWN; not bare passthrough).
  if (kind.startsWith("Flex Chunk")) {
    const title = argumentText(block, "1").trim();
    const head = title ? `<div class="chunk-title">${escapeLiveHtml(title)}</div>` : "";
    const box = `<div class="chunk">${head}<pre class="chunk-body">${renderInsetLayouts(block, parentState, ctx)}</pre></div>`;
    return wrapDisclosure("flex-container chunk", title || "Chunk", box);
  }
  if (kind.startsWith("Flex Structure Tree")) {
    return `<pre class="structure-tree">${escapeLiveHtml(collectVisibleText(block))}</pre>`;
  }
  if (kind.startsWith("Flex LilyPond")) {
    return `<pre class="lilypond">${escapeLiveHtml(collectVisibleText(block))}</pre>`;
  }
  if (kind.startsWith("Flex ChessBoard")) {
    const box = `<div class="chessboard">${renderInsetLayouts(block, parentState, ctx)}</div>`;
    return wrapDisclosure("flex-container chessboard", "Chess board", box);
  }
  if (kind.startsWith("Flex Mainline")) {
    return `<span class="chess-mainline">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex H-P number")) {
    return `<span class="hp-number">${renderFlexInline(block, ctx)}</span>`;
  }
  if (kind.startsWith("Flex H-P statement")) {
    return `<span class="hp-statement">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  if (kind.startsWith("Flex LandscapeSlide")) {
    const box = `<div class="landscape-slide">${renderInsetLayouts(block, parentState, ctx)}</div>`;
    return wrapDisclosure("flex-container landscape-slide", "Slide", box);
  }
  if (kind.startsWith("Flex tablenotemark")) {
    return `<sup class="tablenotemark">${renderFlexInline(block, ctx)}</sup>`;
  }
  if (
    kind.startsWith("Flex PDF-Annotation") ||
    kind.startsWith("Flex PDF-Markup") ||
    kind.startsWith("Flex PDF-Comment") ||
    kind.startsWith("Flex PDF-Margin")
  ) {
    const cls = layoutSlug(kind.slice("Flex ".length));
    const aside = `<aside class="pdf-comment ${cls}">${renderInsetLayouts(block, parentState, ctx)}</aside>`;
    return wrapDisclosure(`flex-container pdf-comment ${cls}`, "PDF comment", aside);
  }
  if (
    kind.startsWith("Flex PDFAction") ||
    kind.startsWith("Flex TextField") ||
    kind.startsWith("Flex ChoiceMenu") ||
    kind.startsWith("Flex PushButton") ||
    kind.startsWith("Flex CheckBox") ||
    kind.startsWith("Flex SubmitButton") ||
    kind.startsWith("Flex ResetButton")
  ) {
    const cls = layoutSlug(kind.slice("Flex ".length));
    return `<span class="pdf-form ${cls}">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  if (kind.startsWith("Box ")) {
    return renderBox(block, kind, parentState, ctx);
  }
  if (kind.startsWith("Flex Subequations")) {
    enterSubequations(ctx);
    try {
      const box = `<div class="subequations">${renderInsetLayouts(block, parentState, ctx)}</div>`;
      return wrapDisclosure("flex-container subequations", "Subequations", box);
    } finally {
      ctx.subeq = null;
    }
  }
  if (kind === "IPA" || kind.startsWith("IPA ")) {
    // Native InsetIPA::xhtml → InsetText::xhtml (children only).
    return `<span class="ipa">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  if (kind.startsWith("IPADeco")) {
    return renderIpaDeco(block, parentState, ctx);
  }
  if (kind === "FloatList" || kind.startsWith("FloatList ")) {
    return renderFloatList(kind, ctx);
  }
  if (kind.startsWith("Branch ")) {
    if (!branchProducesOutput(block, ctx)) return "";
    const name = kind.slice("Branch ".length).trim() || "Branch";
    return wrapDisclosure(
      "branch",
      `Branch ${name}`,
      renderInsetLayouts(block, parentState, ctx),
    );
  }
  if (kind.startsWith("Flex ")) {
    return renderFlexDefault(kind, block, parentState, ctx);
  }
  warnOnce(ctx, `Unknown inset '${kind}' rendered as an escaped fallback.`);
  diagnostic(ctx, "UNKNOWN_INSET", `Unknown inset '${kind}' rendered as an escaped fallback.`);
  const fallback = collectVisibleText(block);
  return `<span class="unknown-inset">${escapeLiveHtml(fallback)}</span>`;
}

function renderFootInner(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length > 0) {
    return nested.map((item) => renderLayoutInline(item.node, ctx, ctx.inTitle)).join("");
  }
  return renderChildren(block.children, enterTraversalState(parentState), ctx);
}

function renderInsetLayouts(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length > 0) {
    return renderFlowItems(nested, ctx);
  }
  return renderChildren(block.children, enterTraversalState(parentState), ctx);
}

function enterSubequations(ctx: RenderCtx): number {
  ctx.equation += 1;
  ctx.subeq = { parent: ctx.equation, child: 0 };
  return ctx.equation;
}

function takeEquationNumber(ctx: RenderCtx): string {
  if (ctx.subeq) {
    ctx.subeq.child += 1;
    return `${ctx.subeq.parent}${String.fromCharCode(96 + ctx.subeq.child)}`;
  }
  ctx.equation += 1;
  return String(ctx.equation);
}

function takeFormulaNumbers(
  src: string,
  ctx: RenderCtx,
): string | Array<string | undefined> | undefined {
  const plan = planFormulaLines(src);
  const nos: Array<string | undefined> = [];
  for (const line of plan.lines) {
    if (line.consumesNumber) {
      const num = takeEquationNumber(ctx);
      nos.push(num);
      for (const lab of line.labels) ctx.labels.set(lab, num);
    } else {
      nos.push(undefined);
    }
  }
  if (plan.lines.length > 1) return nos;
  return nos[0];
}

function walkSubequationLabels(nodes: Node[], ctx: RenderCtx): void {
  const parent = String(ctx.subeq?.parent ?? ctx.equation);
  for (const n of nodes) {
    if (n.type !== "block") continue;
    if (n.tag === "inset") {
      const kind = insetKind(n);
      if (kind.startsWith("CommandInset label")) {
        const name = findProperty(n, "name");
        if (name) ctx.labels.set(name, parent);
        continue;
      }
      if (kind === "Formula" || kind.startsWith("Formula")) {
        takeFormulaNumbers(formulaSource(n), ctx);
        continue;
      }
    }
    walkSubequationLabels(n.children, ctx);
  }
}

function extractMathMacros(ast: DocumentNode): MathMacroMap | null {
  const doc = ast.children.find((n) => n.type === "block" && n.tag === "document");
  const roots = doc && doc.type === "block" ? doc.children : ast.children;
  const header = roots.find((n) => n.type === "block" && n.tag === "header");
  if (!header || header.type !== "block") return null;
  const preamble = header.children.find((n) => n.type === "block" && n.tag === "preamble");
  if (!preamble || preamble.type !== "block") return null;
  const text = preamble.children
    .filter((n): n is { type: "text"; text: string } => n.type === "text")
    .map((n) => n.text)
    .join("\n");
  if (!text.trim()) return null;
  const macros = parseNewcommands(text);
  return macros.size > 0 ? macros : null;
}

function formulaSource(block: BlockNode): string {
  const args = insetKind(block);
  const fromArgs = args.startsWith("Formula") && args.length > "Formula".length
    ? args.slice("Formula".length).trim()
    : "";
  const fromChildren = block.children
    .map((c) => {
      if (c.type === "text") return c.text;
      if (c.type === "property") {
        return c.value === undefined ? `\\${c.key}` : `\\${c.key} ${c.value}`;
      }
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
  if (fromArgs && fromChildren) return `${fromArgs}\n${fromChildren}`;
  return fromArgs || fromChildren;
}

function renderCell(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length === 0) return renderChildren(block.children, enterTraversalState(parentState), ctx);
  return nested.map((item) => renderLayoutInline(item.node, ctx)).join("");
}

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs[m[1]] = m[2];
  return attrs;
}

function widthToCss(width: string | undefined): string {
  if (!width || width === "none") return "";
  const w = width.replace(/^["']|["']$/g, "").trim();
  const pct = /^([\d.]+)(?:col|text)%$/i.exec(w);
  if (pct) return `${pct[1]}%`;
  return w;
}

function fileExists(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function findMagick(layoutsDir?: string): string | undefined {
  const env = Deno.env.get("MAGICK_BINARY");
  if (env && fileExists(env)) return env;
  const candidates: string[] = [];
  if (layoutsDir) {
    const root = path.resolve(layoutsDir, "..", "..");
    candidates.push(
      path.join(root, "imagemagick", "magick.exe"),
      path.join(root, "imagemagick", "magick"),
    );
  }
  const localApp = Deno.env.get("LOCALAPPDATA");
  if (localApp) {
    candidates.push(path.join(localApp, "Programs", "LyX 2.5", "imagemagick", "magick.exe"));
  }
  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  return undefined;
}

const WEB_IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const rasterCache = new Map<string, string>();

function rasterizeToPngDataUri(filepath: string, magickPath?: string): string | undefined {
  const st = (() => {
    try {
      return Deno.statSync(filepath);
    } catch {
      return null;
    }
  })();
  if (!st?.isFile) return undefined;
  const key = `${filepath}|${st.size}|${st.mtime?.getTime() ?? 0}`;
  const cached = rasterCache.get(key);
  if (cached) return cached;
  if (!magickPath) return undefined;
  try {
    const magickDir = path.dirname(magickPath);
    const gsBin = path.resolve(magickDir, "..", "ghostscript", "bin");
    const env = { ...Deno.env.toObject() };
    if (fileExists(path.join(gsBin, "gswin64c.exe")) || fileExists(path.join(gsBin, "gs"))) {
      env.PATH = `${gsBin}${path.DELIMITER}${env.PATH ?? ""}`;
    }
    const result = new Deno.Command(magickPath, {
      args: ["-density", "120", `${filepath}[0]`, "png:-"],
      stdout: "piped",
      stderr: "piped",
      env,
    }).outputSync();
    if (!result.success || result.stdout.length === 0) return undefined;
    let binary = "";
    const bytes = result.stdout;
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const uri = `data:image/png;base64,${btoa(binary)}`;
    rasterCache.set(key, uri);
    return uri;
  } catch {
    return undefined;
  }
}

function renderTabular(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const meta = block.children
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const cols = Number(/columns="(\d+)"/.exec(meta)?.[1] ?? 0);
  const colAttrs = [...meta.matchAll(/<column\b([^>]*)>/g)].map((m) => parseXmlAttrs(m[1]));
  const cellAttrs = [...meta.matchAll(/<cell\b([^>]*)>/g)].map((m) => parseXmlAttrs(m[1]));
  const cells = collectBlocks(block, (b) => b.tag === "inset" && insetKind(b) === "Text");
  const usedCols = cols > 0 ? cols : Math.max(1, cells.length);
  let html = "<table><tbody>";
  let c = 0;
  for (let i = 0; i < cellAttrs.length; i++) {
    const attr = cellAttrs[i];
    if (attr.multicolumn === "2") continue;
    if (attr.multirow === "4") {
      c += 1;
      if (c >= usedCols) {
        html += "</tr>";
        c = 0;
      }
      continue;
    }
    if (c === 0) html += "<tr>";
    let span = 1;
    if (attr.multicolumn === "1") {
      for (let j = i + 1; j < cellAttrs.length && cellAttrs[j].multicolumn === "2"; j++) span++;
    }
    let rowspan = 1;
    if (attr.multirow === "3") {
      for (let j = i + usedCols; j < cellAttrs.length; j += usedCols) {
        if (cellAttrs[j]?.multirow === "4") rowspan++;
        else break;
      }
    }
    const styles: string[] = [];
    const align = attr.alignment || colAttrs[c]?.alignment;
    const valign = attr.valignment || colAttrs[c]?.valignment;
    const width = widthToCss(attr.width || colAttrs[c]?.width);
    if (align) styles.push(`text-align: ${align}`);
    if (valign) styles.push(`vertical-align: ${valign}`);
    if (width && width !== "0" && width !== "0pt") styles.push(`width: ${width}`);
    if (attr.topline === "true") styles.push("border-top: 1px solid");
    if (attr.bottomline === "true") styles.push("border-bottom: 1px solid");
    if (attr.leftline === "true") styles.push("border-left: 1px solid");
    if (attr.rightline === "true") styles.push("border-right: 1px solid");
    const style = styles.length ? ` style="${styles.join("; ")}"` : "";
    const spanAttr = span > 1 ? ` colspan="${span}"` : "";
    const rowAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : "";
    const cell = cells[i];
    html += `<td${spanAttr}${rowAttr}${style}>${cell ? renderCell(cell, parentState, ctx) : ""}</td>`;
    c += span;
    if (c >= usedCols) {
      html += "</tr>";
      c = 0;
    }
  }
  if (c > 0) html += "</tr>";
  html += "</tbody></table>";
  return html;
}

function renderFlexInline(block: BlockNode, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length === 0) return escapeLiveHtml(collectVisibleText(block));
  return nested.map((item) => renderLayoutInline(item.node, ctx)).join("");
}

function renderBox(block: BlockNode, kind: string, parentState: TraversalState, ctx: RenderCtx): string {
  const variant = kind.slice("Box ".length).trim() || "Boxed";
  const width = widthToCss(findProperty(block, "width"));
  const style = width && width !== "100%" ? ` style="width: ${escapeLiveHtml(width)}"` : "";
  const nested = flattenFlow(block.children, 0);
  const inner = nested.length <= 1
    ? (nested[0] ? renderLayoutInline(nested[0].node, ctx) : "")
    : renderInsetLayouts(block, parentState, ctx);
  const box = `<div class="${escapeLiveHtml(variant)}"${style}>${inner}</div>`;
  return wrapDisclosure(`box ${layoutSlug(variant)}`, variant || "Box", box);
}

/**
 * Click-to-toggle disclosure (DL131 J1): `<details>`/`<summary>`, no JS.
 * Always starts collapsed (J5). Hover must not open.
 */
function wrapDisclosure(
  className: string,
  summaryLabel: string,
  bodyHtml: string,
  opts?: { summaryClass?: string; bodyClass?: string },
): string {
  const sumCls = opts?.summaryClass ?? "disclose-summary";
  const bodyCls = opts?.bodyClass ?? "disclose-body";
  return `<details class="disclose ${escapeLiveHtml(className)}"><summary class="${escapeLiveHtml(sumCls)}">${escapeLiveHtml(summaryLabel)}</summary><span class="${escapeLiveHtml(bodyCls)}">${bodyHtml}</span></details>`;
}

function renderInfo(block: BlockNode, ctx?: RenderCtx): string {
  const type = (findProperty(block, "type") ?? "").toLowerCase();
  const arg = findProperty(block, "arg") ?? collectVisibleText(block);
  if (type === "icon") {
    if (!arg) return "";
    const src = resolveInfoIconDataUri(arg, ctx?.systemImagesDir, ctx?.magickPath);
    if (src) {
      return `<img class="info-icon" src="${src}" alt="${escapeLiveHtml(arg)}" title="${escapeLiveHtml(arg)}" aria-label="${escapeLiveHtml(arg)}" data-info-icon="${escapeLiveHtml(arg)}"/>`;
    }
    // Glyph fallback when LyX images / magick are unavailable (DL130 J4).
    return `<span class="info-icon" title="${escapeLiveHtml(arg)}" role="img" aria-label="${escapeLiveHtml(arg)}">▣</span>`;
  }
  if (type === "shortcut" || type === "shortcuts") {
    if (!arg) return "";
    const resolved = lookupShortcut(ctx?.shortcuts, arg, type === "shortcuts");
    const body = resolved ?? arg;
    const title = resolved ? arg : "LFUN";
    return `<kbd class="${type === "shortcuts" ? "shortcuts" : "shortcut"}" title="${escapeLiveHtml(title)}">${escapeLiveHtml(body)}</kbd>`;
  }
  return arg ? `<span class="info">${escapeLiveHtml(arg)}</span>` : "";
}

/**
 * Resolve Info icon LFUN/name to a PNG `data:` URI from `{Resources}/images`.
 * Prefer classic/*.png (no magick); else SVGZ via ImageMagick when present.
 *
 * Info args often include LFUN arguments (`math-macro newmacroname_newcommand`);
 * LyX icon files use underscores for those spaces.
 */
function resolveInfoIconDataUri(
  name: string,
  imagesDir: string | undefined,
  magickPath: string | undefined,
): string | undefined {
  if (!imagesDir || !name) return undefined;
  const trimmed = name.trim();
  const bases = [
    trimmed.replace(/\s+/g, "_"), // full LFUN+args (native imageLibFileSearch)
    trimmed.split(/\s+/)[0]!, // bare LFUN
  ];
  const unique = [...new Set(bases.filter(Boolean))];
  for (const base of unique) {
    const pngCandidates = [
      path.join(imagesDir, "classic", `${base}.png`),
      path.join(imagesDir, `${base}.png`),
    ];
    for (const file of pngCandidates) {
      if (!fileExists(file)) continue;
      try {
        const bytes = Deno.readFileSync(file);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        return `data:image/png;base64,${btoa(binary)}`;
      } catch {
        /* try next */
      }
    }
  }
  for (const base of unique) {
    const svgzCandidates = [
      path.join(imagesDir, `${base}.svgz`),
      path.join(imagesDir, "adwaita", `${base}.svgz`),
      path.join(imagesDir, "oxygen", `${base}.svgz`),
      path.join(imagesDir, "classic", `${base}.svgz`),
    ];
    for (const file of svgzCandidates) {
      const uri = rasterizeToPngDataUri(file, magickPath);
      if (uri) return uri;
    }
  }
  return undefined;
}

function renderCaptionInline(block: BlockNode, ctx: RenderCtx): string {
  const nested = flattenFlow(block.children, 0);
  if (nested.length > 0) {
    return nested.map((item) => renderLayoutInline(item.node, ctx)).join("");
  }
  return renderChildren(block.children, createTraversalState(), ctx);
}

function noteChapterHeading(ctx: RenderCtx, heading: LayoutRole, number: string): void {
  if (heading.kind !== "heading" || heading.level !== 0) return;
  const label = number.trim();
  if (!label) return;
  ctx.chapterLabel = label;
  ctx.figure = 0;
  ctx.table = 0;
  ctx.algorithm = 0;
  ctx.listing = 0;
  ctx.floatTypeCounts = new Map();
}

function takeFloatNumber(ctx: RenderCtx, variant: string): string | undefined {
  let n = 0;
  if (variant === "figure") {
    ctx.figure += 1;
    n = ctx.figure;
  } else if (variant === "table") {
    ctx.table += 1;
    n = ctx.table;
  } else if (variant === "algorithm") {
    ctx.algorithm += 1;
    n = ctx.algorithm;
  } else if (variant === "listing") {
    ctx.listing += 1;
    n = ctx.listing;
  } else {
    return undefined;
  }
  return ctx.chapterLabel ? `${ctx.chapterLabel}.${n}` : String(n);
}

function takeGenericFloatNumber(ctx: RenderCtx, variant: string): string {
  const n = (ctx.floatTypeCounts.get(variant) ?? 0) + 1;
  ctx.floatTypeCounts.set(variant, n);
  return ctx.chapterLabel ? `${ctx.chapterLabel}.${n}` : String(n);
}

function noteFloatListEntry(
  ctx: RenderCtx,
  floatBlock: BlockNode,
  variant: string,
  number: string | undefined,
): void {
  if (!number) return;
  const captions = captionBlocks(floatBlock);
  if (captionsAreUnnumbered(captions)) return;
  const text = captions.map((c) => collectVisibleText(c)).join(" ").replace(/\s+/g, " ").trim();
  const id = `float-${layoutSlug(variant)}-${number.replaceAll(".", "-")}`;
  ctx.floatListEntries.push({ type: variant, number, text, id });
}

function floatListTitle(type: string): string {
  if (type === "figure") return "List of Figures";
  if (type === "table") return "List of Tables";
  if (!type) return "List of Floats";
  return `List of ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

/** Native InsetFloatList::xhtml — TOC of captioned floats of one type. */
function renderFloatList(kind: string, ctx: RenderCtx): string {
  const type = kind.startsWith("FloatList ") ? kind.slice("FloatList ".length).trim() : "";
  const entries = ctx.floatListEntries.filter((e) => e.type === type);
  if (entries.length === 0) return "";
  const title = floatListTitle(type);
  let html = `<nav class="toc toc-floats"><h2 class="tochead toc-${escapeLiveHtml(layoutSlug(type) || "float")}">${escapeLiveHtml(title)}</h2><ol>`;
  for (const e of entries) {
    const label = e.text ? `${e.number} ${e.text}` : e.number;
    html += `<li><a href="#${escapeLiveHtml(e.id)}">${escapeLiveHtml(label.trim())}</a></li>`;
  }
  html += "</ol></nav>";
  return html;
}

/**
 * Remaining Flex insets: prefer layout HTMLTag/HTMLClass/Font, then typed
 * specials, then a classed wrapper (no bare passthrough).
 */
function renderFlexDefault(
  kind: string,
  block: BlockNode,
  parentState: TraversalState,
  ctx: RenderCtx,
): string {
  const name = kind.slice("Flex ".length).trim();
  const slug = layoutSlug(name) || "flex";
  const multipar = block.children.some((c) => c.type === "block" && c.tag === "layout");

  // Beamer / Powerdot overlays & modes — keep text, mark role.
  if (
    /^(Alternative|Uncover|Visible|Invisible|Onslide\+?|Onslide\*|ArticleMode|PresentationMode)$/i
      .test(name) || name.startsWith("Onslide")
  ) {
    const style = /^Invisible$/i.test(name) ? ' style="opacity:0.35"' : "";
    return `<span class="flex ${slug} overlay"${style}>${renderFlexInline(block, ctx)}</span>`;
  }
  if (/^(Email)$/i.test(name)) {
    const text = collectVisibleText(block).trim();
    const href = text.includes("@") ? `mailto:${text}` : text;
    return `<a class="flex email" href="${escapeLiveHtml(href)}">${escapeLiveHtml(text)}</a>`;
  }
  if (/^institutemark$/i.test(name) || /^Bibnote$/i.test(name) || /^Table footnotemark$/i.test(name)) {
    return `<sup class="flex ${slug}">${renderFlexInline(block, ctx)}</sup>`;
  }
  if (/^VerticalSpace$/i.test(name)) {
    return `<div class="flex vertical-space" style="height:1em" aria-hidden="true"></div>`;
  }
  if (/^Ruby$/i.test(name)) {
    return `<ruby class="flex ruby">${renderInsetLayouts(block, parentState, ctx)}</ruby>`;
  }
  if (/^Bold$/i.test(name)) {
    return `<strong class="flex bold">${renderFlexInline(block, ctx)}</strong>`;
  }
  if (/^Highlight$/i.test(name)) {
    return `<mark class="flex highlight">${renderFlexInline(block, ctx)}</mark>`;
  }
  if (/^Latin$/i.test(name)) {
    return `<span class="flex latin" lang="la">${renderFlexInline(block, ctx)}</span>`;
  }
  if (/^Chemistry$/i.test(name)) {
    return `<span class="flex chemistry">${renderFlexInline(block, ctx)}</span>`;
  }
  if (/^Braillebox$/i.test(name)) {
    return `<span class="flex braillebox">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  if (/^Column$/i.test(name)) {
    return `<div class="flex column">${renderInsetLayouts(block, parentState, ctx)}</div>`;
  }
  if (/^Subtitle$/i.test(name)) {
    return `<div class="flex subtitle">${renderInsetLayouts(block, parentState, ctx)}</div>`;
  }
  if (/^Variation$/i.test(name) || /^SetChessBoard$/i.test(name)) {
    return `<div class="flex ${slug} chess-meta">${renderInsetLayouts(block, parentState, ctx)}</div>`;
  }
  if (/^S\/R expression$/i.test(name) || /^Sweave Options$/i.test(name)) {
    return `<code class="flex ${slug}">${escapeLiveHtml(collectVisibleText(block))}</code>`;
  }
  // Europass / Springer author-address field insets.
  if (
    /^(First Name|Surname|Department|Organization|Org\. Address|Street|City|Post Code|State|Country|ItemInset)$/i
      .test(name)
  ) {
    return `<span class="flex field ${slug}" data-field="${escapeLiveHtml(name)}">${renderInsetLayouts(block, parentState, ctx)}</span>`;
  }
  // Linguistics gloss / DRS family.
  if (
    /^(GroupGlossedWords|Interlinear Gloss|Concepts|Expression|Meaning|DRS|IfThen-DRS|Cond-DRS|QDRS|NegDRS|SDRS)/i
      .test(name)
  ) {
    return `<div class="flex gloss ${slug}">${renderInsetLayouts(block, parentState, ctx)}</div>`;
  }

  // InsetLayout HTMLTag / HTMLClass / Font when class+modules provide them.
  const fromLayout = renderFlexFromLayout(kind, name, slug, multipar, block, parentState, ctx);
  if (fromLayout !== undefined) {
    return multipar
      ? wrapDisclosure(`flex-container ${slug}`, name || "Flex", fromLayout)
      : fromLayout;
  }

  if (multipar) {
    const box = `<div class="flex ${slug}">${renderInsetLayouts(block, parentState, ctx)}</div>`;
    return wrapDisclosure(`flex-container ${slug}`, name || "Flex", box);
  }
  return `<span class="flex ${slug}">${renderFlexInline(block, ctx)}</span>`;
}

/** Lookup keys for `Flex Noun` → `Flex:Noun` / underscore variants in layout map. */
function flexLayoutSpec(kind: string, name: string, html: Map<string, LayoutHtml> | null): LayoutHtml | undefined {
  if (!html) return undefined;
  const underscored = name.replace(/ /g, "_");
  const spaced = name.replace(/_/g, " ");
  const keys = [
    `Flex:${name}`,
    `Flex:${underscored}`,
    `Flex:${spaced}`,
    kind,
    name,
    underscored,
    spaced,
  ];
  for (const k of keys) {
    const spec = html.get(k);
    if (spec && (spec.htmlTag || spec.htmlClass || spec.font)) return spec;
  }
  return undefined;
}

function layoutFontStyle(font: LayoutFont | undefined): string {
  if (!font) return "";
  const parts: string[] = [];
  if (font.color) parts.push(`color:${cssLyxColor(font.color)}`);
  const shape = (font.shape ?? "").toLowerCase();
  if (shape === "italic") parts.push("font-style:italic");
  else if (shape === "slanted") parts.push("font-style:oblique");
  else if (shape === "smallcaps") parts.push("font-variant:small-caps");
  const series = (font.series ?? "").toLowerCase();
  if (series === "bold") parts.push("font-weight:bold");
  const family = (font.family ?? "").toLowerCase();
  if (family === "typewriter") parts.push('font-family:monospace');
  else if (family === "sans") parts.push("font-family:sans-serif");
  const size = (font.size ?? "").toLowerCase();
  const sizeCss = FONT_SIZE_CSS[size];
  if (sizeCss) parts.push(`font-size:${sizeCss}`);
  return parts.length ? ` style="${escapeLiveHtml(parts.join(";"))}"` : "";
}

function renderFlexFromLayout(
  kind: string,
  name: string,
  slug: string,
  multipar: boolean,
  block: BlockNode,
  parentState: TraversalState,
  ctx: RenderCtx,
): string | undefined {
  const spec = flexLayoutSpec(kind, name, ctx.layoutHtml);
  if (!spec) return undefined;
  const rawTag = (spec.htmlTag ?? (multipar ? "div" : "span")).toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(rawTag) || rawTag === "script" || rawTag === "iframe") {
    return undefined;
  }
  const cls = spec.htmlClass?.trim() || flexNativeClass(name);
  const style = layoutFontStyle(spec.font);
  const inner = multipar
    ? renderInsetLayouts(block, parentState, ctx)
    : renderFlexInline(block, ctx);
  return `<${rawTag} class="${escapeLiveHtml(cls)}"${style}>${inner}</${rawTag}>`;
}

/** Native InsetIPADeco::xhtml — combining mark between the two halves of child text. */
function renderIpaDeco(block: BlockNode, parentState: TraversalState, ctx: RenderCtx): string {
  const deco = insetKind(block).slice("IPADeco ".length).trim().toLowerCase();
  const mark = deco === "toptiebar" ? "\u0361" : deco === "bottomtiebar" ? "\u035c" : "";
  const inner = renderInsetLayouts(block, parentState, ctx);
  if (!mark) return `<span class="ipa-deco">${inner}</span>`;
  // Prefer plain text split when the deco wraps simple characters (native behavior).
  const plain = collectVisibleText(block).replace(/\s+/g, "");
  if (plain.length >= 2 && !inner.includes("<")) {
    const mid = Math.floor(plain.length / 2);
    return `<span class="ipa-deco">${escapeLiveHtml(plain.slice(0, mid))}${mark}${escapeLiveHtml(plain.slice(mid))}</span>`;
  }
  return `<span class="ipa-deco">${inner}${mark}</span>`;
}

function floatCaptionPrefix(variant: string, num: string | undefined): string {
  if (!num) return "";
  return `${floatNamerefPrefix(variant)} ${num}: `;
}

/** Native nameref text for a float label ("Figure", "Table", …). */
function floatNamerefPrefix(variant: string): string {
  const v = variant.toLowerCase();
  if (v === "table") return "Table";
  if (v === "algorithm") return "Algorithm";
  if (v === "listing") return "Listing";
  if (v === "figure" || !v) return "Figure";
  return variant.charAt(0).toUpperCase() + variant.slice(1);
}

/** `Caption Below` → `Below`; bare `Caption` → `Standard` (native type_). */
function captionTypeFromKind(kind: string): string {
  if (!kind.startsWith("Caption")) return "Standard";
  const rest = kind.slice("Caption".length).trim();
  return rest || "Standard";
}

function captionBlocks(root: BlockNode): BlockNode[] {
  return collectBlocks(root, (b) => b.tag === "inset" && insetKind(b).startsWith("Caption"));
}

function captionsAreUnnumbered(captions: BlockNode[]): boolean {
  return captions.length > 0 &&
    captions.every((c) => captionTypeFromKind(insetKind(c)) === "Unnumbered");
}

/** Native InsetCaption::xhtml adds `float-caption-{type}` (Below, Unnumbered, …). */
function captionClassAttr(captions: BlockNode[]): string {
  if (captions.length === 0) return "";
  const type = captionTypeFromKind(insetKind(captions[0]));
  return ` class="float-caption-${escapeLiveHtml(type)}"`;
}

function listingTakesNumber(block: BlockNode): boolean {
  if ((findProperty(block, "inline") ?? "").toLowerCase() === "true") return false;
  const captions = captionBlocks(block);
  if (captions.length === 0) return false;
  return !captionsAreUnnumbered(captions);
}

function includeIsListings(block: BlockNode): boolean {
  const command = (findProperty(block, "LatexCommand") ?? "").toLowerCase();
  return command.includes("lstinput") || command.includes("inputminted");
}

function renderCaptionedFloat(block: BlockNode, variant: string, ctx: RenderCtx): string {
  const allCaptions = captionBlocks(block);
  const numbered = !captionsAreUnnumbered(allCaptions);
  const num = numbered
    ? (takeFloatNumber(ctx, variant) ?? takeGenericFloatNumber(ctx, variant))
    : undefined;
  const prefix = numbered ? floatCaptionPrefix(variant, num) : "";
  const id = num ? ` id="float-${layoutSlug(variant)}-${num.replaceAll(".", "-")}"` : "";
  let html = `<figure class="float-${layoutSlug(variant)}"${id}>`;
  for (const item of flattenFlow(block.children, 0)) {
    const captions = collectBlocks(item.node, (b) => b.tag === "inset" && insetKind(b).startsWith("Caption"));
    if (captions.length > 0) {
      const cap = captions.map((c) => renderCaptionInline(c, ctx)).join("");
      // Number once per float; only the first caption block gets the prefix.
      const usePrefix = prefix && html.indexOf("<figcaption") === -1 ? prefix : "";
      html += `<figcaption${captionClassAttr(captions)}>${usePrefix}${cap}</figcaption>`;
      continue;
    }
    html += `<div class="float-body">${renderLayoutInline(item.node, ctx)}</div>`;
  }
  html += "</figure>";
  return html;
}

function renderWrap(block: BlockNode, _parentState: TraversalState, ctx: RenderCtx): string {
  const width = widthToCss(findProperty(block, "width")) || "50%";
  const placement = (findProperty(block, "placement") ?? "").toLowerCase();
  const side = placement === "l" || placement === "i" ? "left" : "right";
  const variant = insetKind(block).slice("Wrap ".length).trim() || "figure";
  const prev = ctx.inWrap;
  ctx.inWrap = true;
  let inner = "";
  try {
    inner = renderCaptionedFloat(block, variant, ctx);
  } finally {
    ctx.inWrap = prev;
  }
  const wrap = `<div class="wrap wrap-${side}" style="width: ${escapeLiveHtml(width)}">${inner}</div>`;
  return wrapDisclosure(
    `wrap wrap-${side} wrap-${layoutSlug(variant)}`,
    `Wrap ${variant}`,
    wrap,
  );
}

function listingParam(params: string, key: string): string {
  const m = new RegExp(`${key}\\s*=\\s*(?:\\{([^{}]*)\\}|([^,]+))`, "i").exec(params);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

function listingLanguage(params: string): string {
  const raw = listingParam(params, "language");
  const dialect = /^\[([^\]]*)\](.*)$/.exec(raw);
  return (dialect ? dialect[2] || dialect[1] : raw).trim();
}

function listingCode(block: BlockNode): string {
  const lines: string[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type !== "block") continue;
      if (n.tag === "layout") {
        let line = "";
        const lineWalk = (kids: Node[]) => {
          for (const k of kids) {
            if (k.type === "text") line += k.text;
            else if (k.type === "property" && k.key === "backslash") line += "\\";
            else if (k.type === "block") {
              if (k.tag === "inset" && insetKind(k).startsWith("Caption")) continue;
              lineWalk(k.children);
            }
          }
        };
        lineWalk(n.children);
        lines.push(line.replace(/\s+$/, ""));
        continue;
      }
      if (n.tag === "inset" && insetKind(n).startsWith("Caption")) continue;
      walk(n.children);
    }
  };
  walk(block.children);
  return lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function renderListings(block: BlockNode, _parentState: TraversalState, ctx: RenderCtx): string {
  const lang = listingLanguage(findProperty(block, "lstparams") ?? "");
  const inline = (findProperty(block, "inline") ?? "").toLowerCase() === "true";
  const captions = captionBlocks(block);
  const captionHtml = captions.map((c) => renderCaptionInline(c, ctx)).join("");
  const cls = lang ? `listings ${escapeLiveHtml(lang)}` : "listings";
  const code = `<code class="${cls}">${escapeLiveHtml(listingCode(block))}</code>`;
  if (inline) return code;
  let html = `<div class="float-listings">`;
  if (captionHtml) {
    const prefix = listingTakesNumber(block) ? floatCaptionPrefix("listing", takeFloatNumber(ctx, "listing")) : "";
    html += `<div class="listings-caption"${captionClassAttr(captions)}>${prefix}${captionHtml}</div>`;
  }
  html += `${code}</div>`;
  return html;
}

function renderFloat(block: BlockNode, kind: string, _parentState: TraversalState, ctx: RenderCtx): string {
  const variant = kind.slice("Float ".length).trim() || "figure";
  const figure = renderCaptionedFloat(block, variant, ctx);
  const label = variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : "Float";
  return wrapDisclosure(`float float-${layoutSlug(variant)}`, label, figure);
}

function renderInclude(block: BlockNode, ctx: RenderCtx): string {
  const filename = findProperty(block, "filename") ?? "";
  const command = (findProperty(block, "LatexCommand") ?? "").toLowerCase();
  if (!filename) return "";
  const listing = command.includes("verbatim") || command.includes("lstinput");
  const resolved = resolveGraphicPath(filename, ctx);
  if (listing) {
    try {
      const raw = Deno.readTextFileSync(resolved);
      const params = findProperty(block, "lstparams") ?? "";
      const first = Number(listingParam(params, "firstline") || "1");
      const last = Number(listingParam(params, "lastline") || "0");
      const lines = raw.split(/\r?\n/);
      const from = Math.max(1, first) - 1;
      const to = last > 0 ? Math.min(last, lines.length) : lines.length;
      const body = escapeLiveHtml(lines.slice(from, to).join("\n"));
      if (!includeIsListings(block)) {
        return `<pre class="include">${body}</pre>`;
      }
      const num = takeFloatNumber(ctx, "listing");
      const caption = listingParam(params, "caption");
      const label = listingParam(params, "label");
      const lang = listingLanguage(params);
      const cls = lang ? `listings ${escapeLiveHtml(lang)}` : "listings";
      const id = label ? ` id="${escapeLiveHtml(xmlId(label))}"` : "";
      const prefix = floatCaptionPrefix("listing", num);
      let html = `<div class="float-listings"${id}>`;
      if (prefix || caption) {
        html += `<div class="listings-caption">${prefix}${escapeLiveHtml(caption)}</div>`;
      }
      html += `<pre class="include"><code class="${cls}">${body}</code></pre></div>`;
      return html;
    } catch {
      return "";
    }
  }
  const base = filename.split(/[/\\]/).pop() ?? filename;
  if (!base.toLowerCase().endsWith(".lyx")) return "";
  if (ctx.includeStack.includes(resolved)) return "";
  try {
    const ast = parse(Deno.readTextFileSync(resolved));
    ctx.includeStack.push(resolved);
    try {
      return renderFlowItems(flattenFlow(findBody(ast), 0), ctx);
    } finally {
      ctx.includeStack.pop();
    }
  } catch {
    return "";
  }
}

function resolveGraphicPath(filename: string, ctx: RenderCtx): string {
  const tries: string[] = [];
  if (ctx.filePath) tries.push(path.resolve(path.dirname(ctx.filePath), filename));
  if (ctx.systemDocDir) tries.push(path.resolve(ctx.systemDocDir, filename));
  for (const p of tries) {
    if (fileExists(p)) return p;
  }
  return tries[0] ?? filename;
}

function graphicBoxStyle(block: BlockNode, ctx: RenderCtx): string {
  const width = ctx.inWrap ? "100%" : widthToCss(findProperty(block, "width"));
  const height = ctx.inWrap ? "" : widthToCss(findProperty(block, "height"));
  const styles: string[] = [];
  if (width && width !== "0" && width !== "0pt") styles.push(`width: ${width}`);
  if (height && height !== "0" && height !== "0pt") styles.push(`height: ${height}`);
  return styles.length ? ` style="${escapeLiveHtml(styles.join("; "))}"` : "";
}

function renderGraphics(block: BlockNode, ctx: RenderCtx): string {
  const filename = findProperty(block, "filename") ?? "";
  const base = filename.split(/[/\\]/).pop() ?? filename;
  let src = "";
  let filepath = "";
  if (filename) {
    filepath = resolveGraphicPath(filename, ctx);
    if (fileExists(filepath) && !WEB_IMAGE.test(filepath)) {
      src = rasterizeToPngDataUri(filepath, ctx.magickPath) ?? "";
    }
    if (!src) {
      try {
        src = path.toFileUrl(filepath).href;
      } catch {
        src = "";
      }
    }
  }
  const srcAttr = src ? ` src="${escapeLiveHtml(src)}"` : "";
  const fpAttr = filepath && !src.startsWith("data:") ? ` data-filepath="${escapeLiveHtml(filepath)}"` : "";
  return `<img${srcAttr}${fpAttr}${graphicBoxStyle(block, ctx)} data-filename="${escapeLiveHtml(base)}" alt="${escapeLiveHtml(base)}">`;
}

function lastName(part: string): string {
  if (part.includes(",")) return part.split(",")[0].trim();
  const bits = part.trim().split(/\s+/);
  return bits[bits.length - 1] ?? part;
}

function shortAuthor(author?: string): string {
  if (!author) return "Unknown";
  const people = author.split(/\s+and\s+/i);
  const last = lastName(people[0]);
  return people.length > 1 ? `${last} et al.` : last;
}

function formatInlineCite(command: string, keys: string[], bib: Map<string, Citation>): string {
  const parts = keys.map((key) => {
    const c = bib.get(key);
    if (!c) return key;
    const who = shortAuthor(c.author);
    const year = c.year ?? "";
    return { who, year };
  });
  const parenthetical = command === "citep" || command === "parencite" || command === "cite";
  if (parenthetical) {
    return `(${parts.map((p) => typeof p === "string" ? p : `${p.who} ${p.year}`.trim()).join("; ")})`;
  }
  return parts.map((p) => typeof p === "string" ? p : `${p.who} (${p.year})`).join("; ");
}

function renderToc(ctx: RenderCtx): string {
  if (ctx.outline.length === 0) return "";
  const items = ctx.outline;
  let html = `<nav class="toc"><h2 class="toc">Contents</h2><ol>`;
  let prev = items[0].level;
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    if (i > 0) {
      if (e.level > prev) html += "<ol>";
      else if (e.level === prev) html += "</li>";
      else {
        html += "</li>";
        for (let l = prev; l > e.level; l--) html += "</ol></li>";
      }
    }
    const label = e.number ? `${e.number} ${e.text}` : e.text;
    html += `<li><a href="#${escapeLiveHtml(e.id)}">${escapeLiveHtml(label)}</a>`;
    prev = e.level;
  }
  html += "</li>";
  const first = items[0].level;
  const last = items[items.length - 1].level;
  for (let l = last; l > first; l--) html += "</ol></li>";
  html += "</ol></nav>";
  return html;
}

function argumentText(block: BlockNode, name: string): string {
  const found = collectBlocks(
    block,
    (b) => b.tag === "inset" && insetKind(b) === `Argument ${name}`,
  );
  return found[0] ? nomenclText(found[0]) : "";
}

function renderInitial(node: BlockNode, ctx: RenderCtx): string {
  const letter = argumentText(node, "2");
  const rest = argumentText(node, "3");
  const body = renderLayoutInline(node, ctx);
  const cap = letter
    ? `<span class="dropcap">${escapeLiveHtml(letter)}</span><span class="dropcap-rest">${escapeLiveHtml(rest)}</span>`
    : "";
  return `<div class="initial">${cap}${body}</div>`;
}

function renderBibEnv(items: FlowItem[], start: number, ctx: RenderCtx): [string, number] {
  const title = ctx.layoutHtml?.get("Bibliography")?.labelString || "References";
  let html = `<div class="bibliography"><h2 class="bibliography">${escapeLiveHtml(title)}</h2>`;
  let i = start;
  while (i < items.length && items[i].layout === "Bibliography" && items[i].depth === items[start].depth) {
    html += `<div class="bibitem">${renderLayoutInline(items[i].node, ctx)}</div>`;
    i++;
  }
  html += "</div>";
  return [html, i];
}

function renderBibliography(ctx: RenderCtx): string {
  const citedOnly = ctx.btprint === "btPrintCited";
  const raw = citedOnly ? ctx.citedKeys : [...ctx.bib.keys()];
  const items = raw.filter((k, i, a) => a.indexOf(k) === i && ctx.bib.has(k));
  if (items.length === 0) return "";
  const title = ctx.layoutHtml?.get("Bibliography")?.labelString || "References";
  let html = `<div class="bibtex"><h2 class="bibtex">${escapeLiveHtml(title)}</h2>`;
  items.forEach((key, i) => {
    const c = ctx.bib.get(key)!;
    const body = formatBibliographyEntry(c);
    const label = String(i + 1);
    const labelHtml = `<span class="bibtexlabel">${escapeLiveHtml(label)}</span>`;
    html += `<div class="bibtexentry" id="LyXCite-${escapeLiveHtml(xmlId(key))}">${labelHtml}<span class="bibtexinfo">${body}</span></div>`;
  });
  html += "</div>";
  return html;
}

function isStatusLine(text: string): boolean {
  return /^(status|name|LatexCommand|LatexName|labelwidthstring|range|pageformat|type|literal)\s/.test(text);
}

function nomenclText(block: BlockNode): string {
  let out = "";
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        if (!isStatusLine(n.text)) out += n.text;
        continue;
      }
      if (n.type !== "block") continue;
      if (n.tag === "inset") continue;
      walk(n.children);
    }
  };
  walk(block.children);
  return out.replace(/\s+/g, " ").trim();
}

function nextNomenclId(ctx: RenderCtx): string {
  ctx.nomenclSeq += 1;
  return `nomencl-${ctx.nomenclSeq}`;
}

function nextIndexId(ctx: RenderCtx): string {
  ctx.indexSeq += 1;
  return `idx-${ctx.indexSeq}`;
}

function renderNomenclAnchor(ctx: RenderCtx): string {
  return `<a id="${escapeLiveHtml(nextNomenclId(ctx))}"></a>`;
}

function renderIndexAnchor(ctx: RenderCtx): string {
  return `<a id="${escapeLiveHtml(nextIndexId(ctx))}"></a>`;
}

function collectNomenclEntry(block: BlockNode, ctx: RenderCtx): NomenclEntry {
  let symbol = "";
  let desc = "";
  let prefix = "";
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        if (!isStatusLine(n.text)) symbol += n.text;
        continue;
      }
      if (n.type !== "block") continue;
      if (n.tag === "inset") {
        const kind = insetKind(n);
        if (kind.startsWith("Argument ")) {
          const name = kind.slice("Argument ".length).trim();
          const text = nomenclText(n);
          if (name === "1") prefix = text;
          else if (name.startsWith("post:")) desc = text;
          continue;
        }
        if (
          kind === "ERT" || isInvisibleInset(n) ||
          kind === "Index" || kind.startsWith("Index ") ||
          kind.startsWith("IndexMacro")
        ) {
          continue;
        }
      }
      walk(n.children);
    }
  };
  walk(block.children);
  symbol = symbol.replace(/\s+/g, " ").trim();
  return { symbol, desc, sort: prefix || symbol, id: nextNomenclId(ctx) };
}

function renderNomenclature(ctx: RenderCtx): string {
  if (ctx.nomencl.length === 0) return "";
  const items = [...ctx.nomencl].sort((a, b) => a.sort.localeCompare(b.sort));
  let html = `<div class="nomencl"><h2 class="nomencl">Nomenclature</h2><dl>`;
  for (const e of items) {
    html += `<dt><a class="nomencl" href="#${escapeLiveHtml(e.id)}">${escapeLiveHtml(e.symbol)}</a></dt><dd>${escapeLiveHtml(e.desc)}</dd>`;
  }
  html += "</dl></div>";
  return html;
}

function collectIndexEntry(block: BlockNode, ctx: RenderCtx): IndexEntry {
  let term = "";
  const terms: string[] = [];
  let see = "";
  let sort = "";
  const flush = () => {
    const t = term.replace(/\s+/g, " ").trim();
    if (t) terms.push(t);
    term = "";
  };
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "property" && n.key === "SpecialChar") {
        term += specialChar(n.value ?? "");
        continue;
      }
      if (n.type === "text") {
        if (!isStatusLine(n.text)) term += expandSpecialInText(n.text);
        continue;
      }
      if (n.type !== "block") continue;
      if (n.tag === "inset") {
        const kind = insetKind(n);
        if (kind.startsWith("IndexMacro")) {
          const text = nomenclText(n);
          if (kind.includes("subentry")) {
            flush();
            term = text;
            flush();
          } else if (/\bsee\b/.test(kind)) {
            see = text;
          } else if (kind.includes("sortkey")) {
            sort = text;
          }
          continue;
        }
        if (kind === "ERT" || isInvisibleInset(n) || isOmittedInsetKind(kind)) continue;
      }
      walk(n.children);
    }
  };
  walk(block.children);
  flush();
  return { terms, see, sort: sort || terms.join(", "), id: nextIndexId(ctx) };
}

function renderIndex(ctx: RenderCtx, title: string): string {
  if (ctx.index.length === 0) return "";
  const items = [...ctx.index].sort((a, b) => a.sort.localeCompare(b.sort, undefined, { sensitivity: "base" }));
  const groups = new Map<string, IndexEntry[]>();
  for (const e of items) {
    const label = e.terms.join(", ");
    const key = e.see ? `${label}::see::${e.see}` : label;
    if (!key) continue;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  let html = `<div class="index"><h2 class="index">${escapeLiveHtml(title || "Index")}</h2><ul class="index">`;
  for (const group of groups.values()) {
    const first = group[0];
    const label = first.terms.join(", ");
    if (first.see) {
      html += `<li>${escapeLiveHtml(label)}, see ${escapeLiveHtml(first.see)}</li>`;
      continue;
    }
    const links = group.map((e, i) => `<a href="#${escapeLiveHtml(e.id)}">${i + 1}</a>`).join(", ");
    html += `<li>${escapeLiveHtml(label)} \u2014 ${links}</li>`;
  }
  html += "</ul></div>";
  return html;
}

function renderCommandInset(block: BlockNode, kind: string, ctx: RenderCtx): string {
  const subtype = kind.slice("CommandInset ".length).trim();
  const name = findProperty(block, "name") ?? "";
  const key = findProperty(block, "key") ?? "";
  const command = findProperty(block, "LatexCommand") ?? subtype;
  if (subtype === "citation") {
    const keys = (key || name).split(",").map((s) => s.trim()).filter(Boolean);
    return keys.map((k) => {
      const text = formatInlineCite(command, [k], ctx.bib);
      return `<a class="citation" href="#LyXCite-${escapeLiveHtml(xmlId(k))}">${escapeLiveHtml(text)}</a>`;
    }).join("; ");
  }
  if (
    subtype === "ref" || subtype === "pageref" || subtype === "formatted" ||
    subtype === "eqref" || subtype === "nameref" || subtype === "vref" ||
    subtype === "vpageref" || subtype === "labelonly"
  ) {
    const target = findProperty(block, "reference") ?? name;
    const id = xmlId(target);
    const resolved = ctx.labels.get(target);
    const named = ctx.labelTitles.get(target);
    let text = resolved || target;
    if (command === "eqref" || subtype === "eqref") text = `(${text})`;
    else if (command === "pageref" || command === "vpageref" || subtype === "pageref" || subtype === "vpageref") {
      // No printed page numbers in Live — prefer the numbered target (figure/section)
      // when known; otherwise the reference name. Avoid the opaque "elsewhere".
      text = resolved || target || "elsewhere";
    } else if (command === "nameref" || subtype === "nameref") {
      text = named || resolved || target;
    }
    const title = (command === "pageref" || command === "vpageref" || subtype === "pageref" || subtype === "vpageref")
      ? ` title="page reference (Live shows target number/name, not a page)"`
      : "";
    return `<a class="ref" href="#${escapeLiveHtml(id)}"${title}>${escapeLiveHtml(text)}</a>`;
  }
  if (subtype === "bibtex") return renderBibliography(ctx);
  if (subtype === "toc") return renderToc(ctx);
  if (subtype === "label") {
    return name ? `<a id="${escapeLiveHtml(xmlId(name))}"></a>` : "";
  }
  if (subtype === "nomenclature_print") return "";
  if (subtype === "index_print") return renderIndex(ctx, findProperty(block, "name") || "Index");
  if (subtype === "nomencl_print") return renderNomenclature(ctx);
  if (subtype === "line") return "<hr>";
  if (subtype === "href") {
    const target = findProperty(block, "target") ?? name;
    const label = name || target;
    return `<a class="href" href="${escapeLiveHtml(target)}">${escapeLiveHtml(label)}</a>`;
  }
  if (subtype === "include") return renderInclude(block, ctx);
  if (subtype === "bibitem") {
    const label = findProperty(block, "label") ?? "";
    let shown = label;
    if (!shown) {
      ctx.bibitem += 1;
      shown = String(ctx.bibitem);
    }
    const id = xmlId(key);
    const idAttr = id ? ` id="LyXCite-${escapeLiveHtml(id)}"` : "";
    return `<a${idAttr}></a><span class="bibitemlabel">${escapeLiveHtml(shown)}</span>`;
  }
  const visible = key || name;
  return visible ? `<span class="command-inset">${escapeLiveHtml(visible)}</span>` : "";
}

function spaceChar(kind: string): string {
  const arg = kind.startsWith("space ") ? kind.slice("space ".length).trim() : "";
  // Match InsetSpace::spaceToXMLEntity (LyX 2.5).
  if (arg.includes("textvisiblespace")) return "\u2423";
  if (arg.includes("qquad")) return "\u2003\u2003";
  if (arg.includes("quad")) return "\u2003";
  if (arg.includes("enskip")) return "\u2002";
  if (arg.includes("enspace")) return "\u2060\u2002\u2060";
  if (arg.includes("thinspace")) return "\u202f";
  if (arg.includes("medspace")) return "\u2005";
  if (arg.includes("thickspace")) return "\u2004";
  if (
    arg.includes("negthinspace") || arg.includes("negmedspace") || arg.includes("negthickspace") ||
    arg === "~"
  ) {
    return "\u00a0";
  }
  if (arg === "\\space{}" || arg === "\\space") return " ";
  if (
    arg.includes("hfill") || arg.includes("dotfill") || arg.includes("hrulefill") ||
    arg.includes("leftarrowfill") || arg.includes("rightarrowfill") ||
    arg.includes("upbracefill") || arg.includes("downbracefill") ||
    arg.includes("hspace")
  ) {
    return "\n";
  }
  return "\u00a0";
}

/** Primary open/close, secondary open/close. Keys are InsetQuotes style_char. */
const QUOTE_STYLES: Record<string, [string, string, string, string]> = {
  e: ["\u201c", "\u201d", "\u2018", "\u2019"],
  s: ["\u201d", "\u201d", "\u2019", "\u2019"],
  g: ["\u201e", "\u201c", "\u201a", "\u2018"],
  p: ["\u201e", "\u201d", "\u201a", "\u2019"],
  c: ["\u00ab", "\u00bb", "\u2039", "\u203a"],
  a: ["\u00bb", "\u00ab", "\u203a", "\u2039"],
  q: ["\u0022", "\u0022", "\u0027", "\u0027"],
  b: ["\u2018", "\u2019", "\u201c", "\u201d"],
  w: ["\u00bb", "\u00bb", "\u2019", "\u2019"],
  f: ["\u00ab", "\u00bb", "\u201c", "\u201d"],
  i: ["\u00ab", "\u00bb", "\u00ab", "\u00bb"],
  r: ["\u00ab", "\u00bb", "\u201e", "\u201c"],
  j: ["\u300c", "\u300d", "\u300e", "\u300f"],
  k: ["\u300a", "\u300b", "\u3008", "\u3009"],
  h: ["\u201e", "\u201d", "\u00bb", "\u00ab"],
  d: ["\u201d", "\u201e", "\u2019", "\u201a"],
  x: ["\u201c", "\u201d", "\u2018", "\u2019"],
};

function quoteChar(kind: string): string {
  const code = kind.startsWith("Quotes ") ? kind.slice("Quotes ".length).trim() : "";
  if (code.length !== 3) return "\"";
  const marks = QUOTE_STYLES[code[0]] ?? QUOTE_STYLES.e;
  const secondary = code[2] === "s";
  const closing = code[1] === "r";
  return marks[(secondary ? 2 : 0) + (closing ? 1 : 0)];
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

function collectBlocks(
  root: BlockNode,
  pred: (b: BlockNode) => boolean,
  skip?: (b: BlockNode) => boolean,
): BlockNode[] {
  const out: BlockNode[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type !== "block") continue;
      if (skip?.(n)) continue;
      if (pred(n)) out.push(n);
      else walk(n.children);
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
      if (n.type === "text") {
        if (!isStatusLine(n.text)) out += n.text;
        continue;
      }
      else if (n.type === "block") {
        if (n.tag === "inset") {
          const kind = insetKind(n);
          if (
            kind === "ERT" || isInvisibleInset(n) ||
            kind === "Index" || kind.startsWith("Index ") ||
            kind.startsWith("IndexMacro") ||
            kind === "Nomenclature" || kind.startsWith("Nomenclature ")
          ) {
            continue;
          }
        }
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
    // Keep a single space between LyXHTML split runs ("1" + " Title" → "1 Title").
    if (c.role === "text" && !(c.text ?? "").trim() && node.role !== "pre") {
      if (/^[ \t]+$/.test(c.text ?? "")) return [{ role: "text", text: " ", children: [] }];
      return [];
    }
    if ((node.role === "cell" || node.role === "figure") && c.role === "paragraph") return c.children;
    if (node.role === "caption" && c.role === "paragraph") return c.children;
    // Title/author footnotes are inline in LyXHTML; Live uses <details> — flatten for compare.
    if ((node.role === "author" || node.role === "title") && c.role === "footnote") {
      return [{ role: "text", text: collectText(c), children: [] }];
    }
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
    // Inter-block whitespace from LyXHTML (newlines between </h2> and <div>) is not content.
    const blocky = new Set([
      "list",
      "table",
      "figure",
      "section",
      "quote",
      "formula",
      "document",
      "heading",
      "paragraph",
      "caption",
      "title",
      "abstract",
      "author",
      "note",
    ]);
    if (merged[0]?.role === "text" && merged[0].text) merged[0].text = merged[0].text.trimStart();
    const last = merged[merged.length - 1];
    if (last?.role === "text" && last.text) last.text = last.text.trimEnd();
    for (let i = 0; i < merged.length; i++) {
      const cur = merged[i];
      if (cur.role !== "text" || !cur.text) continue;
      if (i > 0 && blocky.has(merged[i - 1].role)) cur.text = cur.text.trimStart();
      if (i + 1 < merged.length && blocky.has(merged[i + 1].role)) cur.text = cur.text.trimEnd();
    }
    // Drop text nodes that are only whitespace after block trimming.
    for (let i = merged.length - 1; i >= 0; i--) {
      const cur = merged[i]!;
      if (cur.role === "text" && !(cur.text ?? "").trim()) merged.splice(i, 1);
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
  if (tag === "h1" && cls.split(/\s+/).includes("title")) {
    return { role: "title", children };
  }
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
    const tex = findTexAnnotation(node);
    let text = normalizeFormula(tex ?? collectText({ role: tag, children, text: node.text }));
    const eqno = findEqno(node);
    if (eqno && !text.endsWith(eqno)) text += eqno;
    return { role: "formula", text, children: [] };
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
    const classes = cls.split(/\s+/).filter(Boolean);
    const fromAttr = node.attrs?.["data-info-icon"] || node.attrs?.["aria-label"] ||
      node.attrs?.title || "";
    const fromFile = basenameAttr(node.attrs?.src ?? "").replace(/\.(svgz?|png|jpe?g|gif|webp)$/i, "");
    const iconName = (fromAttr || fromFile).trim();
    // Live Info icons only — native guiicon wrappers are remapped in span.guiicon below.
    if (classes.includes("info-icon") || node.attrs?.["data-info-icon"]) {
      return { role: "icon", attrs: iconName ? { name: iconName } : undefined, children: [] };
    }
    const src = node.attrs?.["data-filename"] || basenameAttr(node.attrs?.src ?? "");
    return { role: "image", attrs: src ? { filename: src } : undefined, children: [] };
  }
  if (tag === "br") return { role: "break", children: [] };
  // DL131 disclosure chrome vs footnote semantics for oracle compare.
  if (tag === "details") {
    const classes = cls.split(/\s+/).filter(Boolean);
    if (classes.includes("foot") || classes.includes("foot_intitle")) {
      return { role: "footnote", children };
    }
    // Other disclosed insets: compare body only (drop summary labels).
    return { role: "wrap", children };
  }
  if (tag === "summary") {
    const classes = cls.split(/\s+/).filter(Boolean);
    // Footnote marker text compares as bare text under footnote (native LyXHTML shape).
    if (classes.includes("foot_label") || classes.includes("foot_intitle_label")) {
      return { role: "wrap", children };
    }
    return { role: "wrap", children: [] };
  }
  if (tag === "em" || tag === "i") return { role: "emphasis", children };
  if (tag === "strong" || tag === "b") return { role: "strong", children };
  if (tag === "u") return { role: "underline", children };
  if (tag === "s" || tag === "del") return { role: "strike", children };
  if (tag === "aside") return { role: "note", children };
  if (tag === "kbd" || tag === "bdo") {
    const classes = cls.split(/\s+/).filter(Boolean);
    if (classes.includes("shortcut") || classes.includes("shortcuts") || classes.includes("info-shortcut")) {
      const text = collapseWs(collectText({ role: tag, children, text: node.text }), false).trim();
      return { role: "shortcut", text: text || undefined, children: [] };
    }
  }
  if (tag === "a") {
    const classes = cls.split(/\s+/).filter(Boolean);
    const href = node.attrs?.href ?? "";
    if (classes.includes("ref") || classes.includes("reference")) {
      return mapRefRole(node, children);
    }
    // Native LyXHTML cross-refs are bare <a href="#…"> (no class="ref").
    if (href.startsWith("#")) {
      return mapRefRole(node, children);
    }
    if (classes.includes("citation")) return { role: "citation", children };
    if (classes.includes("href") || href) {
      return { role: "link", attrs: href ? { href } : undefined, children };
    }
    // Empty anchors used only as id targets (<a id="…"/>) — drop.
    if (node.attrs?.id && !href && children.length === 0) {
      return { role: "wrap", children: [] };
    }
  }
  if (tag === "p" || tag === "div") {
    const classes = cls.split(/\s+/).filter(Boolean);
    if (classes.includes("float-figure") || classes.includes("float-table")) {
      return { role: "figure", children };
    }
    if (classes.includes("float-body")) return { role: "wrap", children };
    if (classes.includes("abstract")) return { role: "abstract", children };
    if (classes.includes("author")) return { role: "author", children };
    if (classes.includes("date")) return { role: "date", children };
    return { role: "paragraph", children };
  }
  if (tag === "span") {
    const classes = cls.split(/\s+/).filter(Boolean);
    if (classes.includes("citation")) return { role: "citation", children };
    if (classes.includes("ref")) return mapRefRole(node, children);
    if (classes.includes("info-icon")) {
      const name = node.attrs?.["aria-label"] || node.attrs?.title ||
        collectText({ role: tag, children, text: node.text }).trim();
      return { role: "icon", attrs: name ? { name } : undefined, children: [] };
    }
    // Native Info icons wrap <img> in span.guiicon — promote to role icon by LFUN/name.
    if (classes.includes("guiicon")) {
      const promoted = children.map((c) => {
        if (c.role !== "image" || !c.attrs?.filename) return c;
        const name = c.attrs.filename.replace(/\.(svgz?|png|jpe?g|gif|webp)$/i, "");
        return { role: "icon", attrs: name ? { name } : undefined, children: [] as SemNode[] };
      });
      return { role: "wrap", children: promoted };
    }
    return { role: "wrap", children };
  }
  if (tag === "text") return { role: "text", text: node.text, children: [] };
  return { role: "wrap", children };
}

/** Cross-refs: pageref text is oracle-tolerant (DL130 J1); other refs keep link text. */
function mapRefRole(node: SemNode, children: SemNode[]): SemNode {
  const href = (node.attrs?.href ?? "").replace(/^#/, "");
  const title = node.attrs?.title ?? "";
  const pageTolerant = /page\s*reference/i.test(title) ||
    (node.attrs?.class ?? "").split(/\s+/).includes("pageref");
  const attrs: Record<string, string> = {};
  if (href) attrs.target = href;
  if (pageTolerant) {
    attrs.page = "tolerant";
    return { role: "ref", attrs, children: [] };
  }
  return { role: "ref", attrs: Object.keys(attrs).length ? attrs : undefined, children };
}

function collectText(node: SemNode): string {
  if (node.text) return node.text;
  return node.children.map(collectText).join("");
}

function findEqno(node: SemNode): string | undefined {
  if ((node.attrs?.class ?? "").split(/\s+/).includes("eqno")) {
    return collectText(node).replace(/\s+/g, "");
  }
  for (const child of node.children) {
    const found = findEqno(child);
    if (found) return found;
  }
  return undefined;
}

function findTexAnnotation(node: SemNode): string | undefined {
  if (node.role === "annotation") {
    const enc = node.attrs?.encoding ?? "";
    if (enc === "application/x-tex") return collectText(node);
  }
  for (const child of node.children) {
    const found = findTexAnnotation(child);
    if (found) return found;
  }
  return undefined;
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

