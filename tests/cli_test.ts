/**
 * CLI interface tests — coverage for help, error paths, dump, read --count,
 * bib --search, set/delete success paths, and init validation.
 *
 * Uses runCliTest/runCliRaw from helpers.ts, which isolate tests from the
 * developer's local ~/.lq/config.json by creating a temp config with:
 *   refresh: "none"
 *   trackChanges: false
 *
 * Run from the repo root or lq/: deno test -A (fixture paths are cwd-independent)
 */

import { assertEquals, assert, assertStringIncludes, assertMatch } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { runCliTest, runCliRaw, runCliWithEnv, runCliWithConfig, createTempFixture } from "./helpers.ts";
import { findByReach } from "../src/help.ts";
import { getUserHomeDir } from "../src/paths.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));

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
Deno.test("CLI - global help is the home page map", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["--help"]);
  assertStringIncludes(stdout, "Help commands");
  assertStringIncludes(stdout, "Pages");
  assertStringIncludes(stdout, "model/");
  assertStringIncludes(stdout, "concepts/");
  assertStringIncludes(stdout, "commands/");
  assertStringIncludes(stdout, "lq help read");
  assertStringIncludes(stdout, "lq help set");
  assertStringIncludes(stdout, "lq help undo");
  assertStringIncludes(stdout, "lq help tracked-changes");
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
  assertStringIncludes(stdout, "split-after");
  assertStringIncludes(stdout, "exactly once");
  assertStringIncludes(stdout, "prepend");
  assertStringIncludes(stdout, "--layout");
  assertStringIncludes(stdout, "--cite");
  assertStringIncludes(stdout, "--ref");
  assertStringIncludes(stdout, "--label");
  assertStringIncludes(stdout, "--footnote");
  assertStringIncludes(stdout, "--raw-file");
});

Deno.test("CLI - per-command help (init) documents strict cache count", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["init", "--help"]);
  assertStringIncludes(stdout, "lq init");
  assertStringIncludes(stdout, "--global");
  assertStringIncludes(stdout, "local");
  assertStringIncludes(stdout, "--max-cache-entries");
  assertStringIncludes(stdout, "non-negative integer");
  assertStringIncludes(stdout, "--track-changes");
  assertStringIncludes(stdout, "State scope");
});

// --- Help router (Phase 2) ---
Deno.test("CLI - lq help opens the home page map", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["help"]);
  assertStringIncludes(stdout, "Pages");
  assertStringIncludes(stdout, "lq help selectors");
});

Deno.test("CLI - lq help <page> opens that page", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["help", "tracked-changes"]);
  assertStringIncludes(stdout, "change regions and tracked behavior");
  assertStringIncludes(stdout, "change_deleted");
  assertStringIncludes(stdout, "Further reading");
});

Deno.test("CLI - unknown help page fails with an actionable message", { timeout: 10000 }, async () => {
  const result = await runCliTest(["help", "nope"]);
  assertEquals(result.code, "UNKNOWN_HELP_PAGE");
  assertStringIncludes(result.message!, "lq help");
});

Deno.test("CLI - invalid --rich value fails", { timeout: 10000 }, async () => {
  const result = await runCliTest(["help", "--rich=bogus"]);
  assertEquals(result.code, "INVALID_FLAG");
  assertStringIncludes(result.message!, "--rich");
});

// ---------------------------------------------------------------------------
// Phase 4 — comprehensive help navigation and content
// ---------------------------------------------------------------------------
const COMMAND_REACHES = ["init", "schema", "dump", "read", "bib", "set", "delete", "insert", "undo"];
const TOPIC_REACHES = [
  "cst",
  "guarantees",
  "state-scope",
  "private-notes",
  "insets",
  "selectors",
  "mutations",
  "tracked-changes",
];
const ALL_REACHES = [...COMMAND_REACHES, ...TOPIC_REACHES];

Deno.test("CLI - every help page is reachable via lq help <page>", { timeout: 30000 }, async () => {
  for (const reach of ALL_REACHES) {
    const { stdout } = await runCliRaw(["help", reach]);
    assertStringIncludes(stdout, findByReach(reach)!.title, `help page ${reach} not reachable`);
  }
});

