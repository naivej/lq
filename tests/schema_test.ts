import { getSchemaForClass } from "../src/schema.ts";
import { getDefaultLayoutsDir } from "../src/cli.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("Schema parsing for book class", async () => {
  // Resolve the same layouts dir the CLI uses. getDefaultLayoutsDir returns a
  // best-guess path (never null), so verify it exists and fail loudly instead
  // of silently skipping — the suite already requires a resolvable layouts dir
  // (cli_test "schema fallback auto-detects layouts" fails without one).
  const layoutsDir = await getDefaultLayoutsDir();
  try {
    const stat = await Deno.stat(layoutsDir);
    assert(stat.isDirectory,
      `LyX layouts dir not found at ${layoutsDir} — install LyX or set layoutsDir via 'lq init --layouts-dir'`);
  } catch {
    throw new Error(
      `LyX layouts dir not found at ${layoutsDir} — install LyX or set layoutsDir via 'lq init --layouts-dir'`,
    );
  }

  const schema = await getSchemaForClass("book", layoutsDir);

  assertEquals(schema.textclass, "book");
  assert(schema.documentLayouts.length > 0, "Should have parsed document layouts");
  assert(schema.documentLayouts.includes("Chapter"), "Book class should include Chapter layout");

  // Verify static global constructs are present
  assert(schema.insetLayouts.includes("Plain Layout"));
  assert(schema.insets.includes("Formula"));
  assert(schema.inlineProperties.includes("change_inserted"));

  const formula = schema.insetCatalog.find((e) => e.name === "Formula");
  assert(formula !== undefined, "insetCatalog should include Formula");
  assertEquals(formula.kind, "content");
  const note = schema.insetCatalog.find((e) => e.name === "Note");
  assertEquals(note?.kind, "collapsible");
  assertEquals(note?.subtypes, ["Note", "Comment", "Greyedout"]);
  const command = schema.insetCatalog.find((e) => e.name === "CommandInset");
  assertEquals(command?.kind, "command");
  assert(command?.subtypes.includes("citation"), "CommandInset subtypes include citation");
  assertEquals(schema.insetCatalog.length, schema.insets.length);
});
