/**
 * DL137: simulate Live preview selections, persist live-selection.json, then
 * `lq read` the published pointer and check the read-back owns the highlight.
 *
 * Selection kinds (Help/*.lyx plus my_template): caret, unique-phrase highlight,
 * include-child (via), table-cell nested layout paths, footnote/note nested paths,
 * headings, lists, frontmatter, formula/caption/float/float-body when mapped,
 * multi-owner, first/last token, short unique words.
 * Also reports preview-vs-CST text gaps by kind and unmapped HTML phrases
 * (no data-ref ancestor — DL140 fail-closed holes).
 *
 * Usage (from lq/):
 *   deno run -A tools/live_selection_read_oracle.ts
 *   deno run -A tools/live_selection_read_oracle.ts Intro.lyx Tutorial.lyx
 *   deno run -A tools/live_selection_read_oracle.ts --cli=sample
 *   deno run -A tools/live_selection_read_oracle.ts EmbeddedObjects.lyx --cli=all
 *
 * `--cli=off` (default): in-process equivalent of `lq read` (query + CST text).
 * `--cli=sample`: also spawn the real CLI once per (file, kind).
 * `--cli=all`: spawn the real CLI for every unique (file, selector).
 */
import { basename, dirname, fromFileUrl, join } from "@std/path";
import { parse } from "../src/parser.ts";
import type { BlockNode, Node } from "../src/ast.ts";
import { query } from "../src/query.ts";
import { concatenateTextNodes } from "../src/text_utils.ts";
import { extractAllText } from "../src/tracked_changes.ts";
import {
  buildLiveResponse,
  decodeEntities,
  type LiveToken,
} from "../src/preview.ts";

const HELP_DIR = join(import.meta.dirname!, "../tests/fixtures/Help");
const FIXTURES = join(import.meta.dirname!, "../tests/fixtures");
const MAIN = fromFileUrl(new URL("../main.ts", import.meta.url));
const MIN_PHRASE = 8;
const PER_KIND_TOKENS = 6;
const PER_TOKEN_PHRASES = 2;
const SHORT_WORD_MIN = 4;

type CliMode = "off" | "sample" | "all";

type LiveRecord = {
  file: string;
  diskHash: string;
  stale: boolean;
  mode: "original" | "tracked" | "clean";
  selector: string;
  selectedText: string;
  changeId: string | null;
  multi: boolean;
  capturedAt: string;
  via?: { file: string; selector: string };
};

type Case = {
  previewFile: string;
  kind: string;
  variant: string;
  id: string;
  phrase: string;
  /** For multi-owner: the anchor owner's own slice of selectedText. */
  anchorPhrase?: string;
  record: LiveRecord;
};

type Fail = {
  file: string;
  kind: string;
  variant: string;
  phrase: string;
  selector: string;
  reason: string;
};

type KindStats = {
  cases: number;
  jsonOk: number;
  resolveOk: number;
  ownsPhrase: number;
  textOnlyOwns: number;
  caretOk: number;
  cliOk: number;
  cliTried: number;
};

function nodePhraseText(node: Node): string {
  if (node.type === "text") return node.text;
  if (node.type === "property") return `${node.key} ${node.value ?? ""}`;
  if (node.type !== "block") return "";
  const args = (node.args ?? "").trim();
  // ERT payload is opaque text children — concatenateTextNodes does not collect
  // inset metadata text; use extractAllText (DL137 revisit).
  if (node.tag === "inset" && (args === "ERT" || args.startsWith("ERT "))) {
    return extractAllText(node).replace(/\s+/g, " ").trim();
  }
  let nested = "";
  if (node.tag === "layout" || node.tag === "inset") {
    const { fullText } = concatenateTextNodes(node.children, {
      includeDeleted: true,
      recurseLayouts: true,
      topLevelIsLayout: node.tag === "layout",
      skipInvisibleNotes: false,
    });
    nested = fullText;
  } else {
    nested = node.children.map(nodePhraseText).join(" ");
  }
  return `${args} ${nested}`.replace(/\s+/g, " ").trim();
}

