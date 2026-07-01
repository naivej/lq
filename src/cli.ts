import { parse } from "./parser.ts";
import { serialize } from "./serializer.ts";
import { query } from "./query.ts";
import { getSchemaForClass, INSET_LAYOUTS, INSETS, INLINE_PROPERTIES } from "./schema.ts";
import { parseBibtex, Citation } from "./bib.ts";
import { parseArgs } from "@std/cli/parse-args";
import { Node, BlockNode, DocumentNode, PropertyNode } from "./ast.ts";
import { validateInsetType, KNOWN_COMMAND_INSET_TYPES } from "./registry.ts";
import { getCachedAst, setCachedAst, hashText, setMaxCacheEntries } from "./cache.ts";
import { sendLyxCommands, checkLyxServerAvailable } from "./lyxserver.ts";
import * as path from "@std/path";

const HELP_TEXTS: Record<string, string> = {
  global: `lq - A CLI Tool for Editing LyX Files

Usage:
  lq <command> [options] [arguments]

Commands:
  init      Initialize the user configuration file.
  schema    Return a list of all semantically valid layouts.
  dump      Output the document structure.
  read      Output matching nodes and text content.
  bib       Extract available citation keys from linked bibliography files.
  set       Overwrite the targeted nodes with new text content.
  delete    Safely delete the targeted nodes from the LyX file.
  insert    Insert new blocks or properties before/after/prepend/append.
  undo      Revert tracked changes (change_deleted/change_inserted) in matched nodes.

All output is JSON.
Run 'lq <command> --help' for more information on a specific command.`,

  selector: `lq selector - CSS-like selector to traverse the LyX document.

Tag[args]: Run 'lq schema <file>' to see optional args
  layout[documentLayouts]
  inset[insets]
  inset[CommandInset commandInsetSubtypes]
  property[inlineProperties]
  
Combinators:
  Space for descendant  e.g. layout[Section] inset[Formula]
  ~ for sibling         e.g. layout[Section] ~ layout[Standard]
  , for OR group        e.g. layout[Section], inset[Foot]

Chainable pseudo-classes: must follow a tag
  :first, :last, :nth-child(an+b/even/odd),
  :contains("text"),
  :not(selector), :adjacent(selector),
  :until(selector) bounds a ~ range to stop before the next matching sibling`,

  read: `lq read - Output matching nodes and text content.

Usage:
  lq read <file> <selector> [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.

Options:
  --count     Return match counts by type.
  --text-only Output the text content of matched nodes with structural annotations.
              Each matched node gets a tag[args] prefix (e.g. layout[Standard]),
              with double newline between nodes.
              Insets appear as inline markers (e.g. inset[Foot])
              Tracked changes appear as '\change_deleted{...}' and '\change_inserted{...}' inline markers.`,

  dump: `lq dump - Output the document structure.

Usage:
  lq dump <file> [<selector>] [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.

Options:
  --depth <n>  Limit output to n levels deep (0 = root node only).
               Omit for full depth.
  --toc        Output a hierarchical heading tree (table of contents)
               instead of the document tree. 
               Can be used with --depth, and mutually exclusive with <selector>.`,

  bib: `lq bib - Search and extract citation keys from linked .bib bibliography files.

Usage:
  lq bib <file> [options]

Arguments:
  <file>      The path to the .lyx file.

Options:
  --search <term>           Filter citations by a case-insensitive substring match across
                            key, author, title, and year. Multiple words are AND'd — all
                            must match.
                            Omit for all citations.`,

  set: `lq set - Overwrite the targeted nodes with new text content.

Usage:
  lq set <file> <selector> <new text> [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.
  <new text>  The new text content to apply to the matched nodes.

lq set preserves non-text children (insets, properties) and replaces only text nodes.
Options to change the default behaviour:
  --find <substring>   Replace all occurrences of <substring> within the matched
                       nodes' text, instead of replacing the entire text content.
  --replace-all        Replace ALL children of the target block, not just text nodes.
                       Mutually exclusive with --find.`,

  delete: `lq delete - Delete the targeted nodes.

Usage:
  lq delete <file> <selector>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.`,

  init: `lq init - Initialize or view the user configuration file.

Usage:
  lq init              Print current configuration if exists, 
                       otherwise initialize '~/.lq/config.json' with the default options.
  lq init [options]    Update configuration with the given options.

Options:
  --layouts-dir <path>     Set the LyX layouts directory.
                           Default: auto-detect the highest installed version.
  --refresh <mode>         Configure automatic refresh after mutations.
                           none (default): No refresh. LyX detects changes via polling.
                           reload:         Reload and discards unsaved in-LyX edits. 
                                           Requires LyXServer.
                           save-reload:    Save unsaved edits first before reload.
                                           Requires LyXServer.
  --track-changes <on|off> Enable or disable tracked changes for all mutation commands.
                           On (default): set wraps old text in \\change_deleted + new in \\change_inserted,
                                         delete wraps removed nodes in \\change_deleted,
                                         insert wraps new content in \\change_inserted.
  --author-name <name>     Set the author name used in tracked changes.
                           Default: "lq user".
  --max-cache-entries <n>  Set the maximum number of file caches kept in ~/.lq/cache/.
                           Default: 50.`,

  schema: `lq schema - Return all semantically valid layouts across 6 categories:
  documentLayouts      Styles valid for the document class (e.g. Section, Standard).
  insetLayouts         Layouts valid inside insets (e.g. Plain Layout).
  insets               Valid inset types (e.g. Formula, Foot, CommandInset).
  commandInsetSubtypes Valid CommandInset subtypes (e.g. citation, ref, label).
  inlineProperties     Valid inline property keys (e.g. family, lang).
  headingHierarchy     Heading layouts with their TocLevel values.

Usage:
  lq schema <file>

Arguments:
  <file>      The path to the .lyx file.`,

  insert: `lq insert - Insert new blocks or properties relative to a selector.

Usage:
  lq insert <file> <selector> <position> [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.
  <position>  Where to insert: 'before', 'after', 'prepend', 'append', or 'split-after'
              followed by <match> as the next positional argument.
              It splits a text node right after the exact, case-sensitive substring
              and inserts new content at that point.
              Only proceeds if the match appears exactly once in the block.

Options:
  --layout <name>              Name of the layout to insert (e.g., 'Standard').
  --text <content>             Text content for the new layout (required with --layout).
  --raw-file <path>            Read raw LyX string from a file. Use this for complex
                               structures like nested formulas and batch insertion.
  --cite <key>                 Insert a citation inset for the given BibTeX key.
  --cite-cmd <command>         Citation command: cite, citet (default),
                               citep, citeauthor, citeyear, citeyearpar, citebyear,
                               footcite, autocite, citetitle, fullcite, footfullcite,
                               nocite, keyonly.
  --ref <label>                Insert a cross-reference inset for the given label.
  --ref-cmd <command>          Reference command: ref (default), eqref,
                               pageref, vpageref, vref, nameref, formatted, labelonly.
  --label <name>               Insert a label inset with the given name.
  --footnote <text>            Insert a footnote inset containing a Plain Layout
                               with the given text.`,

  undo: `lq undo - Revert tracked changes in matched nodes.

Only available when trackChanges is enabled.

Usage:
  lq undo <file> <selector> [<substring>]

Arguments:
  <file>       The path to the .lyx file.
  <selector>   A CSS-like selector. Run 'lq selector --help' for syntax.
  <substring>  Text inside the change_deleted or change_inserted block to revert.
               Omit to revert ALL tracked changes in matched nodes.`
};

// Helper to load user config
interface UserConfig {
  layoutsDir?: string;
  refresh?: "none" | "reload" | "save-reload";
  trackChanges?: boolean;
  maxCacheEntries?: number;
  authorName?: string;
}

async function loadUserConfig(): Promise<UserConfig> {
  try {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (homeDir) {
      const configPath = path.join(homeDir, ".lq", "config.json");
      const stat = await Deno.stat(configPath);
      if (stat.isFile) {
        const text = await Deno.readTextFile(configPath);
        return JSON.parse(text);
      }
    }
  } catch (_e) {
    // Ignore config loading errors
  }
  return {};
}

