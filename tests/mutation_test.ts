/**
 * Mutation Engine tests — insert, delete, set, and bib mutation paths.
 *
 * Uses runCliTest from helpers.ts, which isolates tests from the developer's
 * local ~/.lq/config.json by creating a temp config with:
 *   refresh: "none"
 *   trackChanges: false
 *
 * Run from lq/ directory: deno test -A tests/mutation_test.ts
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { parse } from "../src/parser.ts";
import { BlockNode, TextNode } from "../src/ast.ts";
import { CliResult, runCliTest, runCliWithConfig, createTempFixture } from "./helpers.ts";

const FIXTURE_DIR = "tests/fixtures";

// Helper to create a temporary copy of a template for testing mutations
async function createTempFile(name: string): Promise<string> {
  const sourcePath = path.join(FIXTURE_DIR, "my_template.lyx");
  const tempPath = path.join(FIXTURE_DIR, name);
  await Deno.copyFile(sourcePath, tempPath);
  return tempPath;
}

Deno.test("Mutation Engine - Insert Auto-Spacer", async () => {
  const tempFile = await createTempFile("temp_spacer_test.lyx");
  try {
    // Insert a new layout after Title
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "Test Insert"]);
    assertEquals(result.inserted_nodes, 1);

    // Read the file and parse it to verify
    const text = await Deno.readTextFile(tempFile);
    const ast = parse(text);
    
    // Check that we have a spacer (empty text node) between the layouts
    // In my_template.lyx, Title is followed by Author. 
    // Now it should be Title -> spacer -> Standard -> spacer -> Author
    const doc = ast.children.find(c => c.type === 'block' && c.tag === 'document') as BlockNode;
    const body = doc.children.find(c => c.type === 'block' && c.tag === 'body') as BlockNode;
    
    let titleIndex = -1;
    for (let i = 0; i < body.children.length; i++) {
      const c = body.children[i];
      if (c.type === "block" && c.tag === "layout" && c.args === "Title") {
        titleIndex = i;
        break;
      }
    }
    
    // Check the structure after Title
    const nextNode = body.children[titleIndex + 1];
    const insertedLayout = body.children[titleIndex + 2];
    const nextSpacer = body.children[titleIndex + 3];
    
    assertEquals(nextNode.type, "text");
    assertEquals((nextNode as TextNode).text, "");
    
    assertEquals(insertedLayout.type, "block");
    assertEquals((insertedLayout as BlockNode).tag, "layout");
    assertEquals((insertedLayout as BlockNode).args, "Standard");
    
    assertEquals(nextSpacer.type, "text");
    assertEquals((nextSpacer as TextNode).text, "");
    
    // Ensure it serializes with the empty line
    assertStringIncludes(text, "\\end_layout\n\n\\begin_layout Standard\nTest Insert\n\\end_layout\n\n\\begin_layout Author");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Inset in Document Body", async () => {
  const tempFile = await createTempFile("temp_inset_test.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    await Deno.writeTextFile(rawFile, "\\begin_inset Formula\nE=mc^2\n\\end_inset");
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--raw-file", rawFile]);
    assertEquals(result.code, "INVALID_CONTEXT");
    assertStringIncludes(result.message!, "Cannot insert inset directly into the document body");
  } finally {
    await Deno.remove(tempFile);
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});

Deno.test("Mutation Engine - Reject Invalid Raw Strings", async () => {
  const tempFile = await createTempFile("temp_raw_test.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    await Deno.writeTextFile(rawFile, "Just plain text");
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--raw-file", rawFile]);
    assertEquals(result.code, "INVALID_RAW");
    assertStringIncludes(result.message!, "did not parse into any valid LyX blocks or properties");
  } finally {
    await Deno.remove(tempFile);
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});

Deno.test("Mutation Engine - Guard Core Document Nodes", async () => {
  const tempFile = await createTempFile("temp_guard_test.lyx");
  try {
    // Attempt to delete body
    const deleteResult = await runCliTest(["delete", tempFile, "body"]);
    assertEquals(deleteResult.code, "INVALID_CONTEXT");
    
    // Attempt to set document
    const setResult = await runCliTest(["set", tempFile, "document", "foo"]);
    assertEquals(setResult.code, "INVALID_CONTEXT");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Empty Layout Insert", async () => {
  const tempFile = await createTempFile("temp_empty_test.lyx");
  try {
    // Attempt to insert layout without text
    let result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard"]);
    assertEquals(result.code, "MISSING_ARGS");

    // Attempt to insert layout with whitespace-only text
    result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "   "]);
    assertEquals(result.code, "MISSING_ARGS");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Unrecognized Layout Name", async () => {
  const tempFile = await createTempFile("temp_bad_layout_test.lyx");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "NonExistentLayout", "--text", "Foo"]);
    assertEquals(result.code, "INVALID_LAYOUT");
    assertStringIncludes(result.message!, "NonExistentLayout");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Before Position", async () => {
  const tempFile = await createTempFile("temp_before_test.lyx");
  try {
    // Insert a layout before Author
    const result = await runCliTest(["insert", tempFile, "layout[Author]", "before", "--layout", "Standard", "--text", "Before Author"]);
    assertEquals(result.inserted_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Standard should appear before Author
    assertStringIncludes(text, "\\begin_layout Standard\nBefore Author\n\\end_layout\n\n\\begin_layout Author");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Append Position", async () => {
  const tempFile = await createTempFile("temp_append_test.lyx");
  try {
    // Append a footnote inside the Title layout (footnote is an inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "append", "--footnote", "Appended footnote"]);
    assertEquals(result.inserted_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // The footnote should appear inside Title, after its existing text
    assertStringIncludes(text, "Appended footnote");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Prepend Position (single block)", async () => {
  const tempFile = await createTempFile("temp_prepend_test.lyx");
  try {
    // Prepend a footnote inside the Title layout (footnote is an inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "prepend", "--footnote", "Prepended footnote"]);
    assertEquals(result.inserted_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // The footnote should appear inside Title, before Title's existing text
    assertStringIncludes(text, "Prepended footnote");
    // Verify footnote comes before the original text
    const fnPos = text.indexOf("Prepended footnote");
    const titlePos = text.indexOf("\\begin_layout Title");
    assertEquals(fnPos > titlePos, true, "Footnote should be inside Title layout");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Prepend Multi-Block (order preservation)", async () => {
  const tempFile = await createTempFile("temp_prepend_multi.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    // Create raw file with two Plain Layout blocks (valid inside insets): BlockA then BlockB
    await Deno.writeTextFile(rawFile,
      "\\begin_layout Plain Layout\nBLOCK_A\n\\end_layout\n" +
      "\\begin_layout Plain Layout\nBLOCK_B\n\\end_layout\n"
    );
    // Prepend into the first Foot inset
    const result = await runCliTest(["insert", tempFile, "inset[Foot]:first", "prepend", "--raw-file", rawFile]);
    assertEquals(result.inserted_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Verify both blocks exist in the output before checking order
    assertStringIncludes(text, "BLOCK_A");
    assertStringIncludes(text, "BLOCK_B");
    // BLOCK_A must appear BEFORE BLOCK_B (order preserved, not reversed by unshift)
    const posA = text.indexOf("BLOCK_A");
    const posB = text.indexOf("BLOCK_B");
    assertEquals(posA < posB, true, "BLOCK_A should appear before BLOCK_B (order must be preserved)");
  } finally {
    await Deno.remove(tempFile);
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});

Deno.test("Mutation Engine - Insert Split-After Position", async () => {
  const tempFile = await createTempFile("temp_split_after_test.lyx");
  try {
    // Split Title's text "Title" after "Tit" and insert a footnote (inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "split-after", "Tit", "--footnote", "Split footnote"]);
    assertEquals(result.inserted_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Text should be split: "Tit" then footnote, then "le"
    assertStringIncludes(text, "Split footnote");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Split-After with trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_split_tc.lyx");
  try {
    // split-after with trackChanges enabled — should NOT double-wrap
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Title]", "split-after", "Tit", "--footnote", "Tracked split"],
      { trackChanges: true },
    );

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "Tracked split");
    assertStringIncludes(text, "\\tracking_changes true");

    // Verify no double-wrapping: there should never be two \change_inserted
    // markers without a \change_unchanged between them. Double-wrapping
    // produces nested markers like: \change_inserted{...\change_inserted{...}\change_unchanged}\change_unchanged
    const allMatches = [...text.matchAll(/\\change_inserted|\\change_unchanged/g)];
    let insertDepth = 0;
    let maxDepth = 0;
    for (const m of allMatches) {
      if (m[0] === "\\change_inserted") {
        insertDepth++;
        if (insertDepth > maxDepth) maxDepth = insertDepth;
      } else {
        insertDepth--;
      }
    }
    assertEquals(maxDepth, 1, "Should never nest \\change_inserted markers (no double-wrapping)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Bib Engine - Extract Citations", async () => {
  const result = await runCliTest(["bib", path.join("tests", "fixtures", "my_template.lyx")]);
  assertEquals((result.data as unknown[]).length, 15);
  const firstCit = (result.data as unknown[])[0] as { key: string, year: string };
  assertEquals(firstCit.key, "Mena2000");
  assertEquals(firstCit.year, "2000");
});
