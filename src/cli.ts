import { parse } from "./parser.ts";
import { serialize } from "./serializer.ts";
import { query } from "./query.ts";
import { getSchemaForClass, INSET_LAYOUTS, INSETS, INLINE_PROPERTIES } from "./schema.ts";
import { parseBibtex, Citation } from "./bib.ts";
import { parseArgs } from "@std/cli/parse-args";
import { Node, BlockNode, DocumentNode, PropertyNode, TextNode } from "./ast.ts";
import { validateInsetType, KNOWN_COMMAND_INSET_TYPES } from "./registry.ts";
import { concatenateTextNodes, mapPosToSegment } from "./text_utils.ts";
import { getCachedAst, setCachedAst, hashText, hashFile, setMaxCacheEntries } from "./cache.ts";
import { clearSnapshot, collectSnapshots, commitMutation, loadSnapshot, nodeAtPath } from "./undo.ts";
import {
  annotateChanges,
  annotateChangesInPlace,
  applyCrossNodeReplace,
  ensureTrackingChangesInHeader,
  extractAllText,
  flattenNestedChanges,
  getHeader,
  hasTrackedChanges,
  isChangeCloser,
  isChangeOpener,
  resolveAuthorId,
  scanRegionEnd,
  wrapInChangeMarkers,
  wrapWithTracking,
} from "./tracked_changes.ts";
import { sendLyxCommands, checkLyxServerAvailable } from "./lyxserver.ts";
import * as path from "@std/path";

/** Standard LaTeX heading hierarchy used as fallback when .layout files are unavailable. */
const DEFAULT_HEADING_HIERARCHY = [
  { layout: "Part", tocLevel: -1 },
  { layout: "Chapter", tocLevel: 0 },
  { layout: "Section", tocLevel: 1 },
  { layout: "Bibliography", tocLevel: 1 },
  { layout: "Subsection", tocLevel: 2 },
  { layout: "Subsubsection", tocLevel: 3 },
  { layout: "Paragraph", tocLevel: 4 },
  { layout: "Subparagraph", tocLevel: 5 },
];

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
  delete    Delete targeted nodes or mark them deleted when tracking is enabled.
  insert    Insert new blocks or properties relative to matched nodes.
  undo      Revert edits: snapshot restore (1-level, any mutation) or
            replay (unlimited, tracked changes by same author).

Commands return JSON. Help text is plain text.
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
  <selector>  Scope the dump to nodes matching a CSS-like selector.
              Omit to dump the whole document.
              Run 'lq selector --help' for selector syntax.
Options:
  --toc       Output a hierarchical heading tree (table of contents) instead
              of the raw document tree. Heading levels come from the document
              class's .layout file (LaTeX's standard hierarchy as fallback).
              Mutually exclusive with <selector>.
  --depth <n> Limit the output depth. Meaning depends on the mode:
              - Raw document tree (default or <selector>): parse-tree nesting.
                0 = root node only; 1 = direct children; N = descend N levels.
                Omit --depth for full depth.
              - With --toc: absolute LyX TocLevel up to any integer
                Typically --depth 1 = Sections in the document.`,

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
  --find <substring>        Replace all occurrences of <substring> within the matched
                            nodes' text, instead of replacing the entire text content.
  --replace-all             Replace ALL children of the target block, not just text nodes.
                            Mutually exclusive with --find.`,

  delete: `lq delete - Delete targeted nodes or mark them deleted when tracking is enabled.

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
  <position>  Where to insert relative to each matched target:
              'before' / 'after'   Insert as a sibling of the target (for layouts).
              'prepend' / 'append' Insert as a child of the target (for insets, text
                                   inside a layout, etc.).
              'split-after <text>' Split the target's text right after the exact,
                                   case-sensitive <text> substring and insert new
                                   content at the split point. Only proceeds if <text>
                                   appears exactly once in the target. Text inside
                                   \\change_deleted blocks is skipped.

Options (provide exactly one generation helper):
  --layout <name> --text <content>  Insert a layout block with the given name and text.
                               --text requires --layout, except with 'split-after' 
                               where bare --text inserts inline text.
  --raw-file <path>            Read and parse raw LyX syntax from a file.
                               Example: \\begin_layout Standard\\nHello\\n\\end_layout
  --cite <key> [--cite-cmd <cmd>]  Insert a CommandInset citation for the given BibTeX key.
                               --cite-cmd (optional): citet (default), cite, citep,
                               citeauthor, citeyear, citeyearpar, citebyear,
                               footcite, autocite, citetitle, fullcite, footfullcite,
                               nocite, keyonly.
  --ref <label> [--ref-cmd <cmd>]  Insert a CommandInset cross-reference for the given label.
                               --ref-cmd (optional): ref (default), eqref,
                               pageref, vpageref, vref, nameref, formatted, labelonly.
  --label <name>               Insert a CommandInset label with the given name.
  --footnote <text>            Insert a Foot inset containing a Plain Layout with <text>.`,

  undo: `lq undo - Revert edits in matched nodes.

Two modes, distinguished by the presence of a substring argument:

  lq undo <file> <selector>              Snapshot restore (1-level, any mutation).
                                         Consume the snapshot stored at '~/.lq/undo/' to
                                         revert the last (tracked or plain) mutation, even
                                         when the mutation deleted the matched nodes.

  lq undo <file> <selector> <substring>  Replay undo (unlimited levels).
                                         Removes the entire tracked changes block (change_deleted/
                                         change_inserted), which contains <substring>
                                         and made by the current author.
                                         Can be reverted by snapshot restore.

Arguments:
  <file>       The path to the .lyx file.
  <selector>   A CSS-like selector. Run 'lq selector --help' for syntax.
  <substring>  Text inside the change_deleted or change_inserted block to revert.`
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
  const obj = data as Record<string, unknown>;
  // Attach pending warnings to every JSON response
  if (_warnings.length > 0) {
    obj.warnings = [..._warnings];
    _warnings.length = 0;
  } else {
    obj.warnings = [];
  }
  console.log(JSON.stringify(obj, null, 2));
}

