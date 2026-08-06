import { parse } from "./parser.ts";
import { serialize } from "./serializer.ts";
import { query, buildScopePredicate, buildTraversalStateIndex, selectorNoteScope, type ScopePredicate } from "./query.ts";
import { getSchemaForClass, INSET_LAYOUTS, INSETS, INLINE_PROPERTIES } from "./schema.ts";
import { parseBibtex, Citation } from "./bib.ts";
import { parseArgs } from "@std/cli/parse-args";
import { Node, BlockNode, DocumentNode, PropertyNode, TextNode } from "./ast.ts";
import { validateInsetType, KNOWN_COMMAND_INSET_TYPES } from "./registry.ts";
import {
  advanceChangeDepths,
  concatenateTextNodes,
  isInvisibleInset,
  mapPosToSegment,
  traversalRegion,
  type TextSegment,
} from "./text_utils.ts";
import { getCachedAst, setCachedAst, hashText, hashFile, setMaxCacheEntries } from "./cache.ts";
import { clearSnapshot, collectSnapshots, commitMutation, findNodePath, loadSnapshot, nodeAtPath } from "./undo.ts";
import { resolveInitStatePaths, resolveStatePaths, StatePaths } from "./paths.ts";
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
  parseChangeMarker,
  resolveAuthorId,
  scanRegionEnd,
  wrapInChangeMarkers,
  wrapWithTracking,
} from "./tracked_changes.ts";
import { sendLyxCommands, checkLyxServerAvailable } from "./lyxserver.ts";
import * as path from "@std/path";

/**
 * Map every text node in the tree to its parent children list + index.
 * Used to route a bare-text `set --find` inside a change region through the
 * marker-aware rebuild (dev log 90 1b) — a plain replace would embed the
 * replacement inside the surrounding \change_deleted and be rejected with it.
 */
function collectTextParents(ast: DocumentNode): Map<Node, { list: Node[]; index: number; parentBlock: BlockNode | null }> {
  const map = new Map<Node, { list: Node[]; index: number; parentBlock: BlockNode | null }>();
  const walk = (list: Node[], parentBlock: BlockNode | null = null) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.type === "text") map.set(n, { list, index: i, parentBlock });
      else if (n.type === "block") walk((n as BlockNode).children, n as BlockNode);
    }
  };
  walk(ast.children);
  return map;
}

/**
 * Region a text node sits in, computed from the change markers preceding it
 * in its parent's children: "deleted" | "inserted" | "current".
 */
function nodeInChangeRegion(list: Node[], index: number): "deleted" | "inserted" | "current" {
  let deletedDepth = 0;
  let insertedDepth = 0;
  for (let i = 0; i < index; i++) {
    const c = list[i];
    if (c.type === "property" && (isChangeOpener(c.key) || isChangeCloser(c.key))) {
      const d = advanceChangeDepths(c.key, deletedDepth, insertedDepth);
      deletedDepth = d.deletedDepth;
      insertedDepth = d.insertedDepth;
    }
  }
  if (deletedDepth > 0) return "deleted";
  if (insertedDepth > 0) return "inserted";
  return "current";
}

/** Region a split-after segment sits in, including enclosing inset state. */
function segmentRegion(seg: TextSegment): "deleted" | "inserted" | "current" {
  return traversalRegion(seg.state);
}

/** Is the whole span [ms, me) of a segment list inside the mutation scope? (dev log 92 §2.5 E5) */
function matchSpanInScope(
  segments: TextSegment[],
  ms: number,
  me: number,
  scope: ScopePredicate,
): boolean {
  let offset = 0;
  for (const seg of segments) {
    const segStart = offset;
    const segEnd = offset + seg.text.length;
    if (segEnd > ms && segStart < me) {
      const region = segmentRegion(seg);
      const props = seg.state.properties;
      if (!scope(region, props)) return false;
    }
    offset = segEnd;
  }
  return true;
}

/**
 * The change region open at the given index in a children list (scans forward
 * with the flat-model depth rule): its marker key, author, timestamp, and the
 * opener node (for timestamp bumps). Returns null when no region is open.
 */
function openRegionInfo(
  list: Node[],
  index: number,
): { key: "change_deleted" | "change_inserted"; author: number; ts: string; node: PropertyNode } | null {
  let deletedDepth = 0;
  let insertedDepth = 0;
  let deletedInfo: { author: number; ts: string; node: PropertyNode } | null = null;
  let insertedInfo: { author: number; ts: string; node: PropertyNode } | null = null;
  for (let i = 0; i < index; i++) {
    const c = list[i];
    if (c.type === "property" && (isChangeOpener(c.key) || isChangeCloser(c.key))) {
      const d = advanceChangeDepths(c.key, deletedDepth, insertedDepth);
      deletedDepth = d.deletedDepth;
      insertedDepth = d.insertedDepth;
      if (c.key === "change_deleted" || c.key === "change_inserted") {
        const m = parseChangeMarker(c.value);
        const info = { author: m.authorId, ts: m.ts, node: c as PropertyNode };
        if (c.key === "change_deleted") deletedInfo = info;
        else insertedInfo = info;
      } else if (c.key === "change_unchanged") {
        if (insertedDepth === 0) deletedInfo = null;
        if (deletedDepth === 0) insertedInfo = null;
      }
    }
  }
  if (deletedDepth > 0 && deletedInfo) return { key: "change_deleted", ...deletedInfo };
  if (insertedDepth > 0 && insertedInfo) return { key: "change_inserted", ...insertedInfo };
  return null;
}

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
  init      Initialize or view project-local configuration.
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

Tag[args]: substitute a value from 'lq schema <file>' (these are categories, not literal queries)
  layout[Section]              a document layout from documentLayouts
  inset[Formula]               an inset type from insets
  inset[CommandInset citation] a CommandInset subtype from commandInsetSubtypes
  property[family]             an inline property key from inlineProperties
  text                         text nodes (no [args]); GUI-only status
                               open/collapsed lines inside insets are never
                               matched as text
  
Combinators:
  Space for descendant  e.g. layout[Section] inset[Formula]
  ~ for sibling         e.g. layout[Section] ~ layout[Standard]
  , for OR group        e.g. layout[Section], inset[Foot]

