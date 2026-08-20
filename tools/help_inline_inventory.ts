/**
 * Body-only inline-property inventory for Help/*.lyx (+ my_template).
 * Complements help_live_inventory.ts (layouts/insets).
 *
 * Usage (from lq/):
 *   deno run -A tools/help_inline_inventory.ts
 *   deno run -A tools/help_inline_inventory.ts --json
 */
import { basename, join } from "@std/path";
import { parse } from "../src/parser.ts";
import type { DocumentNode, Node } from "../src/ast.ts";

const HELP_DIR = join(import.meta.dirname!, "../tests/fixtures/Help");
const EXTRA = [join(import.meta.dirname!, "../tests/fixtures/my_template.lyx")];

const FONT_KEYS = new Set([
  "emph",
  "noun",
  "bar",
  "uuline",
  "uwave",
  "strikeout",
  "xout",
  "family",
  "series",
  "shape",
  "size",
  "color",
  "lang",
  "align",
]);

function findBody(doc: DocumentNode): Node[] {
  const walk = (nodes: Node[]): Node[] | null => {
    for (const n of nodes) {
      if (n.type === "block" && n.tag === "body") return n.children;
      if (n.type === "block") {
        const inner = walk(n.children);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(doc.children) ?? [];
}

function inventoryFile(path: string): {
  file: string;
  properties: Record<string, Record<string, number>>;
  specialChars: Record<string, number>;
  changes: Record<string, number>;
} {
  const doc = parse(Deno.readTextFileSync(path));
  const properties: Record<string, Record<string, number>> = {};
  const specialChars: Record<string, number> = {};
  const changes: Record<string, number> = {};

  const bump = (bag: Record<string, number>, key: string) => {
    bag[key] = (bag[key] ?? 0) + 1;
  };
  const bump2 = (bag: Record<string, Record<string, number>>, key: string, value: string) => {
    const inner = bag[key] ?? (bag[key] = {});
    inner[value] = (inner[value] ?? 0) + 1;
  };

  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "property") {
        if (n.key === "SpecialChar") {
          bump(specialChars, n.value ?? "");
        } else if (FONT_KEYS.has(n.key)) {
          bump2(properties, n.key, n.value ?? "");
        } else if (n.key.startsWith("change_")) {
          bump(changes, n.key);
        }
      } else if (n.type === "text" && n.text.includes("\\SpecialChar")) {
        for (const m of n.text.matchAll(/\\SpecialChar\s+(\S+)/g)) {
          bump(specialChars, m[1]);
        }
      }
      if (n.type === "block") walk(n.children);
    }
  };
  walk(findBody(doc));

  return { file: basename(path), properties, specialChars, changes };
}

const paths = [
  ...[...Deno.readDirSync(HELP_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".lyx"))
    .map((e) => join(HELP_DIR, e.name))
    .sort(),
  ...EXTRA,
];

const rows = paths.map(inventoryFile);
const json = Deno.args.includes("--json");

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const propTotals: Record<string, number> = {};
  const specialTotals: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, vals] of Object.entries(r.properties)) {
      propTotals[k] = (propTotals[k] ?? 0) + Object.values(vals).reduce((a, b) => a + b, 0);
    }
    for (const [k, n] of Object.entries(r.specialChars)) {
      specialTotals[k] = (specialTotals[k] ?? 0) + n;
    }
  }
  console.log("Inline property totals (Help + my_template body):");
  for (const [k, n] of Object.entries(propTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log("SpecialChar totals:");
  for (const [k, n] of Object.entries(specialTotals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
}
