/**
 * Development-only XHTML oracle tests (dev log 129, minimal M3.2–M3.3).
 *
 * Missing LyX skips the export comparison; sanitizer tests always run.
 */
import { assert, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { parse } from "../src/parser.ts";
import { formatSem, normalizeReaderHtml, renderLiveHtml, semanticEqual } from "../src/preview.ts";
import {
  assertSanitized,
  exportSanitizedXhtml,
  extractXhtmlBody,
  findLyxBinary,
  sanitizeXhtmlBody,
  XhtmlOracleError,
} from "../src/xhtml_oracle.ts";

const LIVE = fromFileUrl(new URL("./fixtures/Live/", import.meta.url));
const PARITY_FIXTURES = [
  "headings_paragraphs.lyx",
  "lists_quotes.lyx",
  "table_figure_foot_math.lyx",
  "hostile.lyx",
  "tracked_ert_notes.lyx",
  "front_matter_math.lyx",
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
      const file = `${LIVE}${name}`;
      let exported;
      try {
        exported = await exportSanitizedXhtml(binary, file, { timeoutMs: 30000 });
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      assert(exported.sanitized.length > 0, name);
      assertSanitized(exported.sanitized);
      const live = normalizeReaderHtml((await renderLiveHtml(parse(await Deno.readTextFile(file)), { filePath: file })).html);
      assert(
        semanticEqual(live, exported.normalized),
        `${name} Live vs oracle:\n${formatSem(live)}\n---\n${formatSem(exported.normalized)}`,
      );
    }
  },
});