Deno.test("CLI - lq <command> --help equals lq help <command> for every command", { timeout: 30000 }, async () => {
  for (const cmd of COMMAND_REACHES) {
    const viaHelp = await runCliRaw(["help", cmd]);
    const viaFlag = await runCliRaw([cmd, "--help"]);
    assertEquals(viaHelp.stdout, viaFlag.stdout, `${cmd} alias mismatch`);
  }
});

Deno.test("CLI - home page map lists every page", { timeout: 10000 }, async () => {
  const { stdout } = await runCliRaw(["help"]);
  for (const reach of ALL_REACHES) {
    assertStringIncludes(stdout, `lq help ${reach}`, `home map missing ${reach}`);
  }
});

Deno.test("CLI - help output stays plain when stdout is not a terminal", { timeout: 30000 }, async () => {
  const cases: string[][] = [["help"], ["help", "read"], ["help", "--rich=auto"], ["help", "--rich=never"]];
  for (const args of cases) {
    const { stdout } = await runCliRaw(args);
    assertEquals(stdout.includes("\x1b["), false, `ANSI leaked for '${args.join(" ")}'`);
  }
});

Deno.test("CLI - no help output references the removed lq selector --help", { timeout: 30000 }, async () => {
  for (const reach of ALL_REACHES) {
    const { stdout } = await runCliRaw(["help", reach]);
    assertEquals(stdout.includes("lq selector --help"), false, `${reach} references lq selector --help`);
  }
});

/** High-risk facts each command page must document (edge-case checklist). */
const PAGE_FACTS: [string, string[]][] = [
  ["init", ["--global", "--refresh", "auto-detect", "--track-changes", "save-reload"]],
  ["schema", ["documentLayouts", "insetLayouts", "commandInsetSubtypes", "headingHierarchy", "textclass"]],
  ["dump", ["--depth", "--toc", "TocLevel", "truncated"]],
  ["read", ["--count", "--text-only", "change_deleted", "empty result"]],
  ["bib", ["--search", ".bib"]],
  ["set", ["--find", "--replace-all", "inset is rejected"]],
  ["delete", ["subtree"]],
  ["insert", ["split-after", "--raw-file", "exactly once", "prepend"]],
  ["undo", ["Snapshot restore", "Replay undo", "substring"]],
];

Deno.test("CLI - each command page documents its high-risk facts", { timeout: 30000 }, async () => {
  for (const [page, facts] of PAGE_FACTS) {
    const { stdout } = await runCliRaw(["help", page]);
    for (const fact of facts) {
      assertStringIncludes(stdout, fact, `${page} missing '${fact}'`);
    }
  }
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
  assertStringIncludes(result.message!, "lq help selectors");
});

Deno.test("CLI - unknown command recommends home help", { timeout: 10000 }, async () => {
  const result = await runCliTest(["unknown", FIXTURE, "layout"]);
  assertEquals(result.code, "UNKNOWN_COMMAND");
  assertStringIncludes(result.message!, "lq help");
});

// test_report_53 D1: an unknown command with a single file arg used to fall
// through to MISSING_SELECTOR; the KNOWN_COMMANDS guard (dev log 120 D3) now
// rejects it up front.
Deno.test("CLI - unknown command with one file arg reports UNKNOWN_COMMAND (not MISSING_SELECTOR)", { timeout: 10000 }, async () => {
  const result = await runCliTest(["unknown", FIXTURE]);
  assertEquals(result.code, "UNKNOWN_COMMAND");
  assertStringIncludes(result.message!, "lq help");
});

Deno.test("CLI - unknown command alone reports UNKNOWN_COMMAND (not MISSING_ARGS)", { timeout: 10000 }, async () => {
  const result = await runCliTest(["unknown"]);
  assertEquals(result.code, "UNKNOWN_COMMAND");
  assertStringIncludes(result.message!, "lq help");
});

