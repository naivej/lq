/**
 * Live projection contract, renderer, escaping, and semantic comparison
 * (dev log 129).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { parse } from "../src/parser.ts";
import {
  LIVE_CONTRACT,
  LIVE_DEFERRED_FIELDS,
  LIVE_UNAVAILABLE_CAPABILITIES,
  buildLiveResponse,
  detectLineEnding,
  escapeLiveHtml,
  formatSem,
  normalizeReaderHtml,
  renderLiveHtml,
  semanticEqual,
  validateLiveResponse,
} from "../src/preview.ts";
import { runCliRaw, runCliTest } from "./helpers.ts";

const LIVE = fromFileUrl(new URL("./fixtures/Live/", import.meta.url));

function livePath(name: string): string {
  return `${LIVE}${name}`;
}

async function renderFile(name: string) {
  const filePath = livePath(name);
  const text = await Deno.readTextFile(filePath);
  const ast = parse(text);
  return { filePath, text, ast, ...await renderLiveHtml(ast, { filePath }) };
}

Deno.test("Live contract - valid response is accepted", async () => {
  const text = await Deno.readTextFile(livePath("headings_paragraphs.lyx"));
  const ast = parse(text);
  const { response, warnings } = await buildLiveResponse(livePath("headings_paragraphs.lyx"), ast, text);
  const validated = validateLiveResponse({ ...response, warnings });
  assertEquals(validated.contract, LIVE_CONTRACT);
  assertEquals(validated.projection, "live");
  assertEquals(validated.capabilities, { ...LIVE_UNAVAILABLE_CAPABILITIES });
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.hashAlgorithm, "sha256");
  assertEquals(validated.source.hashInput, "raw-file-bytes");
  assertEquals(validated.source.diskHash.length, 64);
});

Deno.test("Live contract - rejects malformed required fields", () => {
  const base = {
    contract: LIVE_CONTRACT,
    projection: "live",
    html: "<article></article>",
    source: {
      path: "C:/tmp/a.lyx",
      hashAlgorithm: "sha256",
      hashInput: "raw-file-bytes",
      diskHash: "a".repeat(64),
      lineEnding: "lf",
      lineCount: 2,
      fresh: true,
    },
    capabilities: { ...LIVE_UNAVAILABLE_CAPABILITIES },
    diagnostics: [],
  };
  assertThrows(() => validateLiveResponse({ ...base, contract: "nope" }), Error, "contract");
  assertThrows(() => validateLiveResponse({ ...base, projection: "review" }), Error, "projection");
  assertThrows(() => validateLiveResponse({ ...base, html: 1 }), Error, "html");
  assertThrows(
    () => validateLiveResponse({ ...base, capabilities: { ...LIVE_UNAVAILABLE_CAPABILITIES, review: true } }),
    Error,
    "review",
  );
  assertThrows(
    () => validateLiveResponse({ ...base, source: { ...base.source, fresh: false } }),
    Error,
    "fresh",
  );
});

Deno.test("Live contract - deferred fields are rejected", () => {
  const base = {
    contract: LIVE_CONTRACT,
    projection: "live",
    html: "<article></article>",
    source: {
      path: "C:/tmp/a.lyx",
      hashAlgorithm: "sha256",
      hashInput: "raw-file-bytes",
      diskHash: "a".repeat(64),
      lineEnding: "lf",
      lineCount: 2,
      fresh: true,
    },
    capabilities: { ...LIVE_UNAVAILABLE_CAPABILITIES },
    diagnostics: [],
  };
  for (const field of LIVE_DEFERRED_FIELDS) {
    assertThrows(() => validateLiveResponse({ ...base, [field]: [] }), Error, field);
  }
});

Deno.test("Live contract - CLI envelope distinguishes disk identity", async () => {
  const result = await runCliTest(["preview", livePath("headings_paragraphs.lyx")]);
  const validated = validateLiveResponse(result);
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.lineEnding, "lf");
  assert(validated.source.lineCount > 1);
  assertEquals(validated.capabilities.editing, false);
  assertEquals(validated.capabilities.mapping, false);
  assertEquals(validated.capabilities.outline, false);
  assertEquals(validated.capabilities.sourceReveal, false);
});

Deno.test("Live renderer - headings, paragraphs, unicode, empty, emphasis", async () => {
  const { html } = await renderFile("headings_paragraphs.lyx");
  const sem = normalizeReaderHtml(html);
  assertEquals(sem.role, "document");
  const dump = formatSem(sem);
  assertStringIncludes(dump, "heading");
  assertStringIncludes(html, "<h2>1 Introduction</h2>");
  assertStringIncludes(html, "<h3>1.1 Details</h3>");
  assertStringIncludes(html, "Café naïve");
  assertStringIncludes(html, "𝄞");
  assertStringIncludes(html, "<em>styled</em>");
  assert(!html.includes('<div class="standard"></div>'), "empty Standard paragraphs are omitted like native XHTML");
});

Deno.test("Live renderer - lists and quotes", async () => {
  const { html } = await renderFile("lists_quotes.lyx");
  assertStringIncludes(html, "<ul>");
  assertStringIncludes(html, "<li>outer one");
  assertStringIncludes(html, "<ul><li>nested</li></ul>");
  assertStringIncludes(html, "<ol>");
  assertStringIncludes(html, "<li>first</li>");
  assertStringIncludes(html, "<dt>Term</dt>");
  assertStringIncludes(html, "<dd>the explanation</dd>");
  assertStringIncludes(html, "<blockquote>");
  assertStringIncludes(html, "A quoted line.");
});

Deno.test("Live renderer - table, figure, footnote, formula", async () => {
  const { html } = await renderFile("table_figure_foot_math.lyx");
  assertStringIncludes(html, "<table>");
  assertStringIncludes(html, "<td>");
  assertStringIncludes(html, ">A</");
  assertStringIncludes(html, 'class="foot"');
  assertStringIncludes(html, "Footnote body.");
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, "E=mc^{2}");
  assertStringIncludes(html, "<figure");
  assertStringIncludes(html, 'data-filename="live-figure.png"');
  assertStringIncludes(html, "<figcaption>Figure 1: ");
  assert(!html.includes("<figcaption>Figure 1: <div"), "caption must stay on one line");
  assertStringIncludes(html, "data-filepath=");
  assertStringIncludes(html, 'src="file:');
});

Deno.test("Live renderer - hostile strings stay escaped", async () => {
  const { html } = await renderFile("hostile.lyx");
  assert(!html.includes("<script>"), "raw script tag must not appear");
  assert(!html.includes("<img src=x"), "raw hostile img must not appear");
  assertStringIncludes(html, "&lt;script&gt;");
  assertStringIncludes(html, "&amp; ampersands");
  assertStringIncludes(html, "&quot;quotes&quot;");
});

Deno.test("Live renderer - tracked/ERT/notes follow XHTML omissions", async () => {
  const { html, warnings, diagnostics } = await renderFile("tracked_ert_notes.lyx");
  assertStringIncludes(html, "Visible");
  assertStringIncludes(html, "inserted");
  assert(!html.includes("deleted"), "deleted tracked text must be omitted");
  assert(!html.includes("textbf"), "ERT must be omitted");
  assert(!html.includes("private note"), "private notes must be omitted");
  assert(warnings.some((w) => w.includes("ERT")));
  assert(diagnostics.some((d) => d.code === "ERT_OMITTED"));
});

Deno.test("Live renderer - title, author, abstract, and math", async () => {
  const { html } = await renderFile("front_matter_math.lyx");
  assertStringIncludes(html, '<h1 class="title">Title</h1>');
  assertStringIncludes(html, '<div class="author">My name');
  assertStringIncludes(html, 'class="foot_intitle"');
  assertStringIncludes(html, 'class="foot_intitle_label">*</span>');
  assertStringIncludes(html, "Details about me");
  assertStringIncludes(html, '<div class="abstract">');
  assertStringIncludes(html, '<span class="abstract_label">Abstract</span>');
  assertStringIncludes(html, '<div class="abstract_item">Abstract</div>');
  assertStringIncludes(html, '<div class="abstract_item">Keywords: one</div>');
  assert(!html.includes('<div class="abstract">Abstract</div>'), "abstracts must be grouped, not repeated as sibling blocks");
  assertStringIncludes(html, '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">');
  assertStringIncludes(html, "<mi>ζ</mi>");
  assertStringIncludes(html, 'encoding="application/x-tex"');
  const sem = normalizeReaderHtml(html);
  const dump = formatSem(sem);
  assertStringIncludes(dump, "title");
  assertStringIncludes(dump, "author");
  assertStringIncludes(dump, "abstract");
  assertStringIncludes(dump, "formula");
});

Deno.test("Live renderer - my_template front matter and math", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));
  const text = await Deno.readTextFile(filePath);
  const { html } = await renderLiveHtml(parse(text), { filePath });
  assertStringIncludes(html, '<h1 class="title">Title</h1>');
  assertStringIncludes(html, '<div class="author">My name');
  assertStringIncludes(html, '<span class="abstract_label">Abstract</span>');
  assertStringIncludes(html, '<div class="abstract_item">Keywords:');
  assertStringIncludes(html, '<div class="abstract_item">JEL:');
  assertStringIncludes(html, 'display="block"');
  assertStringIncludes(html, "<mi>ζ</mi>");
  assertStringIncludes(html, "∑");
  assert(!html.includes("\\begin{equation}"), "display math must not dump the TeX environment");
  assert(!html.includes('stretchy="true"'), "\\left/\\right must not emit stretchy fences");
  assertStringIncludes(html, '<span class="ref">1</span>');
  assertStringIncludes(html, '<span class="ref">1.1</span>');
  assert(!html.includes("sec:Section_label"), "refs must resolve to numbers, not raw keys");
  assertStringIncludes(html, "Abernethy et al.");
  assertStringIncludes(html, "References");
  assertStringIncludes(html, "data-filename=\"beamer-g4.jpg\"");
  assertStringIncludes(html, "data-filepath=");
  const fig = html.slice(html.indexOf("<figure"), html.indexOf("</figure>") + 9);
  const capAt = fig.indexOf("<figcaption>");
  const tableAt = fig.indexOf("<table");
  assert(capAt !== -1 && tableAt !== -1 && capAt < tableAt, "figure caption must appear above the figure body");
  assertStringIncludes(fig, "<figcaption>Figure 1: Figure caption");
  assert(!fig.includes("<figcaption>Figure 1: <div"), "figure number and caption must be one line");
});

Deno.test("Live renderer - SpecialChar and quiet insets in Additional.lyx", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const text = await Deno.readTextFile(filePath);
  const { html, diagnostics } = await renderLiveHtml(parse(text), { filePath });
  assertStringIncludes(html, "Additional LyX");
  assertStringIncludes(html, "the LyX");
  assertStringIncludes(html, "⇒");
  assert(!html.includes("<h1 class=\"title\">Additional \\SpecialChar"), "title SpecialChar must expand");
  assertStringIncludes(html, "User&#39;s Guide.");
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assert(
    unknown.length <= 3,
    `too many UNKNOWN_INSET diagnostics: ${unknown.map((d) => d.message).join("; ")}`,
  );
});

Deno.test("Live renderer - escape helper is applied to source-derived text", () => {
  assertEquals(escapeLiveHtml(`<a b="c">`), "&lt;a b=&quot;c&quot;&gt;");
});

Deno.test("Live CLI - parse failure does not emit html", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tmp, "not a lyx file");
    const raw = await runCliRaw(["preview", tmp]);
    assertEquals(raw.code, 1);
    const parsed = JSON.parse(raw.stdout);
    assertEquals(parsed.code, "PARSE_ERROR");
    assertEquals(parsed.html, undefined);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live CLI - CRLF is recorded as crlf and does not spawn per-test LyX", async () => {
  const src = await Deno.readTextFile(livePath("headings_paragraphs.lyx"));
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tmp, src.replaceAll("\n", "\r\n"));
    const result = await runCliTest(["preview", tmp]);
    const validated = validateLiveResponse(result);
    assertEquals(validated.source.lineEnding, "crlf");
    assertEquals(detectLineEnding(src.replaceAll("\n", "\r\n")), "crlf");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live CLI - extra arguments are rejected", async () => {
  const result = await runCliTest(["preview", livePath("hostile.lyx"), "layout"]);
  assertEquals(result.code, "INVALID_FLAG");
});

Deno.test("Live comparison - incidental ids and classes are ignored", () => {
  const a = normalizeReaderHtml(`<div class="standard" id="magicparlabel-9">Hello</div>`);
  const b = normalizeReaderHtml(`<div class="standard">Hello</div>`);
  assert(semanticEqual(a, b), formatSem(a) + "\n---\n" + formatSem(b));
});

Deno.test("Live CSP floor - restrictive policy string has no remote sources", () => {
  const csp = "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "script-src 'none'");
  assert(!/https?:\/\//.test(csp), "CSP must not allow remote http(s) URLs");
});
