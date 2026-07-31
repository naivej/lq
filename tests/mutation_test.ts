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

async function createTempReproFixture(name: string): Promise<string> {
  const tempDir = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const tempPath = `${tempDir}/${name}`;
  await Deno.copyFile(REPRO_FIXTURE, tempPath);
  return tempPath;
}

Deno.test("Cross-Node --find (untracked)", async () => {
  const tempFile = await createTempReproFixture("temp_cross_find_untracked.lyx");
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
  const tempFile = await createTempReproFixture("temp_cross_find_tracked.lyx");
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
  const tempFile = await createTempReproFixture("temp_cross_split.lyx");
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
  const tempFile = await createTempReproFixture("temp_cross_contains.lyx");
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
    // Split into two adjacent flat blocks, one shared closer, no nesting
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_inserted", "change_unchanged"]);
    assertEquals((markers[0].value || "").split(" ")[0], "2", "Bob's block first (id 2)");
    assertEquals(markers[1].value, "1 1700000000", "Alice's remainder keeps author and timestamp");
    const text = allText(children);
    assertEquals(text.includes("FAST"), true);
    assertEquals(text.includes("QUICK"), false, "deletion of pending-inserted text drops it");
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

Deno.test("DL78 - Straddling --find Errors (not generic NO_MATCH)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nThe quick brown fox jumps over\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl78_straddle.lyx", body);
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "QUICK", "--find", "quick"],
      { trackChanges: true },
    );
    // "QUICK brown" spans the inserted block and the original text after it
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "QUICK brown"],
      { trackChanges: true },
    );
    assertEquals(result.code, "NO_MATCH");
    assertStringIncludes(result.message!, "spans across tracked-change boundaries");
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

Deno.test("DL78 - --find Inside change_deleted Is Invisible (NO_MATCH)", { timeout: 15000 }, async () => {
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
    // Deleted text is invisible to mutations: --find on it is a genuine
    // NO_MATCH (generic message, NOT the straddle error)
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X", "--find", "lazy dog"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.code, "NO_MATCH");
    assertStringIncludes(result.message!, "matched no occurrences");
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
