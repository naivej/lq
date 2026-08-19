import * as path from "@std/path";
import {
  KNOWN_INSET_TYPES,
  INLINE_PROPERTIES,
  INSET_CATALOG,
  type InsetMeta,
} from "./registry.ts";

export interface HeadingLevel {
  layout: string;
  tocLevel: number;
}

export interface LyxSchema {
  textclass: string;
  documentLayouts: string[];
  insetLayouts: string[];
  insets: InsetMeta[];
  inlineProperties: readonly string[];
  headingHierarchy: HeadingLevel[];
}

export const INSET_LAYOUTS = ["Plain Layout"];

export { INLINE_PROPERTIES, INSET_CATALOG };

/** Renderer-private Style fields. Not part of `lq schema` JSON. */
export interface LayoutHtml {
  htmlTag?: string;
  htmlItem?: string;
  htmlTitle?: boolean;
  category?: string;
  tocLevel?: number;
}

interface RawStyle extends LayoutHtml {
  copyStyle?: string;
}

interface ParsedLayout {
  allowed: Set<string>;
  disallowed: Set<string>;
  headingLevels: Map<string, number>;
  customInsets: Set<string>;
  disallowedInsets: Set<string>;
  styles: Map<string, RawStyle>;
}

/**
 * Parses a .layout or .inc file and extracts declared Styles.
 * Recursively processes `Input` directives.
 */
function emptyParsed(): ParsedLayout {
  return {
    allowed: new Set(),
    disallowed: new Set(),
    headingLevels: new Map(),
    customInsets: new Set(),
    disallowedInsets: new Set(),
    styles: new Map(),
  };
}

async function parseLayoutFile(
  filePath: string,
  searchPaths: string[],
  visited = new Set<string>()
): Promise<ParsedLayout> {
  const allowed = new Set<string>();
  const disallowed = new Set<string>();
  const headingLevels = new Map<string, number>();
  const customInsets = new Set<string>();
  const disallowedInsets = new Set<string>();
  const styles = new Map<string, RawStyle>();

  if (visited.has(filePath)) {
    return emptyParsed();
  }
  visited.add(filePath);

  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch (_e) {
    return emptyParsed();
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
      const raw = parseStyleBody(lines, i);
      i = raw.endIndex;
      styles.set(styleName, mergeStyle(styles.get(styleName), raw.style));
      const tocLevel = styles.get(styleName)?.tocLevel;
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
        for (const [k, v] of sub.styles) styles.set(k, mergeStyle(styles.get(k), v));
      }
    }
  }

  return { allowed, disallowed, headingLevels, customInsets, disallowedInsets, styles };
}

function mergeStyle(prev: RawStyle | undefined, next: RawStyle): RawStyle {
  if (!prev) return next;
  const out: RawStyle = { ...prev };
  if (next.htmlTag !== undefined) out.htmlTag = next.htmlTag;
  if (next.htmlItem !== undefined) out.htmlItem = next.htmlItem;
  if (next.htmlTitle !== undefined) out.htmlTitle = next.htmlTitle;
  if (next.category !== undefined) out.category = next.category;
  if (next.tocLevel !== undefined) out.tocLevel = next.tocLevel;
  if (next.copyStyle !== undefined) out.copyStyle = next.copyStyle;
  return out;
}

function parseStyleBody(lines: string[], start: number): { style: RawStyle; endIndex: number } {
  const style: RawStyle = {};
  let i = start;
  while (++i < lines.length) {
    let bodyLine = lines[i].trim();
    if (bodyLine === "End") break;
    if (bodyLine.startsWith("#") || bodyLine === "") continue;
    if (bodyLine === "Font" || bodyLine === "LabelFont") {
      while (++i < lines.length && lines[i].trim() !== "EndFont") { /* skip */ }
      continue;
    }
    if (bodyLine === "Preamble") {
      while (++i < lines.length && lines[i].trim() !== "EndPreamble") { /* skip */ }
      continue;
    }
    if (bodyLine === "HTMLStyle") {
      while (++i < lines.length && lines[i].trim() !== "EndHTMLStyle") { /* skip */ }
      continue;
    }
    if (/^Argument\b/.test(bodyLine)) {
      while (++i < lines.length && lines[i].trim() !== "EndArgument") { /* skip */ }
      continue;
    }
    const commentIdx = bodyLine.indexOf("#");
    if (commentIdx !== -1) bodyLine = bodyLine.substring(0, commentIdx).trim();
    const htmlTag = bodyLine.match(/^HTMLTag\s+(\S+)/i);
    if (htmlTag) {
      style.htmlTag = htmlTag[1];
      continue;
    }
    const htmlItem = bodyLine.match(/^HTMLItem\s+(\S+)/i);
    if (htmlItem) {
      style.htmlItem = htmlItem[1];
      continue;
    }
    const htmlTitle = bodyLine.match(/^HTMLTitle\s+(\S+)/i);
    if (htmlTitle) {
      style.htmlTitle = htmlTitle[1].toLowerCase() === "true";
      continue;
    }
    const category = bodyLine.match(/^Category\s+(\S+)/i);
    if (category) {
      style.category = category[1];
      continue;
    }
    const toc = bodyLine.match(/^TocLevel\s+(-?\d+)$/i);
    if (toc) {
      style.tocLevel = parseInt(toc[1]);
      continue;
    }
    const copy = bodyLine.match(/^CopyStyle\s+(.+)$/i);
    if (copy) style.copyStyle = copy[1].trim();
  }
  return { style, endIndex: i };
}

