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
import { parse } from "../src/parser.ts";
import { query } from "../src/query.ts";
import { serialize } from "../src/serializer.ts";
import { BlockNode, Node, PropertyNode, TextNode } from "../src/ast.ts";
import { advanceChangeDepths } from "../src/text_utils.ts";
import { scanRegionEnd, flattenNestedChanges } from "../src/tracked_changes.ts";
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
    // The footnote must land inside layout[Title], before the Author layout —
    // not just anywhere in the file.
    const titleIdx = text.indexOf("\\begin_layout Title");
    const authorIdx = text.indexOf("\\begin_layout Author");
    const fnIdx = text.indexOf("\\begin_inset Foot");
    assert(titleIdx !== -1 && authorIdx !== -1 && fnIdx !== -1, "Title, Author and footnote must exist");
    assert(titleIdx < fnIdx && fnIdx < authorIdx,
      "footnote must be appended inside layout[Title], before Author");
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

Deno.test("Mutation Engine - Split-After explains block-target requirement", async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "Inserted phrase\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_split_after_text_target.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliTest([
      "insert",
      tempFile,
      "text:change(inserted)",
      "split-after",
      "Inserted",
      "--text",
      " X",
    ]);
    assertEquals(result.code, "INVALID_TARGET");
    assertStringIncludes(result.message!, "Select a layout or inset block");
    assertStringIncludes(result.message!, "text selectors cannot be split directly");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
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
  // Minimal clean fixture: no snapshot, no tracked changes. A selector-less
  // undo must be UNDO_STALE, never a replay fallback (dev log 102).
  const tempFile = await writeTempLyx(
    "temp_undo_clean.lyx",
    "\\begin_layout Standard\nClean text\n\\end_layout\n",
  );
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["undo", tempFile],
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

// --- DL98 F1 (user proofreading report): set --find must not pull an
// --- immediately-following inset inside the \change_deleted span. Accepting
// --- such a change deletes the inset (refs, citations, labels, notes, quotes).
// --- A match ending exactly at a text-node boundary before a block left the
// --- change region open across the inset — the \change_unchanged landed after
// --- \end_inset (applyCrossNodeReplace atom serialization; dev log 98).

const DL98_REF_INSET =
  "\\begin_inset CommandInset ref\n" +
  "LatexCommand ref\n" +
  'reference "sec:intro"\n' +
  "\n" +
  "\\end_inset\n";

const DL98_HEADER = '\\author 1 "lq user"\n';

Deno.test("DL98 F1 - --find before a ref inset keeps the inset current", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_ref.lyx",
    "\\begin_layout Standard\nSee Section\n" + DL98_REF_INSET + "\n for details.\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Section 2", "--find", "See Section"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\begin_inset CommandInset ref");
    assertEquals(deletedRegionContainsInset(text), false,
      "the ref inset must stay OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - --find before a citation inset keeps the inset current", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_citation.lyx",
    "\\begin_layout Standard\nSee\n" +
    "\\begin_inset CommandInset citation\n" +
    "LatexCommand citet\n" +
    'key "Einstein1905"\n' +
    'literal "false"\n' +
    "\n" +
    "\\end_inset\n" +
    "\n for details.\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Read", "--find", "See"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\begin_inset CommandInset citation");
    assertEquals(deletedRegionContainsInset(text), false,
      "the citation inset must stay OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - --find before a label inset keeps the inset current", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_label.lyx",
    "\\begin_layout Standard\nintro\n" +
    "\\begin_inset CommandInset label\n" +
    "LatexCommand label\n" +
    'name "sec:intro"\n' +
    "\n" +
    "\\end_inset\n" +
    "\n\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "introduction", "--find", "intro"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\begin_inset CommandInset label");
    assertEquals(deletedRegionContainsInset(text), false,
      "the label inset must stay OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - --find before a Note inset keeps the inset current", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_note.lyx",
    "\\begin_layout Standard\nintro note\n" +
    "\\begin_inset Note Note\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "PRIVATE secret\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "introduction", "--find", "intro note"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\begin_inset Note Note");
    assertEquals(deletedRegionContainsInset(text), false,
      "the Note inset must stay OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - --find before a closing-quote inset keeps the inset current", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_quote.lyx",
    "\\begin_layout Standard\nHe said\n" +
    "\\begin_inset Quotes erd\n" +
    "\\end_inset\n" +
    "\n to them.\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "They said", "--find", "He said"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\begin_inset Quotes erd");
    assertEquals(deletedRegionContainsInset(text), false,
      "the quote inset must stay OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - control: --find with trailing text before an inset stays correct", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_control.lyx",
    "\\begin_layout Standard\nSee Section~\n" + DL98_REF_INSET + "\n for details.\n\\end_layout\n",
    DL98_HEADER);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Section 2", "--find", "See Section"],
      { trackChanges: true },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertEquals(deletedRegionContainsInset(text), false,
      "trailing text must keep the ref inset OUTSIDE the \\change_deleted span");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL98 F1 - --find inside \\change_deleted before an inset keeps the inset in its original deleted region (DL106 A1)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl98_f1_deleted_inset.lyx",
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old text\n" + DL98_REF_INSET +
    "\\change_unchanged\n" +
    " rest\n" +
    "\\end_layout\n",
    '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "new", "--find", "old text"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    // DL106 A1: the erased run inside Alice's \\change_deleted keeps HER
    // author (Bob does not re-author the rejected text); only the replacement
    // is Bob's insert.
    assertStringIncludes(text, "\\change_inserted 2", "replacement is Bob's insert");
    assertStringIncludes(text, "\\change_deleted 1", "Alice's rejected run stays Alice's");
    assert(!text.includes("\\change_deleted 2"),
      "Bob must NOT re-author Alice's rejected text (DL106 A1)");
    // The inset keeps its ORIGINAL deleted region (Alice, id 1). LyX's
    // writer emits a direct same-type transition (\change_deleted 1) with no
    // closer between the two deleted runs — matching Paragraph::write. The
    // last \change_unchanged closes Alice's deleted region (the first closes
    // Bob's inserted run).
    const delAlice = text.indexOf("\\change_deleted 1");
    const insetPos = text.indexOf("\\begin_inset CommandInset ref");
    const unchangedPos = text.lastIndexOf("\\change_unchanged");
    assert(delAlice !== -1 && insetPos !== -1 && unchangedPos !== -1,
      "expected Alice-deleted, inset, unchanged in order");
    assert(delAlice < insetPos && insetPos < unchangedPos,
      "the inset must stay inside Alice's original \\change_deleted region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- DL106 B1/A1: --find inside another author's \change_deleted must NOT
// re-author the rejected run (preserve rejected author; replay-undo must not
// resurrect it) ---

Deno.test("DL106 B1 - Bob's --find inside Alice's \\change_deleted keeps Alice's author; Bob's replay-undo does not resurrect the rejected text", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl106_b1_reauthor.lyx",
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "Hello world\n" +
    "\\change_unchanged\n" +
    "\\change_inserted 1 1700000000\n" +
    "Alice's new text\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n",
    '\\author 1 "Alice"\n');
  try {
    // Bob edits the rejected phrase (see-all default, no scope).
    const setResult = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Hi", "--find", "Hello world"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(setResult.modified_nodes, 1);
    let text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted 2", "replacement is Bob's insert");
    assertStringIncludes(text, "\\change_deleted 1", "Alice's rejection keeps her author (DL106 A1)");
    assert(!text.includes("\\change_deleted 2"),
      "Bob must NOT re-author Alice's rejected text");
    const children = firstLayoutChildren(text);
    assertEquals(maxMarkerDepth(children), 1, "flat, never nested");

    // Bob's replay-undo removes only HIS insert; Alice's deletion survives.
    const undoResult = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(undoResult.undone_changes, 1, "only Bob's insert block is undone");
    text = await Deno.readTextFile(tempFile);
    assert(!text.includes("\\change_inserted 2"), "Bob's insert removed");
    assertStringIncludes(text, "\\change_deleted 1", "Alice's rejection survives Bob's undo");
    // The rejected text is still inside a deleted region — NOT resurrected as plain.
    const delPos = text.indexOf("\\change_deleted 1");
    const helloPos = text.indexOf("Hello world");
    assert(delPos !== -1 && helloPos !== -1 && delPos < helloPos,
      "Hello world must remain rejected text after Bob's undo");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL106 B1 - --find spanning deleted->current keeps the deleted part's author, re-authors the current part", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl106_b1_span.lyx",
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "Hello\n" +
    "\\change_unchanged\n" +
    " world\n" +
    "\\end_layout\n",
    '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Hi", "--find", "Hello world"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted 2", "replacement is Bob's insert");
    assertStringIncludes(text, "\\change_deleted 1", "deleted part keeps Alice's author");
    assertStringIncludes(text, "\\change_deleted 2", "current part re-authored to Bob");
    const delAlice = text.indexOf("\\change_deleted 1");
    const helloPos = text.indexOf("Hello");
    const delBob = text.indexOf("\\change_deleted 2");
    const worldPos = text.indexOf(" world");
    assert(delAlice !== -1 && helloPos !== -1 && delBob !== -1 && worldPos !== -1 &&
      delAlice < helloPos && helloPos < delBob && delBob < worldPos,
      "order: Alice-deleted{Hello} then Bob-deleted{ world}");
    // Flat: the two deleted runs are ADJACENT same-type regions (direct author
    // transition — LyX Paragraph::write), so no closer sits between them. The
    // maxMarkerDepth counter overcounts that legitimate flat shape as depth 2
    // (advanceChangeDepths), so assert the exact marker sequence instead.
    assertEquals(
      changeMarkers(firstLayoutChildren(text)).map(m => m.key),
      ["change_inserted", "change_deleted", "change_deleted", "change_unchanged"],
      "byte-exact (D-15A): inserted{Hi} then Alice-deleted{Hello} adjacent Bob-deleted{ world}, shared closer, final unchanged",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL106 B1 - same-author --find inside own \\change_deleted keeps the same author (guard)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl106_b1_sameauthor.lyx",
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "Hello world\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n",
    '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Hi", "--find", "Hello world"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted 1", "replacement is Alice's insert");
    assertStringIncludes(text, "\\change_deleted 1", "rejected run stays Alice's");
    assert(!text.includes("\\change_deleted 2") && !text.includes("\\change_inserted 2"),
      "no second author introduced");
    assertEquals(maxMarkerDepth(firstLayoutChildren(text)), 1, "flat, never nested");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 120: adjacent same-type tracked regions (test_report_53 Bug A) ---
// LyX writes a marker at every Change-state transition (Changes.cpp::lyxMarkChange),
// including same-type different-author transitions — so `ci 1{...} ci 2{...} cu`
// and `cd 1{...} cd 2{...} cu` are valid flat input. The flat-mode region scanner
// used to treat the same-type opener as NESTED (depth++), merging the regions:
// replay-undo then removed BOTH authors' text (A1) or was a false no-op (A2),
// and the shared closer was dropped on the deleted variant (A3).

const ADJACENT_CI_CI_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 1 1700000000\n" +
  "Alice's text\n" +
  "\\change_inserted 2 1700000001\n" +
  "Bob's text\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

const ADJACENT_CI_CD_SPAN_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 2 1700000001\n" +
  "Hi\n" +
  "\\change_unchanged\n" +
  "\\change_deleted 1 1700000000\n" +
  "Hello\n" +
  "\\change_deleted 2 1700000001\n" +
  " world\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

Deno.test("DL120 A1 - first author's replay-undo on adjacent same-type inserts removes ONLY their own region (no data loss)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl120_a1.lyx", ADJACENT_CI_CI_BODY, '\\author 1 "Alice"\n\\author 2 "Bob"\n');
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 1, "only Alice's insert is undone");
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    // Bob's region survives, self-contained: ci 2{Bob's text} cu
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "Bob's region intact with its own closer",
    );
    assertEquals(changeMarkers(children)[0].value?.split(" ")[0], "2", "surviving region is Bob's (author 2)");
    assertEquals(allText(children), "Bob's text", "Bob's inserted text is not lost");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL120 A2 - second author's replay-undo on adjacent same-type inserts undoes exactly their region (no false no-op)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl120_a2.lyx", ADJACENT_CI_CI_BODY, '\\author 1 "Alice"\n\\author 2 "Bob"\n');
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.undone_changes, 1, "Bob's insert is undone");
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    // Alice's kept region must be closed by a synthetic closer — not leak open.
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "Alice's region survives, closed",
    );
    assertEquals(changeMarkers(children)[0].value?.split(" ")[0], "1", "surviving region is Alice's (author 1)");
    assertEquals(allText(children), "Alice's text", "Alice's text survives");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL120 A3 - replay-undo on the DL106 spanning shape removes Bob's insert AND his deletion (world restored as plain)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl120_a3.lyx", ADJACENT_CI_CD_SPAN_BODY, '\\author 1 "Alice"\n\\author 2 "Bob"\n');
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.undone_changes, 2, "Bob's insert and his deletion both undone");
    const text = await Deno.readTextFile(tempFile);
    assert(!text.includes("change_inserted"), "Bob's insert removed");
    // Only Alice's closed deleted region remains; Bob's " world" is plain
    // current text AFTER that region's closer, not absorbed into it.
    const cdPos = text.indexOf("\\change_deleted");
    const worldPos = text.indexOf(" world");
    const cuPos = text.indexOf("\\change_unchanged");
    assert(cdPos !== -1 && worldPos !== -1 && cuPos !== -1, "markers and world present");
    assert(cdPos < worldPos && worldPos > cuPos, "world must sit after the deleted region's closer (plain text)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL120 A4 - plain set consumes the author's own pending insert next to a co-author's (flat, no nesting)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl120_a4.lyx", ADJACENT_CI_CI_BODY, '\\author 1 "Alice"\n\\author 2 "Bob"\n');
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Bob's replacement"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    // Alice's text re-authored as Bob's deletion; Bob's own pending insert consumed.
    assertStringIncludes(text, "\\change_deleted 2", "Alice's text becomes Bob's deletion");
    assert(!text.includes("\\change_deleted 1"), "no author-1 deletion remains (re-authored)");
    assert(!text.includes("Bob's text"), "Bob's own pending insert consumed");
    assertStringIncludes(text, "\\change_inserted 2", "replacement inserted by Bob");
    assertStringIncludes(allText(children), "Bob's replacement");
    // Flat, exact marker sequence — no nesting on the adjacent shape. The
    // deleted region and the insert share ONE closer (LyX writes a marker
    // only at a (type, author) transition; dev log 122 F2 decision A —
    // plain set now matches the --find path's byte-exact shared-closer form).
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_deleted", "change_inserted", "change_unchanged"],
      "byte-exact: Bob-deleted{Alice} ci 2{replacement} cu (shared closer)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL120 - scanRegionEnd flat mode keeps one region per (type, author) run (LyX reader merge semantics)", () => {
  const mk = (key: string, value: string | undefined): PropertyNode => ({ type: "property", key, value });
  const text = (t: string): TextNode => ({ type: "text", text: t });
  const cu = mk("change_unchanged", undefined);

  // ci 1 / Alice / ci 2 / Bob / cu — same-type different-author → boundary
  const ciCi = [mk("change_inserted", "1 1700000000"), text("Alice"), mk("change_inserted", "2 1700000001"), text("Bob"), cu];
  assertEquals(scanRegionEnd(ciCi, 1, "change_inserted", true), { closer: -1, nextOpener: 2 },
    "same-type different-author opener ends the region");

  // ci 1 / A / ci 1 <ts2> / B / cu — same author, newer timestamp → NOT a
  // boundary: LyX merges same-author regions regardless of timestamp
  // (Changes::merge/isSimilarTo — dev log 120 D2C)
  const ciCiTs = [mk("change_inserted", "1 1700000000"), text("A"), mk("change_inserted", "1 1700000002"), text("B"), cu];
  assertEquals(scanRegionEnd(ciCiTs, 1, "change_inserted", true), { closer: 4, nextOpener: -1 },
    "same-type same-author opener (any timestamp) continues the region");

  // cd 1 / Hello / cd 2 / world / cu — deleted variant
  const cdCd = [mk("change_deleted", "1 1700000000"), text("Hello"), mk("change_deleted", "2 1700000001"), text(" world"), cu];
  assertEquals(scanRegionEnd(cdCd, 1, "change_deleted", true), { closer: -1, nextOpener: 2 },
    "same-type different-author deleted opener ends the region");

  // Byte-identical repeated opener (same type+author+ts) is NOT a boundary (nested)
  const identical = [mk("change_inserted", "1 1700000000"), mk("change_inserted", "1 1700000000"), text("x"), cu, cu];
  assertEquals(scanRegionEnd(identical, 1, "change_inserted", true), { closer: 3, nextOpener: -1 },
    "identical-state opener is not a boundary");

  // Different-type opener still ends the region (DL84 F1 behavior preserved)
  const ciCd = [mk("change_inserted", "1 1700000000"), text("A"), mk("change_deleted", "1 1700000001"), text("D")];
  assertEquals(scanRegionEnd(ciCd, 1, "change_inserted", true), { closer: -1, nextOpener: 2 },
    "different-type opener ends the region");
});