Deno.test("CLI - selector-position flag typos are rejected", { timeout: 20000 }, async () => {
  const cases = [
    ["read", "--text-ony"],
    ["schema", "--bogus-flag"],
    ["delete", "--bogus-flag"],
    ["undo", "--bogus-flag"],
  ];
  for (const [command, typo] of cases) {
    const result = await runCliTest([command, FIXTURE, typo]);
    assertEquals(result.code, "INVALID_FLAG", `${command} must reject ${typo}`);
    assertStringIncludes(result.message!, typo);
    assertStringIncludes(result.message!, `lq ${command} --help`);
  }
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
// 7b. bib on a direct .bib file (dev log 109)
// ---------------------------------------------------------------------------
const BIB_FIXTURE = fromFileUrl(new URL("./fixtures/biblioExample.bib", import.meta.url));

Deno.test("CLI - bib on .bib file returns all citations", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", BIB_FIXTURE]);
  const data = result.data as Array<Record<string, string>>;
  assertEquals(data.length, 15);
  const keys = data.map(c => c.key);
  assert(keys.includes("Mena2000"));
  assert(keys.includes("Abernethy2003"));
  assertEquals(new Set(keys).size, keys.length);
});

Deno.test("CLI - bib on .bib file with --search", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", BIB_FIXTURE, "--search", "Mena"]);
  const data = result.data as Array<Record<string, string>>;
  assertEquals(data.length, 1);
  assertEquals(data[0].key, "Mena2000");
});

Deno.test("CLI - bib on .bib file deduplicates keys", { timeout: 10000 }, async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".bib" });
  try {
    await Deno.writeTextFile(tempFile,
      "@ARTICLE{Dup2020,\n  author = {Alice Author},\n  title = {Duplicate key},\n  year = {2020}\n}\n" +
      "@BOOK{Dup2020,\n  author = {Bob Author},\n  title = {Same key},\n  year = {2021}\n}\n" +
      "@ARTICLE{Unique2022,\n  author = {Carol Author},\n  title = {Unique key},\n  year = {2022}\n}\n"
    );
    const result = await runCliTest(["bib", tempFile]);
    const data = result.data as Array<Record<string, string>>;
    assertEquals(data.length, 2);
    assertEquals(data.map(c => c.key).sort(), ["Dup2020", "Unique2022"]);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - bib on .BIB file (case-insensitive)", { timeout: 10000 }, async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".BIB" });
  try {
    await Deno.writeTextFile(tempFile,
      "@ARTICLE{CaseTest2000,\n  author = {Case Author},\n  title = {Case test},\n  year = {2000}\n}\n"
    );
    const result = await runCliTest(["bib", tempFile]);
    const data = result.data as Array<Record<string, string>>;
    assertEquals(data.length, 1);
    assertEquals(data[0].key, "CaseTest2000");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - bib rejects non-.lyx non-.bib files", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", "refs.txt"]);
  assertEquals(result.code, "INVALID_EXTENSION");
  assertStringIncludes(result.message!, ".lyx document or a .bib file");
});

// ---------------------------------------------------------------------------
// 7c. bib .lyx route — references with a path dot (test_report_52 B1)
// ---------------------------------------------------------------------------
// NOTE: the fixture filename contains a literal '%26' — fromFileUrl decodes
// URL percent-encoding, so this path must not round-trip through a URL.
const ASTRONOMY_FIXTURE =
  `${import.meta.dirname}/fixtures/Articles/Astronomy_%26_Astrophysics.lyx`;

Deno.test("CLI - bib resolves a ../ relative bibfiles reference", { timeout: 10000 }, async () => {
  const result = await runCliTest(["bib", ASTRONOMY_FIXTURE]);
  const data = result.data as Array<Record<string, string>>;
  assertEquals(data.length, 15);
});

