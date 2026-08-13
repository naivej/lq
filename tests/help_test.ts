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
import { renderPage, renderPageRich, renderPageText } from "../src/help_render.ts";

/** Remove ANSI escape sequences. */
// deno-lint-ignore no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

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

// --- Phase 1: content migration invariants (dev log 113) ---

Deno.test("help catalog - every furtherReading target resolves to a real page", () => {
  for (const p of HELP_PAGES) {
    for (const link of p.furtherReading) {
      assertEquals(
        findPage(link.page) !== undefined,
        true,
        `${p.id} links to unknown page '${link.page}'`,
      );
      assertEquals(link.hint.length > 0, true);
    }
  }
});

Deno.test("help catalog - every page has at least one non-empty section", () => {
  for (const p of HELP_PAGES) {
    assertEquals(p.sections.length > 0, true, `${p.id} has no sections`);
    for (const s of p.sections) {
      assertEquals(s.body.length > 0, true);
      if (s.heading.length === 0) {
        // Only the home intro renders bare (straight under the splash).
        assertEquals(p.id, "home", `${p.id} has an empty section heading`);
      }
    }
  }
});

Deno.test("help catalog - furtherReading never links to itself", () => {
  for (const p of HELP_PAGES) {
    for (const link of p.furtherReading) {
      assertEquals(link.page === p.id, false, `${p.id} links to itself`);
    }
  }
});

// --- Phase 3: renderers ---

Deno.test("help render - text is deterministic, marker-free, and non-empty", () => {
  for (const p of HELP_PAGES) {
    const text = renderPageText(p);
    assertEquals(text.length > 0, true, `${p.id} renders empty`);
    assertEquals(text.includes("\x1b["), false, `${p.id} has ANSI`);
    assertEquals(text.includes("`"), false, `${p.id} has stray backticks`);
  }
});

Deno.test("help render - rich=never and rich=auto (non-TTY) equal the text floor", () => {
  for (const p of HELP_PAGES) {
    assertEquals(renderPage(p, "never"), renderPageText(p), `${p.id} never != text`);
    assertEquals(renderPage(p, "auto"), renderPageText(p), `${p.id} auto (non-TTY) != text`);
  }
});

Deno.test("help render - rich=always is ANSI, stripped equals text, runs are balanced", () => {
  for (const p of HELP_PAGES) {
    if (p.id === "home") {
      // Home adds the rich-only splash, so the strip-equality below does not
      // hold; assert only the renderer-mode contract (ANSI in rich mode).
      assertEquals(renderPageRich(p).includes("\x1b["), true, "home rich has no ANSI");
      continue;
    }
    const rich = renderPageRich(p);
    assertEquals(rich.includes("\x1b["), true, `${p.id} has no ANSI`);
    assertEquals(stripAnsi(rich), renderPageText(p), `${p.id} rich != text after strip`);
    // deno-lint-ignore no-control-regex
    const escapes = rich.match(/\x1b\[[0-9;]*m/g) ?? [];
    for (let i = 0; i < escapes.length; i++) {
      if (escapes[i] !== "\x1b[0m") {
        assertEquals(escapes[i + 1], "\x1b[0m", `${p.id}: unbalanced ANSI after ${escapes[i]}`);
      }
    }
  }
});