// --- Dev log 121 item 15: flatten flat-model rework (D-15A) ---

Deno.test("DL121 15 - flatten passes flat interleave sharing one closer through verbatim (byte-exact)", () => {
  const mk = (key: string, value: string | undefined): PropertyNode => ({ type: "property", key, value });
  const text = (t: string): TextNode => ({ type: "text", text: t });
  const cu = mk("change_unchanged", undefined);
  const keys = (nodes: Node[]): string[] => nodes.map(n => n.type === "property" ? n.key : "text");

  // Pre-existing adjacent ci{X} cd{Z} (dev log 85 Finding 1): the inserted
  // region is boundary-terminated by the different-type opener and must stay
  // open (shared closer) — NOT be normalized into the old self-contained
  // `ci{X} cu cd{Z} cu`.
  const interleave: Node[] = [
    mk("change_inserted", "1 1700000000"), text("X"),
    mk("change_deleted", "2 1700000001"), text("Z"), cu,
  ];
  assertEquals(
    keys(flattenNestedChanges(interleave)),
    ["change_inserted", "text", "change_deleted", "text", "change_unchanged"],
    "adjacent ci/cd flat interleave passes through byte-exact (no synthetic closer)",
  );

  // Same-type different-author adjacent inserts sharing one closer also pass
  // through: ci 1{A} ci 2{B} cu — one region per (type, author) run (D2C).
  const ciCiShared: Node[] = [
    mk("change_inserted", "1 1700000000"), text("A"),
    mk("change_inserted", "2 1700000001"), text("B"), cu,
  ];
  assertEquals(
    keys(flattenNestedChanges(ciCiShared)),
    ["change_inserted", "text", "change_inserted", "text", "change_unchanged"],
    "same-type different-author adjacent regions pass through (no closer between)",
  );
});

Deno.test("DL121 15 - flatten merges same-author nested opener (DL78 rule, ts = max)", () => {
  const mk = (key: string, value: string | undefined): PropertyNode => ({ type: "property", key, value });
  const text = (t: string): TextNode => ({ type: "text", text: t });
  const cu = mk("change_unchanged", undefined);

  // ci 1<100> / A / ci 1<200> / B / cu — same-author double opener (mutation
  // artifact): merged into one region, ts = max(100, 200).
  const nested: Node[] = [
    mk("change_inserted", "1 1700000100"), text("A"),
    mk("change_inserted", "1 1700000200"), text("B"), cu,
  ];
  const out = flattenNestedChanges(nested);
  assertEquals(
    out.map(n => n.type === "property" ? n.key : "text"),
    ["change_inserted", "text", "text", "change_unchanged"],
    "same-author double opener collapses to a single region",
  );
  const openers = out.filter((n): n is PropertyNode => n.type === "property" && n.key === "change_inserted");
  assertEquals(openers.length, 1, "double opener collapsed to one");
  assertEquals(openers[0].value, "1 1700000200", "timestamp becomes max(old, new)");
  assertEquals(
    out.filter(n => n.type === "text").map(n => (n as TextNode).text),
    ["A", "B"],
    "content absorbed in order",
  );
});

