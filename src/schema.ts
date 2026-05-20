import * as path from "@std/path";
import { KNOWN_INSET_TYPES } from "./inset_registry.ts";

export interface LyxSchema {
  textclass: string;
  documentLayouts: string[];
  insetLayouts: string[];
  insets: string[];
  inlineProperties: string[];
}

export const INSET_LAYOUTS = ["Plain Layout"];

export const INSETS: string[] = [...KNOWN_INSET_TYPES];

export const INLINE_PROPERTIES = [
  "change_inserted", "change_deleted", "change_unchanged"
];

/**
 * Parses a .layout or .inc file and extracts declared Styles.
 * Recursively processes `Input` directives.
 */
async function parseLayoutFile(
  filePath: string,
  searchPaths: string[],
  visited = new Set<string>()
): Promise<{ allowed: Set<string>; disallowed: Set<string> }> {
  const allowed = new Set<string>();
  const disallowed = new Set<string>();

  if (visited.has(filePath)) {
    return { allowed, disallowed };
  }
  visited.add(filePath);

  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch (_e) {
    // If we can't read an included file, just return what we have
    return { allowed, disallowed };
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith("#") || line === "") continue;

    // Remove inline comments
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      line = line.substring(0, commentIdx).trim();
    }

    const matchStyle = line.match(/^Style\s+(.+)$/);
    if (matchStyle) {
      allowed.add(matchStyle[1].trim());
      continue;
    }

    const matchNoStyle = line.match(/^NoStyle\s+(.+)$/);
    if (matchNoStyle) {
      disallowed.add(matchNoStyle[1].trim());
      continue;
    }

    const matchInput = line.match(/^Input\s+(.+)$/);
    if (matchInput) {
      let incFile = matchInput[1].trim();
      if (!incFile.endsWith(".inc") && !incFile.endsWith(".layout")) {
        incFile += ".inc"; // Usually inputs are .inc
      }

      // Try to find the included file in the search paths
      let foundPath = "";
      for (const searchPath of searchPaths) {
        const fullPath = path.join(searchPath, incFile);
        try {
          const stat = await Deno.stat(fullPath);
          if (stat.isFile) {
            foundPath = fullPath;
            break;
          }
        } catch (_) {
          // Ignore
        }
      }

      if (foundPath) {
        const sub = await parseLayoutFile(foundPath, searchPaths, visited);
        for (const s of sub.allowed) allowed.add(s);
        for (const s of sub.disallowed) disallowed.add(s);
      }
    }
  }

  return { allowed, disallowed };
}

export async function getSchemaForClass(textclass: string, layoutsDir: string): Promise<LyxSchema> {
  const mainLayoutPath = path.join(layoutsDir, `${textclass}.layout`);
  
  try {
    const stat = await Deno.stat(mainLayoutPath);
    if (!stat.isFile) throw new Error("Not a file");
  } catch (_e) {
    throw new Error(`Layout file not found for textclass '${textclass}' at ${mainLayoutPath}`);
  }

  // The search paths for Input files are usually the layouts directory itself
  const searchPaths = [layoutsDir];
  
  const result = await parseLayoutFile(mainLayoutPath, searchPaths);
  
  // Remove disallowed styles from the final list
  for (const s of result.disallowed) {
    result.allowed.delete(s);
  }

  return {
    textclass,
    documentLayouts: Array.from(result.allowed).sort(),
    insetLayouts: INSET_LAYOUTS,
    insets: INSETS,
    inlineProperties: INLINE_PROPERTIES
  };
}
