import { parse } from "./parser.ts";
import { serialize } from "./serializer.ts";
import { query } from "./query.ts";
import { getSchemaForClass } from "./schema.ts";
import { parseBibtex, Citation } from "./bib.ts";
import { parseArgs } from "@std/cli/parse-args";
import { Node, BlockNode, DocumentNode } from "./ast.ts";
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

  bib: `lq bib - Extract available citation keys from linked bibliography files.

Usage:
  lq bib <file>

Arguments:
  <file>      The path to the .lyx file.`,

  set: `lq set - Overwrite the targeted nodes with new text content.

Usage:
  lq set <file> <selector> <new text> [options]

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector targeting nodes to mutate.
  <new text>  The new text content to apply to the matched nodes.

Options:
  --track-changes <inserted|deleted>  Automatically register author and wrap text with LyX change-tracking markers.

Warning:
  The 'set' command applies to ALL matched nodes. If a targeted block has nested children (like an inset), they will be destroyed and replaced entirely by the new text.`,

  delete: `lq delete - Safely delete the targeted nodes from the LyX file.

Usage:
  lq delete <file> <selector>

Arguments:
  <file>      The path to the .lyx file.
  <selector>  A CSS-like selector targeting nodes to delete.`,

  init: `lq init - Initialize the user configuration file.

Usage:
  lq init [options]

Options:
  --layouts-dir <path>  Explicitly set the LyX layouts directory.
                        If omitted, lq will attempt to auto-detect it.`,

  schema: `lq schema - Return a list of all semantically valid layouts.

Usage:
  lq schema <file> [options]

Arguments:
  <file>      The path to the .lyx file.

Options:
  --layouts-dir <path>  Path to the directory containing .layout files.
                        Defaults to checking ~/.lq/config.json, then a hardcoded path.`,

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
  --track-changes <inserted|deleted> Automatically register author and wrap text with tracking markers.
  --validate-layouts-dir <dir> Path to layouts directory for strict validation.
                               Defaults to ~/.lq/config.json.

