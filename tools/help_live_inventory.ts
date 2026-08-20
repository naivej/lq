/**
 * Body-only Live construct inventory for Help/*.lyx (and optional extra files).
 * Skips header and preamble entirely — those are not Live-renderer targets.
 *
 * Usage (from lq/):
 *   deno run -A tools/help_live_inventory.ts
 *   deno run -A tools/help_live_inventory.ts --json
 */
import { basename, join } from "@std/path";
import { parse } from "../src/parser.ts";
import type { BlockNode, DocumentNode, Node } from "../src/ast.ts";

const HELP_DIR = join(import.meta.dirname!, "../tests/fixtures/Help");
const EXTRA = [
  join(import.meta.dirname!, "../tests/fixtures/my_template.lyx"),
];

/** Help files that are assets / non-reader menus — still inventoriable but flagged. */
const NON_MENU = new Set([
  "DummyDocument1.lyx",
  "DummyDocument2.lyx",
  "LFUNs.lyx",
  "Shortcuts.lyx",
  "LaTeXConfig.lyx",
]);

function insetKey(args: string): string {
  const a = args.trim();
  if (!a) return "inset";
  if (a.startsWith("FormulaMacro")) return "FormulaMacro";
  if (a.startsWith("Formula")) {
    return a.startsWith("Formula $") || a === "Formula $" ? "Formula (inline)" : "Formula (display)";
  }
  if (a === "ERT" || a.startsWith("ERT ")) return "ERT";
  if (a === "Tabular" || a.startsWith("Tabular ")) return "Tabular";
  if (a === "Graphics" || a.startsWith("Graphics ")) return "Graphics";
  if (a === "External" || a.startsWith("External ")) return "External";
  if (a === "listings" || a.startsWith("listings ")) return "listings";
  if (a === "Preview" || a.startsWith("Preview ")) return "Preview";
  if (a === "Foot" || a.startsWith("Foot ")) return "Foot";
  if (a === "Marginal" || a.startsWith("Marginal ")) return "Marginal";
  if (a === "Separator" || a.startsWith("Separator ")) return "Separator";
  if (a === "SpecialChar" || a.startsWith("SpecialChar ")) return "SpecialChar";
  if (a === "Text" || a.startsWith("Text ")) return "Text";
  if (a === "Include" || a.startsWith("Include ")) return "Include";
  if (a.startsWith("CommandInset ")) {
    const rest = a.slice("CommandInset ".length).trim();
    const sub = rest.split(/\s+/)[0] ?? rest;
    return `CommandInset ${sub}`;
  }
  if (a.startsWith("Float ")) return `Float ${a.slice(6).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Wrap ")) return `Wrap ${a.slice(5).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Note ")) return `Note ${a.slice(5).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Box ")) return `Box ${a.slice(4).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Caption ")) return `Caption ${a.slice(8).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Quotes ")) return `Quotes ${a.slice(7).trim().split(/\s+/)[0]}`;
  if (a.startsWith("space ")) return "space";
  if (a.startsWith("VSpace ")) return "VSpace";
  if (a.startsWith("Newline ")) return "Newline";
  if (a.startsWith("Newpage ")) return "Newpage";
  if (a.startsWith("Info ")) return `Info ${a.slice(5).trim().split(/\s+/)[0]}`;
  if (a.startsWith("script ")) {
    return a.includes("superscript") ? "script superscript" : a.includes("subscript") ? "script subscript" : "script";
  }
  if (a.startsWith("Flex ")) return a.replace(/\s+/g, " ").trim();
  if (a.startsWith("Branch ")) return `Branch ${a.slice(7).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Phantom")) return a.split(/\s+/).slice(0, 2).join(" ");
  if (a.startsWith("IndexMacro")) return "IndexMacro";
  if (a.startsWith("Index ")) return "Index";
  if (a === "Index") return "Index";
  if (a.startsWith("Nomenclature")) return "Nomenclature";
  if (a.startsWith("Argument ")) return `Argument ${a.slice(9).trim().split(/\s+/)[0]}`;
  if (a.startsWith("Line ")) return "Line";
  const first = a.split(/\s+/)[0]!;
  return first;
}

function walkBody(nodes: Node[], layouts: Map<string, number>, insets: Map<string, number>): void {
  for (const n of nodes) {
    if (n.type !== "block") continue;
    // Never enter preamble (lives under header; belt-and-suspenders if nested oddly).
    if (n.tag === "preamble" || n.tag === "header") continue;
    if (n.tag === "layout") {
      const name = (n.args ?? "").trim() || "(empty)";
      layouts.set(name, (layouts.get(name) ?? 0) + 1);
      walkBody(n.children, layouts, insets);
      continue;
    }
    if (n.tag === "inset") {
      const key = insetKey(n.args ?? "");
      insets.set(key, (insets.get(key) ?? 0) + 1);
      // Do not walk into Formula/ERT opaque payloads as layouts.
      if (key === "Formula (inline)" || key === "Formula (display)" || key === "FormulaMacro" || key === "ERT") {
        continue;
      }
      walkBody(n.children, layouts, insets);
      continue;
    }
    walkBody(n.children, layouts, insets);
  }
}

function inventoryFile(path: string): {
  file: string;
  role: "menu" | "non-menu" | "template";
  layouts: Record<string, number>;
  insets: Record<string, number>;
} {
  const text = Deno.readTextFileSync(path);
  const doc = parse(text) as DocumentNode;
  const document = doc.children.find((n): n is BlockNode => n.type === "block" && n.tag === "document");
  const body = document?.children.find((n): n is BlockNode => n.type === "block" && n.tag === "body");
  const layouts = new Map<string, number>();
  const insets = new Map<string, number>();
  if (body) walkBody(body.children, layouts, insets);
  const name = basename(path);
  const role = name === "my_template.lyx"
    ? "template"
    : NON_MENU.has(name)
    ? "non-menu"
    : "menu";
  const sortRec = (m: Map<string, number>) =>
    Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return { file: name, role, layouts: sortRec(layouts), insets: sortRec(insets) };
}

function listHelpLyx(): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(HELP_DIR)) {
    if (e.isFile && e.name.endsWith(".lyx")) out.push(join(HELP_DIR, e.name));
  }
  return out.sort();
}

const asJson = Deno.args.includes("--json");
const files = [...listHelpLyx(), ...EXTRA.filter((p) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
})];
const results = files.map(inventoryFile);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`# ${r.file} (${r.role})`);
    console.log("layouts:", Object.keys(r.layouts).length, "kinds;", Object.values(r.layouts).reduce((a, b) => a + b, 0), "nodes");
    console.log("insets:", Object.keys(r.insets).length, "kinds;", Object.values(r.insets).reduce((a, b) => a + b, 0), "nodes");
    console.log();
  }
}
