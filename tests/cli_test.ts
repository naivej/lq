/**
 * CLI interface tests — coverage for help, error paths, dump, read --count,
 * bib --search, set/delete success paths, and init validation.
 *
 * Uses runCliTest/runCliRaw from helpers.ts, which isolate tests from the
 * developer's local ~/.lq/config.json by creating a temp config with:
 *   refresh: "none"
 *   trackChanges: false
 *
 * Run from lq/ directory: deno test -A tests/cli_test.ts
 */

import { assertEquals, assertStringIncludes, assertGreater, assertMatch } from "@std/assert";
import { runCliTest, runCliRaw, runCliWithEnv, runCliWithConfig, createTempFixture } from "./helpers.ts";

const FIXTURE = "tests/fixtures/my_template.lyx";

// ---------------------------------------------------------------------------
// 1. Global help
// ---------------------------------------------------------------------------
Deno.test("CLI - global help", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["--help"]);
  assertStringIncludes(stdout, "lq - A CLI Tool for Editing LyX Files");
  assertStringIncludes(stdout, "read");
  assertStringIncludes(stdout, "dump");
  assertStringIncludes(stdout, "bib");
  assertStringIncludes(stdout, "set");
  assertStringIncludes(stdout, "delete");
  assertStringIncludes(stdout, "schema");
  assertStringIncludes(stdout, "insert");
  assertStringIncludes(stdout, "init");
});

// ---------------------------------------------------------------------------
// 2. Per-command help
// ---------------------------------------------------------------------------
Deno.test("CLI - per-command help (read)", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["read", "--help"]);
  assertStringIncludes(stdout, "lq read");
  assertStringIncludes(stdout, "--count");
  assertStringIncludes(stdout, "<file>");
  assertStringIncludes(stdout, "<selector>");
});

// ---------------------------------------------------------------------------
// 3. Invalid file extension
// ---------------------------------------------------------------------------
Deno.test("CLI - reject non-.lyx files", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read", "not-a-lyx.txt", "layout"]);
  assertEquals(result.code, "INVALID_EXTENSION");
});

// ---------------------------------------------------------------------------
// 4. Missing arguments
// ---------------------------------------------------------------------------
Deno.test("CLI - missing arguments", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read"]);
  assertEquals(result.code, "MISSING_ARGS");
});

// ---------------------------------------------------------------------------
// 5. dump command
// ---------------------------------------------------------------------------
Deno.test("CLI - dump command", { timeout: 10000 }, async () => {
  const result = await runCliTest(["dump", FIXTURE]);
  // dump returns the entire CST as data
  const data = result.data as Record<string, unknown>;
  assertEquals(data.type, "document");
  assertEquals(Array.isArray(data.children), true);
});

// ---------------------------------------------------------------------------
// 6. read --count
// ---------------------------------------------------------------------------
Deno.test("CLI - read --count", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read", "--count", FIXTURE, "layout"]);
  const count = (result as unknown as Record<string, unknown>).count as Record<string, number>;
  assertEquals(typeof count, "object");
  assertGreater(Object.keys(count).length, 0);
});

// ---------------------------------------------------------------------------
// 7. bib --search
// ---------------------------------------------------------------------------
Deno.test("CLI - bib search", { timeout: 10000 }, async () => {
  // "Mena" matches exactly one citation in the fixture
  const result = await runCliTest(["bib", FIXTURE, "--search", "Mena"]);
  const data = result.data as Array<Record<string, string>>;
  assertEquals(data.length, 1);
  assertEquals(data[0].key, "Mena2000");
});

Deno.test("CLI - bib search (no match)", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", FIXTURE, "--search", "ZZZZZ_NO_MATCH"]);
  assertEquals((result.data as unknown[]).length, 0);
});

// ---------------------------------------------------------------------------
// 8. set command success
// ---------------------------------------------------------------------------
Deno.test("CLI - set command success", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_cli_set_test.lyx");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Title]", "Changed Title"]);

    // Verify the text actually changed in the file
    const readResult = await runCliTest(["read", tempFile, "layout[Title]"]);
    const nodes = readResult.data as Array<{ children: Array<{ text: string }> }>;
    assertEquals(nodes[0].children[0].text, "Changed Title");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 9. delete command success
