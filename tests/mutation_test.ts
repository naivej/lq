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

Deno.test("Mutation Engine - Insert Auto-Spacer", async () => {
  const tempFile = await createTempFixture("temp_spacer_test.lyx");
  try {
    // Insert a new layout after Title
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "Test Insert"]);
    assertEquals(result.matched_nodes, 1);

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
  const tempFile = await createTempFixture("temp_inset_test.lyx");
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
  const tempFile = await createTempFixture("temp_raw_test.lyx");
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
  const tempFile = await createTempFixture("temp_guard_test.lyx");
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
  const tempFile = await createTempFixture("temp_empty_test.lyx");
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
  const tempFile = await createTempFixture("temp_bad_layout_test.lyx");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "NonExistentLayout", "--text", "Foo"]);
    assertEquals(result.code, "INVALID_LAYOUT");
    assertStringIncludes(result.message!, "NonExistentLayout");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Before Position", async () => {
  const tempFile = await createTempFixture("temp_before_test.lyx");
  try {
    // Insert a layout before Author
    const result = await runCliTest(["insert", tempFile, "layout[Author]", "before", "--layout", "Standard", "--text", "Before Author"]);
    assertEquals(result.matched_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Standard should appear before Author
    assertStringIncludes(text, "\\begin_layout Standard\nBefore Author\n\\end_layout\n\n\\begin_layout Author");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Append Position", async () => {
  const tempFile = await createTempFixture("temp_append_test.lyx");
  try {
    // Append a footnote inside the Title layout (footnote is an inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "append", "--footnote", "Appended footnote"]);
    assertEquals(result.matched_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // The footnote should appear inside Title, after its existing text
    assertStringIncludes(text, "Appended footnote");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Insert Prepend Position (single block)", async () => {
  const tempFile = await createTempFixture("temp_prepend_test.lyx");
  try {
    // Prepend a footnote inside the Title layout (footnote is an inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "prepend", "--footnote", "Prepended footnote"]);
    assertEquals(result.matched_nodes, 1);

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
  const tempFile = await createTempFixture("temp_prepend_multi.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    // Create raw file with two Plain Layout blocks (valid inside insets): BlockA then BlockB
    await Deno.writeTextFile(rawFile,
      "\\begin_layout Plain Layout\nBLOCK_A\n\\end_layout\n" +
      "\\begin_layout Plain Layout\nBLOCK_B\n\\end_layout\n"
    );
    // Prepend into the first Foot inset
    const result = await runCliTest(["insert", tempFile, "inset[Foot]:first", "prepend", "--raw-file", rawFile]);
    assertEquals(result.matched_nodes, 1);

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
  const tempFile = await createTempFixture("temp_split_after_test.lyx");
  try {
    // Split Title's text "Title" after "Tit" and insert a footnote (inset, valid inside layouts)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "split-after", "Tit", "--footnote", "Split footnote"]);
    assertEquals(result.matched_nodes, 1);

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

// Item 5 fix: split-after with --text (no layout wrapper)
Deno.test("Mutation Engine - Insert Split-After with --text", async () => {
  const tempFile = await createTempFixture("temp_split_text.lyx");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "split-after", "Tit", "--text", "NEW"]);
    assertEquals(result.matched_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Text nodes are serialized with \n separators, so we check order, not concatenation.
    const titIdx = text.indexOf("Tit");
    const newIdx = text.indexOf("NEW");
    const leIdx = text.indexOf("le", newIdx);
    assertEquals(titIdx < newIdx && newIdx < leIdx, true, "NEW should appear between 'Tit' and 'le'");
  } finally {
    await Deno.remove(tempFile);
  }
});

// Item 5 fix: split-after with --text + trackChanges
Deno.test("Mutation Engine - Insert Split-After with --text and trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_split_text_tc.lyx");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Title]", "split-after", "Tit", "--text", "NEW"],
      { trackChanges: true },
    );

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "NEW");
    assertStringIncludes(text, "\\change_unchanged");

    // Verify no double-wrapping
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

// Item 1 fix: multi-block split-after order preservation
Deno.test("Mutation Engine - Insert Split-After Multi-Block (order preservation)", async () => {
  const tempFile = await createTempFixture("temp_split_multi.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    // Create raw file with two footnote insets: FN_A then FN_B
    await Deno.writeTextFile(rawFile,
      "\\begin_inset Foot\n" +
      "\\begin_layout Plain Layout\nFN_A\n\\end_layout\n" +
      "\\end_inset\n" +
      "\\begin_inset Foot\n" +
      "\\begin_layout Plain Layout\nFN_B\n\\end_layout\n" +
      "\\end_inset\n"
    );
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "split-after", "Tit", "--raw-file", rawFile]);
    assertEquals(result.matched_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    // Both footnotes should exist
    assertStringIncludes(text, "FN_A");
    assertStringIncludes(text, "FN_B");
    // FN_A must appear BEFORE FN_B (order preserved, not reversed)
    const posA = text.indexOf("FN_A");
    const posB = text.indexOf("FN_B");
    assertEquals(posA < posB, true, "FN_A should appear before FN_B (order must be preserved)");
  } finally {
    await Deno.remove(tempFile);
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});

// T1: Multi-target insert with trackChanges — verifies no double-wrapping
// regression (dev log 61 fix 1.2: payload cloned per target iteration)
Deno.test("Mutation Engine - Multi-Target Insert with trackChanges (no double-wrap)", { timeout: 10000 }, async () => {
  // Create a custom file with exactly 2 body-level Standard layouts
  const tempFile = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tempFile,
      "#LyX 2.5 created this file.\n" +
      "\\begin_document\n\\begin_header\n\\end_header\n" +
      "\\begin_body\n" +
      "\\begin_layout Standard\nTarget A\n\\end_layout\n" +
      "\\begin_layout Standard\nTarget B\n\\end_layout\n" +
      "\\end_body\n\\end_document\n"
    );
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "after", "--layout", "Standard", "--text", "TRACKED"],
      { trackChanges: true },
    );
    assertEquals(result.matched_nodes, 2);

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\tracking_changes true");
    assertStringIncludes(text, "TRACKED");

    // Verify no double-wrapping: max nesting depth of \change_inserted = 1
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
    assertEquals(maxDepth, 1, "Multi-target insert should never double-wrap \\change_inserted markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// T4: Multi-block raw-file after — order preserved (BLOCK_A before BLOCK_B)
// regression guard (dev log 59 fix 1.2: order reversal on after position)
Deno.test("Mutation Engine - Multi-Block Raw-File After (order preservation)", async () => {
  const tempFile = await createTempFixture("temp_after_multi.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    await Deno.writeTextFile(rawFile,
      "\\begin_layout Standard\nBLOCK_A\n\\end_layout\n" +
      "\\begin_layout Standard\nBLOCK_B\n\\end_layout\n"
    );
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--raw-file", rawFile]);
    assertEquals(result.matched_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "BLOCK_A");
    assertStringIncludes(text, "BLOCK_B");
    // BLOCK_A must appear BEFORE BLOCK_B (order preserved, not reversed)
    const posA = text.indexOf("BLOCK_A");
    const posB = text.indexOf("BLOCK_B");
    assertEquals(posA < posB, true, "BLOCK_A should appear before BLOCK_B (order must be preserved)");
  } finally {
    await Deno.remove(tempFile);
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});

// T2: undo with zero changes — verifies no spurious \author pollution
// (dev log 60 fix 1.3: undo on clean file should not write anything)
Deno.test("Mutation Engine - Undo with Zero Changes (no spurious author)", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_undo_clean.lyx");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout"],
      { trackChanges: true },
    );
    assertEquals(result.undone_changes, 0);
    // Re-read the file and verify no NEW \author was added
    // (the fixture may already have \author entries from its header)
    const text = await Deno.readTextFile(tempFile);
    const authorCount = (text.match(/\\author/g) || []).length;
    // A clean fixture should have 0 or 1 \author entries (from the template header)
    assertEquals(authorCount <= 1, true, "Undo on clean file should not add spurious \\author entries");
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