// Helper to get default layouts dir based on OS.
// Scans for installed LyX versions instead of hardcoding a version number.
async function getDefaultLayoutsDir(): Promise<string> {
  if (Deno.build.os === "windows") {
    const bases = [
      Deno.env.get("PROGRAMFILES"),
      Deno.env.get("LOCALAPPDATA") ? path.join(Deno.env.get("LOCALAPPDATA")!, "Programs") : null,
    ].filter(Boolean) as string[];

    const candidates: { version: number[]; dir: string }[] = [];
    for (const base of bases) {
      try {
        for await (const entry of Deno.readDir(base)) {
          const m = entry.name.match(/^LyX (\d+(?:\.\d+)*)$/);
          if (m && entry.isDirectory) {
            const layoutsDir = path.join(base, entry.name, "Resources", "layouts");
            try {
              const stat = await Deno.stat(layoutsDir);
              if (stat.isDirectory) {
                const version = m[1].split(".").map(Number);
                candidates.push({ version, dir: layoutsDir });
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* base dir not readable */ }
    }

    // Sort by version descending, pick highest
    candidates.sort((a, b) => {
      for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
        const va = a.version[i] ?? 0;
        const vb = b.version[i] ?? 0;
        if (va !== vb) return vb - va;
      }
      return 0;
    });

    if (candidates.length > 0) return candidates[0].dir;

    // Fallback: hardcoded common paths
    const fallbacks = [
      path.join(Deno.env.get("LOCALAPPDATA") ?? "", "Programs", "LyX 2.5", "Resources", "layouts"),
      "C:\\Program Files\\LyX 2.5\\Resources\\layouts",
    ];
    for (const f of fallbacks) {
      try {
        const stat = await Deno.stat(f);
        if (stat.isDirectory) return f;
      } catch { /* skip */ }
    }
    return "C:\\Program Files\\LyX 2.5\\Resources\\layouts";
  } else if (Deno.build.os === "darwin") {
    const bases = ["/Applications"];
    const candidates: { version: number[]; dir: string }[] = [];
    for (const base of bases) {
      try {
        for await (const entry of Deno.readDir(base)) {
          const m = entry.name.match(/^LyX(\d+(?:\.\d+)*)\.app$/);
          if (m && entry.isDirectory) {
            const layoutsDir = path.join(base, entry.name, "Contents", "Resources", "layouts");
            try {
              const stat = await Deno.stat(layoutsDir);
              if (stat.isDirectory) {
                const version = m[1].split(".").map(Number);
                candidates.push({ version, dir: layoutsDir });
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* base dir not readable */ }
    }

    candidates.sort((a, b) => {
      for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
        const va = a.version[i] ?? 0;
        const vb = b.version[i] ?? 0;
        if (va !== vb) return vb - va;
      }
      return 0;
    });

    if (candidates.length > 0) return candidates[0].dir;
    return "/Applications/LyX.app/Contents/Resources/layouts";
  } else {
    // Linux: check common paths
    const linuxPaths = ["/usr/share/lyx/layouts", "/usr/local/share/lyx/layouts"];
    for (const p of linuxPaths) {
      try {
        const stat = await Deno.stat(p);
        if (stat.isDirectory) return p;
      } catch { /* skip */ }
    }
    return "/usr/share/lyx/layouts";
  }
}

// Warnings accumulator — all warnings go to stdout JSON, never stderr.
// Each printJson call flushes and clears the accumulator.
const _warnings: string[] = [];

function pushWarning(message: string) {
  _warnings.push(message);
}

function printJson(data: unknown) {
  // Attach pending warnings to every JSON response
  if (_warnings.length > 0) {
    (data as Record<string, unknown>).warnings = [..._warnings];
    _warnings.length = 0;
  } else {
    (data as Record<string, unknown>).warnings = [];
  }
  console.log(JSON.stringify(data, null, 2));
}

function printError(code: string, message: string) {
  printJson({ status: "error", code, message });
  Deno.exit(1);
}

/** Walk the parsed raw CST and validate all inset types against the registry. */
function validateRawInsets(doc: DocumentNode): string[] {
  const warnings: string[] = [];
  function walk(nodes: Node[]) {
    for (const node of nodes) {
      if (node.type === "block") {
        const block = node as BlockNode;
        if (block.tag === "inset" && block.isBeginVariant) {
          const validation = validateInsetType(block.args);
          if (validation) warnings.push(validation);
        }
        walk(block.children);
      }
    }
  }
  walk(doc.children);
  return warnings;
}

/** Compute the maximum depth of the CST (document = level 0). */
function computeMaxDepth(doc: DocumentNode, currentDepth: number): number {
  let maxDepth = currentDepth;
  for (const child of doc.children) {
    if (child.type === "block") {
      const childDoc: DocumentNode = { type: "document", children: (child as BlockNode).children };
      const childDepth = computeMaxDepth(childDoc, currentDepth + 1);
      if (childDepth > maxDepth) maxDepth = childDepth;
    }
  }
  return maxDepth;
}

/** Deep-clone the CST, truncating children at the given depth limit. */
function truncateAtDepth(doc: DocumentNode, maxDepth: number, currentDepth: number): unknown {
  if (currentDepth >= maxDepth) {
    // At cutoff: replace children with a count indicator
    const childCount = doc.children.length;
    // Count block children for a more useful summary
    const blockCount = doc.children.filter(c => c.type === "block").length;
    const textCount = doc.children.filter(c => c.type === "text").length;
    const propCount = doc.children.filter(c => c.type === "property").length;
    const parts: string[] = [];
    if (blockCount > 0) parts.push(`${blockCount} blocks`);
    if (textCount > 0) parts.push(`${textCount} text nodes`);
    if (propCount > 0) parts.push(`${propCount} properties`);
    if (parts.length === 0) parts.push(`${childCount} children`);
    return { type: "document", children: [`... (${parts.join(", ")})`] };
  }
  
  return {
    type: "document",
    children: doc.children.map(child => {
      if (child.type === "block") {
        const block = child as BlockNode;
        const truncatedDoc = truncateAtDepth(
          { type: "document", children: block.children },
          maxDepth,
          currentDepth + 1
        ) as { type: string; children: unknown[] };
        return {
          type: block.type,
          tag: block.tag,
          args: block.args,
          isBeginVariant: block.isBeginVariant,
          children: truncatedDoc.children,
        };
      }
      // Text and property nodes are leaf nodes — always shown
      return child;
    }),
  };
}


// Resolve the author ID for the given author name.
// Reads existing \author entries from the .lyx header:
// - If the name matches an existing author, return its ID.
// - Otherwise, auto-assign a new ID (max existing + 1, or 1 if none exist)
//   and add a new \author entry to the header.
// Returns the resolved author ID (always ≥ 1).
function resolveAuthorId(ast: DocumentNode, authorName: string): number {
  const docBlock = ast.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "document") as BlockNode;
  if (!docBlock) return 1;
  const header = docBlock.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "header") as BlockNode;
  if (!header) return 1;

  // Parse existing \author <id> "<name>" entries
  let maxId = 0;
  for (const c of header.children) {
    if (c.type !== "property" || c.key !== "author" || !c.value) continue;
    const m = c.value.match(/^(\d+)\s+"(.+)"$/);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    const name = m[2];
    if (name === authorName) return id;
    if (id > maxId) maxId = id;
  }

  // Not found — assign new ID
  const newId = maxId + 1;
  header.children.push({ type: "property", key: "author", value: `${newId} "${authorName}"` });
  return newId;
}

// Ensure \tracking_changes true is set in the header so LyX does not auto-accept
// tracked changes on file open. Without this, \change_deleted and \change_inserted
// markers are silently stripped by LyX.
function ensureTrackingChangesInHeader(ast: DocumentNode): void {
  const docBlock = ast.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "document") as BlockNode;
  if (!docBlock) return;
  const header = docBlock.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "header") as BlockNode;
  if (!header) return;
  
  const existing = header.children.find((c: Node) => c.type === "property" && c.key === "tracking_changes") as PropertyNode | undefined;
  if (existing) {
    // Overwrite any existing value (e.g. false) to true
    existing.value = "true";
  } else {
    header.children.push({ type: "property", key: "tracking_changes", value: "true" });
  }
}

/** Recursively extract text from a node's descendants.
 *  Insets emit their selector as a placeholder marker — we do NOT recurse
 *  into them.  This keeps body-text scans clean and prevents concatenation
 *  artifacts.  To see an inset's content, query the inset directly.
 *
 *  Track-change properties (change_deleted, change_inserted, change_unchanged)
 *  emit inline \change_*{} markers so the user can see pending edits at a
 *  glance.  The {} wrapper form is a deliberate simplification of LyX source
 *  syntax for readability — see dev log 45 for rationale. */
function extractAllText(node: Node): string {
  if (node.type === "text") return node.text;
  if (node.type === "property") {
    if (node.key === "change_deleted") return "\\change_deleted{";
    if (node.key === "change_inserted") return "\\change_inserted{";
    if (node.key === "change_unchanged") return "}";
    return "";
  }
  if (node.type === "block") {
    if (node.tag === "inset") {
      return " inset[" + (node.args || "").trim() + "] ";
    }
    return node.children.map(extractAllText).join("");
  }
  return "";
}

/** First N characters of a node's text, for concise verbose output. */
function briefText(node: Node, maxLen = 80): string {
  const text = extractAllText(node).trim();
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...";
}

/** Build a selector-like label for a node: tag[args]. */
function nodeLabel(node: Node): string {
  if (node.type === "block") {
    return node.tag + "[" + ((node.args || "").trim()) + "]";
  }
  return node.type;
}

interface TocNode {
  layout: string;
  text: string;
  children: TocNode[];
}

function buildToc(ast: DocumentNode, headingHierarchy: { layout: string; tocLevel: number }[]): TocNode[] {
  const rankMap = new Map(headingHierarchy.map((h, i) => [h.layout, i]));

  function rank(layout: string): number {
    const r = rankMap.get(layout);
    return r === undefined ? Infinity : r;
  }

  const stack: TocNode[] = [];
  const roots: TocNode[] = [];

  // Headings live under body > document > root. Traverse to find body.
  const docBlock = ast.children.find(n => n.type === "block" && n.tag === "document");
  const bodyNode = docBlock && docBlock.type === "block"
    ? docBlock.children.find(n => n.type === "block" && n.tag === "body")
    : undefined;
  const topLevelChildren = bodyNode && bodyNode.type === "block" ? bodyNode.children : ast.children;

  for (const node of topLevelChildren) {
    if (node.type !== "block") continue;
    const layoutName = (node.args || "").trim().split(" ")[0];
    const r = rank(layoutName);
    if (r === Infinity) continue;

    const entry: TocNode = {
      layout: layoutName,
      text: extractAllText(node).trim(),
      children: [],
    };

    while (stack.length > 0 && rank(stack[stack.length - 1].layout) >= r) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(entry);
    } else {
      stack[stack.length - 1].children.push(entry);
    }
    stack.push(entry);
  }

  return roots;
}

/** Limit TOC tree to a given depth (0 = only top-level headings). */
function truncateTocDepth(nodes: TocNode[], maxDepth: number, currentDepth: number): TocNode[] {
  if (currentDepth >= maxDepth) {
    return nodes.map(n => ({ ...n, children: [] }));
  }
  return nodes.map(n => ({
    ...n,
    children: truncateTocDepth(n.children, maxDepth, currentDepth + 1),
  }));
}

function countOccurrences(text: string, findStr: string): number {
  if (findStr.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(findStr, pos)) !== -1) {
    count++;
    pos += findStr.length;
  }
  return count;
}

