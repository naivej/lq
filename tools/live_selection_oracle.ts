/**
 * DL135/DL136 selection oracle: simulate Live selections via closest("[data-ref]")
 * over distinctive phrases across Help/*.lyx (and optional extras), then check
 * that each published token selector query()-resolves to a CST node that owns
 * the phrase.
 *
 * For included child `.lyx` content (DL136), tokens carry bundle.file pointing
 * at the child; this oracle queries that child AST when bundle.file is set.
 * Prefer `deno test` DL136 for the full child-file + via round-trip.
 *
 * Usage (from lq/):
 *   deno run -A tools/live_selection_oracle.ts
 *   deno run -A tools/live_selection_oracle.ts Intro.lyx Tutorial.lyx
 *   deno run -A tools/live_selection_oracle.ts EmbeddedObjects.lyx --limit=250
 *   deno run -A tools/live_selection_oracle.ts --limit=200 --per-token=4
 *
 * Gate: emptyQuery should stay 0 for Include nested-under-master selectors
 * after DL136 (no `inset[CommandInset include] … layout[…]` tokens).
 */
import { basename, join } from "@std/path";
import { parse } from "../src/parser.ts";
import type { Node } from "../src/ast.ts";
import { query } from "../src/query.ts";
import { concatenateTextNodes } from "../src/text_utils.ts";
import {
  buildLiveResponse,
  decodeEntities,
} from "../src/preview.ts";

const HELP_DIR = join(import.meta.dirname!, "../tests/fixtures/Help");
const FIXTURES = join(import.meta.dirname!, "../tests/fixtures");

const MIN_PHRASE = 8;
const DEFAULT_PER_FILE_LIMIT = 200;

type Fail = {
  file: string;
  phrase: string;
  id: string;
  selector: string;
  reason: string;
};

type FileStats = {
  file: string;
  tokens: number;
  phrasesTried: number;
  phrasesSkippedHtmlOnly: number;
  ok: number;
  fail: Fail[];
  emptyQuery: number;
  nestedPathTokens: number;
  duplicateIds: string[];
};

function nodeHasPhrase(node: Node, phrase: string): boolean {
  return nodePhraseText(node).includes(phrase);
}

function nodePhraseText(node: Node): string {
  if (node.type !== "block") return "";
  const { fullText } = concatenateTextNodes(node.children, {
    includeDeleted: true,
    recurseLayouts: true,
    topLevelIsLayout: node.tag === "layout",
    skipInvisibleNotes: false,
  });
  return fullText;
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

/** Innermost data-ref ancestor of a phrase (webview closest("[data-ref]")). */
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

/** Drop generated TOC — its link labels duplicate real headings and steal closest(). */
function stripToc(html: string): string {
  return html.replace(/<nav class="toc">[\s\S]*?<\/nav>/g, "");
}

/** Text under each data-ref element (text attached to nearest mapped ancestor). */
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
  for (const [id, el] of byId) out.set(id, el.texts.join(" ").replace(/\s+/g, " ").trim());
  return out;
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

async function listHelp(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(HELP_DIR)) {
    if (entry.isFile && entry.name.endsWith(".lyx")) names.push(entry.name);
  }
  names.sort();
  return names;
}