Chainable pseudo-classes: must follow a tag
  :first, :last, :nth-child(an+b/even/odd),
  :contains("text"),
  :not(selector), :adjacent(selector),
  :until(selector) bounds a ~ range to stop before the next matching sibling
  :change(current|inserted|deleted)   nodes by tracked-change region
  :property(key[=value])              nodes under an inline style state
  :note([Note|Comment])               nodes inside a private note (Note Note /
                                      Note Comment); opts into note prose
  :change()/:property() in a selector also scope set --find / split-after
  (union via ',', conjunction via ':' chaining)
  One rule, two axes (private notes: Note Note / Note Comment are invisible
  to content matching by default):
    Content  (:contains, bare text, --find, split-after, --text-only):
             visible-only by default — note prose excluded unless note-scoped
             (:note part or an explicit inset[Note ...] path, per ',' group).
             GUI-only status open/collapsed lines are never matched as text.
    State    (:change, :property): always see note prose.
    Structure(tags, ~, CST views, --toc): lossless; the TOC never surfaces
             note headings or note text. Greyedout is visible output.`,

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
              Tracked changes appear as '\change_deleted{...}' and '\change_inserted{...}' inline markers.

Output is several times larger than the .lyx file (quotes, tags, indentation;
100KB+ gets truncated by the terminal). Check the file size first (ls -l) and
zoom in with a narrower selector for large documents.`,

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
                Typically --depth 1 = Sections in the document.

Output is several times larger than the .lyx file (quotes, tags, indentation;
100KB+ gets truncated by the terminal). Check the file size first (ls -l) and
zoom in with a narrower selector for large documents.`,

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

lq set replaces text content and preserves insets as current content. Inline
properties around the replaced text stay inside the change region when tracking
is on (reject restores formatting) and are dropped when tracking is off (no dead
markup).
Options to change the default behaviour:
  --find <substring>        Replace all case-sensitive occurrences of <substring> within the matched
                            nodes' text, instead of replacing the entire text content.
                            Matches ALL text by default, including \change_deleted
                            (rejected) text; scope with :change(current|inserted|deleted)
                            and/or :property(...) in the selector (union via ',',
                            conjunction via ':' chaining).
  --replace-all             Replace ALL children of the target block, not just text nodes.
                            Mutually exclusive with --find.

For tracked edits, target the child layout inside an inset (e.g.
'inset[Foot] layout[Plain Layout]'), not the inset node itself — tracking
markers cannot wrap inset metadata.`,

  delete: `lq delete - Delete targeted nodes or mark them deleted when tracking is enabled.

Usage:
  lq delete <file> <selector>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector. Run 'lq selector --help' for syntax.`,

  init: `lq init - Initialize or view project-local or global configuration.

Usage:
  lq init              Read the nearest local config, or create
                       '<cwd>/.lq/config.json' when no local marker exists.
  lq init --global     Read or update the global '~/.lq/config.json'.
  lq init [options]    Create or update the selected config with the given options.

State scope:
  Commands use the nearest ancestor containing '.lq' as local state.
  If no local marker exists, commands use the global '~/.lq' state.
  Local config, cache, and undo are isolated from global state.
  '--global' changes only the init target; all other options apply to either scope.

Config precedence:
  New config: built-in defaults, then explicit options.
  Existing config: existing values, then explicit options; omitted values persist.
  A no-option init with an existing config only reads it.

Options:
  --global                  Select the global '~/.lq' target for init.
  --layouts-dir <path>     Set the LyX layouts directory.
                           Default: auto-detect the highest installed version.
  --refresh <mode>         Configure automatic refresh after mutations.
                           none (default): No refresh. LyX detects changes via polling.
                           reload:         Reload and discards unsaved in-LyX edits. 
                                           Requires LyXServer.
                           save-reload:    Save unsaved edits first before reload; aborts
                                           if LyX is unreachable. Requires LyXServer.
  --track-changes <on|off> Enable or disable tracked changes for all mutation commands.
                           On (default): set wraps old text in \\change_deleted + new in \\change_inserted,
                                         delete wraps removed nodes in \\change_deleted,
                                         insert wraps new content in \\change_inserted.
  --author-name <name>     Set the author name used in tracked changes.
                           Default: "lq user".
  --max-cache-entries <n>  Set the maximum number of file caches kept in the
                           selected state's cache directory. Default: 50.
                           Must be a complete non-negative integer.

Successful init responses include 'scope', 'configPath', 'action' (read,
created, or updated), and the configuration under 'data'.`,

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
                                   content at the split point. The target must be a
                                   block (such as layout or inset), and <text> must
                                   appear exactly once. All text is visible by default,
                                   including \\change_deleted; scope with
                                   :change(current|inserted|deleted) or :property(...).

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

  undo: `lq undo - Revert edits.

Two modes, distinguished by the presence of a selector argument:

  lq undo <file>                         Snapshot restore (1-level, any mutation).
                                         Consume the snapshot stored in the selected
                                         local or global state to revert the last
                                         (tracked or plain) mutation as one unit,
                                         even when the mutation deleted matched nodes.

  lq undo <file> <selector> [<substring>]
                                         Replay undo (unlimited levels).
                                         Removes tracked-change blocks
                                         (change_deleted/change_inserted) in the
                                         matched nodes that were made by the current
                                         author; with <substring>, only blocks whose
                                         text contains it. A paired set edit is not
                                         restored as one unit; use snapshot restore
                                         for that. Can be reverted by snapshot restore.

Arguments:
  <file>       The path to the .lyx file.
  <selector>   A CSS-like selector. Run 'lq selector --help' for syntax.
  <substring>  Optional text inside the change_deleted or change_inserted block to revert.`
};

// Helper to load user config
interface UserConfig {
  layoutsDir?: string;
  refresh?: "none" | "reload" | "save-reload";
  trackChanges?: boolean;
  maxCacheEntries?: number;
  authorName?: string;
}

async function loadUserConfig(statePaths: StatePaths): Promise<UserConfig> {
  try {
    const stat = await Deno.stat(statePaths.config);
    if (stat.isFile) {
      const text = await Deno.readTextFile(statePaths.config);
      return JSON.parse(text);
    }
  } catch (_e) {
    // Ignore config loading errors
  }
  return {};
}

async function configFileExists(statePaths: StatePaths): Promise<boolean> {
  try {
    const stat = await Deno.stat(statePaths.config);
    return stat.isFile;
  } catch {
    return false;
  }
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
  // Errors are self-contained: drop accumulated warnings so an error response
  // never carries a mutation-style warning (e.g. the blast-radius notice) that
  // could mislead an agent into thinking the command ran (test_report_39 F3,
  // dev log 88 D4-a).
  _warnings.length = 0;
  printJson({ code, message, ...details });
  Deno.exit(1);
}

// Flags that only 'init' accepts. When a mutation command receives one, the
// error names the exact corrective command instead of a generic "unknown flag"
// (dev log 87 D3 / test_report_38 F7).
const INIT_ONLY_FLAGS = ["global", "layouts-dir", "refresh", "track-changes", "max-cache-entries", "author-name"];

/**
 * Hard-error on flags Deno's parseArgs accepted silently (it captures unknown
 * keys too). `allowed` is the command's declared flag set; anything else —
 * including known init flags misapplied to another command — aborts before any
 * mutation (test_report_38 F7, user decision: no-risk stance).
 */