function formatTextOnly(nodes: Node[]): string {
  const texts: string[] = [];
  for (const node of nodes) {
    const prefix = node.type === "block"
      ? node.tag + "[" + ((node.args || "").trim()) + "]"
      : "";
    let text: string;
    if (node.type === "block" && node.tag === "inset") {
      const layouts = node.children.filter((c): c is BlockNode =>
        c.type === "block" && c.tag === "layout"
      );
      text = layouts.length > 0
        ? layouts.map((c) =>
          "layout[" + ((c.args || "").trim()) + "] " + extractAllText(c).trim()
        ).join("\n")
        : extractAllText(node).trim();
    } else {
      text = extractAllText(node).trim();
    }
    const combined = prefix ? prefix + " " + text : text;
    if (combined.length > 0) texts.push(combined);
  }
  return texts.join("\n\n") + "\n";
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function ownsPhrase(nodes: Node[], phrase: string): boolean {
  if (!phrase) return nodes.length > 0;
  const n = norm(phrase);
  return nodes.some((node) => norm(nodePhraseText(node)).includes(n));
}

function classifyToken(t: LiveToken): string {
  if (t.id.startsWith("change-")) return "change";
  if (t.bundle.via) return "include-child";
  const s = t.bundle.selector;
  // Prefer the deepest structural hop (DL138/139 nested paths).
  if (/inset\[Tabular/.test(s) && /inset\[Text\]/.test(s) && /layout\[/.test(s)) {
    return "table-cell";
  }
  if (/inset\[Caption/.test(s) && /layout\[/.test(s)) return "caption";
  if (
    /inset\[(?:Float|Wrap|listings)\b/.test(s) && /layout\[/.test(s) &&
    !/inset\[Caption/.test(s)
  ) {
    return "float-body";
  }
  const inset = s.match(/inset\[([^\]]+)\]/);
  const layout = s.match(/layout\[([^\]]+)\]/);
  if (inset) {
    const kind = inset[1];
    if (kind.startsWith("Formula")) return "formula";
    if (kind.startsWith("Foot")) return "footnote";
    if (kind.startsWith("Note")) return "note";
    if (kind.startsWith("Caption")) return "caption";
    if (kind.startsWith("Float") || kind.startsWith("Wrap")) return "float";
    if (/^tabular$/i.test(kind) || kind.startsWith("Tabular")) return "tabular";
    if (kind.startsWith("ERT")) return "ert";
    if (kind.startsWith("listings") || kind.startsWith("Listings")) return "listings";
    if (kind.startsWith("CommandInset")) return "command-inset";
    if (kind.startsWith("Graphics") || kind.startsWith("External")) return "graphics";
    if (kind.startsWith("Box")) return "box";
    if (kind.startsWith("Branch")) return "branch";
    return "other-inset";
  }
  if (layout) {
    const name = layout[1];
    if (["Title", "Author", "Date", "Subtitle"].includes(name)) return "frontmatter";
    if (
      /^(Part|Chapter|Section|Subsection|Subsubsection|Paragraph|Subparagraph)/
        .test(name)
    ) return "heading";
    if (["Itemize", "Enumerate", "Description", "Labeling"].includes(name)) {
      return "list";
    }
    if (name === "Standard") return "standard";
    if (name === "Plain Layout") return "plain-layout";
    if (["Quote", "Quotation", "Verse"].includes(name)) return "quote";
    if (name === "LyX-Code" || name.startsWith("Verbatim")) return "code";
    return "other-layout";
  }
  return "other";
}

/** Unique visible phrases (≥minLen) with no `data-ref` ancestor (DL140 fail-closed gaps). */
function findUnmappedPhrases(html: string, minLen = 12, limit = 40): string[] {
  const texts: string[] = [];
  const re = /<([a-zA-Z0-9]+)([^>]*)\/?>|<\/([a-zA-Z0-9]+)>|([^<]+)/g;
  const VOID = new Set(["br", "img", "hr"]);
  type El = { tag: string; id?: string; parent?: El };
  const root: El = { tag: "root" };
  const stack: El[] = [root];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? "";
      const id = attrs.match(/\bdata-ref="([^"]*)"/)?.[1];
      const el: El = { tag, id, parent: stack[stack.length - 1] };
      if (!/\/\s*$/.test(attrs) && !VOID.has(tag)) stack.push(el);
    } else if (m[3]) {
      const want = m[3].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === want) {
          stack.length = i;
          break;
        }
      }
    } else if (m[4]) {
      const raw = decodeEntities(m[4]).replace(/\s+/g, " ").trim();
      if (raw.length < minLen) continue;
      let cur: El | undefined = stack[stack.length - 1];
      let mapped = false;
      while (cur) {
        if (cur.id) {
          mapped = true;
          break;
        }
        cur = cur.parent;
      }
      if (!mapped) texts.push(raw);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    // Prefer a mid-length unique slice for reporting.
    const slice = t.length > 48 ? t.slice(0, 48) : t;
    if (seen.has(slice)) continue;
    if (countOccurrences(html, slice) !== 1) continue;
    seen.add(slice);
    out.push(slice);
    if (out.length >= limit) break;
  }
  return out;
}

function closestDataRef(html: string, phrase: string): string | undefined {
  type El = { tag: string; id?: string; parent?: El };
  const root: El = { tag: "root" };
  const stack: El[] = [root];
  const re = /<([a-zA-Z0-9]+)([^>]*)\/?>|<\/([a-zA-Z0-9]+)>|([^<]+)/g;
  const VOID = new Set(["br", "img", "hr"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? "";
      const id = attrs.match(/\bdata-ref="([^"]*)"/)?.[1];
      const el: El = { tag, id, parent: stack[stack.length - 1] };
      if (!/\/\s*$/.test(attrs) && !VOID.has(tag)) stack.push(el);
    } else if (m[3]) {
      const want = m[3].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === want) {
          stack.length = i;
          break;
        }
      }
    } else if (m[4]?.includes(phrase)) {
      let cur: El | undefined = stack[stack.length - 1];
      while (cur) {
        if (cur.id) return cur.id;
        cur = cur.parent;
      }
    }
  }
  return undefined;
}