Deno.test("DL120 D4 - inserted_blocks counts payload blocks independent of tracking (restores DL26)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nBase\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl120_d4.lyx", body);
  try {
    const untracked = await runCliTest(["insert", tempFile, "layout[Standard]", "append", "--label", "sec:probe"]);
    const tracked = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "append", "--label", "sec:probe2"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(untracked.matched_nodes, 1);
    assertEquals(tracked.matched_nodes, 1);
    assertEquals(untracked.inserted_blocks, 1, "untracked single inset = 1 block");
    assertEquals(tracked.inserted_blocks, 1, "tracked single inset = 1 block (DL26 contract, not 3)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- DL99 F2: notes visibility (dev log 99) — CLI-level behavior ---

const DL99_NOTE_BODY =
  "\\begin_layout Standard\n" +
  "Visible alpha.\n" +
  "\\begin_inset Note Note\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "PRIVATE SECRET note\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "Visible beta.\n" +
  "\\end_layout\n";

const DL99_DUPLICATE_NOTE_BODY =
  DL99_NOTE_BODY +
  "\\begin_layout Standard\n" +
  "PRIVATE SECRET note\n" +
  "\\end_layout\n";

Deno.test("DL99 - --find on a visible layout does not leak into a note", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl99_find.lyx", DL99_NOTE_BODY, "\\textclass article\n");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]:first", "X", "--find", "PRIVATE SECRET"]);
    assertEquals(result.code, "NO_MATCH");
    // DL99 §3.5: the error names the note so the agent can opt in.
    assertStringIncludes(result.message!, "exists only inside a private note");
    assertStringIncludes(result.message!, ":note");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - --find NO_MATCH without a note-only phrase carries no note hint", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl99_find_nohint.lyx", DL99_NOTE_BODY, "\\textclass article\n");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]:first", "X", "--find", "NOWHERE AT ALL"]);
    assertEquals(result.code, "NO_MATCH");
    assertEquals((result.message ?? "").includes("exists only inside a private note"), false);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - no-match hint requires the phrase to be private-only", { timeout: 15000 }, async () => {
  const findFile = await writeTempLyx("temp_dl99_find_duplicate.lyx", DL99_DUPLICATE_NOTE_BODY, "\\textclass article\n");
  const splitFile = await writeTempLyx("temp_dl99_split_duplicate.lyx", DL99_DUPLICATE_NOTE_BODY, "\\textclass article\n");
  try {
    const findResult = await runCliTest(["set", findFile, "layout[Standard]:first", "X", "--find", "PRIVATE SECRET"]);
    assertEquals(findResult.code, "NO_MATCH");
    assertEquals((findResult.message ?? "").includes("exists only inside a private note"), false);

    const splitResult = await runCliTest(["insert", splitFile, "layout[Standard]:first", "split-after", "PRIVATE SECRET", "--text", "Y"]);
    assertEquals(splitResult.code, "SPLIT_NO_MATCH");
    assertEquals((splitResult.message ?? "").includes("exists only inside a private note"), false);
  } finally {
    try { await Deno.remove(findFile); } catch { /* ignore */ }
    try { await Deno.remove(splitFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - split-after on a visible layout does not leak into a note (trap fix)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl99_split.lyx", DL99_NOTE_BODY, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]:first", "split-after", "PRIVATE SECRET", "--text", "Y"]);
    assertEquals(result.code, "SPLIT_NO_MATCH");
    // DL99 §3.5: the error names the note so the agent can opt in.
    assertStringIncludes(result.message!, "exists only inside a private note");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes("\\nY"), false, "must not insert into the note");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - split-after on a note layout still matches note prose", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl99_split_note.lyx", DL99_NOTE_BODY, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "inset[Note Note] layout[Plain Layout]", "split-after", "PRIVATE SECRET", "--text", "Y"]);
    assertEquals(result.code, undefined);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "Y");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - read --text-only on a visible layout collapses the note to a marker", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl99_textonly.lyx", DL99_NOTE_BODY, "\\textclass article\n");
  try {
    const result = await runCliTest(["read", tempFile, "layout[Standard]:first", "--text-only"]);
    assertStringIncludes(result.text!, "inset[Note Note]");
    assertEquals((result.text ?? "").includes("PRIVATE SECRET"), false);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - footnote split-after workflow keeps working (Foot is not a note)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "Before\n" +
    "\\begin_inset Foot\n" +
    "status open\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "footnote text\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    " after.\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl99_footnote.lyx", body, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]:first", "split-after", "footnote text", "--text", "Y"]);
    assertEquals(result.code, undefined);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "Y");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL99 - dump --toc excludes note headings and note text inside headings", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Section\n" +
    "Visible Heading\n" +
    "\\end_layout\n" +
    "\n" +
    "\\begin_layout Standard\n" +
    "\\begin_inset Note Note\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Section\n" +
    "Hidden Note Section\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    "\\end_layout\n" +
    "\n" +
    "\\begin_layout Section\n" +
    "Heading with\n" +
    "\\begin_inset Note Note\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "LEAK NOTE TEXT\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl99_toc.lyx", body, "\\textclass article\n");
  try {
    const result = await runCliTest(["dump", tempFile, "--toc"]);
    const data = JSON.stringify(result.data);
    assertEquals(data.includes("Hidden Note Section"), false);
    assertEquals(data.includes("LEAK NOTE TEXT"), false);
    assertEquals(data.includes("Visible Heading"), true);
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

Deno.test("Report 42 F2 - scoped split-after reaches deleted Foot prose", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "Details about me and more\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\change_unchanged\n" +
    "current text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f2_nested_split.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      [
        "insert",
        tempFile,
        "inset[Foot]:change(deleted)",
        "split-after",
        "Details about me",
        "--text",
        " X",
      ],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "Details about me");
    assertStringIncludes(text, " X");
    assertStringIncludes(text, "and more");
    assert(text.indexOf("status collapsed") < text.indexOf("\\change_inserted"));
    const parsed = parse(text);
    const nestedDeleted = query(parsed, "text:change(deleted)");
    assertEquals(
      nestedDeleted.some(n => n.type === "text" && n.text.trim() === "and more"),
      true,
      "trailing nested prose must retain the enclosing deleted state",
    );
    const nestedLayout = query(parsed, "layout[Plain Layout]")[0] as BlockNode;
    assertEquals(maxMarkerDepth(nestedLayout.children), 1, "nested markers must remain flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Report 42 F2 - property-scoped split-after reaches styled Foot prose", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "foot content\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f2_nested_property_split.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      [
        "insert",
        tempFile,
        "inset[Foot]:property(emph)",
        "split-after",
        "foot content",
        "--text",
        " Y",
      ],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "foot content");
    assertStringIncludes(text, " Y");
    assertStringIncludes(text, "\\change_inserted");
    assert(text.indexOf("\\emph on") < text.indexOf("\\begin_inset Foot"));
    assert(text.indexOf("\\emph default") > text.indexOf("\\end_inset"));
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Report 42 F2 - nested deleted text --find stays tracked", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "Details about me\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\change_unchanged\n" +
    "current text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f2_nested_find.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:change(deleted)", "TAIL", "--find", "Details about me"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "Details about me");
    assertStringIncludes(text, "TAIL");
    assertStringIncludes(text, "\\change_inserted");
    const nestedLayout = query(parse(text), "layout[Plain Layout]")[0] as BlockNode;
    assertEquals(maxMarkerDepth(nestedLayout.children), 1, "nested markers must remain flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});


// --- Dev log 87: Step 3 fixes (test_report_38 F5-F7) ---
Deno.test("Report 42 F2 - nested styled text --find stays inside the style scope", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "foot content\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f2_nested_property_find.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:property(emph)", "TAIL", "--find", "foot content"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "foot content");
    assertStringIncludes(text, "TAIL");
    assertStringIncludes(text, "\\change_inserted");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});


Deno.test("Report 42 F1 - direct nested full set stays tracked", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "old nested text\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\change_unchanged\n" +
    "current text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f1_nested_full.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:change(deleted)", "NEW nested text"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "old nested text");
    assertStringIncludes(text, "NEW nested text");
    assertStringIncludes(text, "\\change_inserted");
    const nestedLayout = query(parse(text), "layout[Plain Layout]")[0] as BlockNode;
    assertEquals(maxMarkerDepth(nestedLayout.children), 1, "nested markers must remain flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

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
    assertEquals(msg.includes("lq init --author-name"), false, "must not suggest changing the author config without approval (dev log 102 D4)");
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

/**
 * True if any \begin_inset sits between a \change_deleted opener and the marker
 * that ends its region (\change_unchanged or a different-type opener). Used by
 * the DL98 F1 tests to catch set --find pulling a following inset inside the
 * \change_deleted span (accepting such a change would delete the inset).
 */
function deletedRegionContainsInset(text: string): boolean {
  const markers = [...text.matchAll(/\\change_(deleted|inserted|unchanged)\b/g)];
  for (let i = 0; i < markers.length; i++) {
    if (markers[i][1] !== "deleted") continue;
    const start = markers[i].index! + markers[i][0].length;
    for (let j = i + 1; j < markers.length; j++) {
      const kind = markers[j][1];
      if (kind === "unchanged" || kind === "inserted") {
        if (text.slice(start, markers[j].index!).includes("\\begin_inset")) return true;
        break;
      }
    }
  }
  return false;
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
    // eraseChars re-authors the erased range). Byte-exact (D-15A, dev log
    // 121): no closer between the inserted replacement and the adjacent
    // deleted region — LyX writes a marker only at a (type, author) transition.
    assertEquals(
      markers.map(m => m.key),
      ["change_inserted", "change_deleted", "change_inserted", "change_unchanged"],
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
    const undone = await runCliTest(["undo", tempFile]);
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
    let undone = await runCliTest(["undo", tempFile]);
    assertEquals(undone.undone_changes, 1);
    assertEquals(await Deno.readTextFile(tempFile), expected, "undo after 'insert after' must restore (dev log 79 N3)");

    await runCliTest(["insert", tempFile, "layout[Standard]", "prepend", "--footnote", "FN"]);
    undone = await runCliTest(["undo", tempFile]);
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
    const undone = await runCliTest(["undo", tempFile]);
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
    const undone = await runCliTest(["undo", tempFile]);
    assertEquals(undone.undone_changes, 1);
    let text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "EDIT_A");
    assertEquals(text.includes("EDIT_B"), false);
    // Snapshot consumed: a second undo is UNDO_STALE, not a redo
    const stale = await runCliTest(["undo", tempFile]);
    assertEquals(stale.code, "UNDO_STALE");
    text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "EDIT_A", "stale undo must not redo or modify the file");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("User report - snapshot undo never falls back to replay (DL94)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nThe quick brown fox\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_user_report_snapshot_fallback.lyx", body);
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "QUICK", "--find", "quick"],
      { trackChanges: true, authorName: "Alice" },
    );
    const tracked = await Deno.readTextFile(tempFile);
    await Deno.writeTextFile(tempFile, tracked + "\n");
    const beforeUndo = await Deno.readTextFile(tempFile);

    // Selector-less undo is snapshot mode: a missing/unusable snapshot must
    // fail closed (UNDO_SNAPSHOT_UNAVAILABLE), never reinterpret as replay.
    const result = await runCliWithConfig(
      ["undo", tempFile],
      { trackChanges: true, authorName: "Alice" },
    );

    assertEquals(result.code, "UNDO_SNAPSHOT_UNAVAILABLE");
    assertEquals(await Deno.readTextFile(tempFile), beforeUndo);
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
      ["undo", tempFile],
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

// --- Dev log 102: undo syntax redesign (mode by selector position) ---

