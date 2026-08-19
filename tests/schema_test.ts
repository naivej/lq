import { getSchemaForClass, getLayoutHtmlForClass, getDefaultLayoutsDir } from "../src/schema.ts";
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
  assert(schema.inlineProperties.includes("change_inserted"));
  assertEquals("insetCatalog" in schema, false, "catalog payload is insets, not insetCatalog");
  assertEquals("commandInsetSubtypes" in schema, false, "CommandInset subtypes live on insets");

  const formula = schema.insets.find((e) => e.name === "Formula");
  assert(formula !== undefined, "insets should include Formula");
  assertEquals(formula.kind, "content");
  const note = schema.insets.find((e) => e.name === "Note");
  assertEquals(note?.kind, "collapsible");
  assertEquals(note?.subtypes, ["Note", "Comment", "Greyedout"]);
  const command = schema.insets.find((e) => e.name === "CommandInset");
  assertEquals(command?.kind, "command");
  assert(command?.subtypes.includes("citation"), "CommandInset subtypes include citation");
  assertEquals(
    JSON.stringify(schema).includes("htmlTag"),
    false,
    "lq schema JSON must not carry renderer HTML keys",
  );
});

Deno.test("Layout HTML lookup is renderer-private and resolves CopyStyle", async () => {
  const layoutsDir = await getDefaultLayoutsDir();
  const html = await getLayoutHtmlForClass("article", layoutsDir);
  assert(html.size > 0, "article.layout should yield Style HTML keys");
  assertEquals(html.get("Section")?.htmlTag?.toLowerCase(), "h2");
  assertEquals(html.get("Section")?.tocLevel, 1);
  assertEquals(html.get("Itemize")?.htmlTag?.toLowerCase(), "ul");
  assertEquals(html.get("Labeling")?.htmlTag?.toLowerCase(), "ol");
  assertEquals(html.get("Quotation")?.htmlTag?.toLowerCase(), "blockquote", "CopyStyle Quote must inherit HTMLTag");
  assertEquals(html.get("Title")?.htmlTitle, true);
  assertEquals(html.get("LyX-Code")?.htmlTag, undefined, "LyX-Code has no HTMLTag; fallback tables still apply");
  const koma = await getLayoutHtmlForClass("scrbook", layoutsDir);
  assertEquals(koma.get("Labeling")?.htmlTag?.toLowerCase(), "ol", "later Style Labeling must merge, not replace");
  assertEquals(koma.get("Section")?.htmlTag?.toLowerCase(), "h2");
  const missing = await getLayoutHtmlForClass("article", "Z:\\lq-no-such-layouts");
  assertEquals(missing.size, 0);
  const withModules = await getLayoutHtmlForClass("scrbook", layoutsDir, ["enumitem"]);
  assertEquals(
    withModules.get("Enumerate-Resume")?.htmlTag?.toLowerCase(),
    "ol",
    "header module Enumerate-Resume CopyStyle Enumerate must resolve HTMLTag",
  );
  const theorems = await getLayoutHtmlForClass("scrbook", layoutsDir, ["theorems-ams"]);
  assertEquals(theorems.get("Theorem")?.labelType?.toLowerCase(), "static");
  assertEquals(theorems.get("Theorem")?.labelString, "Theorem \\thetheorem.");
  assertEquals(theorems.get("Theorem")?.labelCounter, "theorem");
});