function assertNoUnknownFlags(
  flags: Record<string, unknown>,
  allowed: string[],
  commandName: string,
): void {
  const unknown = Object.keys(flags).filter(k => k !== "_" && !allowed.includes(k));
  if (unknown.length === 0) return;
  const initFlag = unknown.find(u => INIT_ONLY_FLAGS.includes(u));
  if (initFlag !== undefined) {
    // Echo the exact value the user passed so the corrective is copy-pasteable
    // (e.g. 'lq init --track-changes off' — dev log 87 D3 / test_report_38 F7).
    const raw = flags[initFlag];
    const value = typeof raw === "string" ? raw : "<value>";
    printError("INVALID_FLAG",
      `--${initFlag} is an 'init' flag, not a '${commandName}' flag. ` +
      `Change it with 'lq init --${initFlag} ${value}', then re-run this command.`);
  }
  printError("INVALID_FLAG",
    `Unknown flag${unknown.length === 1 ? "" : "s"} for '${commandName}': ` +
    `${unknown.map(u => "--" + u).join(", ")}. ` +
    `Run 'lq ${commandName} --help' to list valid flags.`);
}

/**
 * Commands that take no flags at all (read/delete/undo/schema) still receive
 * stray `--` tokens in their extra positional args — reject them instead of
 * silently ignoring (test_report_38 F7).
 */
function assertNoStrayFlags(restArgs: string[], commandName: string): void {
  const stray = restArgs.filter(a => a.startsWith("--"));
  if (stray.length > 0) {
    printError("INVALID_FLAG",
      `Unknown flag${stray.length === 1 ? "" : "s"} for '${commandName}': ` +
      `${stray.join(", ")}. Run 'lq ${commandName} --help' to list valid flags.`);
  }
}

/**
 * Build the children of a tracked full-text replace (lq set without --find /
 * --replace-all, and the flatten of a node with pending changes).
 *
 * Old content (text + inline properties, in original order) is wrapped in
 * \change_deleted; the new value is wrapped in \change_inserted. Properties
 * stay IN PLACE inside the deleted region — LyX's Paragraph::write emits font
 * properties inside a change region, so rejecting the change restores the
 * original formatting (test_report_38 F8, test_report_39 F1).
 *
 * Insets stay OUTSIDE the change pair as current content (the documented
 * "preserves non-text children" contract, dev log 88 D2-b) — they survive
 * both accept and reject.
 */