/** Recursively check if children already contain pending tracked changes
 *  (change_deleted or change_inserted property nodes). Used to warn before
 *  re-editing a node that has not yet had its changes accepted/undone. */
function hasTrackedChanges(children: Node[]): boolean {
  for (const c of children) {
    if (c.type === "property" && (c.key === "change_deleted" || c.key === "change_inserted")) {
      return true;
    }
    if (c.type === "block") {
      if (hasTrackedChanges((c as BlockNode).children)) return true;
    }
  }
  return false;
}

function wrapWithTracking(nodes: Node[], type: "inserted" | "deleted", authorId: number): Node[] {
  const ts = Math.floor(Date.now() / 1000).toString();
  
  const result: Node[] = [];
  // Buffer consecutive text nodes to wrap them under a single change marker pair,
  // reducing verbosity when a layout contains many text fragments.
  let textBuffer: Node[] = [];
  
  function flushTextBuffer() {
    if (textBuffer.length > 0) {
      result.push({ type: "property", key: `change_${type}`, value: `${authorId} ${ts}` });
      for (const tn of textBuffer) result.push(tn);
      result.push({ type: "property", key: "change_unchanged" });
      textBuffer = [];
    }
  }
  
  for (const n of nodes) {
    if (n.type === "text") {
      textBuffer.push(n);
    } else {
      flushTextBuffer();
      if (n.type === "block") {
        const b = n as BlockNode;
        if (b.tag === "layout") {
          b.children = wrapWithTracking(b.children, type, authorId);
          result.push(b);
        } else if (b.tag === "inset") {
          result.push({ type: "property", key: `change_${type}`, value: `${authorId} ${ts}` });
          result.push(b);
          result.push({ type: "property", key: "change_unchanged" });
        } else {
          result.push(b);
        }
      } else {
        result.push(n);
      }
    }
  }
  flushTextBuffer();
  return result;
}

/**
 * Replace all occurrences of findStr with replacement in a text string,
 * wrapping only the changed portions in change tracking markers.
 * Surrounding text that does not match is left untracked (no markers).
 *
 * This mirrors how LyX tracks character-level edits: only the actual
 * changed characters get \change_deleted / \change_inserted markers.
 */
function replaceWithTracking(
  text: string,
  findStr: string,
  replacement: string,
  authorId: number,
  ts: string,
): Node[] {
  const result: Node[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const idx = remaining.indexOf(findStr);
    if (idx === -1) {
      // No more matches — remaining text is unchanged (untracked)
      result.push({ type: "text", text: remaining });
      break;
    }

    // Text before the match (unchanged, untracked)
    if (idx > 0) {
      result.push({ type: "text", text: remaining.substring(0, idx) });
    }

    // The matched substring (tracked as deleted)
    result.push({ type: "property", key: "change_deleted", value: `${authorId} ${ts}` });
    result.push({ type: "text", text: findStr });
    result.push({ type: "property", key: "change_unchanged" });

    // The replacement (tracked as inserted)
    result.push({ type: "property", key: "change_inserted", value: `${authorId} ${ts}` });
    result.push({ type: "text", text: replacement });
    result.push({ type: "property", key: "change_unchanged" });

    remaining = remaining.substring(idx + findStr.length);
  }

  return result;
}

// --- LyXServer refresh helpers ---

/**
 * Pre-step for save-reload: saves the user's unsaved LyX edits to disk
 * BEFORE lq reads and mutates the file. Must succeed or the mutation is aborted.
 * Returns true if the pre-step succeeded (or mode doesn't need a pre-step).
 */
export async function refreshPreStep(filePath: string, mode: "none" | "reload" | "save-reload"): Promise<boolean> {
  if (mode !== "save-reload") return true;

  const commands: string[] = [];
  // buffer-switch ensures the correct file is active before saving.
  // On Windows, skipped: the pipe protocol (Server.cpp) uses ':' as a
  // delimiter, which conflicts with the drive letter in absolute paths.
  if (Deno.build.os !== "windows") {
    commands.push(`buffer-switch ${path.resolve(filePath)}`);
  }
  commands.push("buffer-write");

  return await sendLyxCommands(commands);
}

/**
 * Post-step: reloads the buffer in LyX after lq has written to disk.
 * Best-effort — failure is silent.
 */
async function refreshPostStep(filePath: string, mode: "none" | "reload" | "save-reload"): Promise<void> {
  if (mode === "none") return;

  const commands: string[] = [];
  if (Deno.build.os !== "windows") {
    commands.push(`buffer-switch ${path.resolve(filePath)}`);
  }
  commands.push("buffer-reload");

  await sendLyxCommands(commands);
}