Deno.test("DL102 - replay-all (selector, no substring) reverts only the current author", { timeout: 15000 }, async () => {
  // Mixed tracked edits by Alice (1) and Bob (2) in one paragraph. Alice runs
  // replay-all with no substring — only Alice's regions must revert.
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "ALICE EDIT\n" +
    "\\change_unchanged\n" +
    " base text " +
    "\\change_inserted 2 1700000001\n" +
    "BOB EDIT\n" +
    "\\change_unchanged\n" +
    "\\change_deleted 2 1700000002\n" +
    "BOB GONE\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_replay_all.lyx", body, "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.method, "replay");
    assertEquals(result.undone_changes, 1, "only Alice's inserted region is undone");
    const text = await Deno.readTextFile(tempFile);
    assertEquals(text.includes("ALICE EDIT"), false, "Alice's inserted region removed");
    assertStringIncludes(text, "BOB EDIT", "Bob's inserted region untouched");
    assertStringIncludes(text, "BOB GONE", "Bob's deleted region untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL102 - no-substring replay on nodes with no tracked changes reports nothing-here", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nClean paragraph\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_none_here.lyx", body);
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 0);
    assertEquals(result.method, "replay");
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "No tracked changes found in the matched nodes.", "must report nothing-here, not author mismatch");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL102 - no-substring replay on other-author-only nodes reports nothing-of-yours", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "ALICE EDIT\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_none_yours.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.undone_changes, 0);
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "none belong to author 'Bob'", "must report nothing-of-yours");
    assertEquals(msg.includes("lq init --author-name"), false, "must not suggest changing the author config (dev log 102 D4)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL102 - replay-all warns on multi-node blast radius and suggests undo", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "EDIT ONE\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n" +
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000001\n" +
    "EDIT TWO\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_blast.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 2);
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "Selector matches 2 nodes", "multi-node replay must warn");
    assertStringIncludes(msg, "To undo this undo, run 'lq undo", "warning must suggest the recovery path");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL102 - snapshot restore reports per-entry changes labels (untracked)", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOriginal text here\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_snap_labels.lyx", body);
  try {
    await runCliTest(["set", tempFile, "layout[Standard]", "CHANGED"]);
    const undone = await runCliTest(["undo", tempFile]);
    assertEquals(undone.method, "snapshot");
    assertEquals(undone.undone_changes, 1);
    const labels = (undone.changes as { label: string }[]).map(c => c.label);
    assertEquals(labels.length, 1, "untracked set: only the body node is a content-changing entry");
    assertStringIncludes(labels[0], "restored");
    assertStringIncludes(labels[0], "Original text here");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL102 - tracked snapshot restore labels the header entry", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOld text\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl102_snap_header.lyx", body);
  try {
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(["set", tempFile, "layout[Standard]", "NEW"], cfg);
    const undone = await runCliWithConfig(["undo", tempFile], cfg);
    assertEquals(undone.method, "snapshot");
    const labels = (undone.changes as { label: string }[]).map(c => c.label);
    assert(labels.includes("header"), "header restore must be labeled (dev log 102 D1b)");
    assertEquals(undone.undone_changes, labels.length, "count must match label count (header kept in both)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 103: replay diagnostic message accuracy (test_report_47 F1-F3) ---

Deno.test("DL103 F1 - substring replay blast-radius warning names how many nodes had reverts", { timeout: 15000 }, async () => {
  // Selector matches 3 nodes but the substring hits only one region in one of
  // them — the warning must say "reverted in 1 of them", not "all of them".
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "ALICE EDIT ONE\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n" +
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000001\n" +
    "ALICE EDIT TWO\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n" +
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000002\n" +
    "ALICE EDIT THREE\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f1_blast.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]", "EDIT TWO"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 1, "only the substring-matching region is undone");
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "Selector matches 3 nodes", "multi-node selector must still warn");
    assertStringIncludes(msg, "reverted in 1 of them", "must name the actual node count, not 'all of them' (dev log 103 F1)");
    assertEquals(msg.includes("all of them"), false, "must not overstate the blast radius");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F2 - no-substring replay on nested tracked changes reports refine-selector, not author mismatch", { timeout: 15000 }, async () => {
  // The change is Alice's but lives one level down, inside a Foot inset. The
  // matched outer block has no direct change markers, so replay cannot reach
  // it — the message must say nested/refine, not "none belong to author".
  const body =
    "\\begin_layout Standard\n" +
    "Body text\n" +
    "\\begin_inset Foot\n" +
    "status open\n" +
    "\\begin_layout Plain Layout\n" +
    "\\change_inserted 1 1700000000\n" +
    "FOOTNOTE INSERT\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n" +
    "\\end_inset\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f2_nested.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "inset[Foot]"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 0);
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "nested inside an inset/layout", "must identify nesting, not author mismatch");
    assertStringIncludes(msg, "layout[Plain Layout]", "must point at the innermost-layout refinement");
    assertEquals(msg.includes("none belong to author"), false, "must not claim an author mismatch");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F3 - replay on text-only selector reports blocks-only, not 'no tracked changes'", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "ALICE EDIT\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f3_text.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["undo", tempFile, "text:change(inserted)"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.undone_changes, 0);
    const msg = (result.warnings || []).join(" ");
    assertStringIncludes(msg, "operates on layout/inset blocks", "must explain replay only processes blocks");
    assertStringIncludes(msg, "layout[Standard]", "must suggest a block selector");
    assertEquals(msg.includes("No tracked changes found"), false, "must not claim the matched text has no tracked changes");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 103 F4: wholesale set matches LyX's per-position overwrite model ---
// LyX's Paragraph::eraseChar preserves rejected (\change_deleted) text of any
// author, re-marks a co-author's pending insert as the current author's
// deletion, and physically consumes the current author's own pending insert.

Deno.test("DL103 F4 - wholesale set preserves another author's rejected (deleted) text", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "ALICE REJECTED THIS\n" +
    "\\change_unchanged\n" +
    " plain original \n" +
    "\\change_inserted 1 1700000001\n" +
    "ALICE INSERTED THIS\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f4_preserve.lyx", body, "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "BOB REWRITE"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    // Bob's deleted region (re-author of plain + Alice's pending insert) comes
    // first; Alice's rejected region is preserved verbatim as author 1; Bob's
    // new value is inserted by author 2.
    assert(markers.length >= 6, "expect deleted2/unchanged/deleted1/unchanged/inserted2/unchanged");
    assertStringIncludes(markers[0].value!, "2 ", "first region is Bob's re-authored deletion");
    const bobDeleted = allText(children.slice(children.indexOf(markers[0]) + 1, children.indexOf(markers[1])));
    assertStringIncludes(bobDeleted, "plain original", "plain text re-authored under Bob");
    assertStringIncludes(bobDeleted, "ALICE INSERTED THIS", "co-author's pending insert re-marked under Bob (LyX eraseChar)");
    assertStringIncludes(markers[2].value!, "1 ", "Alice's rejected region preserved with her author id");
    const aliceRejected = allText(children.slice(children.indexOf(markers[2]) + 1, children.indexOf(markers[3])));
    assertEquals(aliceRejected.trim(), "ALICE REJECTED THIS", "rejected text kept verbatim");
    assertStringIncludes(markers[4].value!, "2 ", "new value inserted under Bob");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F4 - wholesale set consumes the current author's own pending insert", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOld text\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f4_consume.lyx", body);
  try {
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(["set", tempFile, "layout[Standard]", "EDIT_A"], cfg);
    // Second set by the same author: the pending EDIT_A insert is consumed
    // (LyX eraseChar physically removes the current author's own insert),
    // leaving only deleted{Old text} + inserted{EDIT_B}.
    await runCliWithConfig(["set", tempFile, "layout[Standard]", "EDIT_B"], cfg);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "EDIT_B", "final value inserted");
    assertEquals(text.includes("EDIT_A"), false, "same-author pending insert is consumed, not kept");
    assertStringIncludes(text, "\\change_deleted 1", "original text re-deleted by the same author");
    // Round-trips losslessly.
    assertEquals(serialize(parse(text)), text);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F4 - shared-closer input: rejected region preserved with synthesized closer", { timeout: 15000 }, async () => {
  // LyX-native adjacent shape: Alice's deleted region shares the \change_unchanged
  // with Bob's following inserted region (one active Change per position).
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "A REJECTED\n" +
    "\\change_inserted 2 1700000001\n" +
    "B INSERTED\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f4_shared.lyx", body, "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n\\author 3 \"Carol\"\n");
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "CAROL REWRITE"],
      { trackChanges: true, authorName: "Carol" },
    );
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted 1", "Alice's rejected region preserved");
    assertStringIncludes(text, "A REJECTED", "rejected text intact");
    assertStringIncludes(text, "\\change_deleted 3", "Bob's pending insert re-marked under Carol");
    assertStringIncludes(text, "B INSERTED", "Bob's insert text still present, now Carol's deletion");
    assertStringIncludes(text, "CAROL REWRITE", "new value inserted");
    // Round-trips losslessly (self-contained explicit closers are valid LyX).
    assertEquals(serialize(parse(text)), text);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F4 - clean input regression: wholesale set output unchanged", { timeout: 15000 }, async () => {
  const body = "\\begin_layout Standard\nOriginal sentence here.\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f4_clean.lyx", body);
  try {
    const cfg = { trackChanges: true, authorName: "Alice" };
    await runCliWithConfig(["set", tempFile, "layout[Standard]", "New sentence"], cfg);
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    const markers = changeMarkers(children);
    // F2 decision A (dev log 122): plain set emits the byte-exact shared-closer
    // form — deleted{Original} ci{New} cu, ONE closer for both adjacent
    // different-type regions (LyX writes a marker only at a transition).
    assertEquals(markers.length, 3, "clean input emits deleted/inserted/unchanged (shared closer)");
    assertStringIncludes(markers[0].value!, "1 ", "deleted under Alice");
    assertStringIncludes(markers[1].value!, "1 ", "inserted under Alice");
    assertEquals(markers[2].key, "change_unchanged");
    assertEquals(serialize(parse(text)), text);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL103 F4 - --replace-all on tracked nodes follows the preservation path (no wipe)", { timeout: 15000 }, async () => {
  // --replace-all routes through buildTrackedFullReplace when tracked changes
  // are present (the hasTrackedChanges(node.children) || !replaceAll gate), so
  // the F4 rules apply: another author's rejected text is preserved and insets
  // are NOT wiped — the "wipe all children" promise only holds for nodes
  // without tracked changes (test report 48 O2).
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "ALICE REJECTED\n" +
    "\\change_unchanged\n" +
    " plain \n" +
    "\\begin_inset Foot\n" +
    "status open\n" +
    "\\begin_layout Plain Layout\n" +
    "FN TEXT\n" +
    "\\end_layout\n" +
    "\\end_inset\n" +
    "\\change_inserted 1 1700000001\n" +
    "ALICE PENDING\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl103_f4_replaceall.lyx", body, "\\author 1 \"Alice\"\n\\author 2 \"Bob\"\n");
  try {
    await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "BOB NEW", "--replace-all"],
      { trackChanges: true, authorName: "Bob" },
    );
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    const markers = changeMarkers(children);
    // Output order: Bob's re-author pair (deleted/unchanged), then Alice's
    // preserved region (deleted/unchanged), then Bob's insert (inserted/unchanged).
    assertStringIncludes(markers[2].value!, "1 ", "Alice's rejected region preserved despite --replace-all");
    const aliceRejected = allText(children.slice(children.indexOf(markers[2]) + 1, children.indexOf(markers[3])));
    assertEquals(aliceRejected.trim(), "ALICE REJECTED", "rejected text kept verbatim");
    assertStringIncludes(text, "begin_inset Foot", "inset survives --replace-all when tracked changes exist (F4 path, no wipe)");
    assertStringIncludes(text, "FN TEXT", "inset content intact");
    assertStringIncludes(text, "BOB NEW", "new value inserted");
    assertEquals(serialize(parse(text)), text);
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
      ["change_inserted", "change_deleted", "change_unchanged"],
      "insert-first (dev log 90) byte-exact (D-15A): replacement at match start, old text deleted — shared closer",
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
    const undone = await runCliWithConfig(["undo", tempFile], cfg);
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
    const undone = await runCliWithConfig(["undo", tempFile], cfg);
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
    const undone = await runCliTest(["undo", tempFile]);
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
    const undone = await runCliWithConfig(["undo", tempFile], cfg);
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
      ["change_inserted", "change_deleted", "change_unchanged"],
      "byte-exact (D-15A): inserted region stays open into the pre-existing deleted region (shared closer); flatten passes it through, no drop",
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
    // Insert-first: \ci{X} then the whole erased range as one \cd{A B C},
    // byte-exact shared-closer form (D-15A): no closer between them.
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_deleted", "change_unchanged"]);
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
    // Bob's block between Alice's region halves, LyX byte-exact form (dev log
    // 121 D-C1): \ci{A} Tit \ci{B} X \ci{A} le \cu — no closer between the
    // block and Alice's reopened region (LyX writes a marker only at the
    // (type, author) transition).
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_inserted", "change_inserted", "change_unchanged"],
      "byte-exact adjacent flat blocks, never nested",
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

