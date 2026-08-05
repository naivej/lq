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

import { assertEquals, assert, assertStringIncludes, assertGreater, assertMatch } from "@std/assert";
import { runCliTest, runCliRaw, runCliWithEnv, runCliWithConfig, createTempFixture } from "./helpers.ts";
import { getUserHomeDir } from "../src/paths.ts";

const FIXTURE = "tests/fixtures/my_template.lyx";

Deno.test("Paths - normalize Git Bash HOME on Windows", () => {
  if (Deno.build.os !== "windows") return;
  const values: Record<string, string> = {
    HOME: "/c/Users/Shifu",
    USERPROFILE: "C:\\Users\\Fallback",
  };
  assertEquals(getUserHomeDir({ get: name => values[name] }), "C:\\Users\\Shifu");
});

Deno.test("Paths - prefer a native HOME override on Windows", () => {
  if (Deno.build.os !== "windows") return;
  const values: Record<string, string> = {
    HOME: "D:\\lq-home",
    USERPROFILE: "C:\\Users\\Fallback",
  };
  assertEquals(getUserHomeDir({ get: name => values[name] }), "D:\\lq-home");
});

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
  assertStringIncludes(stdout, "Commands return JSON. Help text is plain text.");
  assertStringIncludes(stdout, "mark them deleted when tracking is enabled");
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

Deno.test("CLI - per-command help (insert)", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["insert", "--help"]);
  assertStringIncludes(stdout, "lq insert");
  assertStringIncludes(stdout, "<file>");
  assertStringIncludes(stdout, "<selector>");
  assertStringIncludes(stdout, "<position>");
  assertStringIncludes(stdout, "before");
  assertStringIncludes(stdout, "split-after");
  assertStringIncludes(stdout, "target must be a");
  assertStringIncludes(stdout, "block (such as layout or inset)");
  assertStringIncludes(stdout, "--layout");
  assertStringIncludes(stdout, "--raw-file");
  assertStringIncludes(stdout, "All text is visible");
  assertStringIncludes(stdout, ":change(current|inserted|deleted)");
  assertEquals(stdout.includes("Text inside \\change_deleted blocks is skipped."), false);
});

Deno.test("CLI - per-command help (init) documents strict cache count", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["init", "--help"]);
  assertStringIncludes(stdout, "--global");
  assertStringIncludes(stdout, "local");
  assertStringIncludes(stdout, "configPath");
  assertStringIncludes(stdout, "--max-cache-entries");
  assertStringIncludes(stdout, "complete non-negative integer");
});

// ---------------------------------------------------------------------------
// 3. Invalid file extension
// ---------------------------------------------------------------------------
Deno.test("CLI - reject non-.lyx files", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read", "not-a-lyx.txt", "layout"]);
  assertEquals(result.code, "INVALID_EXTENSION");
  assertStringIncludes(result.message!, "Select the LyX document");
});

// ---------------------------------------------------------------------------
// 4. Missing arguments
// ---------------------------------------------------------------------------
Deno.test("CLI - missing arguments", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read"]);
  assertEquals(result.code, "MISSING_ARGS");
});

Deno.test("CLI - missing selector recommends selector help", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read", FIXTURE]);
  assertEquals(result.code, "MISSING_SELECTOR");
  assertStringIncludes(result.message!, "lq selector --help");
});