async function sweepFile(
  path: string,
  perTokenPhraseCap: number,
  filePhraseCap: number,
): Promise<FileStats> {
  const file = basename(path);
  const text = await Deno.readTextFile(path);
  const ast = parse(text);
  const { response } = await buildLiveResponse(path, ast, text);
  // Prefer validate when clean; duplicate outline ids (sec-*) are a separate
  // contract issue — still exercise selector round-trip on the raw tokens.
  const tokens = response.tokens;
  const idCounts = new Map<string, number>();
  for (const t of tokens) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const ambiguous = new Set(duplicateIds);

  // Body HTML without TOC (TOC duplicates headings; not a DL135 desync signal).
  const html = stripToc(response.html);
  const byRef = textByDataRef(html);

  const stats: FileStats = {
    file,
    tokens: tokens.length,
    phrasesTried: 0,
    phrasesSkippedHtmlOnly: 0,
    ok: 0,
    fail: [],
    emptyQuery: 0,
    nestedPathTokens: 0,
    duplicateIds,
  };

  const candidates: { phrase: string; expectId: string }[] = [];

  const astByPath = new Map<string, ReturnType<typeof parse>>();
  astByPath.set(path, ast);
  const astForToken = (t: (typeof tokens)[0]) => {
    const fp = t.bundle.file;
    if (!fp) return ast;
    let child = astByPath.get(fp);
    if (!child) {
      child = parse(Deno.readTextFileSync(fp));
      astByPath.set(fp, child);
    }
    return child;
  };

  for (const t of tokens) {
    if (ambiguous.has(t.id)) continue;
    if (/\binset\[/.test(t.bundle.selector) && /\blayout\[/.test(t.bundle.selector)) {
      stats.nestedPathTokens++;
    }
    let matches: Node[];
    try {
      matches = query(astForToken(t), t.bundle.selector);
    } catch {
      stats.emptyQuery++;
      stats.fail.push({
        file,
        phrase: "(token)",
        id: t.id,
        selector: t.bundle.selector,
        reason: "query threw",
      });
      continue;
    }
    if (matches.length === 0) {
      stats.emptyQuery++;
      stats.fail.push({
        file,
        phrase: "(token)",
        id: t.id,
        selector: t.bundle.selector,
        reason: "query returned 0 nodes",
      });
      continue;
    }

    const cstText = matches.map(nodePhraseText).join("\n");
    const htmlBlob = byRef.get(t.id) ?? "";
    if (htmlBlob.length < MIN_PHRASE) continue;

    for (const p of pickPhrases(htmlBlob, perTokenPhraseCap * 4)) {
      if (!cstText.includes(p)) {
        stats.phrasesSkippedHtmlOnly++;
        continue;
      }
      // Unique in whole HTML so closest() has one unambiguous hit.
      if (countOccurrences(html, p) !== 1) continue;
      candidates.push({ phrase: p, expectId: t.id });
    }
  }

  const seen = new Set<string>();
  const unique: { phrase: string; expectId: string }[] = [];
  for (const c of candidates) {
    if (seen.has(c.phrase)) continue;
    seen.add(c.phrase);
    unique.push(c);
    if (unique.length >= filePhraseCap) break;
  }

  for (const { phrase, expectId } of unique) {
    stats.phrasesTried++;
    const id = closestDataRef(html, phrase);
    if (!id) {
      stats.fail.push({
        file,
        phrase,
        id: "?",
        selector: "",
        reason: "no data-ref ancestor",
      });
      continue;
    }
    const token = tokens.find((t) => t.id === id);
    if (!token) {
      stats.fail.push({
        file,
        phrase,
        id,
        selector: "",
        reason: "token missing for data-ref",
      });
      continue;
    }
    if (ambiguous.has(id)) {
      stats.phrasesSkippedHtmlOnly++;
      continue;
    }
    // closest may land on a nested mapped child — OK if its selector owns the phrase.
    let matches: Node[];
    try {
      matches = query(astForToken(token), token.bundle.selector);
    } catch (e) {
      stats.fail.push({
        file,
        phrase,
        id,
        selector: token.bundle.selector,
        reason: `query threw: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (matches.length === 0) {
      stats.fail.push({
        file,
        phrase,
        id,
        selector: token.bundle.selector,
        reason: "query returned 0 nodes",
      });
      continue;
    }
    if (!matches.some((n) => nodeHasPhrase(n, phrase))) {
      stats.fail.push({
        file,
        phrase,
        id,
        selector: token.bundle.selector,
        reason: `query match does not contain phrase (closest=${id}, sourced=${expectId})`,
      });
      continue;
    }
    stats.ok++;
  }

  return stats;
}

function parseArgs(args: string[]): { files: string[]; limit: number; perToken: number } {
  let limit = DEFAULT_PER_FILE_LIMIT;
  let perToken = 3;
  const files: string[] = [];
  for (const a of args) {
    if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
    else if (a.startsWith("--per-token=")) perToken = Number(a.slice("--per-token=".length));
    else if (!a.startsWith("-")) files.push(a);
  }
  return { files, limit, perToken };
}

async function main() {
  const { files: want, limit, perToken } = parseArgs(Deno.args);
  const helpNames = want.length > 0 ? want : await listHelp();
  const paths = helpNames.map((n) => {
    if (n.includes("/") || n.includes("\\")) return n;
    const name = n.endsWith(".lyx") ? n : `${n}.lyx`;
    if (name === "my_template.lyx") return join(FIXTURES, name);
    return join(HELP_DIR, name);
  });

  if (want.length === 0) {
    paths.unshift(join(FIXTURES, "my_template.lyx"));
  }

  console.log(`DL135 selection oracle — ${paths.length} file(s), ≤${limit} phrases/file\n`);

  const all: FileStats[] = [];
  for (const path of paths) {
    const t0 = performance.now();
    const stats = await sweepFile(path, perToken, limit);
    const ms = Math.round(performance.now() - t0);
    all.push(stats);
    const status = stats.fail.length === 0 ? "OK" : `FAIL×${stats.fail.length}`;
    const dupNote = stats.duplicateIds.length
      ? ` dups=${stats.duplicateIds.slice(0, 3).join("|")}`
      : "";
    console.log(
      `${status.padEnd(10)} ${stats.file.padEnd(28)} tokens=${String(stats.tokens).padStart(5)} ` +
        `tried=${String(stats.phrasesTried).padStart(4)} ok=${String(stats.ok).padStart(4)} ` +
        `nested=${String(stats.nestedPathTokens).padStart(4)} emptyQ=${stats.emptyQuery}${dupNote} (${ms}ms)`,
    );
    for (const f of stats.fail.slice(0, 12)) {
      console.log(`  ! ${f.id}  ${JSON.stringify(f.phrase).slice(0, 70)}`);
      console.log(`    selector: ${f.selector}`);
      console.log(`    ${f.reason}`);
    }
    if (stats.fail.length > 12) console.log(`  … ${stats.fail.length - 12} more`);
  }

  const fails = all.reduce((n, s) => n + s.fail.length, 0);
  const tried = all.reduce((n, s) => n + s.phrasesTried, 0);
  const ok = all.reduce((n, s) => n + s.ok, 0);
  console.log(`\nSummary: ${ok}/${tried} phrases OK, ${fails} failures across ${all.length} files`);
  if (fails > 0) Deno.exit(1);
}

if (import.meta.main) await main();
