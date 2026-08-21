/**
 * Development-only XHTML oracle tests (dev log 129 / 130).
 *
 * Missing LyX skips the export comparison; sanitizer tests always run.
 * Prefer tiny Synthetic isolates — not full Help manuals (DL130 J2).
 */
import { assert, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  assertSanitized,
  compareLiveToOracle,
  extractXhtmlBody,
  findLyxBinary,
  sanitizeXhtmlBody,
  XhtmlOracleError,
} from "../tools/xhtml_oracle.ts";

const SYNTHETIC = fromFileUrl(new URL("./fixtures/Synthetic/", import.meta.url));

/** Baseline M1 floor isolates (DL129). */
const PARITY_FIXTURES = [
  "headings_paragraphs.lyx",
  "lists_quotes.lyx",
  "table_figure_foot_math.lyx",
  "hostile.lyx",
  "tracked_ert_notes.lyx",
  "front_matter_math.lyx",
];

/** DL130 construct slices — Help clones / feature isolates. */
const SLICE_FIXTURES = [
  "nameref_titles.lyx",
  "logical_charstyles.lyx",
  "info_icon_shortcut.lyx",
];

Deno.test("oracle sanitizer - drops head material, scripts, handlers, javascript URLs", () => {
  const exportDoc = `<!DOCTYPE html><html><head><style>body{color:red}</style><script>alert(1)</script></head><body><p onclick="alert(1)">Hi</p><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe></body></html>`;
  const body = extractXhtmlBody(exportDoc);
  const sanitized = sanitizeXhtmlBody(body);
  assertSanitized(sanitized);
  assert(!sanitized.includes("<script"));
  assert(!/onclick/i.test(sanitized));
  assert(!/javascript:/i.test(sanitized));
  assert(!sanitized.includes("<iframe"));
  assert(!sanitized.includes("<style"));
});

Deno.test("oracle sanitizer - missing body is a clean failure", () => {
  assertThrows(() => extractXhtmlBody("<html><div>no body</div></html>"), XhtmlOracleError);
});

Deno.test({
  name: "oracle export - representative fixture when LyX is available",
  ignore: false,
  sanitizeResources: false,
  sanitizeOps: false,
  timeout: 180000,
  fn: async () => {
    const binary = await findLyxBinary();
    if (!binary) {
      console.log("LyX binary not found; skipping oracle export comparison.");
      return;
    }
    for (const name of PARITY_FIXTURES) {
      const file = `${SYNTHETIC}${name}`;
      const result = await compareLiveToOracle(binary, file, { timeoutMs: 30000 });
      assert(result.equal, `${name} Live vs oracle:\n${result.diff}`);
    }
  },
});

Deno.test({
  name: "oracle export - DL130 Help-slice Synthetic isolates when LyX is available",
  ignore: false,
  sanitizeResources: false,
  sanitizeOps: false,
  timeout: 180000,
  fn: async () => {
    const binary = await findLyxBinary();
    if (!binary) {
      console.log("LyX binary not found; skipping DL130 slice oracle comparison.");
      return;
    }
    for (const name of SLICE_FIXTURES) {
      const file = `${SYNTHETIC}${name}`;
      const result = await compareLiveToOracle(binary, file, { timeoutMs: 45000 });
      assert(result.equal, `${name} Live vs oracle:\n${result.diff}`);
    }
  },
});