Deno.test("CLI - bib resolves a reference through a dotted directory", { timeout: 10000 }, async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const subDir = `${tmpDir}/dir.with.dot`;
    await Deno.mkdir(subDir);
    await Deno.writeTextFile(`${subDir}/refs.bib`,
      "@article{pathdot2024,\n" +
      "  author = {P. Dot},\n" +
      "  title = {Dotted directory reference},\n" +
      "  year = {2024}\n" +
      "}\n"
    );
    const docPath = `${tmpDir}/doc.lyx`;
    await Deno.writeTextFile(docPath,
      "#LyX 2.5 created this file.\n" +
      "\\begin_document\n\\begin_header\n\\end_header\n" +
      "\\begin_body\n" +
      "\\begin_layout Standard\n" +
      "A citation.\n" +
      "\\begin_inset CommandInset bibtex\n" +
      "LatexCommand bibtex\n" +
      "btprint \"btPrintAll\"\n" +
      "bibfiles \"dir.with.dot/refs\"\n" +
      "\\end_inset\n" +
      "\\end_layout\n" +
      "\\end_body\n\\end_document\n"
    );
    const result = await runCliTest(["bib", docPath]);
    const data = result.data as Array<Record<string, string>>;
    assertEquals(data.length, 1);
    assertEquals(data[0].key, "pathdot2024");
  } finally {
    try { await Deno.remove(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

Deno.test("CLI - bib skips a non-.bib reference (extension guard)", { timeout: 10000 }, async () => {
  const tempFile = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tempFile,
      "#LyX 2.5 created this file.\n" +
      "\\begin_document\n\\begin_header\n\\end_header\n" +
      "\\begin_body\n" +
      "\\begin_layout Standard\n" +
      "A citation.\n" +
      "\\begin_inset CommandInset bibtex\n" +
      "LatexCommand bibtex\n" +
      "btprint \"btPrintAll\"\n" +
      "bibfiles \"style.bst\"\n" +
      "\\end_inset\n" +
      "\\end_layout\n" +
      "\\end_body\n\\end_document\n"
    );
    const result = await runCliTest(["bib", tempFile]);
    assertEquals(result.code, "NO_BIBFILE");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
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
  const beamerFixture = fromFileUrl(new URL("./fixtures/Presentations/Beamer.lyx", import.meta.url));
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
  const fixture = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));
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
  const book = fromFileUrl(new URL("./fixtures/Books/KOMA-Script_Book.lyx", import.meta.url));
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

// ---------------------------------------------------------------------------
// 33. DL111 tracked edits on non-layout text — preamble / comments / inset metadata
// ---------------------------------------------------------------------------
// LyX only accepts change markers inside a layout's text. Tracked set/delete
// on preamble lines, `#` comments, or inset metadata must fail closed
// (TRACKING_ERROR) and leave the file byte-identical instead of emitting
// markers LyX would read as literal content (dev log 111).

async function assertFileByteIdentical(tempFile: string) {
  const original = await Deno.readTextFile(FIXTURE);
  assertEquals(await Deno.readTextFile(tempFile), original);
}

Deno.test("CLI - tracked set on preamble block rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_preamble_set.lyx");
  try {
    const result = await runCliWithConfig(["set", tempFile, "preamble", "X"], { trackChanges: true });
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "only valid inside a layout's text");
    await assertFileByteIdentical(tempFile);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - tracked set --find on preamble text rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_preamble_find.lyx");
  try {
    const result = await runCliWithConfig(
      ["set", tempFile, "preamble text", "X", "--find", "threeparttable"],
      { trackChanges: true },
    );
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "only valid inside a layout's text");
    await assertFileByteIdentical(tempFile);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - tracked delete on preamble block rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_preamble_delete.lyx");
  try {
    const result = await runCliWithConfig(["delete", tempFile, "preamble"], { trackChanges: true });
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "only valid inside a layout's text");
    await assertFileByteIdentical(tempFile);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - tracked set on root # comment rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_comment_set.lyx");
  try {
    const result = await runCliWithConfig(["set", tempFile, "text:first()", "X"], { trackChanges: true });
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "only valid inside a layout's text");
    await assertFileByteIdentical(tempFile);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - tracked set --find on inset metadata text rejects with TRACKING_ERROR", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_inset_meta.lyx");
  try {
    // `inset[Foot] text` matches the `status collapsed` metadata line (a text
    // node in the CST). It HAS a layout[Author] ancestor but is NOT layout
    // text — a naive "any layout ancestor" check would miss it (dev log 111).
    const result = await runCliWithConfig(
      ["set", tempFile, "inset[Foot] text", "X", "--find", "status"],
      { trackChanges: true },
    );
    assertEquals(result.code, "TRACKING_ERROR");
    assertStringIncludes(result.message!, "only valid inside a layout's text");
    await assertFileByteIdentical(tempFile);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - tracked set --find on header property still allowed (regression)", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_prop_ok.lyx");
  try {
    // Properties are plain value edits — never wrapped, never guarded (the
    // guard must not fire on them: cli_test #20/#27 depend on this).
    const result = await runCliWithConfig(
      ["set", tempFile, "property[language]", "english", "--find", "british"],
      { trackChanges: true },
    );
    assertEquals(result.code, undefined);
    assertStringIncludes(await Deno.readTextFile(tempFile), "\\language english");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("CLI - untracked preamble set --find edits cleanly", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl111_preamble_untracked.lyx");
  try {
    // With tracking off, preamble edits remain surgical and marker-free.
    const result = await runCliTest(["set", tempFile, "preamble", "X", "--find", "threeparttable"]);
    assertEquals(result.code, undefined);
    assertEquals(result.modified_nodes, 1);
    const text = await Deno.readTextFile(tempFile);
    assertStringIncludes(text, "\\usepackage{X}");
    // No change markers inside the preamble (the fixture itself has a
    // deliberate tracked-change region in a Standard layout elsewhere).
    const preamble = text.match(/\\begin_preamble[\s\S]*?\\end_preamble/);
    assert(preamble !== null);
    assertEquals(preamble[0].includes("\\change_deleted"), false);
    assertEquals(preamble[0].includes("\\change_inserted"), false);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 32. DL118 — selector mistake guards tightened to hard errors on EVERY
//     command: text:contains dead arm, misplaced :until(), invalid
//     :nth-match formulas (DL112 originally warned on read-only commands)
// ---------------------------------------------------------------------------
Deno.test("DL118 - read errors on anchorless :until()", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_read_until.lyx");
  try {
    const result = await runCliTest(["read", tempFile, "layout[Standard]:until(layout[Section])", "--count"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, ":until()");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - dump errors on anchorless :until()", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_dump_until.lyx");
  try {
    const result = await runCliTest(["dump", tempFile, "layout[Standard]:until(layout[Section])"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, ":until()");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - set errors on anchorless :until(), file unchanged", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_set_until.lyx");
  const before = await Deno.readTextFile(tempFile);
  try {
    const result = await runCliTest(["set", tempFile, "layout[Standard]:until(layout[Section])", "X"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, ":until()");
    // Fail-closed: no commit.
    assertEquals(await Deno.readTextFile(tempFile), before);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - undo replay errors on anchorless :until()", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_undo_until.lyx");
  try {
    const result = await runCliTest(["undo", tempFile, "layout[Standard]:until(layout[Section])"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, ":until()");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - anchor-side :until() errors on read and set", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_anchor_until.lyx");
  const before = await Deno.readTextFile(tempFile);
  try {
    const read = await runCliTest(["read", tempFile, "layout[Standard]:until(layout[Section]) ~ layout[Standard]", "--count"]);
    assertEquals(read.code, "INVALID_SELECTOR");
    assertStringIncludes(read.message!, ":until()");

    const set = await runCliTest(["set", tempFile, "layout[Standard]:until(layout[Section]) ~ layout[Standard]", "X"]);
    assertEquals(set.code, "INVALID_SELECTOR");
    assertEquals(await Deno.readTextFile(tempFile), before);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - text:contains(x) errors on read", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_text_contains.lyx");
  try {
    const result = await runCliTest(["read", tempFile, "text:contains(world)"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, "text:contains");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - set with text:contains(x) errors, file unchanged", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_set_text_contains.lyx");
  const before = await Deno.readTextFile(tempFile);
  try {
    const result = await runCliTest(["set", tempFile, "text:contains(world)", "X"]);
    assertEquals(result.code, "INVALID_SELECTOR");
    assertStringIncludes(result.message!, "never matches");
    assertEquals(await Deno.readTextFile(tempFile), before);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - a union with one dead arm errors (strict)", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_dead_arm.lyx");
  try {
    const result = await runCliTest(["read", tempFile, "text:contains(world) | layout[Standard]", "--count"]);
    assertEquals(result.code, "INVALID_SELECTOR");
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - invalid :nth-match formulas error", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_nth_invalid.lyx");
  try {
    for (const formula of ["abc", "2n+"]) {
      const result = await runCliTest(["read", tempFile, `layout[Standard]:nth-match(${formula})`, "--count"]);
      assertEquals(result.code, "INVALID_SELECTOR", formula);
      assertStringIncludes(result.message!, ":nth-match");
    }
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - :nth-match(0) is a valid formula matching nothing", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_nth_zero.lyx");
  try {
    const result = await runCliTest(["read", tempFile, "layout[Standard]:nth-match(0)", "--count"]);
    assertEquals(result.code, undefined);
    assertEquals(result.count, {});
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - negative: valid selectors neither warn nor error", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_negative.lyx");
  try {
    // The word "text" inside the argument must not trigger the dead-arm check.
    const a = await runCliTest(["read", tempFile, "layout:contains(text)"]);
    assertEquals(a.code, undefined);
    assertEquals((a.warnings ?? []).filter((w) => w.includes("text:contains")), []);

    // The valid bounded form must neither warn nor error.
    const b = await runCliTest(["read", tempFile, "layout[Section]:first ~ layout[Standard]:until(layout[Section])", "--count"]);
    assertEquals(b.code, undefined);
    const warnings = b.warnings ?? [];
    assert(!warnings.some((w) => w.includes("has no effect")), JSON.stringify(warnings));
    assert(!warnings.some((w) => w.includes("text:contains")), JSON.stringify(warnings));

    // Valid :nth-match formulas must not error.
    const c = await runCliTest(["read", tempFile, "layout[Standard]:nth-match(2n+1)", "--count"]);
    assertEquals(c.code, undefined);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL127 F3 - empty or whitespace :nth-match() formula errors instead of matching everything", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl127_nthmatch_empty.lyx");
  try {
    for (const sel of ["layout[Standard]:nth-match()", "layout[Standard]:nth-match( )", "layout[Standard]:nth-match(  )"]) {
      const r = await runCliTest(["read", tempFile, sel, "--count"]);
      assertEquals(r.code, "INVALID_SELECTOR", `${sel} -> ${JSON.stringify(r)}`);
    }
    // Whitespace inside a non-empty formula stays valid.
    const ok = await runCliTest(["read", tempFile, "layout[Standard]:nth-match(2n + 1)", "--count"]);
    assertEquals(ok.code, undefined);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});

Deno.test("DL118 - second snapshot undo names the consumed-snapshot possibility", { timeout: 10000 }, async () => {
  const tempFile = await createTempFixture("temp_dl118_undo_twice.lyx");
  try {
    await runCliWithConfig(["set", tempFile, "layout[Title]", "First edit"], { trackChanges: true });
    await runCliWithConfig(["set", tempFile, "layout[Title]", "Second edit"], { trackChanges: true });
    const first = await runCliWithConfig(["undo", tempFile], { trackChanges: true });
    assertEquals(first.method, "snapshot");
    const second = await runCliWithConfig(["undo", tempFile], { trackChanges: true });
    assertEquals(second.code, "UNDO_SNAPSHOT_UNAVAILABLE");
    assertStringIncludes(second.message!, "Possibly because a previous 'undo' already consumed the snapshot");
    assert(!second.message!.includes("Verify"), second.message!);
  } finally {
    try { await Deno.remove(tempFile); } catch { /* ignore */ }
  }
});
