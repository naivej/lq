import * as path from "@std/path";
import { KNOWN_INSET_TYPES } from "./inset_registry.ts";

export interface HeadingLevel {
  layout: string;
  tocLevel: number;
}

export interface LyxSchema {
  textclass: string;
  documentLayouts: string[];
  insetLayouts: string[];
  insets: string[];
  inlineProperties: string[];
  headingHierarchy: HeadingLevel[];
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
): Promise<{
  allowed: Set<string>;
  disallowed: Set<string>;
  headingLevels: Map<string, number>;
  customInsets: Set<string>;
  disallowedInsets: Set<string>;
}> {
  const allowed = new Set<string>();
  const disallowed = new Set<string>();
  const headingLevels = new Map<string, number>();
  const customInsets = new Set<string>();
  const disallowedInsets = new Set<string>();

  if (visited.has(filePath)) {
    return { allowed, disallowed, headingLevels, customInsets, disallowedInsets };
  }
  visited.add(filePath);

  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch (_e) {
    return { allowed, disallowed, headingLevels, customInsets, disallowedInsets };
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
      const styleName = matchStyle[1].trim();
      allowed.add(styleName);
      // Parse body of Style block for TocLevel
      let tocLevel: number | undefined;
      while (++i < lines.length) {
        const bodyLine = lines[i].trim();
        if (bodyLine === "End") break;
        if (bodyLine.startsWith("#")) continue;
        const tocMatch = bodyLine.match(/^TocLevel\s+(-?\d+)$/);
        if (tocMatch) tocLevel = parseInt(tocMatch[1]);
      }
      if (tocLevel !== undefined) {
        headingLevels.set(styleName, tocLevel);
      }
      continue;
    }

    const matchNoStyle = line.match(/^NoStyle\s+(.+)$/);
    if (matchNoStyle) {
      disallowed.add(matchNoStyle[1].trim());
      continue;
    }

    const matchInsetLayout = line.match(/^InsetLayout\s+(.+)$/);
    if (matchInsetLayout) {
      customInsets.add(matchInsetLayout[1].trim().replace(/^"|"$/g, ""));
      // Skip body of InsetLayout block
      while (++i < lines.length) {
        if (lines[i].trim() === "End") break;
      }
      continue;
    }

    const matchNoInsetLayout = line.match(/^NoInsetLayout\s+(.+)$/);
    if (matchNoInsetLayout) {
      disallowedInsets.add(matchNoInsetLayout[1].trim());
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
        for (const [k, v] of sub.headingLevels) headingLevels.set(k, v);
        for (const s of sub.customInsets) customInsets.add(s);
        for (const s of sub.disallowedInsets) disallowedInsets.add(s);
      }
    }
  }

  return { allowed, disallowed, headingLevels, customInsets, disallowedInsets };
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

  // Merge hardcoded insets with per-class custom InsetLayout declarations
  const allInsets = new Set(INSETS);
  for (const s of result.customInsets) {
    allInsets.add(s);
  }
  for (const s of result.disallowedInsets) {
    allInsets.delete(s);
  }

  // Build heading hierarchy sorted by TocLevel, excluding disallowed styles
  const headingHierarchy: HeadingLevel[] = [];
  for (const [layout, tocLevel] of result.headingLevels) {
    if (!result.disallowed.has(layout)) {
      headingHierarchy.push({ layout, tocLevel });
    }
  }
  headingHierarchy.sort((a, b) => a.tocLevel - b.tocLevel);

  return {
    textclass,
    documentLayouts: Array.from(result.allowed).sort(),
    insetLayouts: INSET_LAYOUTS,
    insets: Array.from(allInsets).sort(),
    inlineProperties: INLINE_PROPERTIES,
    headingHierarchy,
  };
}