function resolveStyle(name: string, raw: Map<string, RawStyle>, seen: Set<string>): LayoutHtml {
  const own = raw.get(name);
  if (!own) return {};
  if (!own.copyStyle || seen.has(name)) {
    const { copyStyle: _c, ...rest } = own;
    return rest;
  }
  seen.add(name);
  const base = resolveStyle(own.copyStyle, raw, seen);
  const { copyStyle: _c, ...rest } = own;
  const out: LayoutHtml = { ...base };
  if (rest.htmlTag !== undefined) out.htmlTag = rest.htmlTag;
  if (rest.htmlItem !== undefined) out.htmlItem = rest.htmlItem;
  if (rest.htmlTitle !== undefined) out.htmlTitle = rest.htmlTitle;
  if (rest.category !== undefined) out.category = rest.category;
  if (rest.tocLevel !== undefined) out.tocLevel = rest.tocLevel;
  return out;
}

/**
 * Renderer-private HTML keys for a textclass. Missing layout file → empty map.
 * Not returned by `lq schema`.
 */
export async function getLayoutHtmlForClass(
  textclass: string,
  layoutsDir: string,
  modules: readonly string[] = [],
): Promise<Map<string, LayoutHtml>> {
  const mainLayoutPath = path.join(layoutsDir, `${textclass}.layout`);
  try {
    const stat = await Deno.stat(mainLayoutPath);
    if (!stat.isFile) return new Map();
  } catch {
    return new Map();
  }
  const searchPaths = [layoutsDir];
  const visited = new Set<string>();
  const parsed = await parseLayoutFile(mainLayoutPath, searchPaths, visited);
  for (const name of modules) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const modulePath = path.join(layoutsDir, `${trimmed}.module`);
    const sub = await parseLayoutFile(modulePath, searchPaths, visited);
    for (const s of sub.allowed) parsed.allowed.add(s);
    for (const s of sub.disallowed) parsed.disallowed.add(s);
    for (const [k, v] of sub.headingLevels) parsed.headingLevels.set(k, v);
    for (const s of sub.customInsets) parsed.customInsets.add(s);
    for (const s of sub.disallowedInsets) parsed.disallowedInsets.add(s);
    for (const [k, v] of sub.styles) parsed.styles.set(k, mergeStyle(parsed.styles.get(k), v));
  }
  const out = new Map<string, LayoutHtml>();
  for (const name of parsed.styles.keys()) {
    if (parsed.disallowed.has(name)) continue;
    out.set(name, resolveStyle(name, parsed.styles, new Set()));
  }
  return out;
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
  const allInsets = new Set(KNOWN_INSET_TYPES);
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

  const catalogByName = new Map(INSET_CATALOG.map((e) => [e.name, e]));
  const insets: InsetMeta[] = Array.from(allInsets).sort().map((name) => {
    const builtin = catalogByName.get(name);
    if (builtin) return { name: builtin.name, kind: builtin.kind, subtypes: [...builtin.subtypes] };
    return { name, kind: "collapsible", subtypes: [] };
  });

  return {
    textclass,
    documentLayouts: Array.from(result.allowed).sort(),
    insetLayouts: INSET_LAYOUTS,
    insets,
    inlineProperties: INLINE_PROPERTIES,
    headingHierarchy,
  };
}

/** Scan installed LyX versions for the layouts directory. */
export async function getDefaultLayoutsDir(): Promise<string> {
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

    candidates.sort((a, b) => {
      for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
        const va = a.version[i] ?? 0;
        const vb = b.version[i] ?? 0;
        if (va !== vb) return vb - va;
      }
      return 0;
    });

    if (candidates.length > 0) return candidates[0].dir;

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
    const candidates: { version: number[]; dir: string }[] = [];
    try {
      for await (const entry of Deno.readDir("/Applications")) {
        const m = entry.name.match(/^LyX(\d+(?:\.\d+)*)\.app$/);
        if (m && entry.isDirectory) {
          const layoutsDir = path.join("/Applications", entry.name, "Contents", "Resources", "layouts");
          try {
            const stat = await Deno.stat(layoutsDir);
            if (stat.isDirectory) {
              const version = m[1].split(".").map(Number);
              candidates.push({ version, dir: layoutsDir });
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* Applications not readable */ }

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
