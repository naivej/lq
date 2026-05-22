import { parse } from "./parser.ts";
import { serialize } from "./serializer.ts";
import { query } from "./query.ts";
import { getSchemaForClass } from "./schema.ts";
import { parseBibtex, Citation } from "./bib.ts";
import { parseArgs } from "@std/cli/parse-args";
import { Node, BlockNode, DocumentNode } from "./ast.ts";
import { validateInsetType } from "./inset_registry.ts";
import { sendLyxCommands, checkLyxServerAvailable } from "./lyxserver.ts";
import * as path from "@std/path";

const HELP_TEXTS: Record<string, string> = {
  global: `lq - A CLI Tool for Editing LyX Files

Usage:
  lq <command> [options] [arguments]

Commands:
  read      Output matching nodes and text content as JSON.
  dump      Output the full CST as a massive JSON document.
  bib       Extract available citation keys from linked bibliography files.
  set       Overwrite the targeted nodes with new text content.
  delete    Safely delete the targeted nodes from the LyX file.
  schema    Return a list of all semantically valid layouts.
  insert    Insert new blocks or properties before/after/prepend/append.
  init      Initialize the user configuration file.

Run 'lq <command> --help' for more information on a specific command.`,

  read: `lq read - Output matching nodes and text content as JSON.

Usage:
  lq read <file> <selector>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector (e.g., 'layout[Section]', ':contains("text")'). Note: :contains is exact and case-sensitive.`,

  dump: `lq dump - Output the full CST as a massive JSON document.

Usage:
  lq dump <file>

Arguments:
  <file>      The path to the .lyx file.`,

  bib: `lq bib - Search and extract citation keys from linked .bib bibliography files.

Usage:
  lq bib <file> [options]

Arguments:
  <file>      The path to the .lyx file.

Note:
  Only .bib files are supported. References to other file types (e.g. .bst style files,
  embedded bibliographies) are silently skipped.

Options:
  --search <term>           Filter citations by a case-insensitive substring match across
                            key, author, title, and year. Multiple words are AND'd — all
                            must match. Without this flag, all citations are returned.`,

  set: `lq set - Overwrite the targeted nodes with new text content.

Usage:
  lq set <file> <selector> <new text>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector targeting nodes to mutate.
  <new text>  The new text content to apply to the matched nodes.

Note:
  Track-changes behavior is governed by the config file. Use 'lq init --track-changes on'
  to enable tracked changes for all mutations.

Warning:
  The 'set' command applies to ALL matched nodes. If a targeted block has nested children (like an inset), they will be destroyed and replaced entirely by the new text.`,

  delete: `lq delete - Safely delete the targeted nodes from the LyX file.

Usage:
  lq delete <file> <selector>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector targeting nodes to delete.

Note:
  Track-changes behavior is governed by the config file. Use 'lq init --track-changes on'
  to wrap deletions in \\change_deleted markers instead of removing nodes.`,

  init: `lq init - Initialize or view the user configuration file.

Usage:
  lq init              Print current configuration (if config exists).
  lq init [options]    Update configuration with the given options.

Options:
  --layouts-dir <path>    Explicitly set the LyX layouts directory.
                          If omitted, lq will auto-detect the highest installed version.
  --refresh <mode>        Configure automatic refresh after mutations (requires LyXServer).
                          Modes:
                            none        No refresh (default). LyX detects changes via polling.
                            reload      Reload buffer after lq writes. Fast, but discards
                                        unsaved in-LyX edits.
                            save-reload Save unsaved edits first, then reload. Preserves
                                        everything. Requires LyX to be running.
  --track-changes <on|off> Enable or disable tracked changes for all mutation commands.
                            When on: set wraps old text in \\change_deleted + new in \\change_inserted,
                                      delete wraps removed nodes in \\change_deleted,
                                      insert wraps new content in \\change_inserted.`,

  schema: `lq schema - Return a list of all semantically valid layouts.

Usage:
  lq schema <file> [options]

Arguments:
  <file>      The path to the .lyx file.

Options:
  --layouts-dir <path>  Path to the directory containing .layout files.
                        Defaults to checking ~/.lq/config.json, then the default LyX install path.`,

  insert: `lq insert - Insert new blocks or properties relative to a selector.

Usage:
  lq insert <file> <selector> <position> [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector targeting a reference node.
  <position>  Where to insert ('before', 'after', 'prepend', 'append').

Options:
  --layout <name>              Name of the layout to insert (e.g., 'Standard').
  --text <content>             Text content for the new layout or text node.
  --raw <string>               Raw LyX string to parse and insert.
  --raw-file <path>            Read raw LyX string from a file (avoids shell escaping issues).

Note:
  Track-changes behavior is governed by the config file. Use 'lq init --track-changes on'
  to wrap inserted content in \\change_inserted markers.

Warning:
  If the selector matches multiple nodes, the insertion will be duplicated for EVERY matched node.`
};