function buildTrackedFullReplace(
  children: Node[], newValue: string, tcAid: number, tcTs: string,
): Node[] {
  const stripped = children.filter(c =>
    c.type !== "property" || (!isChangeOpener(c.key) && !isChangeCloser(c.key)));
  const insets = stripped.filter(c => c.type === "block");
  const deletedContent = stripped.filter(c => c.type !== "block");
  return [
    ...(deletedContent.length > 0 ? wrapInChangeMarkers(deletedContent, "deleted", tcAid, tcTs) : []),
    ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", tcAid, tcTs),
    ...insets,
  ];
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

/** Brief text preview of a snapshot entry's restored children (dev log 102
 *  D1b): concatenates the children's text with the same 60-char truncation
 *  rule as replay's change labels. */
function briefChildrenText(children: Node[], maxLen = 60): string {
  let raw = "";
  for (const c of children) {
    if (raw.length > maxLen) break;
    raw += extractAllText(c, maxLen + 1 - raw.length);
  }
  const text = raw.trim();
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...";
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

/**
 * DL99: does `phrase` appear only in the document's INVISIBLE content — prose
 * inside a private note (Note Note / Note Comment)? Used by the NO_MATCH error
 * paths of --find and split-after to hint that the selector needs `:note`
 * (dev log 99 §3.5).
 */
function phraseOnlyInInvisibleContent(ast: DocumentNode, phrase: string): boolean {
  let foundInvisible = false;
  let foundVisible = false;
  const walk = (children: Node[], inNote: boolean) => {
    if (foundInvisible && foundVisible) return;
    for (const c of children) {
      if (foundInvisible && foundVisible) return;
      if (c.type === "text") {
        if (c.text.includes(phrase)) {
          if (inNote) foundInvisible = true;
          else foundVisible = true;
        }
      } else if (c.type === "block") {
        const b = c as BlockNode;
        walk(b.children, inNote || isInvisibleInset(b));
      }
    }
  };
  walk(ast.children, false);
  return foundInvisible && !foundVisible;
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

function buildTrackedDirectTextReplacement(
  text: string,
  findStr: string | undefined,
  newValue: string,
  authorId: number,
  ts: string,
): { nodes: Node[]; matchCount: number } {
  if (findStr === undefined) {
    return {
      nodes: [
        ...wrapInChangeMarkers([{ type: "text", text }], "deleted", authorId, ts),
        ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", authorId, ts),
      ],
      matchCount: 0,
    };
  }

  const nodes: Node[] = [];
  let cursor = 0;
  let matchCount = 0;
  while (true) {
    const matchStart = text.indexOf(findStr, cursor);
    if (matchStart === -1) break;
    if (matchStart > cursor) nodes.push({ type: "text", text: text.substring(cursor, matchStart) });
    nodes.push(...wrapInChangeMarkers(
      [{ type: "text", text: text.substring(matchStart, matchStart + findStr.length) }],
      "deleted",
      authorId,
      ts,
    ));
    nodes.push(...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", authorId, ts));
    cursor = matchStart + findStr.length;
    matchCount++;
  }

  if (matchCount === 0) return { nodes: [{ type: "text", text }], matchCount: 0 };
  if (cursor < text.length) nodes.push({ type: "text", text: text.substring(cursor) });
  return { nodes, matchCount };
}

function foldNegativeCacheEntryValue(args: string[]): string[] {
  const folded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--max-cache-entries" && next !== undefined && next.startsWith("-")) {
      folded.push(`--max-cache-entries=${next}`);
      i++;
    } else {
      folded.push(args[i]);
    }
  }
  return folded;
}

// --- LyXServer refresh helpers ---

/**
 * Pre-step for save-reload: saves the user's unsaved LyX edits to disk
 * BEFORE lq reads and mutates the file. Must succeed or the mutation is aborted.
 * Returns true if the pre-step succeeded (or mode doesn't need a pre-step).
 */
/** Result of the save-reload pre-step (test_report_38 F1 / Option A). */
export type RefreshPreStepResult = "ok" | "disconnect" | "unconfirmed" | "error";

/**
 * Pre-step for save-reload: saves the user's unsaved LyX edits to disk
 * BEFORE lq reads and mutates the file. Must succeed or the mutation is aborted.
 *
 * On Windows the response delivery from LyXServer is unreliable (Server.cpp
 * flushes its shared reply buffer only when the pipe loop wakes — test_report_38
 * F1), so the pre-step distinguishes:
 * - "disconnect" — could not even open/write the pipe: LyX is unreachable.
 * - "unconfirmed" — the buffer-write was dispatched (LyX will execute it) but
 *   the confirmation was lost to the race. The save is almost certainly applied,
 *   so the caller proceeds with a warning rather than aborting (Option A).
 * - "error" — LyX confirmed but reported an error saving.
 */
export async function refreshPreStep(
  filePath: string,
  mode: "none" | "reload" | "save-reload",
): Promise<RefreshPreStepResult> {
  if (mode !== "save-reload") return "ok";

  const commands: string[] = [];
  // buffer-switch ensures the correct file is active before saving.
  // On Windows, skipped: the pipe protocol (Server.cpp) uses ':' as a
  // delimiter, which conflicts with the drive letter in absolute paths.
  if (Deno.build.os !== "windows") {
    commands.push(`buffer-switch ${path.resolve(filePath)}`);
  }
  commands.push("buffer-write");

  const { sent, confirmed, errored } = await sendLyxCommands(commands);
  if (!sent) return "disconnect";
  if (!confirmed) return "unconfirmed";
  if (errored) return "error";
  return "ok";
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

  // Best-effort: warn unless the reload was confirmed and did not error. On
  // Windows a lost confirmation (sent but unconfirmed — test_report_38 F1) also
  // warns, since the buffer may not have been reloaded.
  const { confirmed, errored } = await sendLyxCommands(commands);
  if (!confirmed || errored) {
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
    const flags = parseArgs(
      foldNegativeCacheEntryValue(cleanArgs.slice(1)),
      {
        boolean: ["global"],
        string: ["layouts-dir", "refresh", "track-changes", "max-cache-entries", "author-name"],
      },
    );
    assertNoUnknownFlags(flags, INIT_ONLY_FLAGS, "init");
    const hasFlags = flags["layouts-dir"] !== undefined ||
                     flags["refresh"] !== undefined ||
                     flags["track-changes"] !== undefined ||
                     flags["max-cache-entries"] !== undefined ||
                     flags["author-name"] !== undefined;
            const useGlobal = flags["global"] === true;
            const dirFlag = flags["layouts-dir"] as string | undefined;
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
      if (!/^\d+$/.test(maxCacheEntriesStr)) {
        printError("INVALID_FLAG", `--max-cache-entries must be a non-negative integer, got: '${maxCacheEntriesStr}'`);
      }
      const n = Number(maxCacheEntriesStr);
      if (!Number.isSafeInteger(n)) {
        printError("INVALID_FLAG", `--max-cache-entries must be a non-negative integer, got: '${maxCacheEntriesStr}'`);
      }
      maxCacheEntries = n;
    }

    if (authorNameFlag !== undefined && authorNameFlag.trim().length === 0) {
      printError("INVALID_FLAG", "--author-name must be a non-empty string.");
    }

    const statePaths = await resolveInitStatePaths(useGlobal);
    if (!statePaths) {
      printError(
        "NO_HOME",
        "Could not determine a home directory for global state. Set HOME or USERPROFILE, or run 'lq init' from a project directory for local state.",
      );
    }
    const configExists = await configFileExists(statePaths);
    const existing = await loadUserConfig(statePaths);

    // If no flags and config exists, print it and exit
    if (!hasFlags && configExists) {
      printJson({
        scope: statePaths.scope,
        configPath: statePaths.config,
        action: "read",
        data: existing,
      });
      return;
    }

    const dir = dirFlag ?? existing.layoutsDir ?? await getDefaultLayoutsDir();

    try {
      const stat = await Deno.stat(dir);
      if (!stat.isDirectory) {
        printError("INVALID_DIR", `The path '${dir}' is not a directory. Please provide a valid --layouts-dir.`);
      }
    } catch {
      printError("DIR_NOT_FOUND", `Could not find layouts directory at '${dir}'. Please provide it manually via --layouts-dir.`);
    }

    const config: UserConfig = {
      layoutsDir: dir,
      refresh: refresh as "none" | "reload" | "save-reload" ?? existing.refresh ?? "none",
      trackChanges: trackChangesFlag !== undefined
        ? trackChangesFlag === "on"
        : existing.trackChanges ?? true,
      maxCacheEntries: maxCacheEntries ?? existing.maxCacheEntries ?? 50,
      authorName: authorNameFlag ?? existing.authorName ?? "lq user",
    };

    // If refresh is enabled, verify LyXServer is reachable. Dispatch-based
    // probe (test_report_38 F10) — truthful for both "no socket found" and
    // "LyX is up but not accepting commands".
    if (config.refresh !== "none") {
      const available = await checkLyxServerAvailable();
      if (!available) {
        pushWarning(
          `Refresh mode '${config.refresh}' requires a running LyX instance with LyXServer enabled, ` +
          "but the server could not be reached (no socket found, or LyX is not accepting commands). " +
          "Enable LyXServer in LyX Preferences and restart LyX."
        );
      }
    }

    try {
      await Deno.mkdir(statePaths.root, { recursive: true });
      await Deno.writeTextFile(statePaths.config, JSON.stringify(config, null, 2));
      printJson({
        scope: statePaths.scope,
        configPath: statePaths.config,
        action: configExists ? "updated" : "created",
        data: config,
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

  // Commands without their own flag parsing must not silently swallow stray
  // `--` tokens (test_report_38 F7). Flag-bearing commands (init/dump/bib/
  // set/insert) validate via assertNoUnknownFlags at their parse site.
  if (["read", "delete", "undo", "schema"].includes(command)) {
    assertNoStrayFlags(restArgs, command);
  }
  
  if (command !== "init" && !filePath.endsWith(".lyx")) {
    printError("INVALID_EXTENSION", `Target file '${filePath}' must have a .lyx extension. Select the LyX document to edit.`);
  }

  const statePaths = await resolveStatePaths();
  if (!statePaths) {
    printError(
      "NO_HOME",
      "Could not determine a home directory for global state. Set HOME or USERPROFILE, or create a local .lq directory and run the command from that project.",
    );
  }

  // Load user config (shared by all commands: cache sizing, refresh, track-changes)
  const userConfig = await loadUserConfig(statePaths);
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
      const preStep = await refreshPreStep(filePath, refreshMode);
      if (preStep === "disconnect") {
        printError("REFRESH_PRE_ERROR",
          "save-reload: Cannot connect to LyX to save unsaved edits.\n" +
          "Writing the file now would permanently destroy unsaved changes.\n" +
          "Start LyX with LyXServer enabled (see 'lq init --refresh' help) and retry."
        );
        return;
      }
      if (preStep === "error") {
        printError("REFRESH_PRE_ERROR",
          "save-reload: LyX reported an error saving the buffer, so unsaved edits " +
          "may not be on disk.\n" +
          "Writing the file now would permanently destroy unsaved changes."
        );
        return;
      }
      if (preStep === "unconfirmed") {
        // Option A (test_report_38 F1): the save command was dispatched and LyX
        // will execute it; only the confirmation was lost to the Windows pipe
        // race. Proceed — aborting would needlessly block the mutation.
        pushWarning(
          "save-reload: the save command was sent to LyX but the confirmation was " +
          "lost (a known Windows LyXServer race). Proceeding — the save was almost " +
          "certainly applied. If this repeats, restart LyX."
        );
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
    const cached = await getCachedAst(filePath, statePaths);
    if (cached) {
      ast = cached;
    } else {
      ast = parse(text);
      // Populate cache on miss (non-fatal)
      try {
        await setCachedAst(await hashText(text), ast, statePaths);
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
    assertNoUnknownFlags(dumpFlags, ["toc", "depth"], "dump");
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
    assertNoUnknownFlags(bibFlags, ["search"], "bib");
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
    const config = await loadUserConfig(statePaths);
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

  if (!selector && command !== "undo") {
    printError("MISSING_SELECTOR", "A CSS selector is required for this command. Run 'lq selector --help' for selector syntax.");
  }

  let nodes: Node[] = [];
  if (selector) {
    try {
      nodes = query(ast, selector);
    } catch (e: Error | unknown) {
      printError("INVALID_SELECTOR", (e as Error).message);
    }
  }

  // Warn if :until() is used without a preceding ~ combinator: without ~
  // there is no anchor to check intervening siblings against, so :until()
  // has no effect (all nodes pass through).
  if (selector && selector.includes(":until(")) {
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

  const traversalStateIndex = buildTraversalStateIndex(ast.children);

  // Common guard: Prevent mutating core document structures directly
  const unsafeNodes = nodes.filter(n => (n.type === "block" && (n.tag === "body" || n.tag === "header" || n.tag === "document")));
  if (unsafeNodes.length > 0 && ["set", "delete", "insert"].includes(command)) {
    printError("INVALID_CONTEXT", "Cannot mutate core document structures ('document', 'body', 'header') directly. Target specific layouts or properties instead.");
  }

  // Mutation commands below
  
  // Blast radius warning: if selector matches more than 1 node, warn to
  // stderr. The mutation still proceeds — this is a warning, not a blocker.
  // The warning is only seen in the output AFTER the mutation has run, so it
  // also points at undo as the recovery path (dev log 102 D1). `undo` replay
  // is handled separately, after the replay actually reverted something, so
  // its message can truthfully name the recovery.
  if (["set", "delete", "insert"].includes(command) && nodes.length > 1) {
    const warnMsg = `Selector matches ${nodes.length} nodes. ` +
      `If this is not intended, run 'lq read ${filePath} "${selector}"' ` +
      `to inspect them, or 'lq undo ${filePath}' to revert the last mutation.`;
    pushWarning(warnMsg);
  }

  if (command === "set") {
    const flags = parseArgs(restArgs, { boolean: ["replace-all"], string: ["find"] });
    assertNoUnknownFlags(flags, ["replace-all", "find"], "set");
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

    // Mutation scope from the selector's state predicates (dev log 92 §2.4):
    // OR across `,` groups, AND across chained :change()/:property() within a
    // group; a group with no state predicates is unconstrained. Undefined =
    // see all text by default (dev log 90).
    const scope = buildScopePredicate(selector);

    // Track total substring matches for stderr notification
    let totalFindMatches = 0;
    // Nodes that actually had a --find occurrence. `modified_nodes` reports
    // this instead of nodes.length for --find, which previously over-counted
    // matched-but-unmodified nodes (test_report_38 F6).
    let findNodesWithHits = 0;
    // Occurrences that matched inside \change_deleted (rejected text) — the
    // warning appends a note so editing rejected text is not silent (dev log
    // 90 §5.7).
    let totalDeletedHits = 0;
    // Matches that were present but skipped because every occurrence spans an
    // inset — NO_MATCH reports this explicitly (dev log 91 F2).
    let totalCrossedInset = 0;
    // Per-node type counts captured during mutation (before trackChanges wraps text
    // in change_inserted markers, which could cause double-counting if re-scanned)
    const findPerNode: Record<string, number> = {};

    // Parent index for bare-text `--find` routing (dev log 90 1b): a text node
    // inside a change region is rebuilt at the parent level (see-all), so the
    // replacement is not swallowed by the surrounding \change_deleted.
    const textParentIndex = collectTextParents(ast);
    const processedParents = new Set<Node[]>();

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
              findNodesWithHits++;
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
          const { newChildren, matchCount: nodeFindCount, deletedHitCount: nodeDeletedHits, crossedInsetCount: nodeCrossedInset } = applyCrossNodeReplace(
            node.children,
            findStr,
            newValue,
            trackChanges,
            tcAid,
            tcTs,
            scope,
            traversalStateIndex.get(node),
          );
          // Flatten any nested markers produced by editing inside existing
          // tracked changes (safety net — the rebuild emits flat markers).
          node.children = trackChanges
            ? flattenNestedChanges(newChildren)
            : newChildren;
          totalFindMatches += nodeFindCount;
          totalDeletedHits += nodeDeletedHits;
          totalCrossedInset += nodeCrossedInset;
          if (nodeFindCount > 0) {
            findNodesWithHits++;
            addFindCount(node, nodeFindCount);
          }
        } else if (trackChanges) {
          // Full-text replace with trackChanges: flatten old markers to plain
          // content before applying new markers, matching LyX's per-position
          // overwrite model (dev log 78 Fix 1). Inline properties are preserved
          // IN PLACE inside the deleted region — LyX's own writer emits font
          // properties inside a change region (Paragraph::write), so rejecting
          // the change restores the original formatting (test_report_38 F8,
          // test_report_39 F1). Insets stay OUTSIDE the change pair as current
          // content (the documented "preserves non-text children" contract,
          // dev log 88 D2-b) — they survive both accept and reject.
          if (hasTrackedChanges(node.children) || !replaceAll) {
            node.children = buildTrackedFullReplace(node.children, newValue, tcAid, tcTs);
          } else {
            // --replace-all deliberately wipes ALL children, insets included
            // ("Wipe all children and rebuild from scratch").
            node.children = [
              ...wrapInChangeMarkers(node.children, "deleted", tcAid, tcTs),
              ...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", tcAid, tcTs),
            ];
          }
        } else {
          // Full-text replace without trackChanges.
          if (replaceAll) {
            node.children = [{ type: "text", text: newValue }];
          } else {
            // Preserve insets as current content; drop inline properties —
            // they format the replaced text and would become dead trailing
            // markup (test_report_39 F2). The result equals the tracked path's
            // accept view (dev log 88).
            const insets = node.children.filter(c => c.type === "block");
            node.children = [{ type: "text", text: newValue }, ...insets];
          }
        }
      } else if (node.type === "text") {
        const parentCtx = textParentIndex.get(node);
        const nodeState = traversalStateIndex.get(node);
        const nodeRegion = nodeState
          ? traversalRegion(nodeState)
          : (parentCtx ? nodeInChangeRegion(parentCtx.list, parentCtx.index) : "current");
        if (findStr !== undefined) {
          // Direct text node surgical replace. A text node inside a change
          // region must route through the marker-aware rebuild (dev log 90
          // 1b): a plain replace would embed the replacement inside the
          // surrounding \change_deleted and be rejected with it.
          if (parentCtx && nodeRegion !== "current") {
            if (!processedParents.has(parentCtx.list)) {
              processedParents.add(parentCtx.list);
              const { newChildren, matchCount, deletedHitCount, crossedInsetCount } = applyCrossNodeReplace(
                parentCtx.list,
                findStr,
                newValue,
                trackChanges,
                tcAid,
                tcTs,
                scope,
                parentCtx.parentBlock ? traversalStateIndex.get(parentCtx.parentBlock) : undefined,
              );
              parentCtx.list.splice(
                0,
                parentCtx.list.length,
                ...(trackChanges ? flattenNestedChanges(newChildren) : newChildren),
              );
              totalFindMatches += matchCount;
              totalDeletedHits += deletedHitCount;
              totalCrossedInset += crossedInsetCount;
              if (matchCount > 0) {
                findNodesWithHits++;
                addFindCount(node, matchCount);
              }
            }
          } else {
            const count = countOccurrences(node.text, findStr);
            if (count > 0) {
              if (trackChanges && parentCtx) {
                const currentIndex = parentCtx.list.indexOf(node);
                if (currentIndex !== -1) {
                  const replacement = buildTrackedDirectTextReplacement(
                    node.text,
                    findStr,
                    newValue,
                    tcAid,
                    tcTs,
                  );
                  parentCtx.list.splice(currentIndex, 1, ...replacement.nodes);
                  totalFindMatches += replacement.matchCount;
                  findNodesWithHits++;
                  addFindCount(node, replacement.matchCount);
                }
              } else {
                node.text = node.text.replaceAll(findStr, newValue);
                totalFindMatches += count;
                findNodesWithHits++;
                addFindCount(node, count);
              }
            }
          }
        } else {
          if (trackChanges && parentCtx && nodeRegion === "current") {
            const currentIndex = parentCtx.list.indexOf(node);
            if (currentIndex !== -1) {
              const replacement = buildTrackedDirectTextReplacement(node.text, undefined, newValue, tcAid, tcTs);
              parentCtx.list.splice(currentIndex, 1, ...replacement.nodes);
            }
          } else if (trackChanges && parentCtx && nodeRegion !== "current") {
            const currentIndex = parentCtx.list.indexOf(node);
            if (currentIndex !== -1) {
              if (node.text.length === 0) {
                const replacement = buildTrackedDirectTextReplacement(node.text, undefined, newValue, tcAid, tcTs);
                parentCtx.list.splice(currentIndex, 1, ...replacement.nodes);
              } else {
                const replacement = applyCrossNodeReplace(
                  [node],
                  node.text,
                  newValue,
                  true,
                  tcAid,
                  tcTs,
                  scope,
                  nodeState,
                );
                parentCtx.list.splice(
                  currentIndex,
                  1,
                  ...flattenNestedChanges(replacement.newChildren),
                );
              }
            }
          } else {
            node.text = newValue;
          }
        }
      }
    }

    // After loop: check if --find had any matches
    if (findStr !== undefined) {
      if (totalFindMatches === 0) {
        let noMatchMsg = `--find '${findStr}' matched no occurrences within the targeted nodes. Run 'lq read ${filePath} "${selector}" --text-only' to inspect their text.`;
        if (totalCrossedInset > 0) {
          noMatchMsg += ` The phrase spans an inset (citation/footnote) — matches cannot cross an inset; split the phrase or use full 'set' to replace the whole text.`;
        }
        // DL99: the phrase may exist only inside a private note (invisible to
        // content matching by default) — name it so the agent can opt in.
        if (!selectorNoteScope(selector) && phraseOnlyInInvisibleContent(ast, findStr)) {
          noMatchMsg += ` The phrase exists only inside a private note (Note/Comment) — add ':note' to the selector to target note prose.`;
        }
        printError("NO_MATCH", noMatchMsg);
      }
      const plural = totalFindMatches === 1 ? "" : "s";
      const nodeList = Object.entries(findPerNode)
        .map(([k, c]) => `${k} (${c} occurrence${c === 1 ? "" : "s"})`)
        .join(", ");
      let findMsg = `--find matched ${totalFindMatches} occurrence${plural} of '${findStr}' across ${findNodesWithHits} node(s): ${nodeList}. ` +
        `To target a specific occurrence, use a longer unique substring (include surrounding words).`;
      if (totalDeletedHits > 0) {
        const delPlural = totalDeletedHits === 1 ? "" : "s";
        findMsg += ` ${totalDeletedHits} occurrence${delPlural} matched inside \\change_deleted (rejected text) — the replacement is inserted as a new tracked change adjacent to the deletion; scope with :change(current|inserted|deleted) to target a region.`;
      }
      pushWarning(findMsg);
    }

    if (trackChanges) {
      ensureTrackingChangesInHeader(ast);
    }
    await commitMutation(filePath, ast, preSnapshots, statePaths);
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ label: nodeLabel(n), text: briefText(n) }));
    // --find only modified the nodes that contained occurrences; report those,
    // not every selector match (test_report_38 F6).
    const reportedNodes = findStr !== undefined ? findNodesWithHits : nodes.length;
    printJson({ modified_nodes: reportedNodes, changes });
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
      await commitMutation(filePath, ast, deletePreSnapshots, statePaths);
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

    await commitMutation(filePath, ast, deletePreSnapshots, statePaths);
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
    assertNoUnknownFlags(flags, ["layout", "text", "raw-file", "cite", "cite-cmd", "ref", "ref-cmd", "label", "footnote"], "insert");

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
      const config = await loadUserConfig(statePaths);
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
    const config = await loadUserConfig(statePaths);
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
          const message = position === "split-after"
            ? "Cannot split-after to a non-block node. Select a layout or inset block and apply :change(...) or :property(...) to that block; text selectors cannot be split directly."
            : `Cannot ${position} to a non-block node.`;
          printError("INVALID_TARGET", message);

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
      // Region at the split point (dev log 90 §5.4): a split inside a change
      // region must never nest the inserted block — it merges (same author)
      // or splits into adjacent flat blocks.
      let splitRegion: "deleted" | "inserted" | "current" = "current";
      let splitRegionInfo: { key: "change_deleted" | "change_inserted"; author: number; ts: string; node: PropertyNode } | null = null;
      let splitRegionContinues = false;
      // Mutation scope from the selector's state predicates (dev log 92
      // §2.4/E5): resolves SPLIT_AMBIGUOUS by restricting the split point to
      // the scope; undefined = see all text by default.
      const splitScope = buildScopePredicate(selector);
      if (position === "split-after" && targetParentBlock) {
        // Build concatenated text, recursing into nested layouts so the
        // documented two-pass footnote workflow works (test_report_38 F3): a
        // footnote's text lives in a nested Plain Layout inside inset[Foot].
        // Text is collected only under layouts — inset metadata (status lines,
        // CommandInset name lines) is not matchable. Mutations see all text
        // (dev log 90): \change_deleted text is matchable too, so split-after
        // can target a rejected region; SPLIT_AMBIGUOUS is resolved by
        // :change() scoping.
        // DL99: private notes are invisible content — split-after must not
        // leak into them. Note prose is in scope only when the selector is
        // note-scoped (:note / inset[Note ...]) or the target sits inside (or
        // is) a private note.
        const splitNoteScope = selectorNoteScope(selector) ||
          isInvisibleInset(targetParentBlock) ||
          (ctx?.ancestorChain?.some((a) => isInvisibleInset(a)) ?? false);
        const { segments, fullText } = concatenateTextNodes(targetParentBlock.children, {
          recurseLayouts: true,
          topLevelIsLayout: targetParentBlock.tag !== "inset",
          includeDeleted: true,
          inheritedState: traversalStateIndex.get(targetParentBlock),
          skipInvisibleNotes: !splitNoteScope,
        });

        let totalMatches = 0;
        let matchStart = -1;
        {
          let pos = 0;
          while ((pos = fullText.indexOf(splitMatch!, pos)) !== -1) {
            const me = pos + splitMatch!.length;
            if (!splitScope || matchSpanInScope(segments, pos, me, splitScope)) {
              totalMatches++;
              if (matchStart === -1) matchStart = pos;
            }
            pos += splitMatch!.length;
          }
        }

        if (totalMatches === 0) {
          let splitNoMatchMsg = `split-after: substring '${splitMatch}' not found in matched block.`;
          // DL99: the phrase may exist only inside a private note (invisible
          // to content matching by default) — name it so the agent can opt in.
          if (!splitNoteScope && phraseOnlyInInvisibleContent(ast, splitMatch!)) {
            splitNoMatchMsg += ` It exists only inside a private note (Note/Comment) — add ':note' to the selector to target note prose.`;
          }
          printError("SPLIT_NO_MATCH", splitNoMatchMsg);
        }
        if (totalMatches > 1) {
          printError("SPLIT_AMBIGUOUS", `split-after: substring '${splitMatch}' appears ${totalMatches} times in matched block (including rejected \\change_deleted text). Scope with :change(current|inserted|deleted), or use a more specific selector or a longer match string.`);
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
        // but the split point is always within one node. With recursion the
        // text node may live in a nested layout, so splice into the segment's
        // OWNING children list (test_report_38 F3).
        const splitSegment = segments[splitPoint.segIdx];
        const splitChildIdx = splitSegment.childIndex;
        splitParentList = splitSegment.owner ?? targetParentBlock.children;
        const splitText = (splitParentList[splitChildIdx] as TextNode).text;
        const before = splitText.substring(0, splitPoint.offset);
        const splitAfterText = splitText.substring(splitPoint.offset);

        splitTextIdx = splitChildIdx;

        const initialNodes: Node[] = [];
        if (before.length > 0) initialNodes.push({ type: "text", text: before });
        if (splitAfterText.length > 0) initialNodes.push({ type: "text", text: splitAfterText });
        splitParentList.splice(splitTextIdx, 1, ...initialNodes);

        // Region at the split point. A split inside a change region must not
        // nest the inserted block: same-author inserted merges; otherwise the
        // block lands as an adjacent flat block and the region reopens after
        // it if it continues (dev log 90 §5.4).
        splitRegion = traversalRegion(splitSegment.state);
        splitRegionInfo = splitRegion !== "current"
          ? openRegionInfo(splitParentList, splitTextIdx)
          : null;
        splitRegionContinues = splitAfterText.length > 0;
        if (!splitRegionContinues && splitRegion !== "current") {
          let dDepth = splitRegion === "deleted" ? 1 : 0;
          let iDepth = splitRegion === "inserted" ? 1 : 0;
          for (let j = splitTextIdx + 1; j < splitParentList.length; j++) {
            const c = splitParentList[j];
            if (c.type === "text") {
              splitRegionContinues = true;
              break;
            }
            if (c.type === "property" && (isChangeOpener(c.key) || isChangeCloser(c.key))) {
              const dd = advanceChangeDepths(c.key, dDepth, iDepth);
              dDepth = dd.deletedDepth;
              iDepth = dd.insertedDepth;
              if (dDepth === 0 && iDepth === 0) break;
            }
          }
        }
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
            if (splitRegion === "inserted" && splitRegionInfo && splitRegionInfo.author === insertAuthorId) {
              // Same author — merge into the pending insertion (bare text, no
              // new markers, never nested). Bump the region's timestamp.
              splitParentList.splice(insertIdx, 0, copy);
              splitInsertOffset++;
              const newTs = parseInt(insertTs, 10) || 0;
              const oldTs = parseInt(splitRegionInfo.ts, 10) || 0;
              if (newTs > oldTs) splitRegionInfo.node.value = `${insertAuthorId} ${insertTs}`;
            } else {
              // New tracked block. When the split point is inside a change
              // region (different author, or deleted), the block must NOT
              // nest: emit it as an adjacent flat block and REOPEN the region
              // after it if it continues, so the surrounding region text stays
              // in its region (dev log 90 §5.4).
              const wrapped = wrapInChangeMarkers([copy], "inserted", insertAuthorId, insertTs);
              splitParentList.splice(insertIdx, 0, ...wrapped);
              splitInsertOffset += wrapped.length;
              if (splitRegion !== "current" && splitRegionContinues && splitRegionInfo) {
                splitParentList.splice(insertIdx + wrapped.length, 0, {
                  type: "property",
                  key: splitRegionInfo.key,
                  value: `${splitRegionInfo.author} ${splitRegionInfo.ts}`,
                });
                splitInsertOffset++;
              }
            }
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

    await commitMutation(filePath, ast, insertPreSnapshots, statePaths);
    await refreshPostStep(filePath, refreshMode);
    const changes = nodes.map(n => ({ position, label: nodeLabel(n), text: briefText(n) }));
    printJson({ matched_nodes: insertedCount, inserted_blocks: insertedBlocks, changes });
    return;
  }

  if (command === "undo") {
    const substring: string | undefined = restArgs.length > 0 ? restArgs.join(" ") : undefined;

    // --- Snapshot-based undo (no selector; dev log 102) ---
    // Restore from a pre-mutation snapshot when no selector is given. The
    // snapshot is keyed to the whole file's content hash, so no selector is
    // needed — the restore reverts the last (tracked or plain) mutation as one
    // unit. The snapshot is consumed on restore: undo-after-undo is
    // UNDO_STALE, not a redo (dev log 78 — bounded, predictable undo).
    if (selector === undefined) {
      let snapshotFailure = "No snapshot found for the current file content.";
      const currentHash = await hashFile(filePath);
      const snapshot = await loadSnapshot(currentHash, statePaths);
      if (snapshot) {
        let restoredCount = 0;
        let missingCount = 0;
        const restoredLabels: string[] = [];
        // Header path captured pre-restore: the header entry is labeled
        // "header" by PATH, not content (test fixtures can have an empty
        // header with no \textclass). Restores never move the header, so its
        // index path is stable throughout the loop (dev log 102 D1b).
        const headerNode = getHeader(ast);
        const headerPath = headerNode ? findNodePath(ast.children, headerNode) : null;
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
          // count or trip the structure-changed warning. The header stays in
          // BOTH the count and the labels when it does change (dev log 102).
          if (before !== JSON.stringify(entry.children)) {
            restoredCount++;
            const isHeader = headerPath !== null &&
              entry.path.length === headerPath.length &&
              entry.path.every((v, i) => v === headerPath[i]);
            restoredLabels.push(
              isHeader ? "header" : `restored [${entry.path.join(".")}] "${briefChildrenText(entry.children)}"`
            );
          }
        }
        if (restoredCount > 0) {
          if (missingCount > 0) {
            pushWarning(
              `Restored ${restoredCount} of ${snapshot.entries.length} snapshot entries — ` +
              `the document structure changed since the snapshot. Verify with 'lq read ${filePath}'.`
            );
          }
          const newFileText = serialize(ast);
          await Deno.writeTextFile(filePath, newFileText);
          try { await setCachedAst(await hashText(newFileText), ast, statePaths); } catch { /* non-fatal */ }
          await clearSnapshot(currentHash, statePaths);
          await refreshPostStep(filePath, refreshMode);
          printJson({
            undone_changes: restoredCount,
            changes: restoredLabels.map(l => ({ label: l })),
            method: "snapshot",
          });
          return;
        }
        snapshotFailure = "A snapshot was found, but the document structure changed before it could be restored.";
      }

      // A clean file with no snapshot is stale. Whole-document scan (snapshot
      // is whole-file; there is no selector to scope it). Checked before
      // resolving the author ID so it stays untouched (no spurious \author
      // entry). No fallback into replay — modes stay strict (DL94).
      const hasAnyTracked = hasTrackedChanges(ast.children);
      if (!hasAnyTracked) {
        printError("UNDO_STALE", "Nothing to undo. No snapshot found and no tracked changes to revert.");
      }

      printError(
        "UNDO_SNAPSHOT_UNAVAILABLE",
        `${snapshotFailure} Verify that the file was not changed externally, or provide a selector to replay tracked changes: ` +
        `'lq undo <file> <selector> [<substring>]'. Replay does not restore a paired set edit as one unit.`,
      );
    }

    // --- Replay-based undo (selector required; dev log 102) ---
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
    // True when a change region contains the target substring but belongs to
    // another author (or has an unparseable author id). Distinguishes "the
    // change is already gone" from "the change is there, just not yours" so
    // the replay warning picks the honest message (test_report_38 F5).
    let anyContainsSubstringOtherAuthor = false;
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

          // Author id is the marker value's first token ("<authorId> <ts>").
          // 0 only arises from non-numeric/missing prefixes and never equals a
          // real undo author (resolveAuthorId returns >= 1 on well-formed
          // documents), so the previous null-vs-0 handling is preserved.
          const changeAuthorId = parseChangeMarker(child.value).authorId;
          const enclosedText = textParts.join("");

          // Check if this change matches our target AND belongs to this author
          const shouldUndo = substring === undefined || enclosedText.includes(substring);
          const willUndo = changeAuthorId === undoAuthorId && shouldUndo;
          if (substring !== undefined && shouldUndo && !willUndo) {
            // Region contains the substring but isn't undoable by this author
            // — flag it so the no-op warning below can name the real cause.
            anyContainsSubstringOtherAuthor = true;
          }

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
      if (anyContainsSubstringOtherAuthor) {
        // The change is present — it just isn't this author's. "May have
        // already been undone" would send the user chasing a ghost
        // (test_report_38 F5). Never suggest changing the author config —
        // an agent must not do that without explicit approval (dev log 102 D4).
        pushWarning(
          `A tracked change matching '${substring}' exists but belongs to another author. ` +
          `Undo only reverts author '${authorName}'.`
        );
      } else {
        pushWarning(`No tracked change matching '${substring}' found. It may have already been undone. To revert the last undo, run 'lq undo ${filePath}'.`);
      }
    }
    if (substring === undefined && undoneCount === 0) {
      // Distinguish "the matched nodes have no tracked changes at all" from
      // "tracked changes exist but none are the current author's" (dev log
      // 102 D4). Never suggest changing the author config (D4).
      const hasAnyTracked = nodes.some(n => n.type === "block" && hasTrackedChanges(n.children));
      if (!hasAnyTracked) {
        pushWarning("No tracked changes found in the matched nodes.");
      } else {
        pushWarning(
          `Tracked changes exist in the matched nodes but none belong to author '${authorName}'.`
        );
      }
    }
    // Blast radius for replay: the warning is only seen after the replay has
    // already reverted, so it suggests the recovery path (dev log 102 D1).
    if (undoneCount > 0 && nodes.length > 1) {
      pushWarning(
        `Selector matches ${nodes.length} nodes. ` +
        `The current author's changes in all of them were reverted. ` +
        `To undo this undo, run 'lq undo ${filePath}'.`
      );
    }
    // Write file and save snapshot so the replay itself can be undone
    if (undoneCount > 0) {
      await commitMutation(filePath, ast, replayPreSnapshots, statePaths);
      await refreshPostStep(filePath, refreshMode);
    }
    printJson({ undone_changes: undoneCount, changes, method: "replay" });
    return;
  }

  printError("UNKNOWN_COMMAND", `Unknown command: ${command}. Run 'lq --help' to list available commands.`);
}
