/**
 * Minimal LyX `.bind` loader for Live Info shortcut resolution.
 * Maps LFUN name → portable key sequences (system cua.bind + \bind_file includes).
 */
import * as path from "@std/path";

/** LFUN (first word of Info arg) → display strings like `Ctrl+M`. */
export type ShortcutMap = Map<string, string[]>;

const BIND_LINE = /^\\bind\s+"([^"]+)"\s*"([^"]*)"/;
const BIND_FILE = /^\\bind_file\s+(\S+)/;

/** `C-m` / `M-m m` → `Ctrl+M` / `Alt+M M` (CUA-ish, not Qt locale). */
export function formatBindSequence(portable: string): string {
  return portable
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(formatBindKey)
    .join(" ");
}

function formatBindKey(portable: string): string {
  const mods: string[] = [];
  let key = "";
  for (const part of portable.split("-")) {
    if (part === "C") mods.push("Ctrl");
    else if (part === "M") mods.push("Alt");
    else if (part === "S") mods.push("Shift");
    else if (part === "~S") continue;
    else if (part) {
      key = part.length === 1 ? part.toUpperCase() : part.replace(/^KP_/, "");
    }
  }
  return [...mods, key].filter(Boolean).join("+");
}

/**
 * Load shortcut map from `{bindDir}/cua.bind` (and recursive `\bind_file`).
 * Missing dir/file → empty map (caller keeps LFUN fallback).
 */
export async function loadShortcutMap(bindDir: string | undefined): Promise<ShortcutMap> {
  const out: ShortcutMap = new Map();
  if (!bindDir) return out;
  try {
    const st = await Deno.stat(bindDir);
    if (!st.isDirectory) return out;
  } catch {
    return out;
  }
  await loadBindFile(path.join(bindDir, "cua.bind"), bindDir, out, new Set());
  return out;
}

/**
 * System cua.bind first, then user-dir bind (DL130 J5).
 * User keys are prepended so `shortcut` (singular) prefers the user binding.
 */
export async function loadShortcutMapMerged(
  systemBindDir: string | undefined,
  userBindDir: string | undefined,
): Promise<ShortcutMap> {
  const map = await loadShortcutMap(systemBindDir);
  if (!userBindDir || userBindDir === systemBindDir) return map;
  const user = await loadShortcutMap(userBindDir);
  for (const [lfun, keys] of user) {
    const existing = map.get(lfun) ?? [];
    const merged: string[] = [];
    for (const k of keys) if (!merged.includes(k)) merged.push(k);
    for (const k of existing) if (!merged.includes(k)) merged.push(k);
    map.set(lfun, merged);
  }
  return map;
}

/** Bind dir next to layouts: `…/Resources/layouts` → `…/Resources/bind`. */
export function bindDirFromLayouts(layoutsDir: string | undefined): string | undefined {
  if (!layoutsDir) return undefined;
  return path.resolve(layoutsDir, "..", "bind");
}

/** Images dir next to layouts: `…/Resources/layouts` → `…/Resources/images`. */
export function imagesDirFromLayouts(layoutsDir: string | undefined): string | undefined {
  if (!layoutsDir) return undefined;
  return path.resolve(layoutsDir, "..", "images");
}

async function loadBindFile(
  filePath: string,
  bindDir: string,
  out: ShortcutMap,
  visited: Set<string>,
): Promise<void> {
  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  let text: string;
  try {
    text = await Deno.readTextFile(resolved);
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    if (hash > 0) line = line.slice(0, hash).trim();
    const file = line.match(BIND_FILE);
    if (file) {
      const name = file[1]!.replace(/^"|"$/g, "");
      await loadBindFile(path.join(bindDir, name), bindDir, out, visited);
      continue;
    }
    const bind = line.match(BIND_LINE);
    if (!bind) continue;
    const keys = formatBindSequence(bind[1]!);
    const lfunFull = bind[2]!.trim();
    if (!keys || !lfunFull) continue;
    const lfun = lfunFull.split(/\s+/)[0]!;
    const list = out.get(lfun) ?? [];
    if (!list.includes(keys)) list.push(keys);
    out.set(lfun, list);
    if (lfunFull !== lfun) {
      const exact = out.get(lfunFull) ?? [];
      if (!exact.includes(keys)) exact.push(keys);
      out.set(lfunFull, exact);
    }
  }
}

/** Resolve Info shortcut arg to a display string, or undefined to keep LFUN fallback. */
export function lookupShortcut(
  map: ShortcutMap | null | undefined,
  arg: string,
  all: boolean,
): string | undefined {
  if (!map || map.size === 0 || !arg) return undefined;
  const keys = map.get(arg) ?? map.get(arg.split(/\s+/)[0]!);
  if (!keys || keys.length === 0) return undefined;
  return all ? keys.join(", ") : keys[0];
}
