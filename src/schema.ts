import * as path from "@std/path";
import type { BlockNode, DocumentNode, Node } from "./ast.ts";
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

/** Renderer-private Style / InsetLayout Font fields for Live. */
export interface LayoutFont {
  color?: string;
  shape?: string;
  series?: string;
  family?: string;
  size?: string;
}

/** Renderer-private Style / InsetLayout fields. Not part of `lq schema` JSON. */
export interface LayoutHtml {
  htmlTag?: string;
  htmlClass?: string;
  htmlItem?: string;
  htmlTitle?: boolean;
  category?: string;
  tocLevel?: number;
  labelType?: string;
  labelString?: string;
  labelCounter?: string;
  font?: LayoutFont;
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
  visited = new Set<string>(),
): Promise<ParsedLayout> {
  if (visited.has(filePath)) return emptyParsed();
  visited.add(filePath);
  let text: string;
  try {
    text = await Deno.readTextFile(filePath);
  } catch {
    return emptyParsed();
  }
  return parseLayoutText(text, searchPaths, visited);
}

async function parseLayoutText(
  text: string,
  searchPaths: string[],
  visited = new Set<string>(),
): Promise<ParsedLayout> {
  const allowed = new Set<string>();
  const disallowed = new Set<string>();
  const headingLevels = new Map<string, number>();
  const customInsets = new Set<string>();
  const disallowedInsets = new Set<string>();
  const styles = new Map<string, RawStyle>();

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
      const styleName = unquoteLayoutName(matchStyle[1].trim());
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
      disallowed.add(unquoteLayoutName(matchNoStyle[1].trim()));
      continue;
    }

    const matchInsetLayout = line.match(/^InsetLayout\s+(.+)$/);
    if (matchInsetLayout) {
      const insetName = unquoteLayoutName(matchInsetLayout[1].trim());
      customInsets.add(insetName);
      // Parse HTMLTag/HTMLClass/Font like Style (renderer-private).
      const raw = parseStyleBody(lines, i);
      i = raw.endIndex;
      styles.set(insetName, mergeStyle(styles.get(insetName), raw.style));
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

/** `Style "Left Header"` / `CopyStyle "Left Header"` → `Left Header`. */
function unquoteLayoutName(name: string): string {
  const t = name.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

const HTML_OVERLAY_KEYS = [
  "htmlTag", "htmlClass", "htmlItem", "htmlTitle", "category", "tocLevel",
  "labelType", "labelString", "labelCounter",
] as const;

/** Copy defined layout-HTML fields from `next` onto `out` (DL132 F3). */
function overlayHtmlFields<T extends object>(out: T, next: object): T {
  for (const key of HTML_OVERLAY_KEYS) {
    const value = (next as Record<string, unknown>)[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function mergeStyle(prev: RawStyle | undefined, next: RawStyle): RawStyle {
  if (!prev) return next;
  const out: RawStyle = { ...prev };
  if (next.copyStyle !== undefined) out.copyStyle = next.copyStyle;
  if (next.font !== undefined) out.font = mergeFont(prev.font, next.font);
  return overlayHtmlFields(out, next) as RawStyle;
}

function mergeFont(prev: LayoutFont | undefined, next: LayoutFont | undefined): LayoutFont | undefined {
  if (!next) return prev;
  if (!prev) return next;
  return { ...prev, ...next };
}

function parseStyleBody(lines: string[], start: number): { style: RawStyle; endIndex: number } {
  const style: RawStyle = {};
  let i = start;
  while (++i < lines.length) {
    let bodyLine = lines[i].trim();
    if (bodyLine === "End") break;
    if (bodyLine.startsWith("#") || bodyLine === "") continue;
    if (bodyLine === "Font") {
      const font = parseFontBody(lines, i);
      i = font.endIndex;
      style.font = mergeFont(style.font, font.font);
      continue;
    }
    if (bodyLine === "LabelFont") {
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
    const htmlClass = bodyLine.match(/^HTMLClass\s+(.+)$/i);
    if (htmlClass) {
      style.htmlClass = htmlClass[1].replace(/^"|"$/g, "").trim();
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
    if (copy) {
      style.copyStyle = unquoteLayoutName(copy[1].trim());
      continue;
    }
    const labelType = bodyLine.match(/^LabelType\s+(\S+)/i);
    if (labelType) {
      style.labelType = labelType[1];
      continue;
    }
    const labelString = bodyLine.match(/^LabelString\s+(.+)$/i);
    if (labelString) {
      style.labelString = labelString[1].replace(/^"|"$/g, "").trim();
      continue;
    }
    const labelCounter = bodyLine.match(/^LabelCounter\s+(\S+)/i);
    if (labelCounter) {
      style.labelCounter = labelCounter[1];
      continue;
    }
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
  if (rest.font !== undefined) out.font = mergeFont(base.font, rest.font);
  return overlayHtmlFields(out, rest) as LayoutHtml;
}

function parseFontBody(lines: string[], start: number): { font: LayoutFont; endIndex: number } {
  const font: LayoutFont = {};
  let i = start;
  while (++i < lines.length) {
    let bodyLine = lines[i].trim();
    if (bodyLine === "EndFont") break;
    if (bodyLine.startsWith("#") || bodyLine === "") continue;
    const commentIdx = bodyLine.indexOf("#");
    if (commentIdx !== -1) bodyLine = bodyLine.substring(0, commentIdx).trim();
    const color = bodyLine.match(/^Color\s+(\S+)/i);
    if (color) {
      font.color = color[1];
      continue;
    }
    const shape = bodyLine.match(/^Shape\s+(\S+)/i);
    if (shape) {
      font.shape = shape[1];
      continue;
    }
    const series = bodyLine.match(/^Series\s+(\S+)/i);
    if (series) {
      font.series = series[1];
      continue;
    }
    const family = bodyLine.match(/^Family\s+(\S+)/i);
    if (family) {
      font.family = family[1];
      continue;
    }
    const size = bodyLine.match(/^Size\s+(\S+)/i);
    if (size) {
      font.size = size[1];
      continue;
    }
  }
  return { font, endIndex: i };
}

export interface LocalLayoutTexts {
  forced?: string;
  normal?: string;
}

function layoutBlockToText(block: BlockNode): string {
  const lines: string[] = [];
  for (const c of block.children) {
    if (c.type === "text") lines.push(c.text);
    else if (c.type === "property") {
      lines.push(c.value != null && c.value !== "" ? `\\${c.key} ${c.value}` : `\\${c.key}`);
    }
  }
  return lines.join("\n");
}

/** textclass, modules, and LocalLayout bodies from a parsed document. */
export function extractDocumentLayoutContext(ast: DocumentNode): {
  textclass?: string;
  modules: string[];
  local: LocalLayoutTexts;
} {
  let textclass: string | undefined;
  const modules: string[] = [];
  const local: LocalLayoutTexts = {};

  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "property" && n.key === "textclass" && n.value) {
        if (!textclass) textclass = n.value;
        continue;
      }
      if (n.type !== "block") continue;
      if (n.tag === "modules") {
        for (const c of n.children) {
          if (c.type === "text") {
            const name = c.text.trim();
            if (name) modules.push(name);
          }
        }
        continue;
      }
      if (n.tag === "forced_local_layout" && local.forced === undefined) {
        local.forced = layoutBlockToText(n);
        continue;
      }
      if (n.tag === "local_layout" && local.normal === undefined) {
        local.normal = layoutBlockToText(n);
        continue;
      }
      if (n.tag === "header" || n.tag === "document") walk(n.children);
    }
  };
  walk(ast.children);
  return { textclass, modules, local };
}

/** Optional roots for LyX-like layout search (overlay → user-dir → system). */
export interface LayoutSearchOptions {
  /** lq config `layoutsDir` — user-tier overlay, not a system replacement. */
  overlayLayoutsDir?: string;
  /** Override auto-detected install `Resources/layouts` (tests). */
  systemLayoutsDir?: string;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).isFile;
  } catch {
    return false;
  }
}

/**
 * LyX user-dir layouts folder aligned with the install that owns `systemLayoutsDir`
 * when possible (e.g. Windows `%APPDATA%\\LyX2.5\\layouts`).
 */
export async function getLyxUserLayoutsDir(
  systemLayoutsDir?: string,
): Promise<string | undefined> {
  const family = systemLayoutsDir
    ? versionFamilyFromSystemLayouts(systemLayoutsDir)
    : undefined;
  // family "25" → dotted "2.5"
  const dotted = family && family.length >= 2
    ? `${family[0]}.${family.slice(1)}`
    : undefined;

  if (Deno.build.os === "windows") {
    const roaming = Deno.env.get("APPDATA");
    if (!roaming) return undefined;
    const candidates: string[] = [];
    if (family) candidates.push(path.join(roaming, `LyX${family}`, "layouts"));
    try {
      for await (const entry of Deno.readDir(roaming)) {
        if (!entry.isDirectory) continue;
        if (/^LyX\d+$/.test(entry.name)) {
          candidates.push(path.join(roaming, entry.name, "layouts"));
        }
      }
    } catch { /* ignore */ }
    for (const c of candidates) {
      if (await isDir(c)) return c;
    }
    return undefined;
  }

  if (Deno.build.os === "darwin") {
    const home = Deno.env.get("HOME");
    if (!home) return undefined;
    const library = path.join(home, "Library", "Application Support");
    const candidates: string[] = [];
    if (dotted) candidates.push(path.join(library, `LyX${dotted}`, "layouts"));
    if (family) candidates.push(path.join(library, `LyX${family}`, "layouts"));
    candidates.push(path.join(home, ".lyx", "layouts"));
    for (const c of candidates) {
      if (await isDir(c)) return c;
    }
    return undefined;
  }

  const home = Deno.env.get("HOME");
  if (!home) return undefined;
  const candidates = [path.join(home, ".lyx", "layouts")];
  if (dotted) candidates.unshift(path.join(home, `.lyx${dotted}`, "layouts"));
  for (const c of candidates) {
    if (await isDir(c)) return c;
  }
  return undefined;
}

function versionFamilyFromSystemLayouts(systemLayoutsDir: string): string | undefined {
  // .../LyX 2.5/Resources/layouts or .../LyX2.5.app/.../layouts
  const norm = systemLayoutsDir.replace(/\\/g, "/");
  const win = norm.match(/LyX\s+(\d+)\.(\d+)/i);
  if (win) return `${win[1]}${win[2]}`;
  const app = norm.match(/LyX(\d+)\.(\d+)/i);
  if (app) return `${app[1]}${app[2]}`;
  return undefined;
}

/**
 * Search path order (LyX-like): config overlay, LyX user-dir, system install.
 * Missing dirs are omitted.
 */
export async function resolveLayoutSearchPaths(
  opts: LayoutSearchOptions = {},
): Promise<{ system: string; user?: string; overlay?: string; searchPaths: string[] }> {
  const system = opts.systemLayoutsDir && await isDir(opts.systemLayoutsDir)
    ? opts.systemLayoutsDir
    : await getDefaultLayoutsDir();
  const user = await getLyxUserLayoutsDir(system);
  const overlay = opts.overlayLayoutsDir && await isDir(opts.overlayLayoutsDir)
    ? opts.overlayLayoutsDir
    : undefined;
  const searchPaths: string[] = [];
  if (overlay) searchPaths.push(overlay);
  if (user && user !== overlay && user !== system) searchPaths.push(user);
  if (!searchPaths.includes(system)) searchPaths.push(system);
  return { system, user, overlay, searchPaths };
}

/** First hit for `fileName` in ordered search paths (overlay → user → system). */
export async function findLayoutFile(
  fileName: string,
  searchPaths: readonly string[],
): Promise<string | undefined> {
  for (const dir of searchPaths) {
    const full = path.join(dir, fileName);
    if (await isFile(full)) return full;
  }
  return undefined;
}

function mergeParsed(into: ParsedLayout, sub: ParsedLayout): void {
  for (const s of sub.allowed) into.allowed.add(s);
  for (const s of sub.disallowed) into.disallowed.add(s);
  for (const [k, v] of sub.headingLevels) into.headingLevels.set(k, v);
  for (const s of sub.customInsets) into.customInsets.add(s);
  for (const s of sub.disallowedInsets) into.disallowedInsets.add(s);
  for (const [k, v] of sub.styles) into.styles.set(k, mergeStyle(into.styles.get(k), v));
}

function asSearchPaths(layoutsDir: string | readonly string[]): string[] {
  return typeof layoutsDir === "string" ? [layoutsDir] : [...layoutsDir];
}

async function loadParsedForClass(
  textclass: string,
  layoutsDir: string | readonly string[],
  modules: readonly string[] = [],
  local?: LocalLayoutTexts,
): Promise<ParsedLayout | null> {
  const searchPaths = asSearchPaths(layoutsDir);
  const mainLayoutPath = await findLayoutFile(`${textclass}.layout`, searchPaths);
  if (!mainLayoutPath) return null;
  const visited = new Set<string>();
  const parsed = await parseLayoutFile(mainLayoutPath, searchPaths, visited);
  for (const name of modules) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const modulePath = await findLayoutFile(`${trimmed}.module`, searchPaths);
    if (!modulePath) continue;
    mergeParsed(parsed, await parseLayoutFile(modulePath, searchPaths, visited));
  }
  if (local?.forced?.trim()) {
    mergeParsed(parsed, await parseLayoutText(local.forced, searchPaths, visited));
  }
  if (local?.normal?.trim()) {
    mergeParsed(parsed, await parseLayoutText(local.normal, searchPaths, visited));
  }
  return parsed;
}

/**
 * Renderer-private HTML keys for a textclass. Missing layout file → empty map.
 * `layoutsDir` may be one directory (tests / legacy) or an ordered search-path list.
 * Not returned by `lq schema`.
 */
export async function getLayoutHtmlForClass(
  textclass: string,
  layoutsDir: string | readonly string[],
  modules: readonly string[] = [],
  local?: LocalLayoutTexts,
): Promise<Map<string, LayoutHtml>> {
  const parsed = await loadParsedForClass(textclass, layoutsDir, modules, local);
  if (!parsed) return new Map();
  const out = new Map<string, LayoutHtml>();
  for (const name of parsed.styles.keys()) {
    if (parsed.disallowed.has(name)) continue;
    out.set(name, resolveStyle(name, parsed.styles, new Set()));
  }
  return out;
}

export async function getSchemaForClass(
  textclass: string,
  layoutsDir: string | readonly string[],
  modules: readonly string[] = [],
  local?: LocalLayoutTexts,
): Promise<LyxSchema> {
  const parsed = await loadParsedForClass(textclass, layoutsDir, modules, local);
  if (!parsed) {
    const hint = typeof layoutsDir === "string" ? layoutsDir : layoutsDir.join(", ");
    throw new Error(`Layout file not found for textclass '${textclass}' in: ${hint}`);
  }

  for (const s of parsed.disallowed) {
    parsed.allowed.delete(s);
  }

  const allInsets = new Set(KNOWN_INSET_TYPES);
  for (const s of parsed.customInsets) allInsets.add(s);
  for (const s of parsed.disallowedInsets) allInsets.delete(s);

  const headingHierarchy: HeadingLevel[] = [];
  for (const [layout, tocLevel] of parsed.headingLevels) {
    if (!parsed.disallowed.has(layout)) {
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
    documentLayouts: Array.from(parsed.allowed).sort(),
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