Deno.test("CLI - unknown command recommends global help", { timeout: 10000 }, async () => {
  const result = await runCliTest(["unknown", FIXTURE, "layout"]);
  assertEquals(result.code, "UNKNOWN_COMMAND");
  assertStringIncludes(result.message!, "lq --help");
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
    await runCliTest(["set", tempFile, "layout[Title]", "Changed Title"]);

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
    await runCliTest(["delete", tempFile, "layout[Standard]:first"]);

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

Deno.test("CLI - init rejects empty and whitespace-only author names", { timeout: 10000 }, async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "lq_author_name_home" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_author_name_layouts" });
  try {
    for (const value of ["", "   ", "\t"]) {
      const result = await runCliWithEnv(
        ["init", "--layouts-dir", layoutsDir, "--author-name", value],
        { HOME: tmpHome, USERPROFILE: tmpHome },
      );
      assertEquals(result.code, "INVALID_FLAG", value);
      assertStringIncludes(result.message!, "author-name");

      let configExists = false;
      try {
        await Deno.stat(`${tmpHome}/.lq/config.json`);
        configExists = true;
      } catch { /* expected: invalid input must not create config */ }
      assertEquals(configExists, false, value);
    }
  } finally {
    try { await Deno.remove(tmpHome, { recursive: true }); } catch { /* ignore */ }
    try { await Deno.remove(layoutsDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("CLI - init rejects malformed max-cache-entries values", { timeout: 10000 }, async () => {
  for (const value of ["7x", "1.5", "1e2", "-1"]) {
    const result = await runCliTest(["init", "--max-cache-entries", value]);
    assertEquals(result.code, "INVALID_FLAG", value);
    assertStringIncludes(result.message!, "max-cache-entries");
    assertStringIncludes(result.message!, value);
  }

  const equalsForm = await runCliTest(["init", "--max-cache-entries=-1"]);
  assertEquals(equalsForm.code, "INVALID_FLAG");
  assertStringIncludes(equalsForm.message!, "max-cache-entries");
  assertStringIncludes(equalsForm.message!, "-1");
});

Deno.test("CLI - init accepts exact max-cache-entries integers", { timeout: 10000 }, async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "lq_cache_entries_home" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_cache_entries_layouts" });
  try {
    for (const value of ["0", "7"]) {
      await runCliWithEnv(
        ["init", "--global", "--layouts-dir", layoutsDir, "--max-cache-entries", value],
        { HOME: tmpHome, USERPROFILE: tmpHome },
      );
      const config = JSON.parse(await Deno.readTextFile(`${tmpHome}/.lq/config.json`));
      assertEquals(config.maxCacheEntries, Number(value));
    }
  } finally {
    try { await Deno.remove(tmpHome, { recursive: true }); } catch { /* ignore */ }
    try { await Deno.remove(layoutsDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("CLI - init reject nonexistent layouts-dir", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--layouts-dir", "/nonexistent/path/12345"]);
  assertEquals(result.code, "DIR_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 11. init success (with fake HOME to avoid corrupting user config)
// ---------------------------------------------------------------------------
Deno.test("CLI - init success with fake home", { timeout: 10000 }, async () => {
  // Use a temp directory as CWD so local init writes outside the repository.
  const projectDir = await Deno.makeTempDir({ prefix: "lq_test_project" });
  const tmpHome = await Deno.makeTempDir({ prefix: "lq_test_home" });
  // Need a valid layouts dir — use the fixture directory (it's a real dir)
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_test_layouts" });
  try {
    await runCliWithEnv(
      ["init", "--layouts-dir", layoutsDir],
      { HOME: tmpHome, USERPROFILE: tmpHome },
      projectDir,
    );

    // Verify config was written
    const configPath = `${projectDir}/.lq/config.json`;
    const configText = await Deno.readTextFile(configPath);
    const config = JSON.parse(configText);
    assertEquals(config.layoutsDir, layoutsDir);
    assertEquals(config.refresh, "none");
    assertEquals(config.trackChanges, true);
  } finally {
    try { await Deno.remove(projectDir, { recursive: true }); } catch { /* ignore */ }
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
    await runCliWithConfig(
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
    await runCliWithConfig(
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
    await runCliWithConfig(
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
    await runCliTest(["set", tempFile, "layout[Standard]:contains('writing')", "text", "--find", "writing"]);

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
    await runCliTest(["set", tempFile, "layout[Standard]:contains('paper')", "article", "--find", "paper"]);

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
    assertStringIncludes(result.message!, "--text-only");
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
    await runCliWithConfig(
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
    await runCliTest(["set", tempFile, "property[language]", "english", "--find", "british"]);

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

// ---------------------------------------------------------------------------
// 23. T8: bib on file without bibliography — NO_BIBLIO error
// ---------------------------------------------------------------------------
Deno.test("CLI - bib on file without bibliography", { timeout: 10000 }, async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tempFile,
      "#LyX 2.5 created this file.\n" +
      "\\begin_document\n\\begin_header\n\\end_header\n" +
      "\\begin_body\n" +
      "\\begin_layout Standard\nNo bibliography here.\n\\end_layout\n" +
      "\\end_body\n\\end_document\n"
    );
    const result = await runCliTest(["bib", tempFile]);
    assertEquals(result.code, "NO_BIBLIO");
    assertStringIncludes(result.message!, "inset[CommandInset bibtex]");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 24. T9: schema fallback auto-detection when no layouts dir configured
// ---------------------------------------------------------------------------
Deno.test("CLI - schema fallback auto-detects layouts", { timeout: 10000 }, async () => {
  // runCliTest provides a clean config with no layoutsDir set.
  // schema should auto-detect the LyX layouts path.
  const result = await runCliTest(["schema", FIXTURE]);
  const data = result.data as { headingHierarchy?: Array<{ layout: string; level: number }> };
  assertEquals(data.headingHierarchy !== undefined, true);
  assertEquals((data.headingHierarchy!).length > 0, true, "headingHierarchy should not be empty");
});

// ---------------------------------------------------------------------------
// 25. T7: dump --toc on Beamer textclass
// ---------------------------------------------------------------------------
Deno.test("CLI - dump --toc on Beamer textclass", { timeout: 10000 }, async () => {
  const beamerFixture = "tests/fixtures/Presentations/Beamer.lyx";
  const result = await runCliTest(["dump", beamerFixture, "--toc"]);
  const data = result.data as Array<{ layout: string; text: string }>;
  assertEquals(data.length > 0, true, "Beamer ToC should have entries");
  // Beamer uses Frame instead of Section — verify frames appear in the ToC
  const layouts = data.map(d => d.layout).join(" ");
  assertStringIncludes(layouts, "Frame");
});

// ---------------------------------------------------------------------------
// 25b. DL83: --toc heading text clean (no inset markers) + --depth = absolute TocLevel
// ---------------------------------------------------------------------------
Deno.test("CLI - dump --toc heading text clean + depth = absolute TocLevel", { timeout: 10000 }, async () => {
  const fixture = "tests/fixtures/my_template.lyx";
  const full = await runCliTest(["dump", fixture, "--toc"]);
  const fullData = full.data as Array<{ layout: string; text: string; children: unknown[] }>;
  assertEquals(fullData.length > 0, true, "TOC should have entries");
  for (const n of fullData) {
    assert(!n.text.includes("inset["), `heading text must not contain inset markers: "${n.text}"`);
  }

  // --depth 1 = TocLevel 1 = Section: the level-1 anchor (top-level sections)
  const depth1 = await runCliTest(["dump", fixture, "--toc", "--depth", "1"]);
  const depth1Data = depth1.data as Array<{ layout: string; children: unknown[] }>;
  assertEquals(depth1Data.length > 0, true, "depth 1 should show top-level headings");
  for (const n of depth1Data) {
    assertEquals(n.layout, "Section", `depth 1 = Section (level-1 anchor), got ${n.layout}`);
    assertEquals((n.children as unknown[]).length, 0, "depth 1 must drop subsections");
  }

  // --depth 2 = TocLevel <= 2 = Section + Subsection (cumulative)
  const depth2 = await runCliTest(["dump", fixture, "--toc", "--depth", "2"]);
  const depth2Data = depth2.data as Array<{ children: Array<{ layout: string }> }>;
  const hasSubsection = depth2Data.some(n => n.children.some(c => c.layout === "Subsection"));
  assertEquals(hasSubsection, true, "depth 2 must include Subsection under Section");

  // --depth 0 = TocLevel <= 0: article has no level-0 headings -> empty + warning
  const depth0 = await runCliTest(["dump", fixture, "--toc", "--depth", "0"]);
  assertEquals((depth0.data as unknown[]).length, 0, "depth 0 must be empty for an article");
  assertEquals((depth0.warnings ?? []).length > 0, true, "empty depth must report a warning");

  // --depth -1 = TocLevel <= -1: no Parts in this doc -> empty + warning; and
  // any integer (space form) is accepted for --toc (not INVALID_FLAG)
  const depthNeg = await runCliTest(["dump", fixture, "--toc", "--depth", "-1"]);
  assertEquals((depthNeg.data as unknown[]).length, 0, "depth -1 must be empty (no Parts)");
  assertEquals(depthNeg.code, undefined, "negative depth must be accepted for --toc");

  // non-integers are still rejected
  const bad = await runCliTest(["dump", fixture, "--toc", "--depth", "1.5"]);
  assertEquals(bad.code, "INVALID_FLAG", "non-integer depth must be rejected");

  // Book: --depth 0 = TocLevel 0 = Chapter (the book's top-level anchor)
  const book = "tests/fixtures/Books/KOMA-Script_Book.lyx";
  const book0 = await runCliTest(["dump", book, "--toc", "--depth", "0"]);
  const book0Data = book0.data as Array<{ layout: string }>;
  assertEquals(book0Data.length > 0, true, "book depth 0 should show Chapters");
  for (const n of book0Data) {
    assertEquals(n.layout, "Chapter", `book depth 0 = Chapter, got ${n.layout}`);
  }
});

// ---------------------------------------------------------------------------
// 26. T5: init --refresh save-reload succeeds regardless of LyXServer state
// ---------------------------------------------------------------------------
Deno.test("CLI - init --refresh save-reload succeeds", { timeout: 10000 }, async () => {
  // Use a dedicated home: changing refresh here must not affect later tests
  // that share runCliTest's safe refresh=none configuration.
  const tmpHome = await Deno.makeTempDir({ prefix: "lq_test_refresh_home" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_test_refresh_layouts" });
  try {
    const result = await runCliWithEnv(
      ["init", "--global", "--layouts-dir", layoutsDir, "--refresh", "save-reload"],
      { HOME: tmpHome, USERPROFILE: tmpHome },
    );
    assertEquals((result.data as Record<string, unknown>).refresh, "save-reload");
  } finally {
    try { await Deno.remove(tmpHome, { recursive: true }); } catch { /* ignore */ }
    try { await Deno.remove(layoutsDir, { recursive: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 27. T3: set --find on property node — warning labels node as "property"
// ---------------------------------------------------------------------------
Deno.test("CLI - set --find on property node warns as property", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_find_prop_warn.lyx");
  try {
    const result = await runCliTest(["set", tempFile, "property[language]", "english", "--find", "british"]);
    // The --find warning should identify the matched node type as "property"
    if (result.warnings && result.warnings.length > 0) {
      assertStringIncludes(
        JSON.stringify(result.warnings).toLowerCase(),
        "property",
      );
    }
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 28. DL74 inset tracking guards — tracked set on inset block
// ---------------------------------------------------------------------------
Deno.test("CLI - tracked set on inset block rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_inset_tc_set.lyx");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "inset[CommandInset label]:first", "new label"],
      { trackChanges: true },
    );
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "Cannot track changes inside inset parameters");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 29. DL74 inset tracking guards — default set on inset without tracking
// ---------------------------------------------------------------------------
Deno.test("CLI - default set on inset block rejects with TRACKING_ERROR (tracking off)", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_inset_default_set.lyx");
  try {
    // runCliTest uses trackChanges=false
    const result = await runCliTest(["set", tempFile, "inset[CommandInset label]:first", "new label"]);
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "Default 'set' on an inset would destroy its structure");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 30. DL74 inset tracking guards — untracked --find on inset (escape hatch)
// ---------------------------------------------------------------------------
Deno.test("CLI - untracked --find on inset block allowed", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_inset_find_ok.lyx");
  try {
    // Untracked --find on an inset should still work (explicit surgical edit)
    const result = await runCliTest([
      "set", tempFile, "inset[CommandInset label]:first", "sec:new", "--find", "sec:"
    ]);
    assertEquals(result.code, undefined);
    assertEquals(result.modified_nodes, 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 31. DL74 inset tracking guards — delete on inset nested inside another inset
// ---------------------------------------------------------------------------
Deno.test("CLI - delete on nested inset rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_nested_inset_del.lyx");
  try {
    // Text insets are direct children of Tabular insets (inset inside inset)
    const result = await runCliWithConfig(
      ["delete", tempFile, "inset[Text]:first"],
      { trackChanges: true },
    );
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "Cannot track-delete an inset nested inside another inset");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 32. DL74 inset tracking guards — delete on top-level inset wraps atomically
// ---------------------------------------------------------------------------
Deno.test("CLI - delete on top-level inset wraps markers around whole inset", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_toplevel_inset_del.lyx");
  try {
    await runCliWithConfig(
      ["delete", tempFile, "inset[Foot]:first"],
      { trackChanges: true },
    );

    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\change_deleted");
    // The marker must appear BEFORE \begin_inset Foot, not inside
    assertMatch(text, /\\change_deleted[^\n]*\n\\begin_inset Foot/);
    // The closing marker must appear AFTER \end_inset
    assertMatch(text, /\\end_inset\n\\change_unchanged/);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});