// --- Dev log 121: block payloads in split-after (test_report_37 N1 / backlog
// item 16 + the audit's new finding). The block splice path used to emit a
// same-author double opener and never reopened the region after the block —
// the continuation escaped its region (for a deleted region it was resurrected
// as current text). Fixed to the pinned canonical forms (dev log 121 D-C1:
// LyX byte-exact shared-closer form). ---

const DL121_SPLIT_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 1 1700000000\n" +
  "edit here\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

const DL121_SPLIT_DEL_BODY =
  "\\begin_layout Standard\n" +
  "\\change_deleted 1 1700000000\n" +
  "edit here\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

Deno.test("DL121 - block (--footnote) split-after inside a same-author inserted region merges into the region (no double opener)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl121_block_same.lyx", DL121_SPLIT_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--footnote", "FN"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_unchanged"],
      "one merged region, no double opener");
    assertEquals(markers[0].value?.split(" ")[0], "1", "region stays Alice's (author 1)");
    assertStringIncludes(text, "\\begin_inset Foot", "footnote inside the region");
    assertStringIncludes(allText(children), "edit", "pre-split text in region");
    assertStringIncludes(allText(children), "here", "continuation stays inside the region");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL121 - block split-after inside a different-author inserted region reopens Alice's region (byte-exact, continuation stays inserted)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl121_block_diff.lyx", DL121_SPLIT_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--footnote", "FN"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_inserted", "change_inserted", "change_unchanged"],
      "byte-exact: ci(Alice) ci(Bob) ci(Alice-reopen) cu — no closer between the block and the reopen",
    );
    // The continuation " here" must sit inside the reopened Alice region
    // (immediately after the third opener), not as plain text.
    const hereIdx = children.findIndex(c => c.type === "text" && (c as TextNode).text.includes("here"));
    assert(hereIdx >= 1 && children[hereIdx - 1].type === "property" &&
      (children[hereIdx - 1] as PropertyNode).key === "change_inserted",
      "continuation reopens Alice's inserted region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL121 - block split-after inside a deleted region keeps the continuation deleted (no resurrection)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl121_block_del.lyx", DL121_SPLIT_DEL_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--footnote", "FN"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_deleted", "change_inserted", "change_deleted", "change_unchanged"],
      "byte-exact: cd(Alice) ci(Bob) cd(Alice-reopen) cu",
    );
    // " here" must sit inside the reopened deleted region (immediately after a
    // change_deleted opener) — NOT resurrected as plain current text.
    const hereIdx = children.findIndex(c => c.type === "text" && (c as TextNode).text.includes("here"));
    assert(hereIdx >= 1 && children[hereIdx - 1].type === "property" &&
      (children[hereIdx - 1] as PropertyNode).key === "change_deleted",
      "continuation stays inside the reopened deleted region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL121 - replay after a block split inside a different-author region leaves no orphan closer", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl121_replay.lyx", DL121_SPLIT_BODY, '\\author 1 "Alice"\n');
  try {
    await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--footnote", "FN"],
      { trackChanges: true, authorName: "Bob" },
    );
    // Bob replays: his block is removed; Alice's two region halves survive, closed.
    const undone = await runCliWithConfig(
      ["undo", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(undone.undone_changes, 1, "only Bob's block undone");
    const text = await Deno.readTextFile(tempFile);
    assert(!text.includes("begin_inset Foot"), "footnote removed");
    const children = firstLayoutChildren(text);
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_unchanged", "change_inserted", "change_unchanged"],
      "both Alice halves closed, no orphan closer",
    );
    assertStringIncludes(allText(children), "edit");
    assertStringIncludes(allText(children), "here");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 122 F1: split-after at the END of a different-author/deleted
// region must not emit a redundant double closer. When the region's own
// \change_unchanged follows the payload, the block shares it (LyX byte-exact
// shared-closer form) instead of closing itself too — the old output was
// `ci 1{edit} ci 2{TX} cu cu`. ---

const DL122_SPLIT_END_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 1 1700000000\n" +
  "edit\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

const DL122_SPLIT_END_DEL_BODY =
  "\\begin_layout Standard\n" +
  "\\change_deleted 1 1700000000\n" +
  "edit\n" +
  "\\change_unchanged\n" +
  "\\end_layout\n";

const DL122_SPLIT_END_NO_CLOSER_BODY =
  "\\begin_layout Standard\n" +
  "\\change_inserted 1 1700000000\n" +
  "edit\n" +
  "\\end_layout\n";

Deno.test("DL122 F1 - text split-after at the end of a different-author inserted region shares the region's closer (no double closer)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl122_f1_text.lyx", DL122_SPLIT_END_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--text", " TX"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_inserted", "change_unchanged"],
      "byte-exact: ci(Alice) ci(Bob) cu — one closer, no `cu cu`",
    );
    assertStringIncludes(allText(children), "edit", "pre-split text stays in Alice's region");
    assertStringIncludes(allText(children), " TX", "payload lands in Bob's region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL122 F1 - block split-after at the end of a deleted region shares the region's closer (no double closer)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl122_f1_block.lyx", DL122_SPLIT_END_DEL_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--footnote", "FN"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const children = firstLayoutChildren(text);
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_deleted", "change_inserted", "change_unchanged"],
      "byte-exact: cd(Alice) ci(Bob) cu — one closer",
    );
    assertStringIncludes(text, "\\begin_inset Foot", "footnote present in Bob's region");
    assertStringIncludes(allText(children), "edit", "deleted text survives");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL122 F1 - split-after at the end of a region with NO trailing closer keeps the block self-contained (guard)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl122_f1_nocloser.lyx", DL122_SPLIT_END_NO_CLOSER_BODY, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]", "split-after", "edit", "--text", " TX"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.matched_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      changeMarkers(children).map(m => m.key),
      ["change_inserted", "change_inserted", "change_unchanged"],
      "region runs to paragraph end: the block closes itself with its own closer (still a single closer)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 123: tracked delete follows LyX's Paragraph::eraseChar model ---
// (test_report_55 F1, fully Rule 0): current/co-author text becomes the
// deleter's deletion, the deleter's own pending insert is consumed,
// already-deleted content is a no-op, emptied regions are dropped, adjacent
// same-author deletions merge, and markers are emitted byte-exact (dev log
// 123 D1–D4).

Deno.test("DL123 F1a - tracked delete of a co-author's pending insert drops the emptied region (byte-exact)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1a.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:change(inserted)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_deleted", "change_unchanged"], "cd(Bob){alpha} cu — no emptied ci opener, single closer");
    assertEquals((markers[0].value || "").split(" ")[0], "2", "deletion attributed to Bob");
    assertStringIncludes(allText(children), "alpha");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1b - tracked delete of PART of a co-author's insert re-opens the region around the surviving content", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    " beta\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1b.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:change(inserted):nth-match(1)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_inserted", "change_unchanged"],
      "cd(Bob){alpha} ci(Alice){ beta} cu — the surviving ' beta' stays in Alice's region",
    );
    assertEquals((markers[0].value || "").split(" ")[0], "2", "deletion attributed to Bob");
    assertEquals((markers[1].value || "").split(" ")[0], "1", "reopened region keeps Alice's author");
    assertEquals(allText(children), "alpha beta");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1c - tracked delete of the deleter's OWN pending insert consumes it (physically removed)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_inserted 2 1700000001\n" +
    "beta\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1c.lyx", body, '\\author 1 "Alice"\n\\author 2 "Bob"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:change(inserted):nth-match(2)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_unchanged"], "only Alice's region survives; Bob's 'beta' consumed");
    assertEquals((markers[0].value || "").split(" ")[0], "1", "survivor is Alice's region");
    assertEquals(allText(children), "alpha", "beta physically removed, no cd marker");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1d - tracked delete of already-deleted text is a no-op", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old\n" +
    "\\change_unchanged\n" +
    " new\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1d.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:change(deleted)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_deleted", "change_unchanged"], "Alice's deletion untouched, no re-authoring");
    assertEquals((markers[0].value || "").split(" ")[0], "1", "still Alice's author");
    assertEquals(allText(children), "old new", "nothing removed");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1e - tracked delete of 3 adjacent inserts merges to ONE deleted region (own insert consumed)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_inserted 2 1700000001\n" +
    "beta\n" +
    "\\change_inserted 3 1700000002\n" +
    "gamma\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1e.lyx", body, '\\author 1 "Alice"\n\\author 2 "Bob"\n\\author 3 "Carol"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:change(inserted)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 3);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_deleted", "change_unchanged"], "one merged cd region, single closer");
    assertEquals((markers[0].value || "").split(" ")[0], "2", "deletion attributed to Bob");
    assertEquals(allText(children), "alphagamma", "Bob's own 'beta' consumed, alpha+gamma merged");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1f - whole-layout tracked delete of a layout containing a change region is canonicalized", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1f.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_deleted", "change_unchanged"], "no emptied ci opener, no redundant closer");
    assertEquals((markers[0].value || "").split(" ")[0], "2", "wrapped as Bob's deletion");
    assertStringIncludes(allText(children), "alpha");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1g - delete of current text after a co-author's deletion keeps two adjacent regions (not merged)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old\n" +
    "\\change_unchanged\n" +
    " new\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1g.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:nth-match(2)"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_deleted", "change_unchanged"],
      "cd(Alice){old} cd(Bob){new} cu — different authors, shared closer",
    );
    assertEquals((markers[0].value || "").split(" ")[0], "1");
    assertEquals((markers[1].value || "").split(" ")[0], "2");
    assertEquals(allText(children), "old new");
    // NOTE: maxMarkerDepth intentionally not asserted — adjacent same-type
    // flat regions (cd 1{old} cd 2{new}) overcount as depth 2 by the naive
    // depth counter (dev log 122 F1 testing note); the marker sequence above
    // is the authoritative flatness check.
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F1h - delete of current text after a SAME-author deletion merges into one region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old\n" +
    "\\change_unchanged\n" +
    " new\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f1h.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard] text:nth-match(2)"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_deleted", "change_unchanged"], "merged into Alice's single cd region");
    assertEquals((markers[0].value || "").split(" ")[0], "1");
    assertEquals(allText(children), "old new");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL123 F2 - --replace-all on an EMPTY paragraph emits no contentless change_deleted opener", { timeout: 15000 }, async () => {
  // Shape A: childless layout (\begin_layout Standard\n\end_layout)
  const body = "\\begin_layout Standard\n\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl123_f2.lyx", body);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "content", "--replace-all"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(markers.map(m => m.key), ["change_inserted", "change_unchanged"], "ci(Bob){content} cu — no empty cd");
    assertEquals(allText(children), "content");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }

  // Shape B: layout holding only an empty text node (a blank line inside the
  // layout parses as {text: ""}) — still nothing to wipe.
  const bodyB = "\\begin_layout Standard\n\n\\end_layout\n";
  const tempFileB = await writeTempLyx("temp_dl123_f2b.lyx", bodyB);
  try {
    await runCliWithConfig(
      ["set", tempFileB, "layout[Standard]", "content", "--replace-all"],
      { trackChanges: true, authorName: "Bob" },
    );
    const childrenB = firstLayoutChildren(await Deno.readTextFile(tempFileB));
    assertEquals(
      changeMarkers(childrenB).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "blank-line empty paragraph: ci(Bob){content} cu — no empty cd",
    );
  } finally {
    try { await Deno.remove(tempFileB); } catch { /* ignore */ }
  }
});