export async function runCli(args: string[]) {

  const parsedHelp = parseArgs(args, { boolean: ["help", "h"] });
  const showHelp = parsedHelp.help || parsedHelp.h;
  
  // Clean command name (first non-flag argument)
  const commandArg = parsedHelp._[0] ? String(parsedHelp._[0]) : undefined;

  if (showHelp || args.length === 0) {
    if (commandArg && HELP_TEXTS[commandArg]) {
      console.log(HELP_TEXTS[commandArg]);
    } else {
      console.log(HELP_TEXTS.global);
    }
    return;
  }

  // Filter out the help flags before passing to the rest of the app if they somehow got here
  const cleanArgs = args.filter(a => a !== "--help" && a !== "-h");

  if (commandArg === "init") {
    const flags = parseArgs(cleanArgs.slice(1), { string: ["layouts-dir", "refresh", "track-changes", "max-cache-entries", "author-name"] });
    const hasFlags = flags["layouts-dir"] !== undefined ||
                     flags["refresh"] !== undefined ||
                     flags["track-changes"] !== undefined ||
                     flags["max-cache-entries"] !== undefined ||
                     flags["author-name"] !== undefined;
    let dir = flags["layouts-dir"];
    const refresh = flags["refresh"] as string | undefined;
    const trackChangesFlag = flags["track-changes"] as string | undefined;
    const maxCacheEntriesStr = flags["max-cache-entries"] as string | undefined;
    const authorNameFlag = flags["author-name"] as string | undefined;

    // Validate --refresh value
    if (refresh !== undefined && refresh !== "none" && refresh !== "reload" && refresh !== "save-reload") {
      printError("INVALID_FLAG", `--refresh must be 'none', 'reload', or 'save-reload', got: '${refresh}'`);
      return;
    }

    // Validate --track-changes value
    if (trackChangesFlag !== undefined && trackChangesFlag !== "on" && trackChangesFlag !== "off") {
      printError("INVALID_FLAG", `--track-changes must be 'on' or 'off', got: '${trackChangesFlag}'`);
      return;
    }

    // Validate --max-cache-entries value
    let maxCacheEntries: number | undefined;
    if (maxCacheEntriesStr !== undefined) {
      const n = parseInt(maxCacheEntriesStr, 10);
      if (isNaN(n) || n < 0) {
        printError("INVALID_FLAG", `--max-cache-entries must be a non-negative integer, got: '${maxCacheEntriesStr}'`);
        return;
      }
      maxCacheEntries = n;
    }

    // If no flags and config exists, print it and exit
    if (!hasFlags) {
      const existing = await loadUserConfig();
      const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
      if (homeDir) {
        const configPath = path.join(homeDir, ".lq", "config.json");
        try {
          const stat = await Deno.stat(configPath);
          if (stat.isFile) {
            printJson({ status: "success", data: existing });
            return;
          }
        } catch { /* config doesn't exist, proceed to create */ }
      }
    }

    if (!dir) {
      dir = await getDefaultLayoutsDir();
    }

    try {
      const stat = await Deno.stat(dir);
      if (!stat.isDirectory) {
        printError("INVALID_DIR", `The path '${dir}' is not a directory. Please provide a valid --layouts-dir.`);
        return;
      }
    } catch {
      printError("DIR_NOT_FOUND", `Could not find layouts directory at '${dir}'. Please provide it manually via --layouts-dir.`);
      return;
    }

    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (!homeDir) {
      printError("NO_HOME", "Could not determine home directory to save config.");
      return;
    }

    const configDir = path.join(homeDir, ".lq");
    const configPath = path.join(configDir, "config.json");

    // Build config object
    const config: UserConfig = { layoutsDir: dir };
    if (refresh !== undefined) {
      config.refresh = refresh as "none" | "reload" | "save-reload";
    } else {
      const existing = await loadUserConfig();
      if (existing.refresh) {
        config.refresh = existing.refresh;
      } else {
        config.refresh = "none";
      }
    }

    if (trackChangesFlag !== undefined) {
      config.trackChanges = trackChangesFlag === "on";
    } else {
      const existing = await loadUserConfig();
      if (existing.trackChanges !== undefined) {
        config.trackChanges = existing.trackChanges;
      } else {
        config.trackChanges = true;
      }
    }

    if (maxCacheEntries !== undefined) {
      config.maxCacheEntries = maxCacheEntries;
    } else {
      const existing = await loadUserConfig();
      if (existing.maxCacheEntries !== undefined) {
        config.maxCacheEntries = existing.maxCacheEntries;
      } else {
        config.maxCacheEntries = 50;
      }
    }

    if (authorNameFlag !== undefined) {
      if (authorNameFlag.length === 0) {
        printError("INVALID_FLAG", "--author-name must be a non-empty string.");
        return;
      }
      config.authorName = authorNameFlag;
    } else {
      const existing = await loadUserConfig();
      if (existing.authorName) {
        config.authorName = existing.authorName;
      } else {
        config.authorName = "lq user";
      }
    }

    // If refresh is enabled, verify LyXServer is reachable
    if (config.refresh !== "none") {
      const available = checkLyxServerAvailable();
      if (!available) {
        pushWarning(
          `Refresh mode '${config.refresh}' requires a running LyX instance with LyXServer enabled. ` +
          "Could not detect LyXServer socket. Enable LyXServer in LyX Preferences and restart LyX."
        );
      }
    }

    try {
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
      printJson({
        status: "success",
        message: `Configuration saved to ${configPath}`,
        layoutsDir: dir,
        refresh: config.refresh,
        trackChanges: config.trackChanges,
        maxCacheEntries: config.maxCacheEntries,
        authorName: config.authorName,
      });
    } catch (e: Error | unknown) {
      printError("WRITE_ERROR", `Failed to write config file: ${(e as Error).message}`);
    }
    return;
  }

  if (cleanArgs.length < 2) {
    printError("MISSING_ARGS", "Usage: lq <command> <file> [selector] [value]. Run 'lq --help' for details.");
    return;
  }

  // Extract --count and --text-only flags early (before positional arg destructuring)
  // so they don't get mistaken for the file path.
  const countOnly = cleanArgs.includes("--count");
  const textOnly = cleanArgs.includes("--text-only");
  const positionalArgs = cleanArgs.filter(a => a !== "--count" && a !== "--text-only");
  
  const [command, filePath, selector, ...restArgs] = positionalArgs;
  
  if (command !== "init" && !filePath.endsWith(".lyx")) {
    printError("INVALID_EXTENSION", "Target file must have a .lyx extension.");
    return;
  }

  // Load user config (shared by all commands: cache sizing, refresh, track-changes)
  const userConfig = await loadUserConfig();
  setMaxCacheEntries(userConfig.maxCacheEntries ?? 50);

  // --- Refresh pre-step (save-reload only) ---
  // Must happen BEFORE reading the file, so buffer-write saves the user's
  // latest edits to disk before lq reads the stale version.
  const mutationCommands = ["set", "delete", "insert", "undo"];
  let refreshMode: "none" | "reload" | "save-reload" = "none";
  let trackChanges = true;
  let authorName = "lq user";
  if (mutationCommands.includes(command)) {
    if (userConfig.refresh) refreshMode = userConfig.refresh;
    trackChanges = userConfig.trackChanges !== false;
    authorName = userConfig.authorName || "lq user";
    if (refreshMode !== "none") {
      const preOk = await refreshPreStep(filePath, refreshMode);
      if (!preOk) {
        printError("REFRESH_PRE_ERROR",
          "save-reload: Cannot connect to LyX to save unsaved edits.\n" +
          "Writing the file now would permanently destroy unsaved changes."
        );
        return;
      }
    }
  }
  
  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch (_e) {
    printError("FILE_NOT_FOUND", `Could not read file: ${filePath}`);
    return; // for type safety
  }

  let ast: DocumentNode;
  let cacheHash: string | null = null;
  try {
    // Try cache first — deserializing JSON is orders of magnitude faster
    // than line-by-line parsing for large files.
    const cached = await getCachedAst(filePath);
    if (cached) {
      ast = cached;
    } else {
      ast = parse(text);
      // Populate cache on miss (non-fatal)
      try {
        cacheHash = await hashText(text);
        await setCachedAst(cacheHash, ast);
      } catch { /* cache failures are non-fatal */ }
    }
  } catch (e: Error | unknown) {
    printError("PARSE_ERROR", (e as Error).message);
    return;
  }

  if (command === "dump") {
    // Dump may have --depth before the selector destructuring consumes it.
    // Parse from selector + restArgs to catch both "--depth N" patterns.
    const dumpArgs = selector ? [selector, ...restArgs] : restArgs;
    const dumpFlags = parseArgs(dumpArgs, { boolean: ["toc"], string: ["depth"] });
    const depthStr = dumpFlags["depth"];
    const tocMode = dumpFlags["toc"] === true;
    
    // If selector is present and not a flag, use it to target a subtree
    const dumpSelector = (selector && !selector.startsWith("--")) ? selector : undefined;
    
    // --toc mode: output heading tree
    if (tocMode) {
      if (dumpSelector) {
        printError("FLAG_CONFLICT", "--toc and selector are mutually exclusive.");
        return;
      }
      // Get heading hierarchy from schema
      const textclassNode = query(ast, "textclass")[0];
      const textclass = (textclassNode && textclassNode.type === "property" && textclassNode.value)
        ? textclassNode.value : null;
      if (!textclass) {
        printError("NO_TEXTCLASS", "Could not determine textclass from the document.");
        return;
      }
      let headingHierarchy: { layout: string; tocLevel: number }[];
      try {
        const layoutsDir = userConfig.layoutsDir || await getDefaultLayoutsDir();
        const schema = await getSchemaForClass(textclass, layoutsDir);
        headingHierarchy = schema.headingHierarchy;
      } catch {
        // Fallback: standard LaTeX hierarchy
        headingHierarchy = [
          { layout: "Part", tocLevel: -1 },
          { layout: "Chapter", tocLevel: 0 },
          { layout: "Section", tocLevel: 1 },
          { layout: "Bibliography", tocLevel: 1 },
          { layout: "Subsection", tocLevel: 2 },
          { layout: "Subsubsection", tocLevel: 3 },
          { layout: "Paragraph", tocLevel: 4 },
          { layout: "Subparagraph", tocLevel: 5 },
        ];
      }
      
      let toc = buildToc(ast, headingHierarchy);
      
      // Apply --depth limit to toc tree
      if (depthStr !== undefined) {
        const depth = parseInt(depthStr, 10);
        if (isNaN(depth) || depth < 0) {
          printError("INVALID_FLAG", "--depth must be a non-negative integer.");
          return;
        }
        toc = truncateTocDepth(toc, depth, 0);
      }
      
      printJson({ status: "success", data: toc });
      return;
    }
    
    let roots: Node[] = []; // default: empty, will use ast directly
    let useFullAst = true;
    if (dumpSelector) {
      try {
        roots = query(ast, dumpSelector);
      } catch (e: Error | unknown) {
        printError("INVALID_SELECTOR", (e as Error).message);
        return;
      }
      if (roots.length === 0) {
        printError("NO_MATCH", "Selector matched no nodes to dump.");
        return;
      }
      useFullAst = false;
    }
    
    // Wrap each matched node as a document root for depth-limited output
    const wrapAsDoc = (node: Node): DocumentNode => ({
      type: "document",
      children: [structuredClone(node)],
    });
    
    if (depthStr !== undefined) {
      const depth = parseInt(depthStr, 10);
      if (isNaN(depth) || depth < 0) {
        printError("INVALID_FLAG", "--depth must be a non-negative integer.");
        return;
      }
      
      if (useFullAst) {
        const maxDepth = computeMaxDepth(ast, 0);
        if (depth > maxDepth) {
          pushWarning(`Depth ${depth} exceeds document depth (${maxDepth}). Showing full CST.`);
          printJson({ status: "success", data: ast });
        } else {
          printJson({ status: "success", data: truncateAtDepth(ast, depth, 0) });
        }
      } else {
        const results = roots.map(root => {
          const doc = wrapAsDoc(root);
          const maxDepth = computeMaxDepth(doc, 0);
          if (depth > maxDepth) {
            pushWarning(`Depth ${depth} exceeds subtree depth (${maxDepth}). Showing full subtree.`);
            return doc;
          }
          return truncateAtDepth(doc, depth, 0);
        });
        const data = roots.length === 1 ? results[0] : results;
        printJson({ status: "success", count: roots.length, data });
      }
    } else {
      if (useFullAst) {
        printJson({ status: "success", data: ast });
      } else {
        const docs = roots.map(wrapAsDoc);
        const data = roots.length === 1 ? docs[0] : docs;
        printJson({ status: "success", count: roots.length, data });
      }
    }
    return;
  }

  if (command === "bib") {
    const bibArgs = selector ? [selector, ...restArgs] : restArgs;
    const bibFlags = parseArgs(bibArgs, { string: ["search"] });
    const bibtexNodes = query(ast, "inset[CommandInset bibtex]");
    if (bibtexNodes.length === 0) {
      printError("NO_BIBLIO", "No bibliography files found in the document.");
      return;
    }

    const citations: Citation[] = [];
    const lyxDir = path.dirname(path.resolve(filePath));
    let bibFileCount = 0;

    for (const node of bibtexNodes) {
      if (node.type === "block") {
        const bibFilesLine = node.children.find(c => c.type === "text" && c.text.startsWith("bibfiles "));
        if (bibFilesLine && bibFilesLine.type === "text") {
          const value = bibFilesLine.text.replace(/^bibfiles\s+/, "");
          const files = value.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
          
          for (let bibFile of files) {
            // Skip files with a non-.bib extension (e.g. .bst style files).
            // Files without an extension follow LyX convention — append .bib.
            const hasExt = bibFile.includes(".");
            if (hasExt && !bibFile.toLowerCase().endsWith(".bib")) {
              continue;
            }
            if (!hasExt) {
              bibFile += ".bib";
            }
            bibFileCount++;
            
            let bibPath = bibFile;
            if (!path.isAbsolute(bibPath)) {
              bibPath = path.join(lyxDir, bibPath);
            }

            try {
              const rawBib = await Deno.readTextFile(bibPath);
              const parsed = parseBibtex(rawBib);
              citations.push(...parsed);
            } catch (e: Error | unknown) {
              printError("BIB_READ_ERROR", `Could not read or parse bib file '${bibPath}': ${(e as Error).message}`);
              return;
            }
          }
        }
      }
    }

    if (bibFileCount === 0) {
      printError("NO_BIBFILE", "No .bib files referenced in the document. The bib command only processes .bib bibliography files.");
      return;
    }
    
    // Deduplicate citations by key
    let uniqueCitations = Array.from(new Map(citations.map(c => [c.key, c])).values());

    // Filter by search term if provided
    const searchTerm: string | undefined = bibFlags["search"];
    if (searchTerm) {
      const terms = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
      uniqueCitations = uniqueCitations.filter(c => {
        const haystack = `${c.key} ${c.author} ${c.title} ${c.year}`.toLowerCase();
        return terms.every(t => haystack.includes(t));
      });
    }

    printJson({ status: "success", data: uniqueCitations });
    return;
  }

  if (command === "schema") {
    const config = await loadUserConfig();
    const layoutsDir = config.layoutsDir || await getDefaultLayoutsDir();
    if (!layoutsDir) {
      printError("NO_CONFIG", "No layouts directory found. Run 'lq init' to auto-detect and save your LyX layouts path.");
      return;
    }

    const textclassNode = query(ast, "textclass")[0];
    if (!textclassNode || textclassNode.type !== "property" || !textclassNode.value) {
      printError("NO_TEXTCLASS", "Could not determine textclass from the document.");
      return;
    }
    
    try {
      const schema = await getSchemaForClass(textclassNode.value, layoutsDir);
      printJson({ status: "success", data: schema });
    } catch (e: Error | unknown) {
      pushWarning(`Could not read layout file for textclass '${textclassNode.value}': ${(e as Error).message}`);
      printJson({
        status: "success",
        data: {
          textclass: textclassNode.value,
          documentLayouts: [],
          insetLayouts: INSET_LAYOUTS,
          insets: INSETS,
          commandInsetSubtypes: [...KNOWN_COMMAND_INSET_TYPES].sort(),
          inlineProperties: INLINE_PROPERTIES,
          headingHierarchy: [],
        },
      });
    }
    return;
  }

  if (!selector) {
    printError("MISSING_SELECTOR", "A CSS selector is required for this command.");
    return;
  }

  let nodes: Node[] = [];
  try {
    nodes = query(ast, selector);
  } catch (e: Error | unknown) {
    printError("INVALID_SELECTOR", (e as Error).message);
    return;
  }

  // Warn if :until() is used without a preceding ~ combinator: without ~
  // there is no anchor to check intervening siblings against, so :until()
  // has no effect (all nodes pass through).
  if (selector.includes(":until(")) {
    const parts = selector.split(",");
    for (const part of parts) {
      if (part.includes(":until(") && !part.includes("~")) {
        pushWarning(
          `:until() in "${part.trim()}" has no effect without a preceding ~ combinator. ` +
          `Use 'layout[A] ~ layout[B]:until(layout[C])' to bound a sibling range.`
        );
      }
    }
  }

  if (command === "read") {
    const result: Record<string, unknown> = { status: "success" };

    if (countOnly) {
      const tally: Record<string, number> = {};
      for (const node of nodes) {
        const key = node.type === "block"
          ? node.tag + "[" + ((node.args || "").trim()) + "]"
          : node.type;
        tally[key] = (tally[key] || 0) + 1;
      }
      result.count = tally;
    }

    if (textOnly) {
      const texts: string[] = [];
      for (const node of nodes) {
        // Prefix each matched node with its own selector so the user
        // can copy-paste it directly into the next command.
        const prefix = node.type === "block"
          ? node.tag + "[" + ((node.args || "").trim()) + "]"
          : "";
        let text: string;
        if (node.type === "block" && node.tag === "inset") {
          // Direct inset match (e.g. lq read ... "inset[Foot]" --text-only):
          // extract from nested layouts so the user sees the inset's content.
          text = node.children
            .filter(c => c.type === "block" && c.tag === "layout")
            .map(c => {
              const layout = c as BlockNode;
              return "layout[" + ((layout.args || "").trim()) + "] " +
                extractAllText(layout).trim();
            })
            .join("\n");
        } else {
          text = extractAllText(node).trim();
        }
        const combined = prefix ? prefix + " " + text : text;
        if (combined.length > 0) texts.push(combined);
      }
      const output = texts.join("\n\n") + "\n";
      // Warn if output is large (consistent with blast-radius warning for mutations)
      const KB = 1024;
      if (output.length > 10 * KB) {
        const sizeKB = Math.round(output.length / KB);
        const warnMsg = `--text-only output is ${sizeKB}KB across ${nodes.length} nodes. ` +
          `Consider a more specific selector to reduce noise.`;
        pushWarning(warnMsg);
      }
      result.text = output;
    }

    if (!countOnly && !textOnly) {
      result.data = nodes;
      result.count = nodes.length;
    }

    printJson(result);
    return;
  }

  // Common guard: Prevent mutating core document structures directly
  const unsafeNodes = nodes.filter(n => (n.type === "block" && (n.tag === "body" || n.tag === "header" || n.tag === "document")));
  if (unsafeNodes.length > 0 && ["set", "delete", "insert"].includes(command)) {
    printError("INVALID_CONTEXT", "Cannot mutate core document structures ('document', 'body', 'header') directly. Target specific layouts or properties instead.");
    return;
  }

  // Mutation commands below
  
  // Blast radius warning: if selector matches more than 1 node, warn to
  // stderr. The mutation still proceeds — this is a warning, not a blocker.
  if (["set", "delete", "insert"].includes(command) && nodes.length > 1) {
    const warnMsg = `Selector matches ${nodes.length} nodes. ` +
      `Run 'lq read ${filePath} "${selector}"' to inspect them before mutating.`;
    pushWarning(warnMsg);
  }

  if (command === "set") {
    const flags = parseArgs(restArgs, { boolean: ["replace-all"], string: ["find"] });
    const replaceAll = flags["replace-all"] === true;
    const findStr: string | undefined = typeof flags["find"] === "string" ? flags["find"] : undefined;

    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to set.");
      return;
    }

    // --find and --replace-all are mutually exclusive
    if (findStr !== undefined && replaceAll) {
      printError("FLAG_CONFLICT", "--find and --replace-all are mutually exclusive. --find does surgical substring replacement; --replace-all wipes all children.");
      return;
    }

    // --find requires a non-empty substring
    if (findStr !== undefined && findStr.length === 0) {
      printError("INVALID_FLAG", "--find requires a non-empty substring to search for.");
      return;
    }

    if (flags._.length === 0) {
      printError("MISSING_ARGS", "A new text value is required for the 'set' command.");
      return;
    }

    const newValue = flags._.join(" ");

    // Track total substring matches for stderr notification
    let totalFindMatches = 0;
    // Per-node type counts captured during mutation (before trackChanges wraps text
    // in change_inserted markers, which could cause double-counting if re-scanned)
    const findPerNode: Record<string, number> = {};

    // Pre-compute trackChanges timestamp once for all nodes
    const tcTs = trackChanges ? Math.floor(Date.now() / 1000).toString() : "";
    const tcAid = trackChanges ? resolveAuthorId(ast, authorName) : 0;

    // Helper to accumulate per-node find counts during mutation
    const addFindCount = (node: Node, count: number) => {
      const key = node.type === "block"
        ? node.tag + "[" + ((node.args || "").trim()) + "]"
        : "text";
      findPerNode[key] = (findPerNode[key] || 0) + count;
    };

    for (const node of nodes) {
      if (node.type === "property") {
        if (findStr !== undefined) {
          // Surgical replace within the property value
          if (node.value !== undefined) {
            const count = countOccurrences(node.value, findStr);
            if (count > 0) {
              node.value = node.value.replaceAll(findStr, newValue);
              totalFindMatches += count;
              addFindCount(node, count);
            }
          }
        } else {
          node.value = newValue;
        }
      } else if (node.type === "block") {
        if (findStr !== undefined) {
          // Surgical mode: replace substring within text children
          if (trackChanges) {
            // Tracked surgical replace: split text nodes at match boundaries
            const newChildren: Node[] = [];
            let nodeFindCount = 0;
            for (const child of node.children) {
              if (child.type === "text") {
                const count = countOccurrences(child.text, findStr);
                if (count > 0) {
                  nodeFindCount += count;
                  newChildren.push(...replaceWithTracking(child.text, findStr, newValue, tcAid, tcTs));
                } else {
                  newChildren.push(child);
                }
              } else {
                newChildren.push(child);
              }
            }
            node.children = newChildren;
            totalFindMatches += nodeFindCount;
            if (nodeFindCount > 0) addFindCount(node, nodeFindCount);
          } else {
            // Plain surgical replace: simple string replace in all text children
            let nodeFindCount = 0;
            for (const child of node.children) {
              if (child.type === "text") {
                const count = countOccurrences(child.text, findStr);
                if (count > 0) {
                  child.text = child.text.replaceAll(findStr, newValue);
                  nodeFindCount += count;
                }
              }
            }
            totalFindMatches += nodeFindCount;
            if (nodeFindCount > 0) addFindCount(node, nodeFindCount);
          }
        } else if (trackChanges) {
          // Full-text replace with trackChanges (existing behavior)
          // Warn if the node already contains pending tracked changes — the new
          // edit will nest inside existing markers (double-wrap). The user should
          // run `lq undo` first to revert pending changes before re-editing.
          if (hasTrackedChanges(node.children)) {
            pushWarning(
              `This node already contains pending tracked changes. ` +
              `Run 'lq undo ${filePath} "${selector}"' first to revert them, ` +
              `or this edit will nest inside existing markers.`
            );
          }
          if (replaceAll) {
            node.children = [
              { type: "property", key: "change_deleted", value: `${tcAid} ${tcTs}` },
              ...node.children,
              { type: "property", key: "change_unchanged" },
              { type: "property", key: "change_inserted", value: `${tcAid} ${tcTs}` },
              { type: "text", text: newValue },
              { type: "property", key: "change_unchanged" },
            ];
          } else {
            const nonTextChildren = node.children.filter(c => c.type !== "text");
            const oldTextNodes = node.children.filter(c => c.type === "text");
            node.children = [
              { type: "property", key: "change_deleted", value: `${tcAid} ${tcTs}` },
              ...oldTextNodes,
              { type: "property", key: "change_unchanged" },
              { type: "property", key: "change_inserted", value: `${tcAid} ${tcTs}` },
              { type: "text", text: newValue },
              { type: "property", key: "change_unchanged" },
              ...nonTextChildren,
            ];
          }
        } else {
          // Full-text replace without trackChanges (existing behavior)
          if (replaceAll) {
            node.children = [{ type: "text", text: newValue }];
          } else {
            const nonTextChildren = node.children.filter(c => c.type !== "text");
            node.children = [{ type: "text", text: newValue }, ...nonTextChildren];
          }
        }
      } else if (node.type === "text") {
        if (findStr !== undefined) {
          // Direct text node surgical replace (no trackChanges for bare text nodes)
          const count = countOccurrences(node.text, findStr);
          if (count > 0) {
            node.text = node.text.replaceAll(findStr, newValue);
            totalFindMatches += count;
          }
        } else {
          node.text = newValue;
        }
      }
    }

    // After loop: check if --find had any matches
    if (findStr !== undefined) {
      if (totalFindMatches === 0) {
        printError("NO_MATCH", `--find '${findStr}' matched no occurrences within the targeted nodes.`);
        return;
      }
      const plural = totalFindMatches === 1 ? "" : "s";
      const nodeList = Object.entries(findPerNode)
        .map(([k, c]) => `${k} (${c} occurrence${c === 1 ? "" : "s"})`)
        .join(", ");
      const findMsg = `--find matched ${totalFindMatches} occurrence${plural} of '${findStr}' across ${nodes.length} node(s): ${nodeList}. ` +
        `To target a specific occurrence, use a longer unique substring (include surrounding words).`;
      pushWarning(findMsg);
    }

    if (trackChanges) {
      ensureTrackingChangesInHeader(ast);
    }
    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    try { setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
    printJson({ status: "success", modified_nodes: nodes.length, changes });
    return;
  }

  if (command === "delete") {
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to delete.");
      return;
    }

    if (trackChanges) {
      // Track-changes mode: wrap matched nodes in change_deleted markers instead of removing them
      const authorId = resolveAuthorId(ast, authorName);
      ensureTrackingChangesInHeader(ast);
      const nodesToMark = new Set(nodes);

      const markAsDeleted = (children: Node[]) => {
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (nodesToMark.has(child)) {
            if (child.type === "block") {
              child.children = wrapWithTracking(child.children, "deleted", authorId);
            } else if (child.type === "text" || child.type === "property") {
              const wrapped = wrapWithTracking([child], "deleted", authorId);
              children.splice(i, 1, ...wrapped);
            }
          } else if (child.type === "block") {
            markAsDeleted(child.children);
          }
        }
      };

      markAsDeleted(ast.children);
      const newFileText = serialize(ast);
      await Deno.writeTextFile(filePath, newFileText);
      try { setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
      await refreshPostStep(filePath, refreshMode);
      const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
      printJson({ status: "success", tracked_deleted_nodes: nodes.length, changes });
      return;
    }

    const nodesToDelete = new Set(nodes);
    
    const filterNodes = (children: Node[]) => {
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (nodesToDelete.has(child)) {
          children.splice(i, 1);
        } else if (child.type === "block") {
          filterNodes(child.children);
        }
      }
    };

    filterNodes(ast.children);

    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    try { setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
    printJson({ status: "success", deleted_nodes: nodes.length, changes });
    return;
  }

  if (command === "insert") {
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to insert around.");
      return;
    }

    const position = restArgs[0];
    
    // split-after <text> — match string is the next positional arg
    let splitMatch: string | undefined;
    if (position === "split-after") {
      splitMatch = restArgs[1];
      if (!splitMatch || splitMatch === "") {
        printError("MISSING_ARGS", "split-after requires a non-empty match string, e.g. split-after monetary policy");
        return;
      }
    }

    if (!["before", "after", "prepend", "append", "split-after"].includes(position)) {
      printError("INVALID_POSITION", "Position must be 'before', 'after', 'prepend', 'append', or 'split-after' (followed by the match string as the next argument).");
      return;
    }

    // Parse flags (skip position and optional split-after match arg)
    const flagArgs = position === "split-after" ? restArgs.slice(2) : restArgs.slice(1);
    const flags = parseArgs(flagArgs, {
      string: ["layout", "text", "raw-file", "cite", "cite-cmd", "ref", "ref-cmd", "label", "footnote"],
    });

    let flagCount = 0;
    if (flags["raw-file"]) flagCount++;
    if (flags.layout) flagCount++;
    if (flags.cite) flagCount++;
    if (flags.ref) flagCount++;
    if (flags.label) flagCount++;
    if (flags.footnote) flagCount++;

    if (flagCount > 1) {
      printError("FLAG_CONFLICT", "You cannot mix --raw-file, --layout, --cite, --ref, --label, or --footnote. Please provide exactly one generation strategy.");
      return;
    }

    // Resolve --raw-file by reading the file content
    let rawContent: string | undefined;
    if (flags["raw-file"]) {
      try {
        rawContent = await Deno.readTextFile(flags["raw-file"]);
      } catch (e: Error | unknown) {
        printError("FILE_NOT_FOUND", `Could not read --raw-file '${flags["raw-file"]}': ${(e as Error).message}`);
        return;
      }
    }

    const newNodesToInsert: Node[] = [];

    if (rawContent) {
      // Parse the raw string and collect all valid nodes
      try {
        const tempAst = parse(rawContent, true);
        const validNodes = tempAst.children.filter(c => c.type === "block" || c.type === "property");
        if (validNodes.length === 0) {
          printError("INVALID_RAW", "The --raw-file content did not parse into any valid LyX blocks or properties. (e.g. expected \\begin_layout, got plain text)");
          return;
        }

        // Validate inset types in raw content (warning only)
        const warnings = validateRawInsets(tempAst);
        for (const w of warnings) {
          pushWarning(w);
        }

        for (const n of validNodes) newNodesToInsert.push(n);
      } catch (e: Error | unknown) {
        printError("PARSE_ERROR", `Failed to parse raw LyX string: ${(e as Error).message}`);
        return;
      }
    } else if (flags.layout) {
      // Validate the layout against the schema (loaded from config)
      const config = await loadUserConfig();
      if (config.layoutsDir) {
         const textclassNode = query(ast, "textclass")[0];
         if (textclassNode && textclassNode.type === "property" && textclassNode.value) {
            try {
               const schema = await getSchemaForClass(textclassNode.value, config.layoutsDir);
               if (!schema.documentLayouts.includes(flags.layout) && !schema.insetLayouts.includes(flags.layout)) {
                 printError("INVALID_LAYOUT", `The layout '${flags.layout}' is not permitted in textclass '${textclassNode.value}'. Allowed document layouts: ${schema.documentLayouts.join(", ")}`);
                 return;
               }
            } catch (_e) {
               // Layout files unavailable — skip validation, insert proceeds
            }
         }
      }

      newNodesToInsert.push({
        type: "block",
        tag: "layout",
        args: flags.layout,
        isBeginVariant: true,
        children: flags.text ? [{ type: "text", text: flags.text }] : [],
      });
      
      if (!flags.text || flags.text.trim() === "") {
        // Technically valid LyX, but usually a mistake for programmatic insertions.
        // We'll allow it but log a warning to stderr if we want, or just enforce text if we want to be strict.
        // Wait, since the AI explicitly complained about it (O1), let's enforce it to prevent empty layouts.
        printError("MISSING_ARGS", "A non-empty --text argument is required when inserting a new --layout to prevent empty blocks.");
        return;
      }
    } else if (flags.cite) {
      const citeCmd = flags["cite-cmd"] || "citet";
      const validCiteCmds = ["cite", "citet", "citep", "citeauthor", "citeyear",
        "citeyearpar", "citebyear", "footcite", "autocite", "citetitle",
        "fullcite", "footfullcite", "nocite", "keyonly"];
      if (!validCiteCmds.includes(citeCmd)) {
        printError("INVALID_FLAG", `Invalid --cite-cmd '${citeCmd}'. Valid values: ${validCiteCmds.join(", ")}`);
        return;
      }
      newNodesToInsert.push({
        type: "block",
        tag: "inset",
        args: "CommandInset citation",
        isBeginVariant: true,
        children: [
          { type: "text", text: `LatexCommand ${citeCmd}` },
          { type: "text", text: `key "${flags.cite}"` },
          { type: "text", text: `literal "false"` },
        ],
      });
    } else if (flags.ref) {
      const refCmd = flags["ref-cmd"] || "ref";
      const validRefCmds = ["ref", "eqref", "pageref", "vpageref", "vref",
        "nameref", "formatted", "labelonly"];
      if (!validRefCmds.includes(refCmd)) {
        printError("INVALID_FLAG", `Invalid --ref-cmd '${refCmd}'. Valid values: ${validRefCmds.join(", ")}`);
        return;
      }
      newNodesToInsert.push({
        type: "block",
        tag: "inset",
        args: "CommandInset ref",
        isBeginVariant: true,
        children: [
          { type: "text", text: `LatexCommand ${refCmd}` },
          { type: "text", text: `reference "${flags.ref}"` },
          // LyX defaults for internal params
          { type: "text", text: `plural "false"` },
          { type: "text", text: `caps "false"` },
          { type: "text", text: `noprefix "false"` },
          { type: "text", text: `nolink "false"` },
          { type: "text", text: `tuple "list"` },
        ],
      });
    } else if (flags.label) {
      newNodesToInsert.push({
        type: "block",
        tag: "inset",
        args: "CommandInset label",
        isBeginVariant: true,
        children: [
          { type: "text", text: "LatexCommand label" },
          { type: "text", text: `name "${flags.label}"` },
        ],
      });
    } else if (flags.footnote) {
      newNodesToInsert.push({
        type: "block",
        tag: "inset",
        args: "Foot",
        isBeginVariant: true,
        children: [
          {
            type: "block",
            tag: "layout",
            args: "Plain Layout",
            isBeginVariant: true,
            children: [{ type: "text", text: flags.footnote }],
          },
        ],
      });
    } else if (flags.text) {
      printError("TEXT_ONLY_INSERT", "Cannot insert bare text. You must wrap text in a layout using the --layout flag (e.g., --layout 'Standard' --text 'foo').");
      return;
    }

    if (newNodesToInsert.length === 0) {
      printError("MISSING_CONTENT", "You must provide --layout, --raw-file, --cite, --ref, --label, or --footnote to insert.");
      return;
    }

    let insertedCount = 0;
    let insertedBlocks = 0;

    // Helper to find the parent array and index of a target node
    const findNodeContext = (parentList: Node[], target: Node, parentBlock: BlockNode | null = null): { list: Node[]; index: number, parentBlock: BlockNode | null } | null => {
      for (let i = 0; i < parentList.length; i++) {
        if (parentList[i] === target) return { list: parentList, index: i, parentBlock };
        if (parentList[i].type === "block") {
          const res = findNodeContext((parentList[i] as BlockNode).children, target, parentList[i] as BlockNode);
          if (res) return res;
        }
      }
      return null;
    };

    // Pre-fetch schema from config once (avoid per-node I/O and CST traversal)
    let schema: Awaited<ReturnType<typeof getSchemaForClass>> | null = null;
    let textclassValue: string | null = null;
    const config = await loadUserConfig();
    if (config.layoutsDir) {
      const textclassNode = query(ast, "textclass")[0];
      if (textclassNode && textclassNode.type === "property" && textclassNode.value) {
        textclassValue = textclassNode.value;
        try {
          schema = await getSchemaForClass(textclassValue, config.layoutsDir);
        } catch (_e) {
          // Layout files unavailable — skip validation, insert proceeds
        }
      }
    }

    for (const targetNode of nodes) {
      let targetParentBlock: BlockNode | null = null;
      let ctx: { list: Node[]; index: number; parentBlock: BlockNode | null } | null = null;

      if (position === "prepend" || position === "append" || position === "split-after") {
        if (targetNode.type !== "block") {
          printError("INVALID_TARGET", `Cannot ${position} to a non-block node.`);
          continue;
        }
        targetParentBlock = targetNode as BlockNode;
        // Also find context to enable ancestor-chain checks (e.g. is this layout inside an inset?)
        ctx = findNodeContext(ast.children, targetNode);
      } else {
        ctx = findNodeContext(ast.children, targetNode);
        if (!ctx) continue;
        targetParentBlock = ctx.parentBlock;
      }

      // Track how many items we've inserted at this target, so multi-block
      // payloads maintain correct order (each subsequent block advances the
      // insertion index).
      let insertedSoFar = 0;

      // Resolve author once for all payload blocks
      const insertAuthorId = trackChanges ? resolveAuthorId(ast, authorName) : 0;
      if (trackChanges) ensureTrackingChangesInHeader(ast);

      // Per-node validation for each block in the payload
      for (const nodeToInsert of newNodesToInsert) {
        if (trackChanges) {
          if (nodeToInsert.type === "block") {
            nodeToInsert.children = wrapWithTracking(nodeToInsert.children, "inserted", insertAuthorId);
          } else {
            printError("TRACKING_ERROR", "Cannot track bare text nodes. Wrap in a layout block.");
            return;
          }
        }

        if (schema) {
          if (nodeToInsert.type === "block") {
            const block = nodeToInsert as BlockNode;
            if (block.tag === "layout" && block.args) {
              // Walk ancestor chain to determine if we're inside an inset
              let isInsetContext = false;
            if (targetParentBlock && targetParentBlock.tag === "inset") {
              isInsetContext = true;
            } else if (ctx && ctx.parentBlock) {
              let ancestor: BlockNode | null = ctx.parentBlock;
              while (ancestor) {
                if (ancestor.tag === "inset") {
                  isInsetContext = true;
                  break;
                }
                const ancestorCtx = findNodeContext(ast.children, ancestor);
                ancestor = ancestorCtx ? ancestorCtx.parentBlock : null;
              }
            }

            if (isInsetContext) {
              if (!schema.insetLayouts.includes(block.args)) {
                printError("INVALID_CONTEXT", `Cannot insert document layout '${block.args}' inside an Inset. Valid inset layouts are: ${schema.insetLayouts.join(", ")}`);
                continue;
              }
            } else {
              if (schema.insetLayouts.includes(block.args) && !schema.documentLayouts.includes(block.args)) {
                const contextName = targetParentBlock ? `${targetParentBlock.tag}[${targetParentBlock.args || ''}]` : 'document body';
                printError("INVALID_CONTEXT", `Cannot insert inset layout '${block.args}' into ${contextName}.`);
                continue;
              }
              if (!schema.documentLayouts.includes(block.args)) {
                printError("INVALID_LAYOUT", `The layout '${block.args}' is not recognized in textclass '${textclassValue}'. Valid layouts: ${schema.documentLayouts.join(", ")}`);
                continue;
              }
            }
          }
        } else if (nodeToInsert.type === "property") {
          if (!schema.inlineProperties.includes(nodeToInsert.key)) {
            printError("INVALID_PROPERTY", `Property '${nodeToInsert.key}' is not permitted. Valid inline properties are: ${schema.inlineProperties.join(", ")}`);
            continue;
          }
        }
      }

      // --- Schema-independent structural guards (always run) ---
      for (const nodeToInsert of newNodesToInsert) {
        if (nodeToInsert.type === "block") {
          const block = nodeToInsert as BlockNode;
          // Guard: prepend/append/split-after must not nest a layout inside another layout.
          // Only text nodes and insets are valid children of document layouts.
          if (block.tag === "layout" && block.args &&
              (position === "prepend" || position === "append" || position === "split-after") &&
              targetParentBlock && targetParentBlock.tag === "layout") {
            printError("INVALID_CONTEXT",
              `Cannot insert layout '${block.args}' inside another layout. ` +
              `Use 'before' or 'after' to insert as a sibling.`);
            continue;
          }
          // Guard: insets cannot be inserted directly into the document body.
          if (block.tag === "inset" && block.args) {
            const isDocumentContext = targetParentBlock && targetParentBlock.tag === "body";
            if (isDocumentContext) {
              printError("INVALID_CONTEXT", `Cannot insert inset directly into the document body. Insets must be inside a layout (e.g. Standard).`);
              continue;
            }
          }
        }
      }

        const isLayoutBlock = nodeToInsert.type === "block" && nodeToInsert.tag === "layout";
        const spacer: Node = { type: "text", text: "" };
        const copy = structuredClone(nodeToInsert);

        if (position === "split-after") {
          if (!targetParentBlock) continue;
          // Collect descendant text nodes, skipping text inside \change_deleted
          // blocks (those represent old/replaced content, not valid targets for
          // new insertions). Uses a depth counter (not a boolean) so that nested
          // track changes (double-wrap from re-editing) are handled correctly:
          // inner \change_unchanged decrements depth but outer block still >0.
          const allTextNodes: { node: Node & { type: "text" }; parentList: Node[]; index: number }[] = [];
          const collectTextNodes = (children: Node[], deletedDepth = 0) => {
            let depth = deletedDepth;
            for (let i = 0; i < children.length; i++) {
              const c = children[i];
              if (c.type === "property") {
                if (c.key === "change_deleted") depth++;
                else if (c.key === "change_unchanged" && depth > 0) depth--;
                continue;
              }
              if (c.type === "text") {
                if (depth === 0) {
                  allTextNodes.push({ node: c, parentList: children, index: i });
                }
              } else if (c.type === "block") {
                collectTextNodes((c as BlockNode).children, depth);
              }
            }
          };
          collectTextNodes(targetParentBlock.children);

          let totalMatches = 0;
          let matchedTextNode: (typeof allTextNodes)[0] | null = null;
          let matchOffset = -1;

          for (const tn of allTextNodes) {
            let searchFrom = 0;
            while ((searchFrom = tn.node.text.indexOf(splitMatch!, searchFrom)) !== -1) {
              totalMatches++;
              if (!matchedTextNode) {
                matchedTextNode = tn;
                matchOffset = searchFrom;
              }
              searchFrom++; // continue searching for additional matches
            }
          }

          if (totalMatches === 0) {
            printError("SPLIT_NO_MATCH", `split-after: substring '${splitMatch}' not found in matched block.`);
            continue;
          }
          if (totalMatches > 1) {
            printError("SPLIT_AMBIGUOUS", `split-after: substring '${splitMatch}' appears ${totalMatches} times in matched block. Use a more specific selector or a longer match string.`);
            continue;
          }

          // Split the text node: first half includes the match, second half is everything after
          const fullText = matchedTextNode!.node.text;
          const splitEnd = matchOffset + splitMatch!.length;
          const before = fullText.substring(0, splitEnd);
          const after = fullText.substring(splitEnd);

          // Replace the original text node with: before + [new nodes] + after (if non-empty)
          const parentList = matchedTextNode!.parentList;
          const textIdx = matchedTextNode!.index;
          const replacementNodes: Node[] = [{ type: "text", text: before }];

          if (trackChanges) {
            if (nodeToInsert.type === "block") {
              const tracked = structuredClone(nodeToInsert);
              tracked.children = wrapWithTracking(tracked.children, "inserted", insertAuthorId);
              replacementNodes.push(tracked);
            }
          } else {
            replacementNodes.push(copy);
          }

          if (after.length > 0) {
            replacementNodes.push({ type: "text", text: after });
          }

          parentList.splice(textIdx, 1, ...replacementNodes);
        } else if (position === "prepend" || position === "append") {
          if (!targetParentBlock) continue;
          if (position === "prepend") {
            if (isLayoutBlock) targetParentBlock.children.unshift(copy, spacer);
            else targetParentBlock.children.unshift(copy);
          } else {
            if (isLayoutBlock) targetParentBlock.children.push(spacer, copy);
            else targetParentBlock.children.push(copy);
          }
        } else {
          if (ctx) {
            if (position === "before") {
              const insertIdx = ctx.index + insertedSoFar;
              if (isLayoutBlock) ctx.list.splice(insertIdx, 0, copy, spacer);
              else ctx.list.splice(insertIdx, 0, copy);
            } else {
              const insertIdx = ctx.index + 1 + insertedSoFar;
              if (isLayoutBlock) ctx.list.splice(insertIdx, 0, spacer, copy);
              else ctx.list.splice(insertIdx, 0, copy);
            }
          }
        }
        // Track items inserted: layout blocks insert 2 items (block + spacer), others 1
        insertedSoFar += isLayoutBlock ? 2 : 1;
        insertedBlocks++;
      }
      insertedCount++;
    }

    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    try { setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ position, label: nodeLabel(n), text: briefText(n) }));
    printJson({ status: "success", inserted_nodes: insertedCount, inserted_blocks: insertedBlocks, changes });
    return;
  }

  if (command === "undo") {
    if (!trackChanges) {
      printError("TRACK_CHANGES_OFF", "lq undo requires trackChanges to be enabled. Run 'lq init --track-changes on'.");
      return;
    }
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to undo.");
      return;
    }
    const substring: string | undefined = restArgs.length > 0 ? restArgs.join(" ") : undefined;

    let undoneCount = 0;
    const undoneLabels: string[] = [];

    for (const node of nodes) {
      if (node.type !== "block") continue;
      const newChildren: Node[] = [];
      let i = 0;

      while (i < node.children.length) {
        const child = node.children[i];
        if (child.type === "property" && (child.key === "change_deleted" || child.key === "change_inserted")) {
          // Collect text between this change marker and the next change_unchanged
          const markerType = child.key;
          const textParts: string[] = [];
          let j = i + 1;
          let foundUnchanged = false;
          while (j < node.children.length) {
            const next = node.children[j];
            if (next.type === "property" && next.key === "change_unchanged") {
              foundUnchanged = true;
              break;
            }
            if (next.type === "text") {
              textParts.push(next.text);
            }
            j++;
          }

          if (!foundUnchanged) {
            // Malformed: no closing change_unchanged — keep as-is
            newChildren.push(child);
            i++;
            continue;
          }

          const enclosedText = textParts.join("");

          // Check if this change matches our target
          const shouldUndo = substring === undefined || enclosedText.includes(substring);

          if (shouldUndo) {
            if (markerType === "change_deleted") {
              // Restore: keep text nodes, drop the marker and closing change_unchanged
              for (let k = i + 1; k < j; k++) newChildren.push(node.children[k]);
            }
            // change_inserted: drop everything (marker, text, change_unchanged)
            // Both: skip past the closing change_unchanged
            i = j + 1;
            undoneCount++;
            undoneLabels.push(markerType + "{" + (enclosedText.length > 60 ? enclosedText.substring(0, 60) + "..." : enclosedText) + "}");
          } else {
            // Not our target — keep everything as-is
            for (let k = i; k <= j; k++) newChildren.push(node.children[k]);
            i = j + 1;
          }
        } else {
          newChildren.push(child);
          i++;
        }
      }

      node.children = newChildren;
    }

    const changes = undoneLabels.map(l => ({ label: l }));
    if (undoneCount === 0 && substring !== undefined) {
      pushWarning(`--undo did not match '${substring}' in any tracked change within the selector.`);
    }
    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    try { setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
    await refreshPostStep(filePath, refreshMode);
    printJson({ status: "success", undone_changes: undoneCount, changes });
    return;
  }

  printError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}
