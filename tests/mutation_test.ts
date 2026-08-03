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

import { assertEquals, assert, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { parse } from "../src/parser.ts";
import { serialize } from "../src/serializer.ts";
import { BlockNode, Node, PropertyNode, TextNode } from "../src/ast.ts";
import { advanceChangeDepths } from "../src/text_utils.ts";
import { runCliTest, runCliWithConfig, createTempFixture } from "./helpers.ts";

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
    await runCliWithConfig(
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

// DL81 (test_report_34 Finding 1): tracked insert of a CommandInset must wrap
// the inset atomically — markers outside the inset, never inside its metadata
// (LatexCommand / key / name lines). Regression: the DL74 "insets are atomic"
// invariant was violated on the insert path.
Deno.test("Mutation Engine - Tracked CommandInset Insert (atomic wrap)", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_tracked_cite.lyx");
  try {
    await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]:first", "append", "--cite", "Mena2000"],
      { trackChanges: true },
    );

    const text = await Deno.readTextFile(tempFile);
    // The inset body (between begin_inset and end_inset) must contain NO change markers.
    const insetMatch = text.match(/\\begin_inset CommandInset citation\n([\s\S]*?)\\end_inset/);
    assert(insetMatch, "citation inset should be present");
    assert(
      !insetMatch[1].includes("\\change_"),
      "change markers must not appear inside the CommandInset body: " + insetMatch[1],
    );
    // Markers wrap the whole inset: \change_inserted before it, \change_unchanged after.
    const beforeIdx = text.indexOf("\\begin_inset CommandInset citation");
    const afterIdx = text.indexOf("\\end_inset", beforeIdx);
    const insertedIdx = text.lastIndexOf("\\change_inserted", beforeIdx);
    const unchangedIdx = text.indexOf("\\change_unchanged", afterIdx);
    assert(insertedIdx !== -1 && insertedIdx < beforeIdx, "change_inserted must precede the inset");
    assert(unchangedIdx !== -1 && unchangedIdx > afterIdx, "change_unchanged must follow the inset");

    // No double-wrapping: max \change_inserted nesting depth = 1.
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
    assertEquals(maxDepth, 1, "Should never nest \\change_inserted markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// DL81 (test_report_34 Finding 2): untracked --find on inset metadata must not
// split the one-line `name "..."` parameter into multiple lines — LyX rejects
// that ("Missing quote"). The match lies entirely within one text node, so it
// must be replaced in place.
Deno.test("Mutation Engine - Untracked --find on Label Metadata (single line)", async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tempFile,
      "#LyX 2.5 created this file.\n" +
      "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n" +
      "\\begin_body\n" +
      "\\begin_layout Standard\n" +
      "\\begin_inset CommandInset label\n" +
      "LatexCommand label\n" +
      "name \"sec:Section_label\"\n" +
      "\\end_inset\n" +
      "\\end_layout\n" +
      "\\end_body\n\\end_document\n",
    );
    const result = await runCliWithConfig(
      ["set", tempFile, "inset[CommandInset label]:first", "sec:Section_label_NEW", "--find", "sec:Section_label"],
      { trackChanges: false },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    // The whole name parameter must appear on a single contiguous line.
    assertStringIncludes(text, 'name "sec:Section_label_NEW"', "label rename must stay on one line");
    // Old value must be gone.
    assert(!text.includes('name "sec:Section_label"'), "old label value must be replaced");
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
    await runCliWithConfig(
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

// T2: undo with zero changes — UNDO_STALE error, no file write, no \author
// pollution (dev log 78 staleness guard; dev log 60 fix 1.3 still applies)
Deno.test("Mutation Engine - Undo with Zero Changes (UNDO_STALE)", { timeout: 10000 }, async () => {
  // Minimal clean fixture: no snapshot, no tracked changes (my_template.lyx
  // contains tracked changes, which would fall through to replay instead).
  const tempFile = await writeTempLyx(
    "temp_undo_clean.lyx",
    "\\begin_layout Standard\nClean text\n\\end_layout\n",
  );
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout"],
      { trackChanges: true },
    );
    assertEquals(result.code, "UNDO_STALE");
    assertStringIncludes(result.message!, "Nothing to undo");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text, before, "UNDO_STALE undo must not write the file");
    const authorCount = (text.match(/\\author/g) || []).length;
    assertEquals(authorCount, 0, "Undo on clean file should not add spurious \\author entries");
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

// --- Cross-text-node matching tests ---

const REPRO_FIXTURE = new URL("./fixtures/PerDevLog/test_report_33_repro.lyx", import.meta.url);

Deno.test("Cross-Node --find (untracked)", async () => {
  const tempFile = await createTempFixture("temp_cross_find_untracked.lyx", REPRO_FIXTURE);
  try {
    // "Compared to the literature, we find" spans a comma-induced text-node boundary
    const result = await runCliTest([
      "set", tempFile, "layout[Standard]:first", "REPLACED",
      "--find", "Compared to the literature, we find",
    ]);
    assertEquals(result.modified_nodes, 1);
    assertEquals(
      (result.changes as Array<{ text: string }>)[0].text.includes("REPLACED"),
      true,
    );
    // Verify the file content
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "REPLACED");
    assertStringIncludes(text, "significant effects");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Cross-Node --find (tracked)", async () => {
  const tempFile = await createTempFixture("temp_cross_find_tracked.lyx", REPRO_FIXTURE);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:first", "REPLACED",
       "--find", "Compared to the literature, we find"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    assertStringIncludes(
      (result.changes as Array<{ text: string }>)[0].text,
      "\\change_deleted{Compared to the literature, we find}",
    );
    // Verify the file contains tracking markers
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "REPLACED");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Cross-Node split-after", async () => {
  const tempFile = await createTempFixture("temp_cross_split.lyx", REPRO_FIXTURE);
  try {
    // "literature, we find" spans the comma boundary
    const result = await runCliTest([
      "insert", tempFile, "layout[Standard]:first",
      "split-after", "literature, we find", "--text", "INSERTED",
    ]);
    assertEquals(result.matched_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    // The .lyx file has a newline between "literature," and " we find",
    // so we check for INSERTED appearing after the split text.
    assertStringIncludes(text, "INSERTED");
    // Verify INSERTED appears between the matched text and the remainder.
    const posLiterature = text.indexOf("literature,");
    const posInserted = text.indexOf("INSERTED");
    const posSignificant = text.indexOf("significant effects");
    assertEquals(posLiterature < posInserted, true, "INSERTED should be after literature,");
    assertEquals(posInserted < posSignificant, true, "INSERTED should be before significant effects");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Cross-Node :contains()", async () => {
  const tempFile = await createTempFixture("temp_cross_contains.lyx", REPRO_FIXTURE);
  try {
    // :contains should match across the comma boundary
    const result = await runCliTest([
      "read", tempFile, "layout:contains('Compared to the literature, we find')", "--count",
    ]);
    assertEquals((result.count as Record<string, number>)["layout[Standard]"], 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- test_report_38 F2 (code_review_86-74 Deviation 1): --find spanning a
// --- formatting property must mimic LyX (lyxfind.cpp replaceAll) — drop the
// --- property strictly inside the matched span instead of reordering it to the
// --- front (silent formatting destruction + dead markup).

Deno.test("F2 - --find spanning \\emph drops the inside-span property (mimic LyX)", async () => {
  const tempFile = await writeTempLyx("temp_f2_emph_span.lyx",
    "\\begin_layout Standard\n" +
    "Alpha \n" +
    "\\emph on\n" +
    "Beta\n" +
    "\\emph default\n" +
    "Gamma\n" +
    "\\end_layout\n");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]", "XYZ", "--find", "Alpha Beta"]);
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "XYZ");
    // The inside-span \emph on must be dropped — no dead pair, no reorder.
    assertEquals(text.includes("\\emph on"), false, "inside-span \\emph on must be dropped");
    // The edge \emph default survives and sits AFTER the replacement (so the
    // replacement is plain, matching LyX's match-start-font behavior).
    assertStringIncludes(text, "\\emph default");
    assertEquals(text.indexOf("XYZ") < text.indexOf("\\emph default"), true,
      "\\emph default must come after the replacement");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("F2 - --find fully inside \\emph keeps the replacement emphasized", async () => {
  const tempFile = await writeTempLyx("temp_f2_emph_inside.lyx",
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "Alpha Beta\n" +
    "\\emph default\n" +
    "\\end_layout\n");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]", "XYZ", "--find", "Alpha Beta"]);
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "XYZ");
    // Both edge properties survive and bracket the replacement — the inserted
    // text inherits the match-start (emphasized) font, as LyX does.
    assertStringIncludes(text, "\\emph on");
    assertStringIncludes(text, "\\emph default");
    const posOn = text.indexOf("\\emph on");
    const posXyz = text.indexOf("XYZ");
    const posDefault = text.indexOf("\\emph default");
    assertEquals(posOn < posXyz && posXyz < posDefault, true,
      "replacement must sit between \\emph on and \\emph default (emphasized)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("F2 - :contains() still matches across a formatting property", async () => {
  const tempFile = await writeTempLyx("temp_f2_contains_emph.lyx",
    "\\begin_layout Standard\n" +
    "Alpha \n" +
    "\\emph on\n" +
    "Beta\n" +
    "\\emph default\n" +
    "Gamma\n" +
    "\\end_layout\n");
  try {
    // Searching for a phrase should not require knowing formatting boundaries —
    // :contains() stays transparent across properties (only --find drops).
    const result = await runCliTest(["read", tempFile, "layout:contains('Alpha Beta')", "--count"]);
    assertEquals((result.count as Record<string, number>)["layout[Standard]"], 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// test_report_38 F9 (D7, query/mutation model): SELECTORS see all text —
// :contains() matches a phrase even when it lives inside \change_deleted.
// Mutations see all text too (dev log 90): --find matches rejected text.
Deno.test("F9 - :contains() matches text inside \\change_deleted (selectors see all)", async () => {
  const tempFile = await writeTempLyx("temp_f9_contains_deleted.lyx",
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old deleted words\n" +
    "\\change_unchanged\n" +
    "current text\n" +
    "\\end_layout\n");
  try {
    // A selector locates the paragraph even when the phrase is only in a
    // rejected change (the output layer already shows it; --find would not).
    const found = await runCliTest(["read", tempFile, "layout:contains('old deleted words')", "--count"]);
    assertEquals((found.count as Record<string, number>)["layout[Standard]"], 1);
    // Control: current text still matches.
    const current = await runCliTest(["read", tempFile, "layout:contains('current text')", "--count"]);
    assertEquals((current.count as Record<string, number>)["layout[Standard]"], 1);
    // Mutations see all text too (dev log 90): --find on rejected text now
    // matches and edits it, instead of NO_MATCH.
    const setResult = await runCliTest(["set", tempFile, "layout[Standard]", "X", "--find", "old deleted words"]);
    assertEquals(setResult.modified_nodes, 1, "--find now matches rejected text");
    const after = await Deno.readTextFile(tempFile);
    assertStringIncludes(after, "X", "replacement applied to the rejected region");
    assertEquals(after.includes("old deleted words"), false, "rejected text erased");
    assertEquals(
      setResult.warnings?.some(w => w.includes("change_deleted")),
      true,
      "deleted-hit warning fires so editing rejected text is not silent",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- test_report_38 F3 (code_review_86-74 Deviation 2): split-after must reach
// --- text inside nested layouts (e.g. a Foot inset's Plain Layout), restoring
// --- the documented two-pass footnote workflow. Inset METADATA (CommandInset
// --- label/cite lines) stays opaque.

const FOOTNOTE_BODY =
  "\\begin_layout Standard\n" +
  "Alpha \n" +
  "\\begin_inset Foot\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "A footnote\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "Gamma\n" +
  "\\end_layout\n";

Deno.test("F3 - split-after on inset[Foot] reaches the nested Plain Layout text", async () => {
  const tempFile = await writeTempLyx("temp_f3_footnote_split.lyx", FOOTNOTE_BODY);
  try {
    const result = await runCliTest([
      "insert", tempFile, "inset[Foot]", "split-after", "A footnote", "--text", " with a citation",
    ]);
    assertEquals(result.matched_nodes, 1, "split-after must succeed, not SPLIT_NO_MATCH");
    const text = await Deno.readTextFile(tempFile);
    // The payload lands inside the footnote, after the matched text.
    const posFootnote = text.indexOf("A footnote");
    const posInserted = text.indexOf(" with a citation");
    assertEquals(posFootnote !== -1 && posInserted > posFootnote, true,
      "inserted text must appear after 'A footnote' inside the footnote");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("F3 - split-after on layout[Standard] reaches nested footnote text", async () => {
  const tempFile = await writeTempLyx("temp_f3_layout_split.lyx", FOOTNOTE_BODY);
  try {
    const result = await runCliTest([
      "insert", tempFile, "layout[Standard]", "split-after", "A footnote", "--text", " INS",
    ]);
    assertEquals(result.matched_nodes, 1, "split-after on the layout must succeed");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.indexOf("A footnote") < text.indexOf(" INS"), true,
      "inserted text must land inside the footnote");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("F3 - split-after on CommandInset label stays opaque (SPLIT_NO_MATCH)", async () => {
  const body =
    "\\begin_layout Standard\n" +
    "Alpha \n" +
    "\\begin_inset CommandInset label\n" +
    "LatexCommand label\n" +
    "name \"sec:Section_label\"\n" +
    "\\end_inset\n" +
    "\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "A footnote\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    "Gamma\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_f3_label_opaque.lyx", body);
  try {
    // A label inset's metadata is not matchable; the footnote lives in a
    // different subtree, so this must fail rather than reach across.
    const result = await runCliTest([
      "insert", tempFile, "inset[CommandInset label]", "split-after", "A footnote", "--text", " INS",
    ]);
    assertEquals(result.code, "SPLIT_NO_MATCH");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes(" INS"), false, "file must be untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});


// --- Dev log 87: Step 3 fixes (test_report_38 F5-F7) ---

Deno.test("DL87 F5 - replay undo names author mismatch when the change is another author's", { timeout: 15000 }, async () => {
  // Alice (id 1) has a pending insertion containing 'QUICK'; Bob runs the undo.
  const body =
    "\\begin_layout Standard\n" +
    "The quick brown fox\n" +
    "\\change_inserted 1 1700000000\n" +
    "QUICK\n" +
    "LY brown\n" +
    "\\change_unchanged\n" +
    " jumps over\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl87_f5_authormismatch.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "QUICK"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.undone_changes, 0, "nothing may be undone for the wrong author");
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "another author", "warning must name the author mismatch, not 'already been undone'");
    assertStringIncludes(msg, "lq init --author-name", "warning must point at the corrective command");
    assertEquals(msg.includes("already been undone"), false, "must not claim the change is gone");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "QUICK", "file must be untouched on disk");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL87 F6 - --find reports modified_nodes as nodes actually modified", { timeout: 15000 }, async () => {
  // Two Standard layouts match the selector; only one contains the substring.
  const body =
    "\\begin_layout Standard\nAlpha\n\\end_layout\n" +
    "\\begin_layout Standard\nBeta gamma\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl87_f6_modified.lyx", body);
  try {
    const result = await runCliTest([
      "set", tempFile, "layout[Standard]", "GAMMA", "--find", "gamma",
    ]);
    assertEquals(result.modified_nodes, 1, "only one of two matched layouts was actually modified");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL87 F7 - unknown and misapplied flags hard-error before mutating", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nHello\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl87_f7_flags.lyx", body);
  try {
    // Known-but-wrong-command flag: --track-changes is an init flag, not a set flag.
    const misapplied = await runCliTest([
      "set", tempFile, "layout[Standard]", "World", "--track-changes", "off",
    ]);
    assertEquals(misapplied.code, "INVALID_FLAG");
    assertStringIncludes(misapplied.message!, "--track-changes is an 'init' flag");
    assertStringIncludes(misapplied.message!, "lq init --track-changes off");
    // Truly unknown flag (a typo / removed-in-DL76 flag).
    const bogus = await runCliTest([
      "set", tempFile, "layout[Standard]", "World", "--bogus-flag",
    ]);
    assertEquals(bogus.code, "INVALID_FLAG");
    assertStringIncludes(bogus.message!, "Unknown flag");
    // Non-flag commands reject stray flags too (delete).
    const stray = await runCliTest([
      "delete", tempFile, "layout[Standard]", "--bogus-flag",
    ]);
    assertEquals(stray.code, "INVALID_FLAG");
    // File must be untouched by every attempt.
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes("World"), false, "no mutation may occur");
    assertStringIncludes(text, "Hello");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 88 (test_report_39): full-replace property/inset placement + DX ---

// F1: plain tracked full-replace (no pending changes) must keep inline
// properties IN PLACE inside the deleted region — rejecting restores the
// original formatting (test_report_39 F1; completes DL87 F8 on the default
// path, which only fixed the flatten branch).
Deno.test("DL88 F1 - tracked plain full-replace keeps properties inside the deleted region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The \n\\emph on\nquick\n\\emph default\n fox\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl88_f1_plain.lyx", body);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "NEW TEXT"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "NEW TEXT");
    // Properties must sit inside the deleted region, before the inserted
    // region — same position assertion as the DL78 N4 flatten test.
    const deletedPos = text.indexOf("\\change_deleted");
    const insertedPos = text.indexOf("\\change_inserted");
    const emphOnPos = text.indexOf("\\emph on");
    const emphDefaultPos = text.indexOf("\\emph default");
    assertEquals(deletedPos !== -1 && insertedPos !== -1, true, "deleted/inserted markers must be present");
    assertEquals(emphOnPos > deletedPos && emphOnPos < insertedPos, true,
      "\\emph on must stay inside the deleted region");
    assertEquals(emphDefaultPos > deletedPos && emphDefaultPos < insertedPos, true,
      "\\emph default must stay inside the deleted region");
    // No dead pair trails after the change pair.
    assertEquals(text.lastIndexOf("\\emph") < insertedPos, true,
      "no \\emph may trail after the inserted region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// F2: untracked plain full-replace must drop inline properties (dead markup)
// and keep insets as current content.
Deno.test("DL88 F2 - untracked plain full-replace drops dead properties, keeps insets", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The \n\\emph on\nquick\n\\emph default\n fox\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "a note\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl88_f2_untracked.lyx", body);
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]", "NEW TEXT"]);
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "NEW TEXT");
    assertEquals(text.includes("\\emph on"), false, "dead \\emph on must be dropped");
    assertEquals(text.includes("\\emph default"), false, "dead \\emph default must be dropped");
    assertStringIncludes(text, "\\begin_inset Foot", "inset must survive as current content");
    assertEquals(text.indexOf("NEW TEXT") < text.indexOf("\\begin_inset Foot"), true,
      "replacement text must precede the preserved inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// F1b: tracked plain full-replace over a paragraph containing an inset — the
// inset stays OUTSIDE the change pair (survives accept).
Deno.test("DL88 F1b - tracked plain full-replace keeps inset outside the change pair", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The quick brown fox\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "a note\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl88_f1b_inset.lyx", body);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "NEW TEXT"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    // Inset must come after the inserted region's closer (the last
    // \change_unchanged), i.e. outside the change pair — survives accept.
    const lastUnchanged = text.lastIndexOf("\\change_unchanged");
    const insetPos = text.indexOf("\\begin_inset Foot");
    assertEquals(insetPos !== -1 && lastUnchanged !== -1, true, "inset and closer must be present");
    assertEquals(insetPos > lastUnchanged, true,
      "inset must stay outside the change pair (survive accept)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// D2-b: tracked full-replace over a node with pending changes + inset — the
// flatten path must also keep the inset outside the change pair (previously it
// folded the inset into \change_deleted, so accepting would drop the footnote).
Deno.test("DL88 D2b - flatten keeps inset outside the change pair (survives accept)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The quick brown fox\n" +
    "\\change_inserted 1 1700000000\n" +
    "QUICK\n" +
    "\\change_unchanged\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "a note\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl88_d2b_flatten_inset.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "NEW TEXT"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const lastUnchanged = text.lastIndexOf("\\change_unchanged");
    const insetPos = text.indexOf("\\begin_inset Foot");
    assertEquals(insetPos !== -1 && lastUnchanged !== -1, true, "inset and closer must be present");
    assertEquals(insetPos > lastUnchanged, true,
      "flatten must keep the inset outside the change pair (D2-b)");
    assertStringIncludes(text, "NEW TEXT");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// F3 (D4-a): a hard flag error must not carry the blast-radius warning.
Deno.test("DL88 F3 - INVALID_FLAG error carries no warnings", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\nAlpha\n\\end_layout\n" +
    "\\begin_layout Standard\nBeta\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl88_f3_warnings.lyx", body);
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliTest([
      "set", tempFile, "layout[Standard]", "X", "--track-changes", "off",
    ]);
    assertEquals(result.code, "INVALID_FLAG");
    assertEquals((result.warnings ?? []).length, 0,
      "an error response must not carry the blast-radius warning (D4-a)");
    const after = await Deno.readTextFile(tempFile);
    assertEquals(after, before, "no mutation may occur on a hard flag error");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 78: flatten tracked changes + snapshot undo ---

/** Write a minimal .lyx file with the given body content. */
async function writeTempLyx(name: string, body: string, header = ""): Promise<string> {
  const tempDir = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const tempPath = `${tempDir}/${name}`;
  await Deno.writeTextFile(tempPath,
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n" + header + "\\end_header\n" +
    "\\begin_body\n" + body + "\\end_body\n\\end_document\n"
  );
  return tempPath;
}

/** Children of the first layout in the document body. */
function firstLayoutChildren(text: string): Node[] {
  const ast = parse(text);
  const doc = ast.children.find(c => c.type === "block" && c.tag === "document") as BlockNode;
  const body = doc.children.find(c => c.type === "block" && c.tag === "body") as BlockNode;
  const layout = body.children.find(c => c.type === "block" && c.tag === "layout") as BlockNode;
  return layout.children;
}

function changeMarkers(children: Node[]): PropertyNode[] {
  return children.filter(c =>
    c.type === "property" && (c as PropertyNode).key.startsWith("change_")
  ) as PropertyNode[];
}

function allText(children: Node[]): string {
  return children.filter(c => c.type === "text").map(c => (c as TextNode).text).join("");
}

// Fixture with a pending change_inserted by Alice (id 1) spanning two text
// nodes — the shape that produces nested markers when re-edited.
const TRACKED_BODY =
  "\\begin_layout Standard\n" +
  "The quick brown fox\n" +
  "\\change_inserted 1 1700000000\n" +
  "QUICK\n" +
  "LY brown\n" +
  "\\change_unchanged\n" +
  " jumps over\n" +
  "\\end_layout\n";

Deno.test("DL78 Flatten - Same-Author Merge (timestamp updated)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl78_merge.lyx", TRACKED_BODY, "\\author 1 \"Alice\"\n");
  try {
    // Alice edits inside her own pending insertion: QUICK -> FAST
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "FAST", "--find", "QUICK"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);

    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    // Merged into a single flat block: one change_inserted + one change_unchanged
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_unchanged"]);
    const [aid, ts] = (markers[0].value || "").split(" ");
    assertEquals(aid, "1");
    assertEquals(parseInt(ts, 10) > 1700000000, true, "timestamp must update to max(old, new)");
    const text = allText(children);
    assertEquals(text.includes("FASTLY brown"), true, "inner content merged into outer block");
    assertEquals(text.includes("QUICK"), false, "same-author deletion of own insertion drops the text");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Flatten - Different-Author Split (adjacent flat blocks)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl78_split.lyx", TRACKED_BODY, "\\author 1 \"Alice\"\n");
  try {
    // Bob edits inside Alice's pending insertion: QUICK -> FAST
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "FAST", "--find", "QUICK"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);

    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    // Range-erase model (dev log 90): Bob's replacement is inserted at the
    // match start; Alice's pending text is marked DELETED by Bob (LyX
    // eraseChars re-authors the erased range). The \cd region is terminated
    // by the following \ci opener (flat model — one active Change per
    // position, no closer between different types).
    assertEquals(
      markers.map(m => m.key),
      ["change_inserted", "change_unchanged", "change_deleted", "change_inserted", "change_unchanged"],
    );
    assertEquals((markers[0].value || "").split(" ")[0], "2", "Bob's replacement first (id 2)");
    const text = allText(children);
    assertEquals(text.includes("FAST"), true);
    assertEquals(text.includes("QUICK"), true, "different-author pending text is preserved as deleted, not dropped");
    assertEquals(maxMarkerDepth(children), 1, "no nesting");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Flatten - Full-Replace on Tracked Node (properties preserved)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The \n\\emph on\nquick\n\\emph default\n brown fox\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_fullreplace.lyx", body);
  try {
    // Create pending tracked changes, then full-replace over them
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "BROWN", "--find", "brown"],
      { trackChanges: true },
    );
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "REPLACED"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\emph on", "inline properties must survive the flatten (dev log 79 N4)");
    // Properties stay IN PLACE inside the deleted region, not appended after
    // the change pair (test_report_38 F8 — matches LyX's own Paragraph::write
    // shape, so rejecting the change restores the original formatting).
    const deletedPos = text.indexOf("\\change_deleted");
    const insertedPos = text.indexOf("\\change_inserted");
    const emphPos = text.indexOf("\\emph on");
    assertEquals(deletedPos !== -1 && insertedPos !== -1 && emphPos !== -1, true,
      "deleted/inserted markers and \\emph must all be present");
    assertEquals(emphPos > deletedPos && emphPos < insertedPos, true,
      "\\emph must stay inside the deleted region, before the inserted region (test_report_38 F8)");
    const children = firstLayoutChildren(text);
    const keys = changeMarkers(children).map(m => m.key);
    // Flat: no change marker appears between an opener and its closer
    let depth = 0;
    for (const k of keys) {
      if (k === "change_unchanged") depth--;
      else {
        depth++;
        assertEquals(depth <= 1, true, "markers must not nest after full-replace flatten");
      }
    }
    assertEquals(keys.includes("change_inserted"), true);
    assertStringIncludes(text, "REPLACED");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 - Straddling --find now succeeds (range-erase, dev log 90)", { timeout: 15000 }, async () => {
  // A pending insertion mid-sentence: "word" is inserted, " plus" is current.
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "accepted word\n" +
    "\\change_unchanged\n" +
    " plus normal text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_straddle.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    // "word plus" spans the inserted block and the original text after it.
    // Previously refused as a straddle (DL78); now a valid range-erase edit.
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "word plus"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "straddling match must now succeed");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    // Same-author inserted part merges; the current part is marked deleted.
    assertStringIncludes(allText(children), "accepted X", "replacement merged at the match start");
    assertStringIncludes(allText(children), " plus", "current part of the erased range preserved as deleted");
    assertEquals(maxMarkerDepth(children), 1, "no nested markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Snapshot Undo - After Untracked Set (restores original)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOriginal text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_undo_set.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    await runCliTest(["set", tempFile, "layout[Standard]", "CHANGED"]);
    const undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.method, "snapshot");
    assertEquals(undone.undone_changes, 1);
    const restored = await Deno.readTextFile(tempFile);
    assertEquals(restored, expected, "undo after set must restore the original content (dev log 79 N2)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Snapshot Undo - After Insert (after + prepend)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nBase layout\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_undo_insert.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));

    await runCliTest(["insert", tempFile, "layout[Standard]", "after", "--layout", "Standard", "--text", "SIBLING"]);
    let undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.undone_changes, 1);
    assertEquals(await Deno.readTextFile(tempFile), expected, "undo after 'insert after' must restore (dev log 79 N3)");

    await runCliTest(["insert", tempFile, "layout[Standard]", "prepend", "--footnote", "FN"]);
    undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.undone_changes, 1);
    assertEquals(await Deno.readTextFile(tempFile), expected, "undo after 'insert prepend' must restore (dev log 79 N3)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Snapshot Undo - After Untracked Delete (node restored)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nKeep me\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_undo_delete.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    await runCliTest(["delete", tempFile, "layout[Standard]"]);
    const undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.undone_changes, 1);
    assertEquals(await Deno.readTextFile(tempFile), expected, "undo after delete must bring the node back (dev log 79 N3)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Snapshot Undo - 1-Level Enforcement + Consume", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOriginal\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_onelevel.lyx", body);
  try {
    await runCliTest(["set", tempFile, "layout[Standard]", "EDIT_A"]);
    await runCliTest(["set", tempFile, "layout[Standard]", "EDIT_B"]);
    // Undo reverts only the last mutation (EDIT_B); EDIT_A stays
    const undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.undone_changes, 1);
    let text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "EDIT_A");
    assertEquals(text.includes("EDIT_B"), false);
    // Snapshot consumed: a second undo is UNDO_STALE, not a redo
    const stale = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(stale.code, "UNDO_STALE");
    text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "EDIT_A", "stale undo must not redo or modify the file");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 - --find Inside change_deleted Matches (see-all, dev log 90)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "The quick brown fox\n" +
    "\\change_deleted 1 1700000000\n" +
    "lazy dog\n" +
    "\\change_unchanged\n" +
    " jumps over\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_deleted_nomatch.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    // Mutations see all text (dev log 90): --find on rejected text matches and
    // edits it — the replacement is inserted as a tracked change adjacent.
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "lazy dog"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "deleted text is a valid edit target under see-all");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "X", "replacement inserted");
    assertStringIncludes(text, "lazy dog", "rejected text preserved as deleted");
    assertEquals(
      result.warnings?.some(w => w.includes("change_deleted")),
      true,
      "deleted-hit warning fires so editing rejected text is not silent",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Replay Undo - Snapshot Symmetry (replay can be undone)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_replay_sym.lyx", body);
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "QUICK", "--find", "quick"],
      { trackChanges: true },
    );
    // Replay undo removes the inserted block and saves a snapshot
    await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "QUICK"],
      { trackChanges: true },
    );
    // Snapshot undo restores the pre-replay state — markers come back
    const restored = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true },
    );
    assertEquals(restored.method, "snapshot");
    assertEquals(restored.undone_changes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "QUICK");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL78 Replay Undo - Substring Still Works (regression)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_replay.lyx", body);
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "QUICK", "--find", "quick"],
      { trackChanges: true },
    );
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "QUICK"],
      { trackChanges: true },
    );
    assertEquals(undone.undone_changes, 1);
    assertEquals(undone.method, "replay");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes("QUICK"), false, "inserted block removed");
    assertStringIncludes(text, "\\change_deleted", "unrelated change_deleted block preserved");
    assertStringIncludes(text, "quick");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 84: flat change-state model on the LyX-standard replacement shape ---
// LyX emits \change_deleted{old}\change_inserted{new} with no \change_unchanged
// between them (one active Change per position). lq must treat an inserted
// opener as terminating any open deleted run (dev log 84 F1, implemented 85).

const ADJACENT_PAIR_BODY =
  "\\begin_layout Standard\n" +
  "I \n" +
  "\\change_deleted 1 1776668506\n" +
  "write\n" +
  "\\change_inserted 1 1776668507\n" +
  "edit\n" +
  "\\change_unchanged\n" +
  " something with tracked changes.\n" +
  "\\end_layout\n";

Deno.test("DL84 F1 - --find matches current text after adjacent delete+insert pair", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f1_find.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "EDIT", "--find", "edit"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "--find on current (inserted) text must match");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F1 - --find on deleted text now matches (see-all)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f1_deleted.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "write"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "deleted text matches under see-all");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "X", "replacement present");
    assertStringIncludes(text, "write", "deleted text preserved as deleted");
    assertStringIncludes(text, "edit", "adjacent inserted text untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F1 - split-after works on inserted text", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f1_split.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--text", "X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1, "split-after on inserted text must not SPLIT_NO_MATCH");
    assertStringIncludes(await Deno.readTextFile(tempFile), "X");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F1 - :contains finds the paragraph", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f1_contains.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliTest(["read", tempFile, "layout:contains('edit')", "--count"]);
    assertEquals(typeof result.count, "object");
    assertEquals((result.count as Record<string, number>)["layout[Standard]"], 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F1 - read annotations: inserted text labeled inserted, trailing unchanged", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f1_read.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliTest(["read", tempFile, "layout[Standard]"]);
    const node = (result.data as { children: Array<{ text?: string; changeStatus?: string }> }[])[0];
    const statusFor = (t: string) => node.children.find(c => c.text === t)?.changeStatus;
    assertEquals(statusFor("write"), "deleted");
    assertEquals(statusFor("edit"), "inserted");
    assertEquals(statusFor(" something with tracked changes."), undefined, "trailing text must not be mislabeled deleted");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F5 - replay undo reports separate regions for the adjacent pair", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl84_f5_replay.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "edit"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(undone.method, "replay");
    assertEquals(undone.undone_changes, 1);
    const labels = (undone.changes as { label: string }[]).map(c => c.label);
    assertEquals(labels, ["change_inserted{edit}"], "the pair must be two regions, not change_deleted{writeedit}");
    // Byte shape (code_review_85-74 Spec-1): the kept \change_deleted region
    // has no closer of its own (terminated by the \change_inserted), so when
    // that inserted region is undone a synthetic \change_unchanged must close
    // the deleted region — otherwise LyX's flat reader absorbs the trailing
    // text into it. Label/text-presence assertions alone let the corruption pass.
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "deleted region must be closed by a synthetic closer (mirror of test_report_36 F4)",
    );
    const text = allText(children);
    assertStringIncludes(text, "write");
    assertStringIncludes(text, " something with tracked changes.", "trailing text must survive outside the deleted region");
    assertEquals(text.includes("edit"), false);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 84 F3: same-author in-region edits unify to merge (Option A) ---

Deno.test("DL84 F3 - same-author match consuming whole region merges (not a pair)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n\\change_inserted 1 1700000000\nFIXED\n\\change_unchanged\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f3_whole.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "FIXEDX", "--find", "FIXED"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "full-consumption same-author match must merge, not emit a delete+insert pair",
    );
    const [aid, ts] = (markers[0].value || "").split(" ");
    assertEquals(aid, "1");
    assertEquals(parseInt(ts, 10) > 1700000000, true, "timestamp must update to max(old, new)");
    assertEquals(allText(children), "FIXEDX");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F3 - different-author full-consumption emits insert-then-delete (dev log 90)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n\\change_inserted 1 1700000000\nFIXED\n\\change_unchanged\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f3_whole_diff.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "FIXEDX", "--find", "FIXED"],
      { trackChanges: true, authorName: "Bob" },
    );
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_inserted", "change_unchanged", "change_deleted", "change_unchanged"],
      "insert-first (dev log 90): replacement at match start, old text deleted",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 84 F2: header snapshot makes tracked-mutation undo byte-exact ---

Deno.test("DL84 F2 - tracked set --find then snapshot undo is byte-exact (header restored)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nold text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f2_undo.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "NEW", "--find", "old"],
      cfg,
    );
    assertStringIncludes(await Deno.readTextFile(tempFile), "\\author");
    // Undo must run under the SAME config (same temp HOME) so it finds the
    // snapshot saved by the set command.
    const undone = await runCliWithConfig(["undo", tempFile, "layout[Standard]"], cfg);
    assertEquals(undone.method, "snapshot");
    assertEquals(
      await Deno.readTextFile(tempFile),
      expected,
      "tracked mutation undo must restore the file byte-identically, header included (dev log 84 F2)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F2 - tracked delete then snapshot undo is byte-exact (header restored)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nold text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f2_undo_delete.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(["delete", tempFile, "layout[Standard]"], cfg);
    assertStringIncludes(await Deno.readTextFile(tempFile), "\\author");
    const undone = await runCliWithConfig(["undo", tempFile, "layout[Standard]"], cfg);
    assertEquals(undone.method, "snapshot");
    assertEquals(
      await Deno.readTextFile(tempFile),
      expected,
      "tracked delete undo must restore the file byte-identically, header included",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F2 - untracked set undo stays byte-exact and counts only the body node", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nold text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f2_undo_untracked.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    await runCliTest(["set", tempFile, "layout[Standard]", "NEW", "--find", "old"]);
    const undone = await runCliTest(["undo", tempFile, "layout[Standard]"]);
    assertEquals(undone.method, "snapshot");
    assertEquals(undone.undone_changes, 1, "no-op header restore must not inflate the count");
    assertEquals(await Deno.readTextFile(tempFile), expected);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F2 - tracked insert --cite then snapshot undo is byte-exact (header restored)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nold text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f2_undo_cite.lyx", body);
  try {
    const expected = serialize(parse(await Deno.readTextFile(tempFile)));
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "append", "--cite", "Mena2000"],
      cfg,
    );
    assertStringIncludes(await Deno.readTextFile(tempFile), "\\author");
    const undone = await runCliWithConfig(["undo", tempFile, "layout[Standard]"], cfg);
    assertEquals(undone.method, "snapshot");
    assertEquals(
      await Deno.readTextFile(tempFile),
      expected,
      "tracked insert --cite undo must restore the file byte-identically, header included (code_review_85-74 Spec-4)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 84 F4: --footnote inserts LyX's status line ---

Deno.test("DL84 F4 - --footnote insert emits status line (untracked)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nBase\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f4_untracked.lyx", body);
  try {
    await runCliTest(["insert", tempFile, "layout[Standard]", "append", "--footnote", "A footnote"]);
    const text = await Deno.readTextFile(tempFile);
    const idx = text.indexOf("\\begin_inset Foot");
    assert(idx !== -1, "Foot inset must exist");
    const after = text.substring(idx + "\\begin_inset Foot".length).trimStart();
    assert(
      after.startsWith("status collapsed\n\n\\begin_layout Plain Layout"),
      "status line must precede the layout (dev log 84 F4)",
    );
    assertStringIncludes(text, "A footnote");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL84 F4 - --footnote insert emits status line (tracked)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nBase\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl84_f4_tracked.lyx", body);
  try {
    await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "append", "--footnote", "A footnote"],
      { trackChanges: true, authorName: "Alice" },
    );
    const text = await Deno.readTextFile(tempFile);
    const idx = text.indexOf("\\begin_inset Foot");
    assert(idx !== -1, "Foot inset must exist");
    const after = text.substring(idx + "\\begin_inset Foot".length).trimStart();
    assert(
      after.startsWith("status collapsed\n\n\\begin_layout Plain Layout"),
      "status line must precede the layout (dev log 84 F4)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 85: test_report_36 fixes ---
// F1: same-author --find on text inside a \change_inserted region that is
// immediately followed by \change_deleted (the LyX-native "insert then
// delete" adjacent shape) must not destroy the replacement or the deleted
// region. F2: split-after at a text-node boundary. F3: --find preserves
// empty text nodes. F4: replay undo preserves the shared closer. F5:
// header-less tracked mutations hard-error.

const ADJACENT_INSERT_DELETE_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 1 1700000000\n" +
  "X\n" +
  "\\change_deleted 1 1700000001\n" +
  "Z\n" +
  "\\change_unchanged\n" +
  " tail\n" +
  "\\end_layout\n";

/** Max change-marker depth of a node's children under the FLAT model (dev log
 * 90): a different-type opener terminates the open region (one active Change
 * per position), so adjacent different-type regions are depth 1 — only genuine
 * same-type nesting (or deleted-inside-inserted) exceeds 1. */
function maxMarkerDepth(children: Node[]): number {
  let deletedDepth = 0;
  let insertedDepth = 0;
  let max = 0;
  for (const m of changeMarkers(children)) {
    const d = advanceChangeDepths(m.key, deletedDepth, insertedDepth);
    deletedDepth = d.deletedDepth;
    insertedDepth = d.insertedDepth;
    const depth = deletedDepth + insertedDepth;
    if (depth > max) max = depth;
  }
  return max;
}

Deno.test("DL85 F1 - same-author --find on adjacent inserted→deleted shape preserves replacement + deleted region", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl85_f1_adjacent.lyx", ADJACENT_INSERT_DELETE_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "newValue", "--find", "X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged", "change_deleted", "change_unchanged"],
      "inserted region must be closed before the pre-existing deleted region (no nesting)",
    );
    const text = allText(children);
    assertStringIncludes(text, "newValue", "replacement text must survive");
    assertStringIncludes(text, "Z", "pre-existing deleted region must survive");
    assertStringIncludes(text, " tail", "trailing text must stay plain");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F1 - adjacent shape without trailing text: paragraph not wiped", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\nX\n" +
    "\\change_deleted 1 1700000001\nZ\n" +
    "\\change_unchanged\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f1_notail.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "newValue", "--find", "X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "newValue", "replacement must survive");
    assertStringIncludes(text, "Z", "deleted region must survive");
    assertEquals(maxMarkerDepth(children), 1, "no nested markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F1 - adjacent shape with other-author deleted region preserved", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\nX\n" +
    "\\change_deleted 2 1700000001\nZ\n" +
    "\\change_unchanged\n tail\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f1_other.lyx", body, "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n");
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "newValue", "--find", "X"],
      { trackChanges: true, authorName: "Alice" },
    );
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "newValue");
    assertStringIncludes(text, "Z", "other-author deleted region must survive");
    assertEquals(maxMarkerDepth(children), 1, "no nested markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F1 - --find on trailing text preserves the interleaved deleted region (no pending match at boundary)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl85_f1_tailfind.lyx", ADJACENT_INSERT_DELETE_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "newTail", "--find", "tail"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "X", "inserted region must survive");
    assertStringIncludes(text, "Z", "deleted region must survive");
    assertStringIncludes(text, "newTail");
    assertEquals(maxMarkerDepth(children), 1, "no nested markers");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F2 - split-after at a text-node boundary inserts after the match, not at block end", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nHello,\n world\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f2_split.lyx", body);
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]", "split-after", "Hello,", "--text", "INS"]);
    assertEquals(result.matched_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const idxHello = text.indexOf("Hello,");
    const idxIns = text.indexOf("INS");
    const idxWorld = text.indexOf(" world");
    assert(idxHello !== -1 && idxIns !== -1 && idxWorld !== -1, "all three fragments present");
    assert(idxHello < idxIns && idxIns < idxWorld, "INS must land between 'Hello,' and ' world' (test_report_36 F2)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F2 - split-after on tracked inserted text lands right after the match", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl85_f2_tracked.lyx", ADJACENT_PAIR_BODY, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--text", "INS"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const idxEdit = text.indexOf("edit");
    const idxIns = text.indexOf("INS");
    const idxSomething = text.indexOf(" something");
    assert(idxEdit !== -1 && idxIns !== -1 && idxSomething !== -1, "all fragments present");
    assert(idxEdit < idxIns && idxIns < idxSomething, "INS must land between 'edit' and ' something' (test_report_36 F2)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F3 - set --find preserves empty text nodes (blank lines in an ERT inset)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n" +
    "\\begin_inset ERT\n" +
    "status open\n" +
    "\n" +
    "\\backslash newcommand{foo}\n" +
    "\n" +
    "\\end_inset\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f3_ert.lyx", body);
  try {
    await runCliTest(["set", tempFile, "inset[ERT]", "NEW", "--find", "newcommand"]);
    const ast = parse(await Deno.readTextFile(tempFile));
    const doc = ast.children.find(c => c.type === "block" && c.tag === "document") as BlockNode;
    const bodyBlock = doc.children.find(c => c.type === "block" && c.tag === "body") as BlockNode;
    const layout = bodyBlock.children.find(c => c.type === "block" && c.tag === "layout") as BlockNode;
    const inset = layout.children.find(c => c.type === "block" && c.tag === "inset") as BlockNode;
    const emptyText = inset.children.filter(c => c.type === "text" && (c as TextNode).text === "");
    assertEquals(emptyText.length, 2, "blank spacer lines must survive the --find mutation (test_report_36 F3)");
    const joined = inset.children.filter(c => c.type === "text").map(c => (c as TextNode).text).join("|");
    assertStringIncludes(joined, "NEW{foo}");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F3 - set --find preserves an internal blank line in a paragraph (tracked)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nAlpha\n\nBeta\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f3_blank.lyx", body);
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "Alpha"],
      { trackChanges: true, authorName: "Alice" },
    );
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const emptyText = children.filter(c => c.type === "text" && (c as TextNode).text === "");
    assertEquals(emptyText.length, 1, "internal blank line must survive tracked --find (test_report_36 F3)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F4 - replay undo of deleted text on the adjacent shape preserves the shared closer", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl85_f4_undo.lyx", ADJACENT_INSERT_DELETE_BODY, "\\author 1 \"Alice\"\n");
  try {
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "Z"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(undone.method, "replay");
    assertEquals(undone.undone_changes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "shared closer must survive to close the inserted region (test_report_36 F4)",
    );
    const text = allText(children);
    assertStringIncludes(text, "X", "inserted region preserved");
    assertStringIncludes(text, "Z", "deleted text restored");
    assertStringIncludes(text, " tail", "trailing text plain");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F4 - mirror control: undo of inserted text on the insert→delete shape drops the closer cleanly", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl85_f4_undo_x.lyx", ADJACENT_INSERT_DELETE_BODY, "\\author 1 \"Alice\"\n");
  try {
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(undone.method, "replay");
    assertEquals(undone.undone_changes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "kept deleted region keeps its own closer; no orphan or spurious closer (DL85 F4 test 2)",
    );
    const text = allText(children);
    assertEquals(text.includes("X"), false, "undone inserted text removed");
    assertStringIncludes(text, "Z", "deleted text preserved");
    assertStringIncludes(text, " tail", "trailing text plain");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F4 - undo of deleted text on the \\change_unchanged-separated shape drops the closer, no spurious emission", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\nX\n" +
    "\\change_unchanged\n" +
    "\\change_deleted 1 1700000001\nZ\n" +
    "\\change_unchanged\n" +
    " tail\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl85_f4_sep.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "Z"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(undone.method, "replay");
    assertEquals(undone.undone_changes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "inserted region keeps its own closer; deleted region's closer dropped; no spurious closer (DL85 F4 test 3)",
    );
    const text = allText(children);
    assertStringIncludes(text, "X");
    assertStringIncludes(text, "Z", "deleted text restored");
    assertStringIncludes(text, " tail");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F5 - tracked mutation on a header-less document hard-errors and writes nothing", { timeout: 15000 }, async () => {
  const tempDir = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const tempFile = `${tempDir}/temp_dl85_f5_headerless.lyx`;
  await Deno.writeTextFile(tempFile,
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n"
  );
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "NEW", "--find", "Hello"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.code, "TRACKING_HEADER_MISSING");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes("\\change_"), false, "no tracked markers may be written (test_report_36 F5)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL85 F5 - untracked mutation on a header-less document still works", { timeout: 15000 }, async () => {
  const tempDir = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const tempFile = `${tempDir}/temp_dl85_f5_untracked.lyx`;
  await Deno.writeTextFile(tempFile,
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_body\n\\begin_layout Standard\nHello\n\\end_layout\n\\end_body\n\\end_document\n"
  );
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]", "NEW", "--find", "Hello"]);
    assertEquals(result.modified_nodes, 1);
    assertStringIncludes(await Deno.readTextFile(tempFile), "NEW");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 90: range-erase across tracked regions ---

Deno.test("DL90 F3 - --find spanning a deleted region erases one contiguous range (Spec-2)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "A\n" +
    "\\change_deleted 1 1700000000\n" +
    "B\n" +
    "\\change_unchanged\n" +
    "C\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_f3.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    // Under see-all the concatenation is "ABC" (deleted text occupies
    // positions), so the match spans current\u2192deleted\u2192current contiguously.
    // (The original Spec-2 "AC"-skipping-B scenario cannot occur under see-all
    // — that is exactly why the straddle guard is gone.)
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "ABC"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "spanning match succeeds");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    // Insert-first: \ci{X} then the whole erased range as one \cd{A B C}.
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_unchanged", "change_deleted", "change_unchanged"]);
    const text = allText(children);
    assertStringIncludes(text, "X");
    assertStringIncludes(text, "B", "interposed deleted text absorbed into the erased range");
    assertEquals(maxMarkerDepth(children), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - --find fully inside \\change_deleted splits the region flat (see-all)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "This is bad text\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_insidedeleted.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "terrible", "--find", "bad"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "rejected text is a valid edit target under see-all");
    const text = allText(firstLayoutChildren(await Deno.readTextFile(tempFile)));
    assertStringIncludes(text, "This is ", "pre-match rejected text survives");
    assertStringIncludes(text, "terrible", "replacement inserted adjacent");
    assertStringIncludes(text, "bad text", "matched rejected text preserved as deleted");
    assertEquals(maxMarkerDepth(firstLayoutChildren(await Deno.readTextFile(tempFile))), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - split-after inside a same-author inserted region merges (never nested)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "Title\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_splitins.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "Tit", "--text", " X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(changeMarkers(children).map(m => m.key), ["change_inserted", "change_unchanged"], "merged into one region");
    assertStringIncludes(allText(children), "Tit X", "payload merged into the region");
    assertEquals(maxMarkerDepth(children), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - split-after inside a different-author inserted region emits adjacent flat blocks", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "Title\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_splitdiff.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "Tit", "--text", " X"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    // Bob's block between Alice's region halves: \ci{A} Tit \ci{B} X \cu \ci{A} le \cu
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_inserted", "change_unchanged", "change_inserted", "change_unchanged"],
      "adjacent flat blocks, never nested",
    );
    assertStringIncludes(allText(children), "Tit Xle", "both parts present");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - split-after inside a deleted region splits flat (never nested)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "This is bad text\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_splitdel.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "This", "--text", " NEW"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1, "split-after reaches rejected text under see-all");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "NEW", "payload inserted");
    const children = firstLayoutChildren(text);
    assertEquals(maxMarkerDepth(children), 1, "flat, never nested");
    assertStringIncludes(allText(children), "This", "pre-split rejected text survives");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - :change(deleted) scoped --find touches only the rejected region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "and\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_scope_del.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(deleted)", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "scoped find matches the rejected phrase");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "X", "rejected 'and' replaced");
    // The current-text 'and' sits before any change marker — untouched.
    assertStringIncludes(text.split("\\change_")[0], "and", "current-text 'and' untouched");
    assertEquals((text.match(/and/g) || []).length, 2, "current + rejected 'and' both survive");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - :change(current) scoped --find touches only current text", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "and\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_scope_cur.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(current)", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "scoped find matches the current phrase");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "X", "current 'and' replaced");
    assertStringIncludes(text, "and", "rejected 'and' preserved");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - :change(inserted) scoped --find touches only the pending insertion", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "and\n" +
    "\\change_inserted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\change_deleted 1 1700000001\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_scope_ins.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(inserted)", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "scoped find matches only the inserted phrase");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const text = allText(children);
    assertStringIncludes(text, "X", "inserted 'and' replaced");
    assertStringIncludes(text.split("\\change_")[0], "and", "current-text 'and' untouched");
    // current + rejected 'and' survive; the inserted copy became X
    assertEquals((text.match(/and/g) || []).length, 2, "current + rejected 'and' both survive");
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged", "change_deleted", "change_unchanged"],
      "replacement stays inside one flat inserted region (same-author merge)",
    );
    assertEquals(maxMarkerDepth(children), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - text:change(deleted) + set --find is tracked, not swallowed", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "rejected old text\n" +
    "\\change_unchanged\n" +
    " current text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_baretext.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:change(deleted)", "X", "--find", "old"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "bare text node inside a deletion is editable");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted", "replacement is a tracked insert, not embedded in the deletion");
    assertStringIncludes(text, "X", "replacement present");
    assertStringIncludes(text, " current text", "current text untouched");
    assertEquals(maxMarkerDepth(firstLayoutChildren(text)), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL90 - split-after SPLIT_AMBIGUOUS resolved by :change(deleted)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "and\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl90_splitamb.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    // Without scoping the phrase exists in both current and rejected text.
    const ambiguous = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "and", "--text", " X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(ambiguous.code, "SPLIT_AMBIGUOUS", "phrase in both regions is ambiguous without scoping");
    assertStringIncludes(ambiguous.message!, ":change", "error names the escape hatch");
    // Scoped to the deleted region, the match is unique.
    const scoped = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]:change(deleted)", "split-after", "and", "--text", " X"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(scoped.matched_nodes, 1, "scoped split-after succeeds");
    assertStringIncludes(await Deno.readTextFile(tempFile), " X", "payload inserted in the rejected region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL91 - --find spanning an inset NO_MATCH names the blocker", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "A\n" +
    "\\begin_inset Foot\n" +
    "\\begin_layout Plain Layout\n" +
    "foot\n" +
    "\\end_layout\n" +
    "\\end_inset\n" +
    "B\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl91_inset.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    // "AB" exists only if the footnote is ignored — the match spans an inset.
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "AB"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.code, "NO_MATCH", "phrase spanning an inset cannot match");
    assertStringIncludes(result.message!, "spans an inset", "NO_MATCH names the inset blocker");
    assertStringIncludes(result.message!, "split the phrase", "NO_MATCH suggests the escape hatch");
    // File untouched.
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "A\n", "pre-match text intact");
    assertStringIncludes(text, "B\n", "post-match text intact");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});