// --- Dev log 125: whole-layout delete via the region-aware eraseChar model
// (D1-B), byte-identity on unmatched lists (D2), property-delete refusal
// (D3-b). test_report_56 F1/F2/F3/F4/F5.

/** Children of the nth layout (0-based) in the document body. */
function nthLayoutChildren(text: string, n: number): Node[] {
  const ast = parse(text);
  const doc = ast.children.find(c => c.type === "block" && c.tag === "document") as BlockNode;
  const body = doc.children.find(c => c.type === "block" && c.tag === "body") as BlockNode;
  const layouts = body.children.filter(c => c.type === "block" && c.tag === "layout") as BlockNode[];
  return layouts[n].children;
}

Deno.test("DL125 W1 - whole-layout delete merges text + inset into ONE deleted region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "Some text\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "Note.\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_w1.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "one merged cd(Bob) region — no separate text/inset regions",
    );
    assertEquals((markers[0].value || "").split(" ")[0], "2", "attributed to Bob");
    assertStringIncludes(allText(children), "Some text", "text inside the merged region");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 W2 - whole-layout delete merges change-region content + inset + text", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_unchanged\n" +
    " plus an inset\n" +
    "\\begin_inset Foot\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "Note.\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_w2.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "co-author insert re-authored + merged into a single cd(Bob) region",
    );
    assertEquals((markers[0].value || "").split(" ")[0], "2", "attributed to Bob");
    assertStringIncludes(allText(children), "alpha plus an inset", "all content merged");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 W3 - whole-layout delete of a paragraph ending inside a region writes NO closer", { timeout: 15000 }, async () => {
  // Paragraph ends inside a change region (no \change_unchanged before
  // \end_layout). LyX writes no closer at a true paragraph end inside a
  // region (verified headless 2026-08-14), so the fully-deleted paragraph must
  // also end inside the region.
  const body =
    "\\begin_layout Standard\n" +
    "current text\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_w3.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted"],
      "one merged cd(Bob) region with NO final closer (paragraph ends inside the region)",
    );
    assertStringIncludes(allText(children), "current textalpha", "all content merged");
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 W4 - whole-layout delete PRESERVES the original author of already-deleted text", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "old\n" +
    "\\change_unchanged\n" +
    " current\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_w4.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_deleted", "change_unchanged"],
      "Alice's 'old' keeps author 1 (eraseChar no-op), Bob's ' current' is his own — not merged",
    );
    assertEquals((markers[0].value || "").split(" ")[0], "1", "already-deleted stays Alice's");
    assertEquals((markers[1].value || "").split(" ")[0], "2", "current text re-authored to Bob");
    assertEquals(allText(children), "old current");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 W5 - whole-layout delete folds inline properties INSIDE the deleted region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "emphasized\n" +
    "\\emph default\n" +
    "plain\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_w5.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const markers = changeMarkers(children);
    assertEquals(
      markers.map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "one merged cd(Bob) region",
    );
    // The emph properties sit INSIDE the region (between the opener and closer).
    const cdIdx = children.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_deleted");
    const cuIdx = children.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_unchanged");
    assert(cdIdx !== -1 && cuIdx !== -1, "opener and closer present");
    const inside = children.slice(cdIdx + 1, cuIdx);
    assertEquals(
      inside.filter(c => c.type === "property" && (c as PropertyNode).key === "emph").length,
      2,
      "both \\emph markers folded inside the deleted region",
    );
    assertStringIncludes(allText(inside), "emphasizedplain", "all text inside the region");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 E1 - unrelated delete leaves a truly-empty pre-existing region byte-identical", { timeout: 15000 }, async () => {
  // Layout 2 holds an EMPTY change region: opener immediately followed by its
  // closer with no content (and no blank line) between them. Deleting layout
  // 1's text must not touch layout 2 at all (LyX only mutates the target
  // paragraph; DL123 §8 byte-identity rule).
  const body =
    "\\begin_layout Standard\n" +
    "Target text\n" +
    "\\end_layout\n" +
    "\n" +
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "\\change_unchanged\n" +
    "surviving text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_e1.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]:nth-match(1) text"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    // Layout 1: text deleted (Bob's cd).
    const layout1 = nthLayoutChildren(await Deno.readTextFile(tempFile), 0);
    assertEquals(
      changeMarkers(layout1).map(m => m.key),
      ["change_deleted", "change_unchanged"],
      "layout 1 text becomes Bob's deletion",
    );
    // Layout 2: byte-identical — the empty region survives untouched.
    const layout2 = nthLayoutChildren(await Deno.readTextFile(tempFile), 1);
    assertEquals(
      changeMarkers(layout2).map(m => m.key),
      ["change_inserted", "change_unchanged"],
      "unrelated layout's empty ci region survives (byte-identity on unmatched lists)",
    );
    assertStringIncludes(allText(layout2), "surviving text", "layout 2 text intact");
    // The empty region must still parse back to the opener→closer pair with no
    // content node between them (the exact shape the pass used to drop).
    const ciIdx = layout2.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_inserted");
    const cuIdx = layout2.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_unchanged");
    assert(ciIdx !== -1 && cuIdx === ciIdx + 1, "opener immediately followed by closer, no content between");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 126: content-less whole-layout delete refuses (F1),
// foldProperties defers across region boundaries (F2), header-property
// refusal message variant (F3). test_report_57 F1–F4.

/** Compact structural render: change markers as cd:<author>/cu, other
 * properties as key=value, text as its value. Pins byte-exact child order. */
function renderSequence(children: Node[]): string[] {
  return children.map(c => {
    if (c.type === "property") {
      const p = c as PropertyNode;
      if (p.key === "change_deleted") return `cd:${(p.value || "").split(" ")[0]}`;
      if (p.key === "change_unchanged") return "cu";
      return `${p.key}=${p.value}`;
    }
    return (c as TextNode).text;
  });
}