function stripToc(html: string): string {
  return html.replace(/<nav class="toc">[\s\S]*?<\/nav>/g, "");
}

function textByDataRef(html: string): Map<string, string> {
  type El = { tag: string; id?: string; parent?: El; texts: string[] };
  const byId = new Map<string, El>();
  const root: El = { tag: "root", texts: [] };
  const stack: El[] = [root];
  const re = /<([a-zA-Z0-9]+)([^>]*)\/?>|<\/([a-zA-Z0-9]+)>|([^<]+)/g;
  const VOID = new Set(["br", "img", "hr"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? "";
      const id = attrs.match(/\bdata-ref="([^"]*)"/)?.[1];
      const el: El = { tag, id, parent: stack[stack.length - 1], texts: [] };
      if (id) byId.set(id, el);
      if (!/\/\s*$/.test(attrs) && !VOID.has(tag)) stack.push(el);
    } else if (m[3]) {
      const want = m[3].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === want) {
          stack.length = i;
          break;
        }
      }
    } else if (m[4]) {
      const text = decodeEntities(m[4]).replace(/\s+/g, " ").trim();
      if (!text) continue;
      let cur: El | undefined = stack[stack.length - 1];
      while (cur && !cur.id) cur = cur.parent;
      if (cur?.id) cur.texts.push(text);
    }
  }
  const out = new Map<string, string>();
  for (const [id, el] of byId) {
    out.set(id, el.texts.join(" ").replace(/\s+/g, " ").trim());
  }
  return out;
}

function dataRefOrder(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\bdata-ref="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    n++;
    from = i + Math.max(1, needle.length);
  }
  return n;
}

function pickPhrases(blob: string, limit: number): string[] {
  const words = blob.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let n = 6; n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ");
      if (phrase.length < MIN_PHRASE) continue;
      if (/^[\d.*†‡§¶\s]+$/.test(phrase)) continue;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
      if (out.length >= limit) return out;
    }
  }
  if (blob.length >= MIN_PHRASE && !seen.has(blob)) out.push(blob.slice(0, 80));
  return out;
}

function pickShortWord(blob: string): string | undefined {
  const words = blob.split(" ").filter((w) =>
    w.length >= SHORT_WORD_MIN && /[A-Za-z]/.test(w)
  );
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return words.find((w) => counts.get(w) === 1);
}

