/**
 * CLI interface tests — coverage for help, error paths, dump, read --count,
 * bib --search, set/delete success paths, and init validation.
 *
 * Uses the runCliTest helper from mutation_test.ts for JSON-output commands
 * and a raw helper for --help (which outputs plain text).
 */

import { assertEquals, assertStringIncludes, assertGreater } from "@std/assert";
import { runCliTest, runCliRaw, runCliWithEnv, createTempFixture } from "./helpers.ts";

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
  assertEquals(result.status, "error");
  assertEquals(result.code, "INVALID_EXTENSION");
});

// ---------------------------------------------------------------------------
// 4. Missing arguments
// ---------------------------------------------------------------------------
Deno.test("CLI - missing arguments", { timeout: 10000 }, async () => {
  const result = await runCliTest(["read"]);
  assertEquals(result.status, "error");
  assertEquals(result.code, "MISSING_ARGS");
});

// ---------------------------------------------------------------------------
// 5. dump command
// ---------------------------------------------------------------------------
Deno.test("CLI - dump command", { timeout: 10000 }, async () => {
  const result = await runCliTest(["dump", FIXTURE]);
  assertEquals(result.status, "success");
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
  assertEquals(result.status, "success");
  const count = (result as unknown as Record<string, unknown>).count as number;
  assertEquals(typeof count, "number");
  assertGreater(count, 0);
});

// ---------------------------------------------------------------------------
// 7. bib --search
// ---------------------------------------------------------------------------
Deno.test("CLI - bib search", { timeout: 10000 }, async () => {
  // "Mena" matches exactly one citation in the fixture
  const result = await runCliTest(["bib", FIXTURE, "--search", "Mena"]);
  assertEquals(result.status, "success");
  const data = result.data as Array<Record<string, string>>;
  assertEquals(data.length, 1);
  assertEquals(data[0].key, "Mena2000");
});

Deno.test("CLI - bib search (no match)", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", FIXTURE, "--search", "ZZZZZ_NO_MATCH"]);
  assertEquals(result.status, "success");
  assertEquals((result.data as unknown[]).length, 0);
});

// ---------------------------------------------------------------------------
// 8. set command success
// ---------------------------------------------------------------------------
Deno.test("CLI - set command success", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_cli_set_test.lyx");
  try {
    const result = await runCliTest(["set", tempFile, "layout[Title]", "Changed Title"]);
    assertEquals(result.status, "success");

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
    const countBefore = (before as unknown as Record<string, unknown>).count as number;

    // Delete the first Standard layout
    const result = await runCliTest(["delete", tempFile, "layout[Standard]:first"]);
    assertEquals(result.status, "success");

    // Verify count decreased by 1
    const after = await runCliTest(["read", "--count", tempFile, "layout[Standard]"]);
    assertEquals((after as unknown as Record<string, unknown>).count, countBefore - 1);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 10. init validation errors
// ---------------------------------------------------------------------------
Deno.test("CLI - init reject invalid refresh mode", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--refresh", "invalid"]);
  assertEquals(result.status, "error");
  assertEquals(result.code, "INVALID_FLAG");
  assertStringIncludes(result.message!, "refresh");
});

Deno.test("CLI - init reject invalid track-changes", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--track-changes", "invalid"]);
  assertEquals(result.status, "error");
  assertEquals(result.code, "INVALID_FLAG");
  assertStringIncludes(result.message!, "track-changes");
});

Deno.test("CLI - init reject nonexistent layouts-dir", { timeout: 10000 }, async () => {
  const result = await runCliTest(["init", "--layouts-dir", "/nonexistent/path/12345"]);
  assertEquals(result.status, "error");
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
    assertEquals(result.status, "success");

    // Verify config was written
    const configPath = `${tmpHome}/.lq/config.json`;
    const configText = await Deno.readTextFile(configPath);
    const config = JSON.parse(configText);
    assertEquals(config.layoutsDir, layoutsDir);
    assertEquals(config.refresh, "none");
    assertEquals(config.trackChanges, false);
  } finally {
    try { await Deno.remove(tmpHome, { recursive: true }); } catch { /* ignore */ }
    try { await Deno.remove(layoutsDir, { recursive: true }); } catch { /* ignore */ }
  }
});