// Helper to load user config
interface UserConfig {
  layoutsDir?: string;
  refresh?: "none" | "reload" | "save-reload";
  trackChanges?: boolean;
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

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function printError(code: string, message: string) {
  printJson({ status: "error", code, message });
  Deno.exit(1);
}

function printWarning(message: string) {
  // Output to stderr so it doesn't interfere with JSON stdout.
  // Format as JSON for consistency with the tool's contract.
  console.error(JSON.stringify({ status: "warning", message }));
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


// Ensure author ID is generated correctly if missing
function ensureAuthorInHeader(ast: DocumentNode, authorId: number = 1, authorName: string = "lq-agent"): void {
  const docBlock = ast.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "document") as BlockNode;
  if (!docBlock) return;
  const header = docBlock.children.find((c: Node) => c.type === "block" && (c as BlockNode).tag === "header") as BlockNode;
  if (!header) return;
  
  const hasAuthor = header.children.some((c: Node) => c.type === "property" && c.key === "author" && c.value?.includes(authorId.toString()));
  if (!hasAuthor) {
    header.children.push({ type: "property", key: "author", value: `${authorId} "${authorName}"` });
  }
}

function wrapWithTracking(nodes: Node[], type: "inserted" | "deleted"): Node[] {
  const ts = Math.floor(Date.now() / 1000).toString();
  const authorId = 1; // Testing sequential ID instead of random large number
  
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
          b.children = wrapWithTracking(b.children, type);
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

// --- LyXServer refresh helpers ---

/**
 * Pre-step for save-reload: saves the user's unsaved LyX edits to disk
 * BEFORE lq reads and mutates the file. Must succeed or the mutation is aborted.
 * Returns true if the pre-step succeeded (or mode doesn't need a pre-step).
 */
export async function refreshPreStep(filePath: string, mode: "none" | "reload" | "save-reload"): Promise<boolean> {
  if (mode !== "save-reload") return true;

  const absPath = path.resolve(filePath);
  const ok = await sendLyxCommands([
    `buffer-switch ${absPath}`,
    "buffer-write",
  ]);

  return ok;
}

/**
 * Post-step: reloads the buffer in LyX after lq has written to disk.
 * Best-effort — failure is silent.
 */
async function refreshPostStep(filePath: string, mode: "none" | "reload" | "save-reload"): Promise<void> {
  if (mode === "none") return;

  const absPath = path.resolve(filePath);
  await sendLyxCommands([
    `buffer-switch ${absPath}`,
    "buffer-reload",
  ]);
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
    const flags = parseArgs(cleanArgs.slice(1), { string: ["layouts-dir", "refresh", "track-changes"] });
    const hasFlags = flags["layouts-dir"] !== undefined ||
                     flags["refresh"] !== undefined ||
                     flags["track-changes"] !== undefined;
    let dir = flags["layouts-dir"];
    const refresh = flags["refresh"] as string | undefined;
    const trackChangesFlag = flags["track-changes"] as string | undefined;

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
        config.trackChanges = false;
      }
    }