Warning:
  If the selector matches multiple nodes, the insertion will be duplicated for EVERY matched node.`
};

// Helper to load user config
async function loadUserConfig(): Promise<{ layoutsDir?: string }> {
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

// Helper to get default layouts dir based on OS
function getDefaultLayoutsDir(): string {
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA");
    if (localAppData) {
      // Common path for LyX 2.3 or 2.4+
      return path.join(localAppData, "Programs", "LyX 2.5", "Resources", "layouts");
    }
    return "C:\\Program Files\\LyX 2.5\\Resources\\layouts";
  } else if (Deno.build.os === "darwin") {
    return "/Applications/LyX.app/Contents/Resources/layouts";
  } else {
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
  for (const n of nodes) {
    if (n.type === "text") {
      result.push({ type: "property", key: `change_${type}`, value: `${authorId} ${ts}` });
      result.push(n);
      result.push({ type: "property", key: "change_unchanged" });
    } else if (n.type === "block") {
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
  return result;
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
    const flags = parseArgs(cleanArgs.slice(1), { string: ["layouts-dir"] });
    let dir = flags["layouts-dir"];
    
    if (!dir) {
      dir = getDefaultLayoutsDir();
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

    try {
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(configPath, JSON.stringify({ layoutsDir: dir }, null, 2));
      printJson({ status: "success", message: `Configuration saved to ${configPath}`, layoutsDir: dir });
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
    const bibtexNodes = query(ast, "inset[CommandInset bibtex]");
    if (bibtexNodes.length === 0) {
      printError("NO_BIBLIO", "No bibliography files found in the document.");
      return;
    }

    const citations: Citation[] = [];
    const lyxDir = path.dirname(path.resolve(filePath));

    for (const node of bibtexNodes) {
      if (node.type === "block") {
        const bibFilesLine = node.children.find(c => c.type === "text" && c.text.startsWith("bibfiles "));
        if (bibFilesLine && bibFilesLine.type === "text") {
          const value = bibFilesLine.text.replace(/^bibfiles\s+/, "");
          const files = value.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
          
          for (let bibFile of files) {
            if (!bibFile.toLowerCase().endsWith(".bib")) {
              bibFile += ".bib";
            }
            
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
    
    // Deduplicate citations by key
    const uniqueCitations = Array.from(new Map(citations.map(c => [c.key, c])).values());
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
        layoutsDir = getDefaultLayoutsDir();
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
    printJson({ status: "success", data: nodes });
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
    const flags = parseArgs(restArgs, { string: ["track-changes"] });
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to set.");
      return;
    }
    
    if (flags["track-changes"] !== undefined && flags["track-changes"] !== "inserted" && flags["track-changes"] !== "deleted") {
      printError("INVALID_FLAG", `track-changes must be 'inserted' or 'deleted', got: ${flags["track-changes"]}`);
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
        if (flags["track-changes"] === "deleted") {
          node.children = [
            ...wrapWithTracking(node.children, "deleted"),
            ...wrapWithTracking([{ type: "text", text: newValue }], "inserted")
          ];
        } else if (flags["track-changes"] === "inserted") {
          node.children = wrapWithTracking([{ type: "text", text: newValue }], "inserted");
        } else {
          // Clear children and set as a single text node
          node.children = [{ type: "text", text: newValue }];
        }
      } else if (node.type === "text") {
        node.text = newValue;
      }
    }
    
    if (flags["track-changes"]) ensureAuthorInHeader(ast);
    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    printJson({ status: "success", modified_nodes: nodes.length });
    return;
  }

  if (command === "delete") {
    if (nodes.length === 0) {
      printError("NO_MATCH", "Selector matched no nodes to delete.");
      return;
    }

    const nodesToDelete = new Set(nodes);
    
    // Recursive function to filter out children
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
      string: ["layout", "text", "raw", "track-changes"],
    });

    if (flags["track-changes"] !== undefined && flags["track-changes"] !== "inserted" && flags["track-changes"] !== "deleted") {
      printError("INVALID_FLAG", `track-changes must be 'inserted' or 'deleted', got: ${flags["track-changes"]}`);
      return;
    }

    let flagCount = 0;
    if (flags.raw) flagCount++;
    if (flags.layout) flagCount++;
    if (flags.text && !flags.layout) flagCount++;

    if (flagCount > 1) {
      printError("FLAG_CONFLICT", "You cannot mix --raw with --layout or isolated --text. Please provide exactly one generation strategy.");
      return;
    }

    let newNodeToInsert: Node | null = null;

    if (flags.raw) {
      // Parse the raw string as a document and grab its children
      try {
        const tempAst = parse(flags.raw, true);
        if (tempAst.children.length > 0) {
          const validNode = tempAst.children.find(c => c.type === "block" || c.type === "property");
          if (!validNode) {
            printError("INVALID_RAW", "The --raw string did not parse into any valid LyX blocks or properties. (e.g. expected \\begin_layout, got plain text)");
            return;
          }
          newNodeToInsert = validNode;
        } else {
          printError("INVALID_RAW", "The --raw string produced an empty CST.");
          return;
        }
      } catch (e: Error | unknown) {
        printError("PARSE_ERROR", `Failed to parse raw LyX string: ${(e as Error).message}`);
        return;
      }
    } else if (flags.layout) {
      // Optional: Validating the layout against the schema
      let validateDir = flags["validate-layouts-dir"] ? String(flags["validate-layouts-dir"]) : undefined;
      
      if (!validateDir) {
        const config = await loadUserConfig();
        if (config.layoutsDir) validateDir = config.layoutsDir;
      }

      if (validateDir) {
         const textclassNode = query(ast, "textclass")[0];
         if (textclassNode && textclassNode.type === "property" && textclassNode.value) {
            try {
               const schema = await getSchemaForClass(textclassNode.value, validateDir);
               // Simple validation for document layouts
               if (!schema.documentLayouts.includes(flags.layout) && !schema.insetLayouts.includes(flags.layout)) {
                 printError("INVALID_LAYOUT", `The layout '${flags.layout}' is not permitted in textclass '${textclassNode.value}'. Allowed document layouts: ${schema.documentLayouts.join(", ")}`);
                 return;
               }
            } catch (_e) {
               // Ignore if we can't find the layout file, just proceed
            }
         }
      }

      newNodeToInsert = {
        type: "block",
        tag: "layout",
        args: flags.layout,
        isBeginVariant: true,
        children: flags.text ? [{ type: "text", text: flags.text }] : [],
      };
      
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

    if (!newNodeToInsert) {
      printError("MISSING_CONTENT", "You must provide --layout, --text, or --raw to insert.");
      return;
    }

    let insertedCount = 0;

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

    // Pre-fetch schema and config once (avoid per-node I/O and AST traversal)
    let validateDirForStrict: string | undefined = flags["validate-layouts-dir"] ? String(flags["validate-layouts-dir"]) : undefined;
    if (!validateDirForStrict) {
      const config = await loadUserConfig();
      if (config.layoutsDir) validateDirForStrict = config.layoutsDir;
      else validateDirForStrict = getDefaultLayoutsDir();
    }

    let schema: Awaited<ReturnType<typeof getSchemaForClass>> | null = null;
    let textclassValue: string | null = null;
    if (validateDirForStrict) {
      const textclassNode = query(ast, "textclass")[0];
      if (textclassNode && textclassNode.type === "property" && textclassNode.value) {
        textclassValue = textclassNode.value;
        try {
          schema = await getSchemaForClass(textclassValue, validateDirForStrict);
        } catch (_e) {
          // Ignore schema fetching errors
        }
      }
    }

    const isLayoutBlock = newNodeToInsert.type === "block" && newNodeToInsert.tag === "layout";

    for (const targetNode of nodes) {
      let targetParentBlock: BlockNode | null = null;
      let ctx: { list: Node[]; index: number; parentBlock: BlockNode | null } | null = null;

      if (flags["track-changes"]) {
        ensureAuthorInHeader(ast);
        if (newNodeToInsert.type === "block") {
          newNodeToInsert.children = wrapWithTracking(newNodeToInsert.children, flags["track-changes"] as "inserted" | "deleted");
        } else { // Since newNodeToInsert can only be block or property
           printError("TRACKING_ERROR", "Cannot track bare text nodes. Wrap in a layout block.");
           return;
        }
      }

      if (position === "prepend" || position === "append") {
        if (targetNode.type !== "block") {
          printError("INVALID_TARGET", "Cannot prepend or append to a non-block node.");
          continue;
        }
        targetParentBlock = targetNode as BlockNode;
      } else {
        ctx = findNodeContext(ast.children, targetNode);
        if (!ctx) continue;
        targetParentBlock = ctx.parentBlock;
      }

      // Per-node validation using pre-fetched schema
      if (schema) {
        if (newNodeToInsert.type === "block") {
          const block = newNodeToInsert as BlockNode;
          if (block.tag === "layout" && block.args) {
            const isInsetContext = targetParentBlock && targetParentBlock.tag === "inset";

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
        } else if (newNodeToInsert.type === "property") {
          if (!schema.inlineProperties.includes(newNodeToInsert.key)) {
            printError("INVALID_PROPERTY", `Property '${newNodeToInsert.key}' is not permitted. Valid inline properties are: ${schema.inlineProperties.join(", ")}`);
            continue;
          }
        }
      }

      const spacer: Node = { type: "text", text: "" };
      const copy = structuredClone(newNodeToInsert);

      if (position === "prepend" || position === "append") {
        if (!targetParentBlock) continue;
        if (position === "prepend") {
          if (isLayoutBlock) targetParentBlock.children.unshift(copy, spacer);
          else targetParentBlock.children.unshift(copy);
        } else {
          if (isLayoutBlock) targetParentBlock.children.push(spacer, copy);
          else targetParentBlock.children.push(copy);
        }
        insertedCount++;
      } else {
        // ctx already computed above
        if (ctx) {
          if (position === "before") {
            if (isLayoutBlock) ctx.list.splice(ctx.index, 0, copy, spacer);
            else ctx.list.splice(ctx.index, 0, copy);
          } else {
            if (isLayoutBlock) ctx.list.splice(ctx.index + 1, 0, spacer, copy);
            else ctx.list.splice(ctx.index + 1, 0, copy);
          }
          insertedCount++;
        }
      }
    }

    const newFileText = serialize(ast);
    await Deno.writeTextFile(filePath, newFileText);
    printJson({ status: "success", inserted_nodes: insertedCount });
    return;
  }

  printError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}