Deno.test("DL126 F1a - whole-layout delete of a props-only layout REFUSES (no silent no-op)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f1a.lyx", body, '\\author 1 "Alice"\n');
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, "TRACKING_ERROR", "refuses with TRACKING_ERROR");
    assert(
      (result.message || "").includes("no trackable content"),
      "message names the gap: " + (result.message || ""),
    );
    assertEquals(result.tracked_deleted_nodes, undefined, "no false success count");
    const after = await Deno.readTextFile(tempFile);
    assertEquals(after.replace(/\r\n/g, "\n"), before.replace(/\r\n/g, "\n"), "file untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL126 F1b - whole-layout delete of an empty-region-only layout REFUSES (no silent no-op)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_inserted 1 1700000000\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f1b.lyx", body, '\\author 1 "Alice"\n');
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, "TRACKING_ERROR", "refuses with TRACKING_ERROR");
    assert(
      (result.message || "").includes("no trackable content"),
      "message names the gap: " + (result.message || ""),
    );
    assertEquals(result.tracked_deleted_nodes, undefined, "no false success count");
    const after = await Deno.readTextFile(tempFile);
    assertEquals(after.replace(/\r\n/g, "\n"), before.replace(/\r\n/g, "\n"), "file untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL126 F1c - mixed content-ful + content-less layouts refuse ATOMICALLY (no partial delete)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "Real text\n" +
    "\\end_layout\n" +
    "\n" +
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f1c.lyx", body, '\\author 1 "Alice"\n');
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, "TRACKING_ERROR", "refuses with TRACKING_ERROR");
    assertEquals(result.tracked_deleted_nodes, undefined, "no false success count");
    const after = await Deno.readTextFile(tempFile);
    assertEquals(after.replace(/\r\n/g, "\n"), before.replace(/\r\n/g, "\n"), "BOTH layouts byte-unchanged (fail closed)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL126 F2a - leading property before a change-region opener folds INSIDE the deleted region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\change_inserted 1 1700000000\n" +
    "alpha\n" +
    "\\change_unchanged\n" +
    "\\emph default\n" +
    "plain\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f2a.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      renderSequence(children),
      ["cd:2", "emph=on", "alpha", "emph=default", "plain", "cu"],
      "LyX-canonical: the leading \\emph on rides INSIDE Bob's deleted region",
    );
    assertEquals(maxMarkerDepth(children), 1, "flat");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL126 F2b - leading property before a pre-existing deletion rides inside ALICE's region", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\change_deleted 1 1700000000\n" +
    "old\n" +
    "\\change_unchanged\n" +
    " current\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f2b.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.tracked_deleted_nodes, 1);
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    assertEquals(
      renderSequence(children),
      ["cd:1", "emph=on", "old", "cd:2", " current", "cu"],
      "the property folds inside Alice's pre-existing deletion; adjacent different-author regions share one closer (byte-exact transitions)",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL126 F3a - header-property refusal names the actual key and leads with tracking-off", { timeout: 15000 }, async () => {
  const header = '\\author 1 "Alice"\n\\use_hyperref false\n';
  const body =
    "\\begin_layout Standard\n" +
    "Plain text\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl126_f3a.lyx", body, header);
  try {
    const result = await runCliWithConfig(
      ["delete", tempFile, "property[use_hyperref]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, "TRACKING_ERROR", "refuses with TRACKING_ERROR");
    assert(
      (result.message || "").includes("property[use_hyperref]"),
      "message names the actual property key: " + (result.message || ""),
    );
    assert(
      !(result.message || "").includes("text:property"),
      "no inapplicable text-targeting example for a header property",
    );
    const alts = (result.message || "").split("Alternatives:")[1] || "";
    assert(
      alts.trim().startsWith("- Disable tracking first"),
      "header variant leads with the tracking-off option: " + (result.message || ""),
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 P1 - tracked delete of a property node REFUSES with guidance (no false success)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "emphasized\n" +
    "\\emph default\n" +
    "plain\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_p1.lyx", body, '\\author 1 "Alice"\n');
  try {
    const before = await Deno.readTextFile(tempFile);
    const result = await runCliWithConfig(
      ["delete", tempFile, "property[emph]"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, "TRACKING_ERROR", "refuses with TRACKING_ERROR");
    assert(
      (result.message || "").includes("cannot track-delete a property node"),
      "message names the non-trackable target: " + (result.message || ""),
    );
    assert(
      (result.message || "").includes("text:property"),
      "message offers the text-targeting alternative: " + (result.message || ""),
    );
    // File byte-unchanged (no false tracked_deleted_nodes report, no mutation).
    assertEquals(result.tracked_deleted_nodes, undefined, "no false success count");
    const after = await Deno.readTextFile(tempFile);
    assertEquals(after.replace(/\r\n/g, "\n"), before.replace(/\r\n/g, "\n"), "file untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL125 P1b - set on a property stays an untracked physical edit (D5)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "emphasized\n" +
    "\\emph default\n" +
    "plain\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl125_p1b.lyx", body, '\\author 1 "Alice"\n');
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "property[emph]:nth-match(2)", "on"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.code, undefined, "set on a property is not refused");
    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const emphs = children.filter(c => c.type === "property" && (c as PropertyNode).key === "emph");
    assertEquals(emphs.length, 2, "both emph markers present");
    assertEquals((emphs[1] as PropertyNode).value, "on", "second marker value edited physically");
    assertEquals(changeMarkers(children).length, 0, "no tracked markers emitted (untracked physical edit)");
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
      ["change_inserted", "change_deleted", "change_unchanged"],
      "replacement stays inside one flat inserted region (same-author merge); shared closer with the rejected region (D-15A)",
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

Deno.test("User report - scoped bare-text find preserves region boundaries", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "current before\n" +
    "\\change_inserted 1 1700000000\n" +
    "Inserted region with mainly through internal sources.\n" +
    "\\change_unchanged\n" +
    "current after\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_user_report_region_scope.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      [
        "set",
        tempFile,
        "layout[Standard]:contains('mainly through internal sources.'):first text:change(inserted)",
        "Fourth",
        "--find",
        "mainly through internal sources.",
      ],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);

    const children = firstLayoutChildren(await Deno.readTextFile(tempFile));
    const insertedStart = children.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_inserted");
    const insertedEnd = children.findIndex(c => c.type === "property" && (c as PropertyNode).key === "change_unchanged");
    const beforeIndex = children.findIndex(c => c.type === "text" && (c as TextNode).text.includes("current before"));
    const afterIndex = children.findIndex(c => c.type === "text" && (c as TextNode).text.includes("current after"));
    assert(insertedStart >= 0 && insertedEnd > insertedStart);
    assert(beforeIndex >= 0 && beforeIndex < insertedStart, "current text before the region must stay current");
    assert(afterIndex > insertedEnd, "current text after the region must stay current");
    const insertedText = children
      .slice(insertedStart + 1, insertedEnd)
      .filter(c => c.type === "text")
      .map(c => (c as TextNode).text)
      .join("");
    assertStringIncludes(insertedText, "Fourth");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Report 42 F1 - direct current text --find preserves tracking and warning breakdown", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "current phrase\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f1_direct_current.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:change(current)", "TAIL", "--find", "current phrase"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    assertStringIncludes(text, "current phrase");
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "TAIL");
    assert(
      (result.warnings ?? []).some(w => w.includes("text (1 occurrence)")),
      `expected a text occurrence breakdown, got: ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("Report 42 F1 - direct styled text and full set remain reviewable", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "emphasized phrase\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const surgicalFile = await writeTempLyx("temp_report42_f1_direct_styled.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const surgical = await runCliWithConfig(
      ["set", surgicalFile, "text:property(emph)", "TAIL", "--find", "phrase"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(surgical.modified_nodes, 1);
    const text = await Deno.readTextFile(surgicalFile);
    assert(text.indexOf("\\emph on") < text.indexOf("\\change_deleted"));
    assert(text.indexOf("\\change_inserted") < text.indexOf("\\emph default"));
    assertStringIncludes(text, "phrase");
    assertStringIncludes(text, "TAIL");
  } finally {
    try { await Deno.remove(surgicalFile); } catch { /* ignore */ }
  }
});

Deno.test("Report 42 F1 - direct current text full set remains reviewable", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "emphasized phrase\n" +
    "\\emph default\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_report42_f1_direct_full.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "text:property(emph)", "REPLACED"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, JSON.stringify(result));
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "REPLACED");
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

// --- Dev log 108: multi-target split-after aggregate diagnostics ---
// A broad selector matching several blocks must not abort with a per-target
// message on the first offending block — it reports the exactly-once /
// multiple / none breakdown and restates the contract as the hint (DL108 §4).

const DL108_BODY_ONE_OF_THREE =
  "\\begin_layout Standard\n" +
  "Alpha\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "write here\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "Beta\n" +
  "\\end_layout\n";

const DL108_BODY_WORRYING_CASE =
  "\\begin_layout Standard\n" +
  "write once\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "write again\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "write and write twice\n" +
  "\\end_layout\n";

const DL108_BODY_MIXED =
  "\\begin_layout Standard\n" +
  "write and write twice\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "nothing here\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "write once\n" +
  "\\end_layout\n";

const DL108_BODY_ALL_ONCE =
  "\\begin_layout Standard\n" +
  "write first\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "write second\n" +
  "\\end_layout\n";

Deno.test("DL108 - multi-target no-match reports the aggregate breakdown (SPLIT_NO_MATCH)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl108_nomatch.lyx", DL108_BODY_ONE_OF_THREE, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]", "split-after", "write", "--text", "!"]);
    assertEquals(result.code, "SPLIT_NO_MATCH");
    assertStringIncludes(result.message!, "matched 3 blocks");
    assertStringIncludes(result.message!, "appears exactly once in 1 of them");
    assertStringIncludes(result.message!, "in none of the others");
    assertStringIncludes(result.message!, "(tracked changes included)");
    assertStringIncludes(result.message!, "appears exactly once in every matched block");
    // Abort precedes the splice loop — nothing reaches disk.
    assertEquals((await Deno.readTextFile(tempFile)).includes("!"), false, "abort must precede any splice");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL108 - phrase in every block, once in some and multiple times in others (SPLIT_AMBIGUOUS breakdown)", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl108_amb.lyx", DL108_BODY_WORRYING_CASE, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]", "split-after", "write", "--text", "!"]);
    assertEquals(result.code, "SPLIT_AMBIGUOUS");
    assertStringIncludes(result.message!, "matched 3 blocks");
    assertStringIncludes(result.message!, "appears exactly once in 2 of them");
    assertStringIncludes(result.message!, "multiple times in 1");
    assertStringIncludes(result.message!, "(tracked changes included)");
    assertStringIncludes(result.message!, "appears exactly once in every matched block");
    assertEquals((await Deno.readTextFile(tempFile)).includes("!"), false, "abort must precede any splice");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL108 - deterministic precedence: any 0-occurrence target wins over ambiguity", { timeout: 15000 }, async () => {
  // The first block has 2 occurrences (loop order would fire SPLIT_AMBIGUOUS),
  // but a later block has none — SPLIT_NO_MATCH must win regardless of order.
  const tempFile = await writeTempLyx("temp_dl108_precedence.lyx", DL108_BODY_MIXED, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]", "split-after", "write", "--text", "!"]);
    assertEquals(result.code, "SPLIT_NO_MATCH", "NO_MATCH wins when any target has 0");
    assertStringIncludes(result.message!, "appears exactly once in 1 of them");
    assertStringIncludes(result.message!, "multiple times in 1");
    assertStringIncludes(result.message!, "in none of the others");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL108 - multi-target all exactly-once still splits every block", { timeout: 15000 }, async () => {
  const tempFile = await writeTempLyx("temp_dl108_allonce.lyx", DL108_BODY_ALL_ONCE, "\\textclass article\n");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Standard]", "split-after", "write", "--text", "!"]);
    assertEquals(result.code, undefined);
    assertEquals(result.matched_nodes, 2, "both targets split");
    const text = await Deno.readTextFile(tempFile);
    assertEquals((text.match(/!/g) ?? []).length, 2, "payload lands in both blocks");
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

// --- Dev log 92 phase B: structural scope (no new syntax; scope = selector combination) ---

Deno.test("DL92 B - union scope: change(current), change(deleted) spans both regions, order-independent", { timeout: 15000 }, async () => {
  // The two 'and' occurrences are non-adjacent (separated by the inserted zzz),
  // so each scope-accepted match produces its own replacement.
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\change_inserted 1 1700000001\n" +
    "zzz\n" +
    "\\change_unchanged\n" +
    "and\n" +
    "\\end_layout\n";
  for (const sel of [
    "layout[Standard]:change(current), layout[Standard]:change(deleted)",
    "layout[Standard]:change(deleted), layout[Standard]:change(current)",
  ]) {
    const tempFile = await writeTempLyx("temp_dl92b_union.lyx", body, "\\author 1 \"Alice\"\n");
    try {
      const result = await runCliWithConfig(
        ["set", tempFile, sel, "X", "--find", "and"],
        { trackChanges: true, authorName: "Alice" },
      );
      assertEquals(result.modified_nodes, 1, `${sel}: layout replaced`);
      const text = allText(firstLayoutChildren(await Deno.readTextFile(tempFile)));
      assertEquals((text.match(/X/g) || []).length, 2, `${sel}: both current + rejected 'and' replaced`);
      assertEquals((text.match(/and/g) || []).length, 2, `${sel}: both erased 'and's preserved as rejected text`);
      assertStringIncludes(text, "zzz", "inserted text untouched by the union scope");
    } finally {
      try { await Deno.remove(tempFile); } catch { /* ignore */ }
    }
  }
});

Deno.test("DL92 B - union scope excludes the omitted region (inserted) from --find", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "and\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\change_inserted 1 1700000001\n" +
    "zzz\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_excl.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(current), layout[Standard]:change(deleted)", "X", "--find", "zzz"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.code, "NO_MATCH", "inserted text is outside the union scope");
    assertStringIncludes(await Deno.readTextFile(tempFile), "zzz", "file untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL92 B - an unscoped OR arm widens the scope to see-all (E4)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\change_inserted 1 1700000001\n" +
    "zzz\n" +
    "\\change_unchanged\n" +
    "and\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_e4.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(deleted), layout[Standard]", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "see-all scope still replaces the layout");
    const text = allText(firstLayoutChildren(await Deno.readTextFile(tempFile)));
    assertEquals((text.match(/X/g) || []).length, 2, "both current + rejected 'and' replaced (see-all)");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL92 B - :property() scope restricts --find to the styled text", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "plain foo\n" +
    "\\emph on\n" +
    "emph foo\n" +
    "\\emph default\n" +
    "plain foo\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_prop.lyx", body);
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:property(emph)", "X", "--find", "foo"],
      { trackChanges: false, authorName: "me" },
    );
    assertEquals(result.modified_nodes, 1, "property-scoped find replaces in the layout");
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "emph X", "only the emphasized foo replaced");
    assertEquals((text.match(/plain foo/g) || []).length, 2, "both plain foo occurrences untouched");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL92 B - chained :property(emph):change(deleted) requires both axes (E9)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\emph on\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\emph default\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_chain.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:property(emph):change(deleted)", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.modified_nodes, 1, "conjunction scope replaces in the layout");
    const text = allText(firstLayoutChildren(await Deno.readTextFile(tempFile)));
    assertEquals((text.match(/X/g) || []).length, 1, "only the emph+deleted 'and' replaced");
    assertEquals((text.match(/and/g) || []).length, 2, "both deleted 'and's preserved as rejected text");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL92 B - the rejected-text warning is suppressed under any explicit scope (E7)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "and\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_warn.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:change(deleted)", "X", "--find", "and"],
      { trackChanges: true, authorName: "Alice" },
    );
    const warnings = result.warnings ?? [];
    assertEquals(
      warnings.some((w) => w.includes("matched inside \\change_deleted")),
      false,
      "no rejected-text warning under an explicit scope",
    );
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL92 B - split-after under the union scope works in any listed region (E5)", { timeout: 15000 }, async () => {
  const body =
    "\\begin_layout Standard\n" +
    "current and\n" +
    "\\change_deleted 1 1700000000\n" +
    "rejected\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n";
  const tempFile = await writeTempLyx("temp_dl92b_split.lyx", body, "\\author 1 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]:change(current), layout[Standard]:change(deleted)", "split-after", "and", "--text", " Y"],
      { trackChanges: true, authorName: "Alice" },
    );
    assertEquals(result.matched_nodes, 1, "split in a listed region is allowed");
    const text = allText(firstLayoutChildren(await Deno.readTextFile(tempFile)));
    assertStringIncludes(text, "and Y", "payload inserted at the split point");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// --- Dev log 124: Rule 0 fixes (author-line parsing + generated-inset bytes) ---

/** Lines in the header that are \author entries. */
function authorLines(text: string): string[] {
  return text.split("\n").filter(l => l.startsWith("\\author "));
}

Deno.test("DL124 A1 - email-bearing author line is recognized and reused", { timeout: 15000 }, async () => {
  // LyX writes \author <id> "<name>" <email> when an email is set (Author.cpp
  // operator<<). The old regex required the line to end at the closing quote,
  // so this line was invisible and a duplicate \author 1 was added. Dev log
  // 124 F1: parse a first-quoted name with an optional trailing email.
  const tempFile = await writeTempLyx("temp_dl124_a1_email.lyx",
    "\\begin_layout Standard\nHello\n\\end_layout\n",
    "\\author 236438948 \"lq user\" lquser@example.com\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Goodbye"],
      { trackChanges: true, authorName: "lq user" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const authors = authorLines(text);
    assertEquals(authors.length, 1, "no duplicate \\author entry may be added");
    assertEquals(authors[0], "\\author 236438948 \"lq user\" lquser@example.com");
    assertStringIncludes(text, "\\change_deleted 236438948", "markers reuse the existing author ID");
    assertStringIncludes(text, "\\change_inserted 236438948", "markers reuse the existing author ID");
    assertEquals(text.includes("\\author 1"), false, "no fresh sequential author may be injected");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 A2 - negative-hash author line is recognized and reused", { timeout: 15000 }, async () => {
  // LyX's author ID is a Bernstein hash cast to int — often negative (LyX's
  // own tex2lyx fixtures: \author -443692588 "Hans Wurst"). The old regex
  // ^\d+ required digits-only IDs. Dev log 124 F1: accept -?\d+.
  const tempFile = await writeTempLyx("temp_dl124_a2_negid.lyx",
    "\\begin_layout Standard\nHello\n\\end_layout\n",
    "\\author -443692588 \"Hans Wurst\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "Bye"],
      { trackChanges: true, authorName: "Hans Wurst" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const authors = authorLines(text);
    assertEquals(authors.length, 1, "no duplicate \\author entry may be added");
    assertEquals(authors[0], "\\author -443692588 \"Hans Wurst\"");
    assertStringIncludes(text, "\\change_deleted -443692588", "markers reuse the negative existing ID");
    assertStringIncludes(text, "\\change_inserted -443692588", "markers reuse the negative existing ID");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 A3 - mixed header, new author gets maxId+1 over parsed positives", { timeout: 15000 }, async () => {
  // No name match for "Bob": the new ID must be max parsed positive + 1.
  // The email-bearing line is recognized, so its positive ID (236438948)
  // counts for maxId — Bob gets 236438949, no collision with Alice's 5 or
  // "me"'s 236438948. Dev log 124 D1 + maxId note (A3).
  const tempFile = await writeTempLyx("temp_dl124_a3_mixed.lyx",
    "\\begin_layout Standard\nHello\n\\end_layout\n",
    "\\author 236438948 \"me\" me@example.com\n\\author 5 \"Alice\"\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const authors = authorLines(text);
    assertEquals(authors.length, 3);
    assertStringIncludes(text, "\\author 236438949 \"Bob\"", "new ID = max parsed positive + 1");
    assertStringIncludes(text, "\\change_deleted 236438949");
    assertStringIncludes(text, "\\change_inserted 236438949");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 A4 - email-only header, new author still sequential past email ID", { timeout: 15000 }, async () => {
  // Header has only an email-bearing author. Its positive ID is parsed and
  // counts for maxId, so the first new author is 236438949 — never a
  // collision with 236438948 (dev log 124 maxId note).
  const tempFile = await writeTempLyx("temp_dl124_a4_seq.lyx",
    "\\begin_layout Standard\nHello\n\\end_layout\n",
    "\\author 236438948 \"me\" me@example.com\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const authors = authorLines(text);
    assertEquals(authors.length, 2);
    assertStringIncludes(text, "\\author 236438949 \"Bob\"", "new ID = email line's positive ID + 1 (no collision)");
    assertStringIncludes(text, "\\change_deleted 236438949");
    assertStringIncludes(text, "\\change_inserted 236438949");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 A5 - negative-ID email line: recognized but not counted for maxId", { timeout: 15000 }, async () => {
  // A negative hash ID never counts toward the positive sequential new-ID
  // scheme (dev log 124 D1), even on an email-bearing line. It only needs to
  // be recognized for name matching, so a non-matching name gets \author 1.
  const tempFile = await writeTempLyx("temp_dl124_a5_negemail.lyx",
    "\\begin_layout Standard\nHello\n\\end_layout\n",
    "\\author -443692588 \"me\" me@example.com\n");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]", "X"],
      { trackChanges: true, authorName: "Bob" },
    );
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    const authors = authorLines(text);
    assertEquals(authors.length, 2);
    assertStringIncludes(text, "\\author 1 \"Bob\"", "negative IDs never count for maxId; new ID starts at 1");
    assertStringIncludes(text, "\\change_deleted 1");
    assertStringIncludes(text, "\\change_inserted 1");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B1 - --cite emits the canonical blank line before \\end_inset", { timeout: 15000 }, async () => {
  // LyX's Paragraph::write (META_INSET) emits <last>\n\n\end_inset for every
  // non-directWrite inset (dev log 124 F2). Byte-verified in tex2lyx fixtures.
  const tempFile = await createTempFixture("temp_dl124_b1_cite.lyx");
  try {
    await runCliTest(["insert", tempFile, "layout[Standard]:first", "append", "--cite", "K1"]);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, 'literal "false"\n\n\\end_inset',
      "citation inset must carry the blank line LyX writes before \\end_inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B2 - --ref emits the canonical blank line before \\end_inset", { timeout: 15000 }, async () => {
  const tempFile = await createTempFixture("temp_dl124_b2_ref.lyx");
  try {
    await runCliTest(["insert", tempFile, "layout[Standard]:first", "append", "--ref", "sec:x"]);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, 'tuple "list"\n\n\\end_inset',
      "ref inset must carry the blank line LyX writes before \\end_inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B3 - --label emits the canonical blank line before \\end_inset", { timeout: 15000 }, async () => {
  const tempFile = await createTempFixture("temp_dl124_b3_label.lyx");
  try {
    await runCliTest(["insert", tempFile, "layout[Standard]:first", "append", "--label", "sec:x"]);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, 'name "sec:x"\n\n\\end_inset',
      "label inset must carry the blank line LyX writes before \\end_inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B4 - --footnote emits the canonical blank line before \\end_inset", { timeout: 15000 }, async () => {
  const tempFile = await createTempFixture("temp_dl124_b4_footnote.lyx");
  try {
    await runCliTest(["insert", tempFile, "layout[Standard]:first", "append", "--footnote", "note"]);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\end_layout\n\n\\end_inset",
      "footnote inset must carry the blank line LyX writes before \\end_inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B5 - tracked --cite keeps markers outside and the blank line inside", { timeout: 15000 }, async () => {
  const tempFile = await createTempFixture("temp_dl124_b5_tracked_cite.lyx");
  try {
    await runCliWithConfig(
      ["insert", tempFile, "layout[Standard]:first", "append", "--cite", "K1"],
      { trackChanges: true },
    );
    const text = await Deno.readTextFile(tempFile);
    const insetMatch = text.match(/\\begin_inset CommandInset citation\n([\s\S]*?)\\end_inset/);
    assert(insetMatch, "citation inset should be present");
    assert(!insetMatch[1].includes("\\change_"), "no markers inside the inset body (atomic wrap, DL81)");
    assertStringIncludes(insetMatch[1], 'literal "false"\n\n', "blank line preserved inside the tracked body");
    const beforeIdx = text.indexOf("\\begin_inset CommandInset citation");
    const afterIdx = text.indexOf("\\end_inset", beforeIdx);
    const insertedIdx = text.lastIndexOf("\\change_inserted", beforeIdx);
    const unchangedIdx = text.indexOf("\\change_unchanged", afterIdx);
    assert(insertedIdx !== -1 && insertedIdx < beforeIdx, "change_inserted must precede the inset");
    assert(unchangedIdx !== -1 && unchangedIdx > afterIdx, "change_unchanged must follow the inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL124 B6 - --raw-file passes through byte-identical (no synthesized blank line)", { timeout: 15000 }, async () => {
  // F2 touches only the generators. --raw-file must stay verbatim: a raw
  // CommandInset written WITHOUT the trailing blank line must round-trip
  // untouched, proving lq never adds the blank line to user-provided bytes.
  // The assertion is scoped to the inserted inset via a unique key, because
  // the my_template fixture already contains citation insets that DO carry
  // the canonical blank line.
  const tempFile = await createTempFixture("temp_dl124_b6_raw.lyx");
  const rawFile = await Deno.makeTempFile({ suffix: ".raw" });
  const rawContent =
    "\\begin_inset CommandInset citation\n" +
    "LatexCommand citet\n" +
    'key "DL124B6"\n' +
    'literal "false"\n' +
    "\\end_inset\n";
  try {
    await Deno.writeTextFile(rawFile, rawContent);
    await runCliTest(["insert", tempFile, "layout[Standard]:first", "append", "--raw-file", rawFile]);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, 'key "DL124B6"\nliteral "false"\n\\end_inset',
      "raw-file content must pass through verbatim (no synthesized blank line)");
    assertEquals(text.includes('key "DL124B6"\nliteral "false"\n\n\\end_inset'), false,
      "raw-file must not gain the generator's blank line");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
    try { await Deno.remove(rawFile); } catch { /* ignore */ }
  }
});