    // If refresh is enabled, verify LyXServer is reachable
    if (config.refresh !== "none") {
      const available = checkLyxServerAvailable();
      if (!available) {
        printWarning(
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

  const [command, filePath, selector, ...restArgs] = cleanArgs;
  
  if (command !== "init" && !filePath.endsWith(".lyx")) {
    printError("INVALID_EXTENSION", "Target file must have a .lyx extension.");
    return;
  }

  // --- Refresh pre-step (save-reload only) ---
  // Must happen BEFORE reading the file, so buffer-write saves the user's
  // latest edits to disk before lq reads the stale version.
  const mutationCommands = ["set", "delete", "insert"];
  let refreshMode: "none" | "reload" | "save-reload" = "none";
  let trackChanges = false;
  if (mutationCommands.includes(command)) {
    const config = await loadUserConfig();
    if (config.refresh) refreshMode = config.refresh;
    trackChanges = config.trackChanges === true;
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
  try {
    ast = parse(text);
  } catch (e: Error | unknown) {
    printError("PARSE_ERROR", (e as Error).message);
    return;
  }

  if (command === "dump") {
    printJson({ status: "success", data: ast });
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
    const schemaArgs = selector ? [selector, ...restArgs] : restArgs;
    const flags = parseArgs(schemaArgs, {
      string: ["layouts-dir"],
    });

    let layoutsDir = flags["layouts-dir"];

    if (!layoutsDir) {
      const config = await loadUserConfig();
      if (config.layoutsDir) {
        layoutsDir = config.layoutsDir;
      } else {
        printError("NO_CONFIG", "No layouts directory configured. Run 'lq init' to auto-detect and save your LyX layouts path.");
        return;
      }
    } else {
      try {
        const stat = await Deno.stat(layoutsDir);
        if (!stat.isDirectory) throw new Error();
      } catch (_e) {
        printError("INVALID_DIR", `The provided --layouts-dir '${layoutsDir}' does not exist or is not a directory.`);
        return;
      }
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
      printError("SCHEMA_ERROR", (e as Error).message);
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

  if (command === "read") {
    printJson({ status: "success", data: nodes, count: nodes.length });
    return;
  }

  // Common guard: Prevent mutating core document structures directly
  const unsafeNodes = nodes.filter(n => (n.type === "block" && (n.tag === "body" || n.tag === "header" || n.tag === "document")));
  if (unsafeNodes.length > 0 && ["set", "delete", "insert"].includes(command)) {
    printError("INVALID_CONTEXT", "Cannot mutate core document structures ('document', 'body', 'header') directly. Target specific layouts or properties instead.");
    return;
  }

  // Mutation commands below
  
  if (command === "set") {
    const flags = parseArgs(restArgs, { string: [] });
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to set.");
      return;
    }
    
    if (flags._.length === 0) {
      printError("MISSING_ARGS", "A new text value is required for the 'set' command.");
      return;
    }
    
    const newValue = flags._.join(" ");
    
    for (const node of nodes) {
      if (node.type === "property") {
        node.value = newValue;
      } else if (node.type === "block") {
        if (trackChanges) {
          node.children = [
            ...wrapWithTracking(node.children, "deleted"),
            ...wrapWithTracking([{ type: "text", text: newValue }], "inserted")
          ];
        } else {
          node.children = [{ type: "text", text: newValue }];
        }
      } else if (node.type === "text") {
        node.text = newValue;
      }
    }
    
    if (trackChanges) ensureAuthorInHeader(ast);
    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    await refreshPostStep(filePath, refreshMode);
    printJson({ status: "success", modified_nodes: nodes.length });
    return;
  }

  if (command === "delete") {
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to delete.");
      return;
    }

    if (trackChanges) {
      // Track-changes mode: wrap matched nodes in change_deleted markers instead of removing them
      ensureAuthorInHeader(ast);
      const nodesToMark = new Set(nodes);

      const markAsDeleted = (children: Node[]) => {
        for (let i = children.length - 1; i >= 0; i--) {
          const child = children[i];
          if (nodesToMark.has(child)) {
            if (child.type === "block") {
              child.children = wrapWithTracking(child.children, "deleted");
            } else if (child.type === "text" || child.type === "property") {
              const wrapped = wrapWithTracking([child], "deleted");
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
      await refreshPostStep(filePath, refreshMode);
      printJson({ status: "success", tracked_deleted_nodes: nodes.length });
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
    await refreshPostStep(filePath, refreshMode);
    printJson({ status: "success", deleted_nodes: nodes.length });
    return;
  }

  if (command === "insert") {
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to insert around.");
      return;
    }

    const position = restArgs[0];
    if (!["before", "after", "prepend", "append"].includes(position)) {
      printError("INVALID_POSITION", "Position must be 'before', 'after', 'prepend', or 'append'.");
      return;
    }

    // Parse flags
    const flags = parseArgs(restArgs.slice(1), {
      string: ["layout", "text", "raw", "raw-file"],
    });

    let flagCount = 0;
    if (flags.raw) flagCount++;
    if (flags["raw-file"]) flagCount++;
    if (flags.layout) flagCount++;
    if (flags.text && !flags.layout) flagCount++;

    if (flagCount > 1) {
      printError("FLAG_CONFLICT", "You cannot mix --raw/--raw-file with --layout or isolated --text. Please provide exactly one generation strategy.");
      return;
    }

    if (flags.raw && flags["raw-file"]) {
      printError("FLAG_CONFLICT", "You cannot provide both --raw and --raw-file. Choose one.");
      return;
    }

    // Resolve --raw-file by reading the file content into flags.raw
    let rawContent = flags.raw;
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
          printError("INVALID_RAW", "The --raw string did not parse into any valid LyX blocks or properties. (e.g. expected \\begin_layout, got plain text)");
          return;
        }

        // Validate inset types in raw content (warning only)
        const warnings = validateRawInsets(tempAst);
        for (const w of warnings) {
          printWarning(w);
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
    } else if (flags.text) {
      printError("TEXT_ONLY_INSERT", "Cannot insert bare text. You must wrap text in a layout using the --layout flag (e.g., --layout 'Standard' --text 'foo').");
      return;
    }

    if (newNodesToInsert.length === 0) {
      printError("MISSING_CONTENT", "You must provide --layout, --text, or --raw to insert.");
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

      if (position === "prepend" || position === "append") {
        if (targetNode.type !== "block") {
          printError("INVALID_TARGET", "Cannot prepend or append to a non-block node.");
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

      // Per-node validation for each block in the payload
      for (const nodeToInsert of newNodesToInsert) {
        if (trackChanges) {
          ensureAuthorInHeader(ast);
          if (nodeToInsert.type === "block") {
            nodeToInsert.children = wrapWithTracking(nodeToInsert.children, "inserted");
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
          } else if (block.tag === "inset" && block.args) {
            const isDocumentContext = targetParentBlock && targetParentBlock.tag === "body";
            if (isDocumentContext) {
              printError("INVALID_CONTEXT", `Cannot insert inset directly into the document body. Insets must be inside a layout (e.g. Standard).`);
              continue;
            }

            // Quick check if the inset starts with any of our valid insets
            const blockArgs = block.args;
            const isValidInset = schema.insets.some(i => blockArgs === i || blockArgs.startsWith(i + " "));
            if (!isValidInset) {
              printError("INVALID_INSET", `Inset type '${block.args}' is not permitted. Valid insets are: ${schema.insets.join(", ")}`);
              continue;
            }
          }
        } else if (nodeToInsert.type === "property") {
          if (!schema.inlineProperties.includes(nodeToInsert.key)) {
            printError("INVALID_PROPERTY", `Property '${nodeToInsert.key}' is not permitted. Valid inline properties are: ${schema.inlineProperties.join(", ")}`);
            continue;
          }
        }
      }

        const isLayoutBlock = nodeToInsert.type === "block" && nodeToInsert.tag === "layout";
        const spacer: Node = { type: "text", text: "" };
        const copy = structuredClone(nodeToInsert);

        if (position === "prepend" || position === "append") {
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
              if (isLayoutBlock) ctx.list.splice(ctx.index, 0, copy, spacer);
              else ctx.list.splice(ctx.index, 0, copy);
            } else {
              if (isLayoutBlock) ctx.list.splice(ctx.index + 1, 0, spacer, copy);
              else ctx.list.splice(ctx.index + 1, 0, copy);
            }
          }
        }
        insertedBlocks++;
      }
      insertedCount++;
    }

    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    await refreshPostStep(filePath, refreshMode);
    printJson({ status: "success", inserted_nodes: insertedCount, inserted_blocks: insertedBlocks });
    return;
  }

  printError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}