function formatLiveSelectionJson(record: LiveRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseLiveSelectionJson(raw: string): LiveRecord | undefined {
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
  if (o.mode !== "original" && o.mode !== "tracked" && o.mode !== "clean") {
    return undefined;
  }
  if (typeof o.selector !== "string" || o.selector.length === 0) return undefined;
  if (typeof o.selectedText !== "string") return undefined;
  if (typeof o.multi !== "boolean" || typeof o.capturedAt !== "string") {
    return undefined;
  }
  const changeId = o.changeId === null
    ? null
    : typeof o.changeId === "string"
    ? o.changeId
    : null;
  let via: LiveRecord["via"];
  if (o.via !== null && o.via !== undefined) {
    if (typeof o.via !== "object") return undefined;
    const v = o.via as Record<string, unknown>;
    if (typeof v.file !== "string" || v.file.length === 0) return undefined;
    if (typeof v.selector !== "string" || v.selector.length === 0) return undefined;
    via = { file: v.file, selector: v.selector };
  }
  const record: LiveRecord = {
    file: o.file,
    diskHash: o.diskHash,
    stale: o.stale,
    mode: o.mode,
    selector: o.selector,
    selectedText: o.selectedText,
    changeId,
    multi: o.multi,
    capturedAt: o.capturedAt,
  };
  if (via) record.via = via;
  return record;
}

function resolveRecord(
  token: LiveToken,
  selectedText: string,
  multi: boolean,
  ctx: { file: string; diskHash: string; mode: LiveRecord["mode"] },
): LiveRecord {
  const foreign = typeof token.bundle.file === "string" && token.bundle.file.length > 0;
  const record: LiveRecord = {
    file: foreign ? token.bundle.file! : ctx.file,
    diskHash: foreign ? (token.bundle.diskHash ?? ctx.diskHash) : ctx.diskHash,
    stale: foreign ? false : false,
    mode: ctx.mode,
    selector: token.bundle.selector,
    selectedText,
    changeId: token.id.startsWith("change-") ? token.id : null,
    multi,
    capturedAt: new Date().toISOString(),
  };
  if (token.bundle.via) {
    record.via = { file: token.bundle.via.file, selector: token.bundle.via.selector };
  }
  return record;
}

function uniquePhrases(
  html: string,
  blob: string,
  cstText: string,
  limit: number,
): string[] {
  const out: string[] = [];
  for (const p of pickPhrases(blob, limit * 8)) {
    if (!cstText.includes(p)) continue;
    if (countOccurrences(html, p) !== 1) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

async function listHelp(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(HELP_DIR)) {
    if (entry.isFile && entry.name.endsWith(".lyx")) names.push(entry.name);
  }
  names.sort();
  return names;
}

function sampleTokensByKind(tokens: LiveToken[], ambiguous: Set<string>): LiveToken[] {
  const buckets = new Map<string, LiveToken[]>();
  for (const t of tokens) {
    if (ambiguous.has(t.id)) continue;
    const kind = classifyToken(t);
    const arr = buckets.get(kind) ?? [];
    if (arr.length < PER_KIND_TOKENS) arr.push(t);
    buckets.set(kind, arr);
  }
  const out: LiveToken[] = [];
  for (const arr of buckets.values()) out.push(...arr);
  if (tokens.length > 0 && !ambiguous.has(tokens[0].id)) {
    if (!out.includes(tokens[0])) out.push(tokens[0]);
  }
  const last = tokens[tokens.length - 1];
  if (last && !ambiguous.has(last.id) && !out.includes(last)) out.push(last);
  return out;
}

type FileAstCache = Map<string, ReturnType<typeof parse>>;

function astFor(cache: FileAstCache, file: string, fallback: ReturnType<typeof parse>) {
  let ast = cache.get(file);
  if (!ast) {
    try {
      ast = parse(Deno.readTextFileSync(file));
      cache.set(file, ast);
    } catch {
      ast = fallback;
    }
  }
  return ast;
}

function buildCases(
  previewFile: string,
  previewAst: ReturnType<typeof parse>,
  tokens: LiveToken[],
  html: string,
  byRef: Map<string, string>,
  ctx: { file: string; diskHash: string; mode: LiveRecord["mode"] },
  astCache: FileAstCache,
): Case[] {
  const cases: Case[] = [];
  const idCounts = new Map<string, number>();
  for (const t of tokens) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  const ambiguous = new Set(
    [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id),
  );
  const sampled = sampleTokensByKind(tokens, ambiguous);
  const seen = new Set<string>();
  const push = (c: Case) => {
    const key = `${c.kind}|${c.variant}|${c.record.selector}|${c.phrase}|${c.record.multi}`;
    if (seen.has(key)) return;
    seen.add(key);
    cases.push(c);
  };

  for (const token of sampled) {
    const kind = classifyToken(token);
    const blob = byRef.get(token.id) ?? "";
    const ast = astFor(astCache, token.bundle.file ?? previewFile, previewAst);
    let matches: Node[] = [];
    try {
      matches = query(ast, token.bundle.selector);
    } catch {
      matches = [];
    }
    const cstText = matches.map(nodePhraseText).join("\n");

    push({
      previewFile,
      kind,
      variant: "caret",
      id: token.id,
      phrase: "",
      record: resolveRecord(token, "", false, ctx),
    });

    for (const phrase of uniquePhrases(html, blob, cstText, PER_TOKEN_PHRASES)) {
      const closest = closestDataRef(html, phrase) ?? token.id;
      const landed = tokens.find((t) => t.id === closest) ?? token;
      push({
        previewFile,
        kind: classifyToken(landed),
        variant: "highlight",
        id: landed.id,
        phrase,
        record: resolveRecord(landed, phrase, false, ctx),
      });
    }

    // HTML-unique phrases that may not be in CST (heading numbers, MathML).
    if (kind === "heading" || kind === "formula" || kind === "table-cell") {
      for (const p of pickPhrases(blob, 4)) {
        if (countOccurrences(html, p) !== 1) continue;
        if (cstText.includes(p)) continue;
        const closest = closestDataRef(html, p) ?? token.id;
        const landed = tokens.find((t) => t.id === closest) ?? token;
        push({
          previewFile,
          kind: classifyToken(landed),
          variant: "html-only",
          id: landed.id,
          phrase: p,
          record: resolveRecord(landed, p, false, ctx),
        });
        break;
      }
    }

    const short = pickShortWord(blob);
    if (short && countOccurrences(html, short) === 1 && cstText.includes(short)) {
      push({
        previewFile,
        kind,
        variant: "short-word",
        id: token.id,
        phrase: short,
        record: resolveRecord(token, short, false, ctx),
      });
    }
  }

  const order = dataRefOrder(html);
  for (let i = 0; i < order.length - 1 && i < 400; i++) {
    const a = tokens.find((t) => t.id === order[i]);
    const b = tokens.find((t) => t.id === order[i + 1]);
    if (!a || !b || a.id === b.id) continue;
    const ta = byRef.get(a.id) ?? "";
    const tb = byRef.get(b.id) ?? "";
    const wa = ta.split(" ").filter(Boolean).slice(-3).join(" ");
    const wb = tb.split(" ").filter(Boolean).slice(0, 3).join(" ");
    if (wa.length < 3 || wb.length < 3) continue;
    const phrase = `${wa} ${wb}`;
    push({
      previewFile,
      kind: "multi",
      variant: "cross-owner",
      id: a.id,
      phrase,
      anchorPhrase: wa,
      record: resolveRecord(a, phrase, true, ctx),
    });
    if (cases.filter((c) => c.kind === "multi").length >= 4) break;
  }

  return cases;
}

async function writeAndReadRecord(
  dir: string,
  record: LiveRecord,
): Promise<{ ok: boolean; roundTrip?: LiveRecord; reason?: string }> {
  const path = join(dir, "live-selection.json");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, formatLiveSelectionJson(record));
  const raw = await Deno.readTextFile(path);
  const parsed = parseLiveSelectionJson(raw);
  if (!parsed) return { ok: false, reason: "live-selection.json failed to parse" };
  if (parsed.file !== record.file) return { ok: false, reason: "file mismatch after JSON round-trip" };
  if (parsed.selector !== record.selector) {
    return { ok: false, reason: "selector mismatch after JSON round-trip" };
  }
  if (parsed.selectedText !== record.selectedText) {
    return { ok: false, reason: "selectedText mismatch after JSON round-trip" };
  }
  return { ok: true, roundTrip: parsed };
}

type CliCache = Map<string, { text?: string; dataText?: string; error?: string; count?: number }>;

async function runLqRead(
  file: string,
  selector: string,
  cache: CliCache,
): Promise<{ text?: string; dataText?: string; error?: string; count?: number }> {
  const key = `${file}\0${selector}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "read", file, selector],
    stdout: "piped",
    stderr: "piped",
    cwd: dirname(MAIN),
  });
  const { stdout, stderr, code } = await proc.output();
  const out = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();
  let parsed: { text?: string; data?: Node[]; count?: number; code?: string; message?: string };
  try {
    parsed = JSON.parse(out);
  } catch {
    const result = { error: `CLI JSON parse failed (${code}): ${out.slice(0, 200)} ${err.slice(0, 200)}` };
    cache.set(key, result);
    return result;
  }
  if (parsed.code && !parsed.data) {
    const result = { error: parsed.message ?? parsed.code };
    cache.set(key, result);
    return result;
  }
  const data = parsed.data ?? [];
  const result = {
    dataText: data.map(nodePhraseText).join("\n"),
    count: typeof parsed.count === "number" ? parsed.count : data.length,
  };
  cache.set(key, result);
  return result;
}

async function runLqReadTextOnly(
  file: string,
  selector: string,
  cache: CliCache,
): Promise<string | undefined> {
  const key = `text\0${file}\0${selector}`;
  const hit = cache.get(key);
  if (hit) return hit.text;
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "read", file, selector, "--text-only"],
    stdout: "piped",
    stderr: "piped",
    cwd: dirname(MAIN),
  });
  const { stdout, code } = await proc.output();
  const out = new TextDecoder().decode(stdout).trim();
  try {
    const parsed = JSON.parse(out) as { text?: string; code?: string };
    const text = parsed.text ?? "";
    cache.set(key, { text });
    return text;
  } catch {
    cache.set(key, { error: `text-only parse failed (${code})` });
    return undefined;
  }
}

function parseArgs(args: string[]): { files: string[]; cli: CliMode; samples?: string } {
  let cli: CliMode = "off";
  let samples: string | undefined;
  const files: string[] = [];
  for (const a of args) {
    if (a.startsWith("--cli=")) {
      const v = a.slice("--cli=".length);
      if (v === "off" || v === "sample" || v === "all") cli = v;
    } else if (a.startsWith("--samples=")) {
      samples = a.slice("--samples=".length);
    } else if (!a.startsWith("-")) files.push(a);
  }
  return { files, cli, samples };
}

function emptyKind(): KindStats {
  return {
    cases: 0,
    jsonOk: 0,
    resolveOk: 0,
    ownsPhrase: 0,
    textOnlyOwns: 0,
    caretOk: 0,
    cliOk: 0,
    cliTried: 0,
  };
}

async function main() {
  const { files: want, cli, samples: sampleOut } = parseArgs(Deno.args);
  const helpNames = want.length > 0 ? want : await listHelp();
  const paths = helpNames.map((n) => {
    if (n.includes("/") || n.includes("\\")) return n;
    const name = n.endsWith(".lyx") ? n : `${n}.lyx`;
    if (name === "my_template.lyx") return join(FIXTURES, name);
    return join(HELP_DIR, name);
  });
  if (want.length === 0) paths.unshift(join(FIXTURES, "my_template.lyx"));

  const tmp = await Deno.makeTempDir({ prefix: "lq-live-sel-" });
  const cliCache: CliCache = new Map();
  const kindStats = new Map<string, KindStats>();
  const fails: Fail[] = [];
  const gaps: Fail[] = [];
  const samples: Record<string, LiveRecord> = {};
  const unmappedSamples: { file: string; phrase: string }[] = [];
  let unmappedTotal = 0;
  let total = 0;
  let ok = 0;

  console.log(
    `DL137 live-selection → lq read — ${paths.length} file(s), cli=${cli}\n`,
  );

  for (const path of paths) {
    const file = basename(path);
    const t0 = performance.now();
    const text = await Deno.readTextFile(path);
    const ast = parse(text);
    const { response } = await buildLiveResponse(path, ast, text);
    const tokens = response.tokens;
    const html = stripToc(response.html);
    const byRef = textByDataRef(html);
    const unmapped = findUnmappedPhrases(html);
    unmappedTotal += unmapped.length;
    for (const phrase of unmapped.slice(0, 3)) {
      unmappedSamples.push({ file, phrase });
    }
    const astCache: FileAstCache = new Map([[path, ast]]);
    const ctx = {
      file: path,
      diskHash: response.source.diskHash,
      mode: "original" as const,
    };
    const cases = buildCases(path, ast, tokens, html, byRef, ctx, astCache);
    let fileOk = 0;
    let fileFail = 0;
    const cliSampled = new Set<string>();

    for (const c of cases) {
      total++;
      const ks = kindStats.get(c.kind) ?? emptyKind();
      ks.cases++;
      const json = await writeAndReadRecord(tmp, c.record);
      if (!json.ok || !json.roundTrip) {
        fails.push({
          file,
          kind: c.kind,
          variant: c.variant,
          phrase: c.phrase,
          selector: c.record.selector,
          reason: json.reason ?? "json round-trip failed",
        });
        fileFail++;
        kindStats.set(c.kind, ks);
        continue;
      }
      ks.jsonOk++;
      const rec = json.roundTrip;
      const prev = samples[c.kind];
      if (!prev || (prev.selectedText.length === 0 && rec.selectedText.length > 0)) {
        samples[c.kind] = rec;
      }
      if (c.kind === "include-child" && rec.via && rec.selectedText.length > 0) {
        samples["include-child"] = rec;
      }

      const targetAst = astFor(astCache, rec.file, ast);
      let matches: Node[] = [];
      let threw = "";
      try {
        matches = query(targetAst, rec.selector);
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      if (threw || matches.length === 0) {
        fails.push({
          file,
          kind: c.kind,
          variant: c.variant,
          phrase: c.phrase || "(caret)",
          selector: rec.selector,
          reason: threw ? `query threw: ${threw}` : "lq read selector matched 0 nodes",
        });
        fileFail++;
        kindStats.set(c.kind, ks);
        continue;
      }
      ks.resolveOk++;

      if (c.variant === "caret") {
        ks.caretOk++;
        ok++;
        fileOk++;
        kindStats.set(c.kind, ks);
        continue;
      }

      const phraseOk = ownsPhrase(matches, rec.selectedText);
      const textOnly = formatTextOnly(matches);
      const textOk = rec.selectedText.length > 0 &&
        norm(textOnly).includes(norm(rec.selectedText));
      if (textOk) ks.textOnlyOwns++;

      if (c.kind === "multi" && rec.multi) {
        const slice = c.anchorPhrase || rec.selectedText.split(" ").slice(0, 3).join(" ");
        if (ownsPhrase(matches, slice)) {
          ks.ownsPhrase++;
          ok++;
          fileOk++;
        } else {
          gaps.push({
            file,
            kind: c.kind,
            variant: c.variant,
            phrase: rec.selectedText,
            selector: rec.selector,
            reason: `multi selectedText includes preview chrome not in CST slice ${JSON.stringify(slice)}`,
          });
          ok++;
          fileOk++;
        }
        kindStats.set(c.kind, ks);
        continue;
      }

      if (!phraseOk) {
        if (c.variant === "html-only") {
          gaps.push({
            file,
            kind: c.kind,
            variant: c.variant,
            phrase: rec.selectedText,
            selector: rec.selector,
            reason: "preview selectedText is not in lq read CST (heading number / MathML / chrome)",
          });
          ok++;
          fileOk++;
          kindStats.set(c.kind, ks);
          continue;
        }
        fails.push({
          file,
          kind: c.kind,
          variant: c.variant,
          phrase: rec.selectedText,
          selector: rec.selector,
          reason: textOk
            ? "CST walk missed phrase but --text-only has it"
            : `lq read payload does not contain selectedText${textOk ? "" : " (nor --text-only)"}`,
        });
        fileFail++;
        kindStats.set(c.kind, ks);
        continue;
      }
      ks.ownsPhrase++;
      ok++;
      fileOk++;

      const wantCli = cli === "all" ||
        (cli === "sample" && !cliSampled.has(c.kind));
      if (wantCli) {
        cliSampled.add(c.kind);
        ks.cliTried++;
        const cliResult = await runLqRead(rec.file, rec.selector, cliCache);
        if (cliResult.error) {
          fails.push({
            file,
            kind: c.kind,
            variant: `${c.variant}+cli`,
            phrase: rec.selectedText,
            selector: rec.selector,
            reason: `CLI: ${cliResult.error}`,
          });
          fileFail++;
          ok--;
        } else if (
          rec.selectedText &&
          !norm(cliResult.dataText ?? "").includes(norm(rec.selectedText)) &&
          c.kind !== "multi"
        ) {
          fails.push({
            file,
            kind: c.kind,
            variant: `${c.variant}+cli`,
            phrase: rec.selectedText,
            selector: rec.selector,
            reason: "CLI lq read data does not contain selectedText",
          });
          fileFail++;
          ok--;
        } else {
          ks.cliOk++;
          if (cli === "all" || c.kind === "include-child" || c.kind === "table-cell") {
            await runLqReadTextOnly(rec.file, rec.selector, cliCache);
          }
        }
      }

      if (rec.via) {
        const viaAst = astFor(astCache, rec.via.file, ast);
        let viaHits: Node[] = [];
        try {
          viaHits = query(viaAst, rec.via.selector);
        } catch {
          viaHits = [];
        }
        if (
          viaHits.length === 0 ||
          !(viaHits[0]?.type === "block" &&
            (viaHits[0].args ?? "").startsWith("CommandInset"))
        ) {
          fails.push({
            file,
            kind: c.kind,
            variant: c.variant,
            phrase: rec.selectedText,
            selector: rec.via.selector,
            reason: "via.selector did not resolve to a CommandInset on via.file",
          });
          fileFail++;
          ok--;
        }
      }

      kindStats.set(c.kind, ks);
    }

    const ms = Math.round(performance.now() - t0);
    const status = fileFail === 0 ? "OK" : `FAIL×${fileFail}`;
    console.log(
      `${status.padEnd(10)} ${file.padEnd(28)} cases=${String(cases.length).padStart(4)} ` +
        `ok=${String(fileOk).padStart(4)} tokens=${String(tokens.length).padStart(5)} (${ms}ms)`,
    );
  }

  console.log("\nBy kind:");
  console.log(
    "kind".padEnd(16) +
      "cases".padStart(7) +
      "json".padStart(7) +
      "resolve".padStart(9) +
      "owns".padStart(7) +
      "txtOnly".padStart(9) +
      "caret".padStart(7) +
      "cli".padStart(10),
  );
  for (const kind of [...kindStats.keys()].sort()) {
    const s = kindStats.get(kind)!;
    const cliNote = s.cliTried ? `${s.cliOk}/${s.cliTried}` : "—";
    console.log(
      kind.padEnd(16) +
        String(s.cases).padStart(7) +
        String(s.jsonOk).padStart(7) +
        String(s.resolveOk).padStart(9) +
        String(s.ownsPhrase).padStart(7) +
        String(s.textOnlyOwns).padStart(9) +
        String(s.caretOk).padStart(7) +
        cliNote.padStart(10),
    );
  }

  console.log(
    `\nSummary: ${ok}/${total} cases OK, ${fails.length} failures, ${gaps.length} preview-vs-CST text gaps`,
  );

  if (gaps.length > 0) {
    const gapByKind = new Map<string, number>();
    for (const g of gaps) gapByKind.set(g.kind, (gapByKind.get(g.kind) ?? 0) + 1);
    console.log("\nPreview-vs-CST gaps by kind:");
    for (const kind of [...gapByKind.keys()].sort()) {
      console.log(`  ${kind.padEnd(16)} ${String(gapByKind.get(kind)).padStart(4)}`);
    }
    console.log("\nPreview selectedText not in CST (informational samples):");
    for (const g of gaps.slice(0, 20)) {
      console.log(`  ~ [${g.kind}] ${g.file} ${JSON.stringify(g.phrase).slice(0, 70)}`);
      console.log(`    selector: ${g.selector}`);
    }
    if (gaps.length > 20) console.log(`  … ${gaps.length - 20} more`);
  }

  console.log(
    `\nUnmapped visible phrases (no data-ref ancestor; unique slices): ${unmappedTotal}`,
  );
  if (unmappedSamples.length > 0) {
    console.log("Samples (fail-closed / chrome holes — human highlight publishes nothing):");
    for (const u of unmappedSamples.slice(0, 24)) {
      console.log(`  · ${u.file} ${JSON.stringify(u.phrase)}`);
    }
    if (unmappedSamples.length > 24) {
      console.log(`  … ${unmappedSamples.length - 24} more sample slots`);
    }
  }
  for (const f of fails.slice(0, 40)) {
    console.log(`  ! [${f.kind}/${f.variant}] ${f.file}`);
    console.log(`    phrase: ${JSON.stringify(f.phrase).slice(0, 80)}`);
    console.log(`    selector: ${f.selector}`);
    console.log(`    ${f.reason}`);
  }
  if (fails.length > 40) console.log(`  … ${fails.length - 40} more`);

  const sampleDir = sampleOut ?? join(tmp, "samples");
  await Deno.mkdir(sampleDir, { recursive: true });
  for (const [kind, rec] of Object.entries(samples)) {
    await Deno.writeTextFile(
      join(sampleDir, `${kind}.json`),
      formatLiveSelectionJson(rec),
    );
  }
  console.log(`\nJSON samples: ${sampleDir}`);
  console.log(`live-selection.json bus (last write): ${join(tmp, "live-selection.json")}`);

  if (fails.length > 0) Deno.exit(1);
}

if (import.meta.main) await main();