// ---------------------------------------------------------------------------
Deno.test("CLI - delete command success", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_cli_delete_test.lyx");
  try {
    // Count Standard layouts before delete
    const before = await runCliTest(["read", "--count", tempFile, "layout[Standard]"]);
    const countBefore = (before as unknown as Record<string, unknown>).count as Record<string, number>;
    const totalBefore = Object.values(countBefore).reduce((a, b) => a + b, 0);

    // Delete the first Standard layout
    const result = await runCliTest(["delete", tempFile, "layout[Standard]:first"]);

    // Verify count decreased by 1
    const after = await runCliTest(["read", "--count", tempFile, "layout[Standard]"]);
    const totalAfter = Object.values((after as unknown as Record<string, unknown>).count as Record<string, number>).reduce((a, b) => a + b, 0);
    assertEquals(totalAfter, totalBefore - 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 10. init validation errors
// ---------------------------------------------------------------------------
Deno.test("CLI - init reject invalid refresh mode", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--refresh", "invalid"]);
  assertEquals(result.code, "INVALID_FLAG");
  assertStringIncludes(result.message!, "refresh");
});

Deno.test("CLI - init reject invalid track-changes", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--track-changes", "invalid"]);
  assertEquals(result.code, "INVALID_FLAG");
  assertStringIncludes(result.message!, "track-changes");
});

Deno.test("CLI - init reject nonexistent layouts-dir", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--layouts-dir", "/nonexistent/path/12345"]);
  assertEquals(result.code, "DIR_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 11. init success (with fake HOME to avoid corrupting user config)
// ---------------------------------------------------------------------------
Deno.test("CLI - init success with fake home", { timeout: 10000 }, async () => {
  // Use a temp directory as HOME so init writes config there, not ~/.lq/
  const tmpHome = await Deno.makeTempDir({ prefix: "lq_test_home" });
  // Need a valid layouts dir — use the fixture directory (it's a real dir)
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_test_layouts" });
  try {
    const result = await runCliWithEnv(
      ["init", "--layouts-dir", layoutsDir],
      { HOME: tmpHome, USERPROFILE: tmpHome },
    );

    // Verify config was written
    const configPath = `${tmpHome}/.lq/config.json`;
    const configText = await Deno.readTextFile(configPath);
    const config = JSON.parse(configText);
    assertEquals(config.layoutsDir, layoutsDir);
    assertEquals(config.refresh, "none");
    assertEquals(config.trackChanges, true);
  } finally {
    try { await Deno.remove(tmpHome, { recursive: true }); } catch { /* ignore */ }
    try { await Deno.remove(layoutsDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 12. trackChanges: true — set wraps old in \change_deleted, new in \change_inserted
// ---------------------------------------------------------------------------
Deno.test("CLI - set with trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_tc_set.lyx");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Title]", "Tracked Title"],
      { trackChanges: true },
    );

    // Read back and verify change markers
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "Tracked Title");
    // Header should have tracking_changes true AND author
    assertStringIncludes(text, "\\tracking_changes true");
    assertMatch(text, /\\author \d+ "lq user"/);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 13. trackChanges: true — delete wraps in \change_deleted instead of removing
// ---------------------------------------------------------------------------
Deno.test("CLI - delete with trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_tc_delete.lyx");
  try {
    // Count Standard layouts before
    const before = await runCliWithConfig(
      ["read", "--count", tempFile, "layout[Standard]"],
      { trackChanges: true },
    );
    const countBefore = (before as unknown as Record<string, unknown>).count as Record<string, number>;
    const totalBefore = Object.values(countBefore).reduce((a, b) => a + b, 0);

    // Delete the first Standard layout with trackChanges
    const result = await runCliWithConfig(
      ["delete", tempFile, "layout[Standard]:first"],
      { trackChanges: true },
    );

    // With trackChanges, the node is NOT removed — it's wrapped in change_deleted.
    // So count should stay the same.
    const after = await runCliWithConfig(
      ["read", "--count", tempFile, "layout[Standard]"],
      { trackChanges: true },
    );
    const totalAfter = Object.values((after as unknown as Record<string, unknown>).count as Record<string, number>).reduce((a, b) => a + b, 0);
    assertEquals(totalAfter, totalBefore);

    // Verify markers are in the file
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    assertStringIncludes(text, "\\tracking_changes true");
    assertMatch(text, /\\author \d+ "lq user"/);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 14. trackChanges: true — insert wraps new content in \change_inserted
// ---------------------------------------------------------------------------
Deno.test("CLI - insert with trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_tc_insert.lyx");
  try {
    const result = await runCliWithConfig(
      ["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "Tracked Insert"],
      { trackChanges: true },
    );

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_inserted");
    assertStringIncludes(text, "Tracked Insert");
    assertStringIncludes(text, "\\tracking_changes true");
    assertMatch(text, /\\author \d+ "lq user"/);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 15. set --find: surgical substring replacement
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find basic substring replacement", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_basic.lyx");
  try {
    // The fixture has text "Some writing in " in a Standard layout
    const result = await runCliTest(["set", tempFile, "layout[Standard]:contains('writing')", "text", "--find", "writing"]);

    // Verify via read: "writing" → "text" in the matched node
    const readResult = await runCliTest(["read", tempFile, "layout[Standard]:contains('text')"]);
    const nodes = readResult.data as Array<{ children: Array<{ text: string }> }>;
    const allText = nodes[0].children
      .filter((c: { type?: string; text?: string }) => c.type === "text" || c.text !== undefined)
      .map((c: { text: string }) => c.text)
      .join("");
    // "writing" should be gone from this node's text
    assertEquals(allText.includes("writing"), false);
    // "text" should be present
    assertStringIncludes(allText, "text");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 16. set --find: multiple occurrences all replaced
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find replaces all occurrences", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_multi.lyx");
  try {
    // "paper" appears twice as text in a Standard layout
    const result = await runCliTest(["set", tempFile, "layout[Standard]:contains('paper')", "article", "--find", "paper"]);

    // Verify via read: all "paper" → "article" in the matched node's text
    const readResult = await runCliTest(["read", tempFile, "layout[Standard]:contains('article')"]);
    const nodes = readResult.data as Array<{ children: Array<{ text: string }> }>;
    const allText = nodes[0].children
      .filter((c: { type?: string; text?: string }) => c.type === "text" || c.text !== undefined)
      .map((c: { text: string }) => c.text)
      .join("");
    assertEquals(allText.includes("paper"), false);
    assertStringIncludes(allText, "article");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 17. set --find: no match produces NO_MATCH error
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find no match errors", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_none.lyx");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]:first", "replacement", "--find", "nonexistent_xyz"]);
    assertEquals(result.code, "NO_MATCH");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 18. set --find + --replace-all: mutually exclusive
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find and --replace-all conflict", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_conflict.lyx");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]:first", "text", "--find", "foo", "--replace-all"]);
    assertEquals(result.code, "FLAG_CONFLICT");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 19. set --find with trackChanges: surgical tracking markers
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find with trackChanges", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_tc.lyx");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "layout[Standard]:contains('writing')", "text", "--find", "writing"],
      { trackChanges: true },
    );

    const rawText = await Deno.readTextFile(tempFile);
    // Should have tracking markers
    assertStringIncludes(rawText, "\\change_deleted");
    assertStringIncludes(rawText, "\\change_inserted");
    // Tracked change header properties
    assertStringIncludes(rawText, "\\tracking_changes true");
    assertMatch(rawText, /\\author \d+ "lq user"/);
    // Old text "writing" should appear inside change_deleted
    assertStringIncludes(rawText, "writing");
    // New text "text" should appear inside change_inserted
    assertStringIncludes(rawText, "text");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 20. set --find on a property node
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find on property node", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_prop.lyx");
  try {
    // The fixture has \language british (and \quotes_style british, but we target language)
    const result = await runCliTest(["set", tempFile, "property[language]", "english", "--find", "british"]);

    // Verify the specific property changed
    const readResult = await runCliTest(["read", tempFile, "property[language]"]);
    const propNode = (readResult.data as Array<{ value: string }>)[0];
    assertEquals(propNode.value, "english");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 21. read --text-only: basic text extraction
// ---------------------------------------------------------------------------
Deno.test("CLI - read --text-only basic", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_textonly.lyx");
  try {
    // Run with --text-only and capture raw stdout
    const { stdout } = await runCliRaw(["read", tempFile, "layout[Title]", "--text-only"]);
    // The fixture Title layout contains "Title"
    assertStringIncludes(stdout, "Title");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 22. read --text-only + --count: combined output
// ---------------------------------------------------------------------------
Deno.test("CLI - read --text-only and --count combined", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_tonly_combined.lyx");
  try {
    const result = await runCliTest(["read", tempFile, "layout[Title]", "--text-only", "--count"]);
    // Both count and text fields should be present
    assertEquals(typeof result.count, "object");
    assertEquals(typeof result.text, "string");
    const countMap = result.count as Record<string, number>;
    assertEquals(countMap["layout[Title]"], 1);
    assertEquals(result.text!.trim(), "layout[Title] Title");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});
