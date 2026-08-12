/**
 * Structural invariants for the help catalog (dev log 113, Phase 0).
 * Content-level help tests (router, rendering, facts) land in Phase 4.
 */
import { assertEquals } from "@std/assert";
import {
  HELP_PAGES,
  aliasOf,
  findByAlias,
  findByReach,
  findPage,
  groupOf,
  groupedPages,
  reachOf,
} from "../src/help.ts";

/** The 18-page page map from the help draft, exactly. */
const EXPECTED_IDS = [
  "home",
  "model/cst",
  "model/guarantees",
  "concepts/state-scope",
  "concepts/private-notes",
  "concepts/insets",
  "concepts/selectors",
  "concepts/mutations",
  "concepts/tracked-changes",
  "commands/init",
  "commands/schema",
  "commands/dump",
  "commands/read",
  "commands/bib",
  "commands/set",
  "commands/delete",
  "commands/insert",
  "commands/undo",
];

Deno.test("help catalog - page map matches the draft (18 pages)", () => {
  const ids = HELP_PAGES.map((p) => p.id).sort();
  assertEquals(ids, [...EXPECTED_IDS].sort());
});

Deno.test("help catalog - page IDs are unique", () => {
  const ids = HELP_PAGES.map((p) => p.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("help catalog - reaches are unique (one canonical lq help <page> form)", () => {
  const reaches = HELP_PAGES.map((p) => reachOf(p.id));
  assertEquals(new Set(reaches).size, reaches.length);
});

Deno.test("help catalog - command aliases are unique and only on command pages", () => {
  const aliases = HELP_PAGES.map((p) => aliasOf(p.id)).filter((a): a is string => a !== undefined);
  assertEquals(new Set(aliases).size, aliases.length);
  // 9 command pages (init schema dump read bib set delete insert undo)
  assertEquals(aliases.length, 9);
});

Deno.test("help catalog - every page has a non-empty title", () => {
  for (const p of HELP_PAGES) assertEquals(p.title.length > 0, true);
});

Deno.test("help catalog - group/reach/alias are derived from id", () => {
  assertEquals(reachOf("commands/read"), "read");
  assertEquals(reachOf("model/cst"), "cst");
  assertEquals(reachOf("home"), "home");
  assertEquals(groupOf("commands/read"), "commands");
  assertEquals(groupOf("concepts/insets"), "concepts");
  assertEquals(groupOf("model/guarantees"), "model");
  assertEquals(groupOf("home"), null);
  assertEquals(aliasOf("commands/read"), "read");
  assertEquals(aliasOf("model/cst"), undefined);
  assertEquals(aliasOf("home"), undefined);
});

Deno.test("help catalog - lookups resolve and unknown names are undefined", () => {
  assertEquals(findByReach("read")?.id, "commands/read");
  assertEquals(findByReach("cst")?.id, "model/cst");
  assertEquals(findByAlias("read")?.id, "commands/read");
  assertEquals(findByAlias("cst"), undefined);
  assertEquals(findPage("concepts/selectors")?.id, "concepts/selectors");
  assertEquals(findPage("home")?.id, "home");
  assertEquals(findByReach("nope"), undefined);
  assertEquals(findByAlias("nope"), undefined);
  assertEquals(findPage("nope/nope"), undefined);
});

Deno.test("help catalog - grouped map covers all non-home pages", () => {
  const grouped = groupedPages();
  const groups = grouped.map((g) => g.group);
  assertEquals(groups, ["model", "concepts", "commands"]);
  const total = grouped.reduce((n, g) => n + g.pages.length, 0);
  assertEquals(total, HELP_PAGES.length - 1); // home is excluded
  // 2 model + 6 concepts + 9 commands
  assertEquals(grouped[0].pages.length, 2);
  assertEquals(grouped[1].pages.length, 6);
  assertEquals(grouped[2].pages.length, 9);
});