function printError(code: string, message: string, details: Record<string, unknown> = {}): never {
  printJson({ code, message, ...details });
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

/** First N characters of a node's text, for concise verbose output.
 *  Uses an early-terminating walk to avoid traversing the full subtree
 *  only to discard 99% of the result. */
function briefText(node: Node, maxLen = 80): string {
  const raw = extractAllText(node, maxLen + 1);
  const text = raw.trim();
  // Use trimmed length: a node with leading whitespace should not falsely
  // trigger truncation just because extractAllText consumed whitespace chars.
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...";
}

/** Build a selector-like label for a node: tag[args]. */
function nodeLabel(node: Node): string {
  if (node.type === "block") {
    return node.tag + "[" + ((node.args || "").trim()) + "]";
  }
  if (node.type === "property") {
    return node.type + "[" + node.key + "]";
  }
  return node.type;
}

interface TocNode {
  layout: string;
  text: string;
  children: TocNode[];
}

function buildToc(
  ast: DocumentNode,
  headingHierarchy: { layout: string; tocLevel: number }[],
  maxLevel: number,
): TocNode[] {
  const rankMap = new Map(headingHierarchy.map((h, i) => [h.layout, i]));
  const levelMap = new Map(headingHierarchy.map(h => [h.layout, h.tocLevel]));

  function rank(layout: string): number {
    const r = rankMap.get(layout);
    return r === undefined ? Infinity : r;
  }
  function tocLevel(layout: string): number {
    const l = levelMap.get(layout);
    return l === undefined ? Infinity : l;
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
    // Absolute TocLevel filter: skip headings deeper than maxLevel. Their
    // subtrees drop too — children always have higher TocLevels (DL83).
    if (tocLevel(layoutName) > maxLevel) continue;

    const entry: TocNode = {
      layout: layoutName,
      text: extractHeadingText(node).trim(),
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

/**
 * Extract the plain text of a heading node for the TOC, skipping inline insets
 * (e.g. `\begin_inset CommandInset label` inside a Section). Unlike
 * `extractAllText`, this does not emit `inset[Type]` markers — a label inset is
 * bookkeeping, not heading text (test_report_34 Finding 6).
 */
function extractHeadingText(node: Node): string {
  if (node.type === "text") return node.text;
  if (node.type === "block") {
    if (node.tag === "inset") return ""; // insets are not heading text
    let out = "";
    for (const child of node.children) out += extractHeadingText(child);
    return out;
  }
  return "";
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
 * Best-effort — warns on failure so the user knows to reload manually.
 */
async function refreshPostStep(filePath: string, mode: "none" | "reload" | "save-reload"): Promise<void> {
  if (mode === "none") return;

  const commands: string[] = [];
  if (Deno.build.os !== "windows") {
    commands.push(`buffer-switch ${path.resolve(filePath)}`);
  }
  commands.push("buffer-reload");

  const ok = await sendLyxCommands(commands);
  if (!ok) {
    pushWarning(
      "LyX buffer was not reloaded — LyX may be closed, busy, or the server " +
      "connection timed out. The file was written successfully. " +
      "Run 'buffer-reload' in LyX or reopen the file to see the changes."
    );
  }
}

// Guard: tracked mutations write \author / \change_* entries that reference
// the document header. A document with no header block cannot represent them
// (LyX rejects \change_* markers without a matching \author entry), so refuse
// rather than silently write a file LyX cannot open (test_report_36 F5).
function assertTrackingHeader(ast: DocumentNode, trackChanges: boolean): void {
  if (!trackChanges) return;
  if (getHeader(ast)) return;
  printError("TRACKING_HEADER_MISSING",
    "This document has no '\\begin_header' block, so tracked changes cannot be " +
    "written — LyX would reject the \\change_* markers (no matching \\author entry).\n" +
    "Fix the file (restore its header) or disable tracking first " +
    "('lq init --track-changes off') to mutate without tracking.");
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
    }

    // Validate --track-changes value
    if (trackChangesFlag !== undefined && trackChangesFlag !== "on" && trackChangesFlag !== "off") {
      printError("INVALID_FLAG", `--track-changes must be 'on' or 'off', got: '${trackChangesFlag}'`);
    }

    // Validate --max-cache-entries value
    let maxCacheEntries: number | undefined;
    if (maxCacheEntriesStr !== undefined) {
      const n = parseInt(maxCacheEntriesStr, 10);
      if (isNaN(n) || n < 0) {
        printError("INVALID_FLAG", `--max-cache-entries must be a non-negative integer, got: '${maxCacheEntriesStr}'`);
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
            printJson({ data: existing });
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
      }
    } catch {
      printError("DIR_NOT_FOUND", `Could not find layouts directory at '${dir}'. Please provide it manually via --layouts-dir.`);
    }

    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (!homeDir) {
      printError("NO_HOME", "Could not determine home directory to save config.");
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
  }

  // Extract --count and --text-only flags early (before positional arg destructuring)
  // so they don't get mistaken for the file path.
  const countOnly = cleanArgs.includes("--count");
  const textOnly = cleanArgs.includes("--text-only");
  const positionalArgs = cleanArgs.filter(a => a !== "--count" && a !== "--text-only");
  
  const [command, filePath, selector, ...restArgs] = positionalArgs;
  
  if (command !== "init" && !filePath.endsWith(".lyx")) {
    printError("INVALID_EXTENSION", `Target file '${filePath}' must have a .lyx extension. Select the LyX document to edit.`);
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
  }

  let ast: DocumentNode;
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
        await setCachedAst(await hashText(text), ast);
      } catch { /* cache failures are non-fatal */ }
    }
  } catch (e: Error | unknown) {
    printError("PARSE_ERROR", (e as Error).message);
  }

/** Fold "--depth -N" into "--depth=-N" — parseArgs treats a bare "-1" as a flag. */
function foldNegativeDepth(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--depth" && next !== undefined && /^-\d+$/.test(next)) {
      out.push(`--depth=${next}`);
      i++;
    } else {
      out.push(args[i]);
    }
  }
  return out;
}

  if (command === "dump") {
    // Dump may have --depth before the selector destructuring consumes it.
    // Parse from selector + restArgs to catch both "--depth N" patterns.
    // parseArgs treats a bare "-1" as a flag, not a value — fold "--depth -N"
    // into "--depth=-N" so negative TocLevels (Part=-1) parse correctly.
    const dumpArgs = foldNegativeDepth(selector ? [selector, ...restArgs] : restArgs);
    const dumpFlags = parseArgs(dumpArgs, { boolean: ["toc"], string: ["depth"] });
    const depthStr = dumpFlags["depth"];
    const tocMode = dumpFlags["toc"] === true;
    
    // If selector is present and not a flag, use it to target a subtree
    const dumpSelector = (selector && !selector.startsWith("--")) ? selector : undefined;
    
    // --toc mode: output heading tree
    if (tocMode) {
      if (dumpSelector) {
        printError("FLAG_CONFLICT", "--toc and selector are mutually exclusive.");
      }
      // Get heading hierarchy from schema
      const textclassNode = query(ast, "textclass")[0];
      const textclass = (textclassNode && textclassNode.type === "property" && textclassNode.value)
        ? textclassNode.value : null;
      if (!textclass) {
        printError("NO_TEXTCLASS", "Could not determine textclass from the document.");
      }
      let headingHierarchy: { layout: string; tocLevel: number }[];
      try {
        const layoutsDir = userConfig.layoutsDir || await getDefaultLayoutsDir();
        const schema = await getSchemaForClass(textclass, layoutsDir);
        headingHierarchy = schema.headingHierarchy;
      } catch {
        // Fallback: standard LaTeX hierarchy
        headingHierarchy = DEFAULT_HEADING_HIERARCHY;
      }
      
      // --depth N = show the heading tree down to absolute LyX TocLevel N
      // (cumulative: every heading with TocLevel <= N). Any integer is valid:
      // Part = -1, Chapter = 0, Section = 1, Subsection = 2, ... (DL83).
      if (depthStr !== undefined && !/^-?\d+$/.test(depthStr.trim())) {
        printError("INVALID_FLAG", "--depth must be an integer (Part=-1, Chapter=0, Section=1, ...).");
      }
      const maxLevel = depthStr !== undefined ? parseInt(depthStr, 10) : Infinity;
      const toc = buildToc(ast, headingHierarchy, maxLevel);

      // Empty results are reported, not silent: the query is valid but the
      // user should know there is nothing to show and what to try instead.
      if (toc.length === 0) {
        pushWarning(
          depthStr !== undefined
            ? `No headings at TocLevel ≤ ${maxLevel} in this document — this class's heading levels may start higher (e.g. Section = 1). Try '--depth 1' for top-level headings.`
            : "No headings found in this document.",
        );
      }

      printJson({ data: toc });
      return;
    }
    
    let roots: Node[] = []; // default: empty, will use ast directly
    let useFullAst = true;
    if (dumpSelector) {
      try {
        roots = query(ast, dumpSelector);
      } catch (e: Error | unknown) {
        printError("INVALID_SELECTOR", (e as Error).message);
      }
      if (roots.length === 0) {
        printError("NO_MATCH", `Selector matched no nodes to dump. Run 'lq read ${filePath} "${dumpSelector}" --count' to verify or refine the selector.`);
      }
      useFullAst = false;
    }
    
    // Wrap each matched node as a document root for depth-limited output
    const wrapAsDoc = (node: Node): DocumentNode => ({
      type: "document",
      children: [node],
    });
    
    if (depthStr !== undefined) {
      const depth = parseInt(depthStr, 10);
      if (isNaN(depth) || depth < 0) {
        printError("INVALID_FLAG", "--depth must be a non-negative integer.");
      }
      
      if (useFullAst) {
        const maxDepth = computeMaxDepth(ast, 0);
        if (depth > maxDepth) {
          pushWarning(`Depth ${depth} exceeds document depth (${maxDepth}). Showing full CST.`);
          printJson({ data: annotateChanges(ast) });
        } else {
          printJson({ data: annotateChanges(truncateAtDepth(ast, depth, 0) as Node | DocumentNode) });
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
        printJson({ count: roots.length, data: annotateChanges(data as Node | DocumentNode | Node[]) });
      }
    } else {
      if (useFullAst) {
        printJson({ data: annotateChanges(ast) });
      } else {
        const docs = roots.map(wrapAsDoc);
        const data = roots.length === 1 ? docs[0] : docs;
        printJson({ count: roots.length, data: annotateChanges(data as Node | DocumentNode | Node[]) });
      }
    }
    return;
  }

  if (command === "bib") {
    const bibArgs = selector ? [selector, ...restArgs] : restArgs;
    const bibFlags = parseArgs(bibArgs, { string: ["search"] });
    const bibtexNodes = query(ast, "inset[CommandInset bibtex]");
    if (bibtexNodes.length === 0) {
      printError("NO_BIBLIO", "No bibliography inset was found. Inspect the document with 'lq read <file> \"inset[CommandInset bibtex]\"' or add a bibliography in LyX, then rerun 'lq bib'.");
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
            }
          }
        }
      }
    }

    if (bibFileCount === 0) {
      printError("NO_BIBFILE", "No .bib files are referenced by the bibliography inset. Add a .bib file in LyX, then rerun 'lq bib'.");
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

    printJson({ data: uniqueCitations });
    return;
  }

  if (command === "schema") {
    const config = await loadUserConfig();
    const layoutsDir = config.layoutsDir || await getDefaultLayoutsDir();
    if (!layoutsDir) {
      printError("NO_CONFIG", "No layouts directory found. Run 'lq init' to auto-detect and save your LyX layouts path.");
    }

    const textclassNode = query(ast, "textclass")[0];
    if (!textclassNode || textclassNode.type !== "property" || !textclassNode.value) {
      printError("NO_TEXTCLASS", "Could not determine textclass from the document.");
    }
    
    try {
      const schema = await getSchemaForClass(textclassNode.value, layoutsDir);
      printJson({ data: schema });
    } catch (e: Error | unknown) {
      pushWarning(`Could not read layout file for textclass '${textclassNode.value}': ${(e as Error).message}`);
      printJson({
        data: {
          textclass: textclassNode.value,
          documentLayouts: [],
          insetLayouts: INSET_LAYOUTS,
          insets: INSETS,
          commandInsetSubtypes: [...KNOWN_COMMAND_INSET_TYPES].sort(),
          inlineProperties: INLINE_PROPERTIES,
          headingHierarchy: DEFAULT_HEADING_HIERARCHY,
        },
      });
    }
    return;
  }

  if (!selector) {
    printError("MISSING_SELECTOR", "A CSS selector is required for this command. Run 'lq selector --help' for selector syntax.");
  }

  let nodes: Node[] = [];
  try {
    nodes = query(ast, selector);
  } catch (e: Error | unknown) {
    printError("INVALID_SELECTOR", (e as Error).message);
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
    const result: Record<string, unknown> = {} ;

    if (countOnly) {
      const tally: Record<string, number> = {};
      for (const node of nodes) {
        const label = nodeLabel(node);
        tally[label] = (tally[label] || 0) + 1;
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
      // Annotate text nodes with changeStatus in-place
      for (const node of nodes) annotateChangesInPlace(node, 0, 0);
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
      printError("NO_MATCH", `Selector matched no nodes to set. Run 'lq read ${filePath} "${selector}" --count' to verify or refine the selector.`);
    }

    // --find and --replace-all are mutually exclusive
    if (findStr !== undefined && replaceAll) {
      printError("FLAG_CONFLICT", "--find and --replace-all are mutually exclusive. --find does surgical substring replacement; --replace-all wipes all children.");
    }

    // --find requires a non-empty substring
    if (findStr !== undefined && findStr.length === 0) {
      printError("INVALID_FLAG", "--find requires a non-empty substring to search for.");
    }

    if (flags._.length === 0) {
      printError("MISSING_ARGS", "A new text value is required for the 'set' command.");
    }

    const newValue = flags._.join(" ");

    // Track total substring matches for stderr notification
    let totalFindMatches = 0;
    // Matches skipped because they straddle a tracked-change boundary —
    // reported with a dedicated error when nothing valid matched (dev log 78).
    let totalStraddles = 0;
    // Per-node type counts captured during mutation (before trackChanges wraps text
    // in change_inserted markers, which could cause double-counting if re-scanned)
    const findPerNode: Record<string, number> = {};

    // Snapshot pre-mutation state for undo — must run BEFORE the mutation loop
    // AND before resolveAuthorId/ensureTrackingChangesInHeader below (dev log
    // 84 F2: the header snapshot must capture the pre-mutation header).
    const preSnapshots = collectSnapshots(ast, nodes, "self");

    // A tracked mutation on a document without a header would write \author-0
    // markers LyX rejects — refuse up front (test_report_36 F5).
    assertTrackingHeader(ast, trackChanges);

    // Pre-compute trackChanges timestamp once for all nodes
    const tcTs = trackChanges ? Math.floor(Date.now() / 1000).toString() : "";
    const tcAid = trackChanges ? resolveAuthorId(ast, authorName) : 0;

    // Helper to accumulate per-node find counts during mutation
    const addFindCount = (node: Node, count: number) => {
      const key = node.type === "block" ? nodeLabel(node) : node.type;
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
        // DL11: Insets are atomic. Tracking markers must not land inside
        // inset metadata lines, and default set silently destroys inset
        // structure. Guard both paths; allow explicit untracked --find
        // and --replace-all as escape hatches.
        const block = node as BlockNode;
        if (block.tag === "inset") {
          if (trackChanges) {
            printError("TRACKING_ERROR",
              `Cannot track changes inside inset parameters — LyX does not track them either.\n` +
              `Alternatives:\n` +
              `  - Delete the old inset + insert a new one (both operations are reviewable when tracking is on)\n` +
              `  - Disable tracking first ('lq init --track-changes off'), then re-run this command\n` +
              `    (untracked '--find' does surgical edits to inset metadata without corrupting it)`);
          }
          if (!findStr && !replaceAll) {
            printError("TRACKING_ERROR",
              `Default 'set' on an inset would destroy its structure (e.g. wiping LatexCommand and name lines).\n` +
              `Use one of:\n` +
              `  --find <substring>   surgical replacement of a parameter value (stays on one line; requires tracking off)\n` +
              `  --replace-all        deliberate full replacement — wipes ALL children, including LatexCommand\n` +
              `  --raw-file           for complete structural rewrites via insert`);
          }
        }

        if (findStr !== undefined) {
          // Cross-node surgical replace: concatenates text children
          // and matches findStr across punctuation-induced text-node boundaries.
          const { newChildren, matchCount: nodeFindCount, straddleCount: nodeStraddles } = applyCrossNodeReplace(
            node.children, findStr, newValue, trackChanges, tcAid, tcTs,
          );
          // Flatten any nested markers produced by editing inside existing
          // tracked changes (dev log 78 Fix 1).
          node.children = trackChanges
            ? flattenNestedChanges(newChildren)
            : newChildren;
          totalFindMatches += nodeFindCount;
          totalStraddles += nodeStraddles;
          if (nodeFindCount > 0) addFindCount(node, nodeFindCount);
        } else if (trackChanges) {
          // Full-text replace with trackChanges: flatten old markers to plain
          // content before applying new markers, matching LyX's per-position
          // overwrite model (dev log 78 Fix 1). All non-marker nodes (text,
          // inline properties, insets) survive the flatten.
          if (hasTrackedChanges(node.children)) {
            const stripped = node.children.filter(c =>
              c.type !== "property" ||
              (!isChangeOpener(c.key) && !isChangeCloser(c.key)));
            node.children = [
              ...wrapInChangeMarkers(stripped.filter(c => c.type === "text"), "deleted", tcAid, tcTs),
              ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", tcAid, tcTs),
              ...stripped.filter(c => c.type !== "text"),
            ];
          } else if (replaceAll) {
            node.children = [
              ...wrapInChangeMarkers(node.children, "deleted", tcAid, tcTs),
              ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", tcAid, tcTs),
            ];
          } else {
            const nonTextChildren = node.children.filter(c => c.type !== "text");
            const oldTextNodes = node.children.filter(c => c.type === "text");
            node.children = [
              ...wrapInChangeMarkers(oldTextNodes, "deleted", tcAid, tcTs),
              ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", tcAid, tcTs),
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
        if (totalStraddles > 0) {
          printError("NO_MATCH", `--find '${findStr}' spans across tracked-change boundaries. Run 'lq undo ${filePath} "${selector}"' first, then retry.`);
        }
        printError("NO_MATCH", `--find '${findStr}' matched no occurrences within the targeted nodes. Run 'lq read ${filePath} "${selector}" --text-only' to inspect their text.`);
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
    await commitMutation(filePath, ast, preSnapshots);
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
    printJson({ modified_nodes: nodes.length, changes });
    return;
  }

  if (command === "delete") {
    if (nodes.length === 0) {
      printError("NO_MATCH", `Selector matched no nodes to delete. Run 'lq read ${filePath} "${selector}" --count' to verify or refine the selector.`);
    }

    // Snapshot pre-mutation state for undo (before any mutation). Parent
    // mode: deletion removes nodes from (or splices markers into) the
    // parent's child list, so the parent's children are what must restore.
    const deletePreSnapshots = collectSnapshots(ast, nodes, "parent");

    // A tracked mutation on a document without a header would write \author-0
    // markers LyX rejects — refuse up front (test_report_36 F5).
    assertTrackingHeader(ast, trackChanges);

    if (trackChanges) {
      // Track-changes mode: wrap matched nodes in change_deleted markers instead of removing them
      const authorId = resolveAuthorId(ast, authorName);
      const deleteTs = Math.floor(Date.now() / 1000).toString();
      ensureTrackingChangesInHeader(ast);
      const nodesToMark = new Set(nodes);

      // DL11: Insets are atomic for change tracking — markers must not land
      // inside inset structural metadata. When a matched block is an inset,
      // wrap the entire inset atomically at the parent level (if the parent is
      // a layout or the document body). An inset nested inside another inset
      // has no valid tracked-deletion representation in LyX.
      const markAsDeleted = (children: Node[], inParagraphContext: boolean) => {
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (nodesToMark.has(child)) {
            if (child.type === "block") {
              const block = child as BlockNode;
              if (block.tag === "inset") {
                if (inParagraphContext) {
                  // Wrap the whole inset atomically — same shape
                  // wrapWithTracking already produces for insets inside
                  // deleted layouts.
                  const wrapped = wrapInChangeMarkers([block], "deleted", authorId, deleteTs);
                  children.splice(i, 1, ...wrapped);
                } else {
                  printError("TRACKING_ERROR",
                    `Cannot track-delete an inset nested inside another inset.\n` +
                    `Use 'lq set' on the enclosing inset's text content to mark changes,\n` +
                    `or delete the enclosing structure.\n` +
                    `Run 'lq read ${filePath} "${selector}" --count' to verify the target.`);
                }
              } else {
                // Layout or other non-inset block: wrap children (existing behavior)
                block.children = wrapWithTracking(block.children, "deleted", authorId, deleteTs);
              }
            } else if (child.type === "text" || child.type === "property") {
              const wrapped = wrapWithTracking([child], "deleted", authorId, deleteTs);
              children.splice(i, 1, ...wrapped);
            }
          } else if (child.type === "block") {
            const block = child as BlockNode;
            // Layout children are paragraph-level; inset children are structural.
            markAsDeleted(block.children, block.tag === "layout");
          }
        }
      };

      markAsDeleted(ast.children, true); // document body = paragraph context
      await commitMutation(filePath, ast, deletePreSnapshots);
      await refreshPostStep(filePath, refreshMode);
      const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
      printJson({ tracked_deleted_nodes: nodes.length, changes });
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

    await commitMutation(filePath, ast, deletePreSnapshots);
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
    printJson({ deleted_nodes: nodes.length, changes });
    return;
  }

  if (command === "insert") {
    if (nodes.length === 0) {
      printError("NO_MATCH", `Selector matched no nodes to insert around. Run 'lq read ${filePath} "${selector}" --count' to verify or refine the selector.`);
    }

    const position = restArgs[0];
    
    // split-after <text> — match string is the next positional arg
    let splitMatch: string | undefined;
    if (position === "split-after") {
      splitMatch = restArgs[1];
      if (!splitMatch || splitMatch === "") {
        printError("MISSING_ARGS", "split-after requires a non-empty match string, e.g. split-after monetary policy");
      }
    }

    if (!["before", "after", "prepend", "append", "split-after"].includes(position)) {
      printError("INVALID_POSITION", "Position must be 'before', 'after', 'prepend', 'append', or 'split-after' (followed by the match string as the next argument).");
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
    }

    // Resolve --raw-file by reading the file content
    let rawContent: string | undefined;
    if (flags["raw-file"]) {
      try {
        rawContent = await Deno.readTextFile(flags["raw-file"]);
      } catch (e: Error | unknown) {
        printError("FILE_NOT_FOUND", `Could not read --raw-file '${flags["raw-file"]}': ${(e as Error).message}`);
      }
    }

    const newNodesToInsert: Node[] = [];

    if (rawContent) {
      // Parse the raw string and collect all valid nodes
      try {
        const tempAst = parse(rawContent, true);
        const validNodes = tempAst.children.filter(c => c.type === "block" || c.type === "property");
        if (validNodes.length === 0) {
          printError("INVALID_RAW", "The --raw-file content did not parse into any valid LyX blocks or properties. Expected content like: \\begin_layout Standard\nYour text\n\\end_layout");
        }

        // Validate inset types in raw content (warning only)
        const warnings = validateRawInsets(tempAst);
        for (const w of warnings) {
          pushWarning(w);
        }

        for (const n of validNodes) newNodesToInsert.push(n);
      } catch (e: Error | unknown) {
        printError("PARSE_ERROR", `Failed to parse raw LyX string: ${(e as Error).message}`);
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
      }
    } else if (flags.cite) {
      const citeCmd = flags["cite-cmd"] || "citet";
      const validCiteCmds = ["cite", "citet", "citep", "citeauthor", "citeyear",
        "citeyearpar", "citebyear", "footcite", "autocite", "citetitle",
        "fullcite", "footfullcite", "nocite", "keyonly"];
      if (!validCiteCmds.includes(citeCmd)) {
        printError("INVALID_FLAG", `Invalid --cite-cmd '${citeCmd}'. Valid values: ${validCiteCmds.join(", ")}`);
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
          // LyX writes `status` as the first line of every collapsible inset,
          // followed by a blank line (dev log 84 F4). Without it LyX warns
          // "Missing 'status'-tag in InsetCollapsible::read".
          { type: "text", text: "status collapsed" },
          { type: "text", text: "" },
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
      if (position === "split-after") {
        // Insert bare text nodes at the split point — these are valid inline
        // children of a layout's text stream (no layout wrapper needed).
        newNodesToInsert.push({ type: "text", text: flags.text } as Node);
      } else {
        printError("TEXT_ONLY_INSERT", "Cannot insert bare text. You must wrap text in a layout using the --layout flag (e.g., --layout 'Standard' --text 'foo').");
      }
    }

    if (newNodesToInsert.length === 0) {
      printError("MISSING_CONTENT", "You must provide --layout, --raw-file, --cite, --ref, --label, or --footnote to insert.");
    }

    let insertedCount = 0;
    let insertedBlocks = 0;

    // Helper to find the parent array and index of a target node.
    // Also returns the full ancestor chain (from root to parent) so that
    // subsequent inset-context checks don't need to re-walk the tree.
    const findNodeContext = (parentList: Node[], target: Node, parentBlock: BlockNode | null = null, ancestors: BlockNode[] = []): { list: Node[]; index: number, parentBlock: BlockNode | null, ancestorChain: BlockNode[] } | null => {
      for (let i = 0; i < parentList.length; i++) {
        if (parentList[i] === target) return { list: parentList, index: i, parentBlock, ancestorChain: ancestors };
        if (parentList[i].type === "block") {
          const block = parentList[i] as BlockNode;
          ancestors.push(block);
          const res = findNodeContext(block.children, target, block, ancestors);
          if (res) return res;
          ancestors.pop();
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

    // Snapshot pre-mutation state for undo — captured BEFORE resolving the
    // author / ensuring the tracking header, so the header entry records the
    // pre-mutation header (dev log 84 F2). prepend/append/split-after modify
    // the target's own children; before/after splice into the parent
    // container's child list.
    const insertPreSnapshots = collectSnapshots(
      ast,
      nodes,
      (position === "before" || position === "after") ? "parent" : "self",
    );

    // A tracked mutation on a document without a header would write \author-0
    // markers LyX rejects — refuse up front (test_report_36 F5).
    assertTrackingHeader(ast, trackChanges);

    // Resolve author and ensure tracking header once for all target nodes
    // and payload blocks (not per-targetNode — avoid re-scanning header N times).
    const insertAuthorId = trackChanges ? resolveAuthorId(ast, authorName) : 0;
    const insertTs = trackChanges ? Math.floor(Date.now() / 1000).toString() : "";
    if (trackChanges) ensureTrackingChangesInHeader(ast);

    for (const targetNode of nodes) {
      let targetParentBlock: BlockNode | null = null;
      let ctx: { list: Node[]; index: number; parentBlock: BlockNode | null; ancestorChain: BlockNode[] } | null = null;

      if (position === "prepend" || position === "append" || position === "split-after") {
        if (targetNode.type !== "block") {
          printError("INVALID_TARGET", `Cannot ${position} to a non-block node.`);

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

      // --- Hoisted split-after match search (runs once per target, not per payload node) ---
      // The match search was previously inside the payload loop, causing multi-block
      // payloads to splice at the same textIdx each iteration (order reversal bug).
      let splitParentList: Node[] | null = null;
      let splitTextIdx = -1;
      let splitInsertOffset = 0;
      if (position === "split-after" && targetParentBlock) {
        // Build concatenated text of direct text children (skipping \change_deleted blocks)
        const { segments, fullText } = concatenateTextNodes(targetParentBlock.children);

        let totalMatches = 0;
        let matchStart = -1;
        {
          let pos = 0;
          while ((pos = fullText.indexOf(splitMatch!, pos)) !== -1) {
            totalMatches++;
            if (matchStart === -1) matchStart = pos;
            pos += splitMatch!.length;
          }
        }

        if (totalMatches === 0) {
          printError("SPLIT_NO_MATCH", `split-after: substring '${splitMatch}' not found in matched block.`);
        }
        if (totalMatches > 1) {
          printError("SPLIT_AMBIGUOUS", `split-after: substring '${splitMatch}' appears ${totalMatches} times in matched block. Use a more specific selector or a longer match string.`);
        }

        const splitPos = matchStart + splitMatch!.length;
        // The split point is right AFTER the last matched character. Map to
        // the segment containing that character, then split one char past it.
        // Mapping bare splitPos lands at offset 0 of the NEXT node when the
        // match ends exactly at a text-node boundary, inserting the payload
        // after the wrong node (test_report_36 F2).
        const lastCharPoint = mapPosToSegment(segments, splitPos > 0 ? splitPos - 1 : 0);
        const splitPoint = { segIdx: lastCharPoint.segIdx, offset: lastCharPoint.offset + 1 };

        // The split falls within a single text node at splitPoint.offset.
        // The "before" portion includes all text from the start of the children
        // up to splitPos; the matched text itself may span multiple text nodes
        // but the split point is always within one node.
        const splitChildIdx = segments[splitPoint.segIdx].childIndex;
        const splitText = (targetParentBlock.children[splitChildIdx] as TextNode).text;
        const before = splitText.substring(0, splitPoint.offset);
        const splitAfterText = splitText.substring(splitPoint.offset);

        splitParentList = targetParentBlock.children;
        splitTextIdx = splitChildIdx;

        const initialNodes: Node[] = [];
        if (before.length > 0) initialNodes.push({ type: "text", text: before });
        if (splitAfterText.length > 0) initialNodes.push({ type: "text", text: splitAfterText });
        splitParentList.splice(splitTextIdx, 1, ...initialNodes);
      }

      // Clone payload to avoid mutating shared nodes across target iterations.
      // Without this, wrapWithTracking on iteration 2 wraps already-wrapped children.
      const payload = newNodesToInsert.map(n => structuredClone(n));

      // DL74/DL11: insets are atomic for change tracking. When tracking is on,
      // an inset payload must be wrapped as a WHOLE — markers around the inset,
      // never inside its metadata children (LatexCommand / key / name lines).
      // Expand each inset to its marker sequence so the loop below treats the
      // markers and the inset as flat siblings.
      let loopPayload = payload;
      if (trackChanges) {
        const expanded: Node[] = [];
        for (const p of payload) {
          if (p.type === "block" && (p as BlockNode).tag === "inset") {
            expanded.push(...wrapWithTracking([p], "inserted", insertAuthorId, insertTs));
          } else {
            expanded.push(p);
          }
        }
        loopPayload = expanded;
      }

      // Per-node validation for each block in the payload
      for (const nodeToInsert of loopPayload) {
        if (trackChanges) {
          if (nodeToInsert.type === "block") {
            const payloadBlock = nodeToInsert as BlockNode;
            if (payloadBlock.tag === "inset") {
              // Already atomically wrapped in the pre-pass above — never wrap
              // an inset's metadata children.
            } else {
              nodeToInsert.children = wrapWithTracking(nodeToInsert.children, "inserted", insertAuthorId, insertTs);
            }
          } else if (nodeToInsert.type === "text" && position === "split-after") {
            // Tracking markers are generated inline at the splice point below.
            // wrapWithTracking is the wrong tool for bare text nodes — it expects
            // an array of children to wrap inside blocks.
          } else if (nodeToInsert.type !== "property") {
            // change_* marker properties from the atomic wrap are already wrapped.
            printError("TRACKING_ERROR", "Cannot track bare text nodes. Wrap in a layout block.");
          }
        }

        if (schema) {
          if (nodeToInsert.type === "block") {
            const block = nodeToInsert as BlockNode;
            if (block.tag === "layout" && block.args) {
              // Determine if the target is inside an inset by walking the
              // ancestor chain captured during the initial findNodeContext call.
              let isInsetContext = false;
              if (targetParentBlock && targetParentBlock.tag === "inset") {
                isInsetContext = true;
              } else if (ctx) {
                for (const ancestor of ctx.ancestorChain) {
                  if (ancestor.tag === "inset") {
                    isInsetContext = true;
                    break;
                  }
                }
              }

            if (isInsetContext) {
              if (!schema.insetLayouts.includes(block.args)) {
                printError("INVALID_CONTEXT", `Cannot insert document layout '${block.args}' inside an Inset. Valid inset layouts are: ${schema.insetLayouts.join(", ")}`);

              }
            } else {
              if (schema.insetLayouts.includes(block.args) && !schema.documentLayouts.includes(block.args)) {
                const contextName = targetParentBlock ? `${targetParentBlock.tag}[${targetParentBlock.args || ''}]` : 'document body';
                printError("INVALID_CONTEXT", `Cannot insert inset layout '${block.args}' into ${contextName}.`);

              }
              if (!schema.documentLayouts.includes(block.args)) {
                printError("INVALID_LAYOUT", `The layout '${block.args}' is not recognized in textclass '${textclassValue}'. Valid layouts: ${schema.documentLayouts.join(", ")}`);

              }
            }
          } else if ((nodeToInsert as Node).type === "property") {
            const prop = nodeToInsert as unknown as PropertyNode;
            if (!schema.inlineProperties.includes(prop.key)) {
              printError("INVALID_PROPERTY", `Property '${prop.key}' is not permitted. Valid inline properties are: ${schema.inlineProperties.join(", ")}`);

            }
          }
        }
      }

      // --- Schema-independent structural guards (always run) ---
      if (nodeToInsert.type === "block") {
        const block = nodeToInsert as BlockNode;
        // Guard: prepend/append/split-after must not nest a layout inside another layout.
        if (block.tag === "layout" && block.args &&
            (position === "prepend" || position === "append" || position === "split-after") &&
            targetParentBlock && targetParentBlock.tag === "layout") {
          printError("INVALID_CONTEXT",
            `Cannot insert layout '${block.args}' inside another layout. ` +
            `Use 'before' or 'after' to insert as a sibling.`);

        }
        // Guard: insets cannot be inserted directly into the document body.
        if (block.tag === "inset" && block.args) {
          const isDocumentContext = targetParentBlock && targetParentBlock.tag === "body";
          if (isDocumentContext) {
            printError("INVALID_CONTEXT", `Cannot insert inset directly into the document body. Insets must be inside a layout (e.g. Standard).`);

          }
        }
      }

        const isLayoutBlock = nodeToInsert.type === "block" && nodeToInsert.tag === "layout";
        const spacer: Node = { type: "text", text: "" };
        const copy = structuredClone(nodeToInsert);

        if (position === "split-after") {
          if (!splitParentList) continue;
          // Insert payload node after the "before" half of the split text.
          // splitTextIdx points to the "before" node; payload goes after it.
          // splitInsertOffset tracks how many nodes from previous payload
          // iterations have already been inserted (fixes multi-block order).
          const insertIdx = splitTextIdx + 1 + splitInsertOffset;
          if (trackChanges && nodeToInsert.type === "text") {
            // Generate change tracking markers inline for bare text nodes.
            const wrapped = wrapInChangeMarkers([copy], "inserted", insertAuthorId, insertTs);
            splitParentList.splice(insertIdx, 0, ...wrapped);
            splitInsertOffset += wrapped.length;
          } else {
            splitParentList.splice(insertIdx, 0, copy);
            splitInsertOffset++;
          }
        } else if (position === "prepend" || position === "append") {
          if (!targetParentBlock) continue;
          if (position === "prepend") {
            // Use splice with offset instead of unshift to preserve
            // insertion order for multi-block payloads.
            if (isLayoutBlock) targetParentBlock.children.splice(insertedSoFar, 0, copy, spacer);
            else targetParentBlock.children.splice(insertedSoFar, 0, copy);
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
        // Track items inserted: layout blocks insert 2 items (block + spacer), others 1.
        // split-after uses splitInsertOffset; append uses push — both don't need this.
        if (position !== "split-after" && position !== "append") {
          insertedSoFar += isLayoutBlock ? 2 : 1;
        }
        insertedBlocks++;
      }
      insertedCount++;
    }

    await commitMutation(filePath, ast, insertPreSnapshots);
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ position, label: nodeLabel(n), text: briefText(n) }));
    printJson({ matched_nodes: insertedCount, inserted_blocks: insertedBlocks, changes });
    return;
  }

  if (command === "undo") {
    const substring: string | undefined = restArgs.length > 0 ? restArgs.join(" ") : undefined;

    // --- Snapshot-based undo (primary path, no substring) ---
    // Restore from a pre-mutation snapshot when no surgical substring
    // is specified. The snapshot is consumed on restore: undo-after-undo
    // is UNDO_STALE, not a redo (dev log 78 — bounded, predictable undo).
    if (substring === undefined) {
      const currentHash = await hashFile(filePath);
      const snapshot = await loadSnapshot(currentHash);
      if (snapshot) {
        let restoredCount = 0;
        let missingCount = 0;
        // Ancestor paths first: a parent restore recreates the structure
        // that descendant paths index into.
        const sortedEntries = [...snapshot.entries].sort((a, b) => a.path.length - b.path.length);
        for (const entry of sortedEntries) {
          const target = nodeAtPath(ast, entry.path);
          if (!target) {
            missingCount++;
            continue;
          }
          const before = JSON.stringify(target.children);
          target.children = entry.children;
          // Count only content-changing restores: the header entry is a no-op
          // for untracked mutations (dev log 84 F2) and must not inflate the
          // count or trip the structure-changed warning.
          if (before !== JSON.stringify(entry.children)) restoredCount++;
        }
        if (restoredCount > 0) {
          if (missingCount > 0) {
            pushWarning(
              `Restored ${restoredCount} of ${snapshot.entries.length} snapshot entries — ` +
              `the document structure changed since the snapshot. Verify with 'lq read ${filePath} "${selector}"'.`
            );
          }
          const newFileText = serialize(ast);
          await Deno.writeTextFile(filePath, newFileText);
          try { await setCachedAst(await hashText(newFileText), ast); } catch { /* non-fatal */ }
          await clearSnapshot(currentHash);
          await refreshPostStep(filePath, refreshMode);
          printJson({ undone_changes: restoredCount, method: "snapshot" });
          return;
        }
        // Snapshot existed but no nodes matched — fall through to replay
        pushWarning("Snapshot found but file structure changed. Falling back to tracked-change undo.");
      }

      // No usable snapshot: if there is also nothing to replay, undo is
      // stale. Checked before resolving the author ID so a clean file
      // stays untouched (no spurious \author entry).
      const hasAnyTracked = nodes.some(n => n.type === "block" && hasTrackedChanges(n.children));
      if (!hasAnyTracked) {
        printError("UNDO_STALE", "Nothing to undo. No snapshot found and no tracked changes to revert.");
      }
    }

    // --- Replay-based undo (fallback path) ---
    // Replay scans the matched nodes' children, so it needs live matches —
    // unlike snapshot restore, which addresses nodes by path and therefore
    // works even when the mutation removed the matched nodes entirely.
    if (nodes.length === 0) {
      printError("NO_MATCH", `Selector matched no nodes to undo. Run 'lq read ${filePath} "${selector}" --count' to verify or refine the selector.`);
    }

    // Snapshot pre-replay children so the replay itself can be undone —
    // captured before resolving the author so the header entry records the
    // pre-replay header (dev log 84 F2).
    const replayPreSnapshots = collectSnapshots(ast, nodes, "self");

    // Resolve the current author's ID to only undo their own changes
    const undoAuthorId = resolveAuthorId(ast, authorName);

    let undoneCount = 0;
    const undoneLabels: string[] = [];

    for (const node of nodes) {
      if (node.type !== "block") continue;
      const newChildren: Node[] = [];
      let i = 0;
      // A kept change_inserted region that ended at a different-type opener
      // (closerAt === -1) has no closer of its own — its \change_unchanged is
      // shared with the following region. Track it so undoing that following
      // region preserves the shared closer (test_report_36 F4).
      let openInsertedRegion = false;
      // Mirror for the deleted side (code_review_85-74 Spec-1): a kept
      // change_deleted region that ended at a different-type opener has no
      // closer of its own; when the following change_inserted region is
      // undone, emit a \change_unchanged so LyX's flat reader doesn't absorb
      // trailing text into the open deleted region.
      let openDeletedRegion = false;

      while (i < node.children.length) {
        const child = node.children[i];
        if (child.type === "property" && isChangeOpener(child.key)) {
          const markerType = child.key;
          const textParts: string[] = [];
          // A region ends at the matching \change_unchanged OR at a
          // different-type opener — LyX's flat model emits adjacent
          // different-type regions (\change_deleted{write} immediately
          // followed by \change_inserted{edit}) with no closer between them
          // (dev log 84 F1/F5). Each opener is processed independently. The
          // extent scan is shared via scanRegionEnd (flat-terminator mode).
          const { closer: closerAt, nextOpener: nextOpenerAt } = scanRegionEnd(
            node.children,
            i + 1,
            markerType,
            true,
          );
          for (let k = i + 1; k < (closerAt !== -1 ? closerAt : nextOpenerAt); k++) {
            const next = node.children[k];
            if (next.type === "text") textParts.push(next.text);
          }

          if (closerAt === -1 && nextOpenerAt === -1) {
            // Malformed: no closing change_unchanged and no next opener — keep as-is
            newChildren.push(child);
            i++;
            continue;
          }

          // Region extent: closer is inclusive, a different-type opener is
          // exclusive (it starts its own region on the next iteration).
          const regionEnd = closerAt !== -1 ? closerAt : nextOpenerAt;
          const nextStart = closerAt !== -1 ? closerAt + 1 : nextOpenerAt;

          const authorIdMatch = child.value?.match(/^(\d+)/);
          const changeAuthorId = authorIdMatch ? parseInt(authorIdMatch[1], 10) : null;
          const enclosedText = textParts.join("");

          // Check if this change matches our target AND belongs to this author
          const shouldUndo = substring === undefined || enclosedText.includes(substring);
          const willUndo = changeAuthorId === undoAuthorId && shouldUndo;

          if (willUndo) {
            if (markerType === "change_deleted") {
              if (openInsertedRegion) {
                // The \change_unchanged that would close this deleted region
                // also closes the still-open preceding change_inserted region.
                // Emit it FIRST, then restore the deleted text as plain text
                // (test_report_36 F4).
                newChildren.push({ type: "property", key: "change_unchanged" });
                openInsertedRegion = false;
              }
              // Restore: keep text nodes, drop the marker and terminator
              for (let k = i + 1; k < regionEnd; k++) newChildren.push(node.children[k]);
            }
            if (markerType === "change_inserted") {
              // A preceding kept deleted region was terminated by this
              // inserted opener and has no closer of its own. Close it with a
              // synthetic \change_unchanged before dropping this region
              // (code_review_85-74 Spec-1 — the mirror of test_report_36 F4).
              if (openDeletedRegion) {
                newChildren.push({ type: "property", key: "change_unchanged" });
                openDeletedRegion = false;
              }
            }
            // change_inserted: drop everything (marker, text, terminator)
            i = nextStart;
            undoneCount++;
            undoneLabels.push(markerType + "{" + (enclosedText.length > 60 ? enclosedText.substring(0, 60) + "..." : enclosedText) + "}");
          } else {
            // Not our target (or another author's) — keep everything as-is
            for (let k = i; k < nextStart; k++) newChildren.push(node.children[k]);
            i = nextStart;
            if (markerType === "change_inserted") {
              // A kept inserted region terminates any open deleted region
              // (flat model — one active Change per position), with or
              // without a closer of its own.
              openDeletedRegion = false;
              if (closerAt === -1) {
                // Kept inserted region with no closer of its own — it stays
                // open, so a following undone deleted region preserves the
                // shared closer (test_report_36 F4).
                openInsertedRegion = true;
              }
            } else if (markerType === "change_deleted") {
              // A kept deleted region keeps its closer, which closes any
              // preceding open inserted region (flat model). If it has no
              // closer of its own (terminated by a different-type opener),
              // the deleted region stays open — it needs a synthetic closer
              // when the following inserted region is undone
              // (code_review_85-74 Spec-1).
              openInsertedRegion = false;
              openDeletedRegion = closerAt === -1;
            }
          }
        } else {
          newChildren.push(child);
          i++;
        }
      }

      node.children = newChildren;
    }

    const changes = undoneLabels.map(l => ({ label: l }));
    if (substring !== undefined && undoneCount === 0) {
      pushWarning(`No tracked change matching '${substring}' found. It may have already been undone. To undo the last undo, run 'lq undo ${filePath} "${selector}"' without a substring.`);
    }
    if (substring === undefined && undoneCount === 0) {
      // Reaching replay without a substring means tracked changes exist
      // (otherwise UNDO_STALE fired above) — so none belong to this author.
      pushWarning(
        `Tracked changes exist in the matched nodes but none belong to author '${authorName}'. ` +
        `Change the default via 'lq init --author-name <name>'.`
      );
    }
    // Write file and save snapshot so the replay itself can be undone
    if (undoneCount > 0) {
      await commitMutation(filePath, ast, replayPreSnapshots);
      await refreshPostStep(filePath, refreshMode);
    }
    printJson({ undone_changes: undoneCount, changes, method: "replay" });
    return;
  }

  printError("UNKNOWN_COMMAND", `Unknown command: ${command}. Run 'lq --help' to list available commands.`);
}
