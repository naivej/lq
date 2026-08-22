/**
 * Live projection contract, renderer, escaping, and semantic comparison
 * (dev log 129).
 *
 * Real-document renderer checks use my_template.lyx and Help/.
 * fixtures/Synthetic/ holds tiny hand-written isolates (hostile, oracle, CRLF).
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "../src/parser.ts";
import { hashText } from "../src/cache.ts";
import {
  LIVE_CAPABILITIES,
  LIVE_CONTRACT,
  LIVE_DEFERRED_FIELDS,
  type LiveNavigate,
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

const SYNTHETIC = fromFileUrl(new URL("./fixtures/Synthetic/", import.meta.url));
const HELP_DIR = fromFileUrl(new URL("./fixtures/Help/", import.meta.url));

function syntheticPath(name: string): string {
  return `${SYNTHETIC}${name}`;
}

async function listHelpLyx(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(HELP_DIR)) {
    if (entry.isFile && entry.name.endsWith(".lyx")) names.push(entry.name);
  }
  names.sort();
  if (names.length === 0) throw new Error("no Help/*.lyx fixtures found");
  return names;
}

async function renderFile(name: string) {
  const filePath = syntheticPath(name);
  const text = await Deno.readTextFile(filePath);
  const ast = parse(text);
  return { filePath, text, ast, ...await renderLiveHtml(ast, { filePath }) };
}

Deno.test("Live contract - valid response is accepted", async () => {
  const text = await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"));
  const ast = parse(text);
  const { response, warnings } = await buildLiveResponse(syntheticPath("headings_paragraphs.lyx"), ast, text);
  const validated = validateLiveResponse({ ...response, warnings });
  assertEquals(validated.contract, LIVE_CONTRACT);
  assertEquals(validated.projection, "live");
  assertEquals(validated.capabilities, { ...LIVE_CAPABILITIES });
  assertEquals(validated.capabilities.outline, true);
  assert(Array.isArray(validated.outline));
  assert(validated.outline.length >= 2, "headings_paragraphs should yield outline entries");
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.hashAlgorithm, "sha256");
  assertEquals(validated.source.hashInput, "raw-file-bytes");
  assertEquals(validated.source.diskHash.length, 64);
});

function emptyNavigate(): LiveNavigate {
  return {
    figures: [],
    tables: [],
    equations: [],
    labels: [],
    listings: [],
    algorithms: [],
  };
}

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
    capabilities: { ...LIVE_CAPABILITIES },
    diagnostics: [],
    outline: [],
    navigate: emptyNavigate(),
  };
  assertThrows(() => validateLiveResponse({ ...base, contract: "nope" }), Error, "contract");
  assertThrows(() => validateLiveResponse({ ...base, projection: "review" }), Error, "projection");
  assertThrows(() => validateLiveResponse({ ...base, html: 1 }), Error, "html");
  assertThrows(
    () => validateLiveResponse({ ...base, capabilities: { ...LIVE_CAPABILITIES, review: true } }),
    Error,
    "review",
  );
  assertThrows(
    () => validateLiveResponse({ ...base, source: { ...base.source, fresh: false } }),
    Error,
    "fresh",
  );
  assertThrows(() => validateLiveResponse({ ...base, outline: "nope" }), Error, "outline");
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
    capabilities: { ...LIVE_CAPABILITIES },
    diagnostics: [],
    outline: [],
    navigate: emptyNavigate(),
  };
  for (const field of LIVE_DEFERRED_FIELDS) {
    assertThrows(() => validateLiveResponse({ ...base, [field]: [] }), Error, field);
  }
  // outline is no longer deferred — must be accepted.
  validateLiveResponse(base);
});

Deno.test("Live contract - CLI envelope distinguishes disk identity", async () => {
  const result = await runCliTest(["preview", syntheticPath("headings_paragraphs.lyx")]);
  const validated = validateLiveResponse(result);
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.lineEnding, detectLineEnding(await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"))));
  assert(validated.source.lineCount > 1);
  assertEquals(validated.capabilities.editing, false);
  assertEquals(validated.capabilities.mapping, false);
  assertEquals(validated.capabilities.outline, true);
  assertEquals(validated.capabilities.sourceReveal, false);
  assert(validated.outline.some((e) => e.text.includes("Introduction")));
});

Deno.test("Live contract - buildLiveResponse honors the passed diskHash (DL132 P4)", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    const original = await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"));
    await Deno.writeTextFile(tmp, original);
    const ast = parse(original);
    const expected = await hashText(original);
    // Simulate a mid-run disk change: the response must identify the bytes it
    // rendered (the passed hash), not the newer disk state.
    await Deno.writeTextFile(tmp, original + "\n% changed on disk after read\n");
    const { response } = await buildLiveResponse(tmp, ast, original, {}, expected);
    assertEquals(response.source.diskHash, expected);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live navigate - Labels lists only leftover anchors (DL131 B)", async () => {
  const file = syntheticPath("navigate_labels.lyx");
  const text = await Deno.readTextFile(file);
  const { response } = await buildLiveResponse(file, parse(text), text);
  const validated = validateLiveResponse(response);
  const names = validated.navigate.labels.map((l) => l.name).sort();
  assertEquals(names, ["box:aside-point", "note:custom-hook"]);
  // Covered elsewhere — must not reappear under Labels.
  for (const banned of ["sec:intro", "fig:demo", "eq:demo"]) {
    assert(!names.includes(banned), `${banned} must not appear under Labels`);
  }
  // Leftovers must not inherit enclosing section number/title (that hid them in Explorer dedupe).
  for (const l of validated.navigate.labels) {
    assertEquals(l.number, "");
    assertEquals(l.text, "");
    assert(!!l.name);
    assertStringIncludes(response.html, `id="${l.id}"`);
  }
  assert(validated.outline.some((e) => /Introduction/i.test(e.text)));
  assert(validated.navigate.figures.some((e) => e.id.includes("float-figure")));
  assert(validated.navigate.equations.some((e) => e.name === "eq:demo" || e.id.includes("eq")));
});

Deno.test("Live outline - disclosure_collapsibles reuses TOC heading ids (DL131 B1)", async () => {
  const { response } = await buildLiveResponse(
    syntheticPath("disclosure_collapsibles.lyx"),
    parse(await Deno.readTextFile(syntheticPath("disclosure_collapsibles.lyx"))),
    await Deno.readTextFile(syntheticPath("disclosure_collapsibles.lyx")),
  );
  const validated = validateLiveResponse(response);
  assert(validated.outline.length >= 5);
  for (const e of validated.outline) {
    assert(e.id.length > 0);
    assertStringIncludes(response.html, `id="${e.id}"`);
  }
  assert(validated.outline.some((e) => /Body footnotes/i.test(e.text)));
  assert(Array.isArray(validated.navigate.figures));
  assert(Array.isArray(validated.navigate.tables));
  assert(validated.navigate.figures.length >= 1, "disclosure fixture has a figure float");
  assert(validated.navigate.tables.length >= 1, "disclosure fixture has a table float");
  for (const e of [...validated.navigate.figures, ...validated.navigate.tables]) {
    assertStringIncludes(response.html, `id="${e.id}"`);
  }
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
  assertStringIncludes(html, '<ol class="enumi">');
  assertStringIncludes(html, "<li>first</li>");
  assertStringIncludes(html, "<dt>Term</dt>");
  assertStringIncludes(html, "<dd>the explanation</dd>");
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, "A quoted line.");
});

Deno.test("Live renderer - missing textclass.layout is a hard error", async () => {
  const filePath = syntheticPath("headings_paragraphs.lyx");
  let caught: (Error & { code?: string }) | undefined;
  try {
    await renderLiveHtml(parse(await Deno.readTextFile(filePath)), {
      filePath,
      layoutsDir: "Z:\\lq-no-such-layouts",
    });
  } catch (e) {
    caught = e as Error & { code?: string };
  }
  assert(caught !== undefined, "expected LAYOUT_NOT_FOUND");
  assertEquals(caught!.code, "LAYOUT_NOT_FOUND");
  assertStringIncludes(caught!.message, "article");
});

Deno.test("Live renderer - table, figure, footnote, formula", async () => {
  const { html } = await renderFile("table_figure_foot_math.lyx");
  assertStringIncludes(html, "<table>");
  assertStringIncludes(html, "<td");
  assertStringIncludes(html, ">A</");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "Footnote body.");
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, "E=mc^{2}");
  assertStringIncludes(html, "<figure");
  assertStringIncludes(html, 'data-filename="live-figure.png"');
  assertStringIncludes(html, "<figcaption");
  assertStringIncludes(html, "Figure 1: ");
  assertStringIncludes(html, 'class="float-caption-Standard"');
  assert(!/<figcaption[^>]*>Figure 1: <div/.test(html), "caption must stay on one line");
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

Deno.test("Live renderer - tracked changes omit deleted; ERT is a Live disclosure chip", async () => {
  const { html, diagnostics } = await renderFile("tracked_ert_notes.lyx");
  assertStringIncludes(html, "Visible");
  assertStringIncludes(html, "inserted");
  assert(!html.includes("deleted"), "deleted tracked text must be omitted");
  // DL131: ERT is Live-only plain-text disclosure (native XHTML still omits).
  assertStringIncludes(html, 'class="disclose ert"');
  assertStringIncludes(html, "\\textbf{nope}");
  assert(!diagnostics.some((d) => d.code === "ERT_OMITTED"), "ERT_OMITTED retired for Live chips");
});

Deno.test("Live renderer - click disclosure and private Note/Comment (DL131)", async () => {
  const { html } = await renderFile("disclosure_notes.lyx");
  assertStringIncludes(html, "<details class=\"disclose foot\"");
  assertStringIncludes(html, "<summary class=\"foot_label\">1</summary>");
  assertStringIncludes(html, "Selectable footnote body");
  assertStringIncludes(html, 'class="disclose note note-note"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Note</summary>");
  assertStringIncludes(html, "private note body");
  assertStringIncludes(html, 'class="disclose note note-comment"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Comment</summary>");
  assertStringIncludes(html, "private comment body");
  assertStringIncludes(html, 'class="disclose note note-greyedout"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Greyedout</summary>");
  assertStringIncludes(html, "greyed always visible");
  // Must not use hover-only hide (collapsed by default via <details>).
  assert(!html.includes(":hover"), "Live HTML must not embed hover CSS");
  assert(!html.includes('class="foot"><span class="foot_label">'), "legacy hover foot markup removed");
});

Deno.test("Live renderer - disclosure_collapsibles covers foldable inset set (DL131)", async () => {
  const { html } = await renderFile("disclosure_collapsibles.lyx");
  const mustDisclose = [
    'class="disclose foot foot_intitle"',
    'class="disclose foot"',
    'class="disclose note note-note"',
    'class="disclose note note-comment"',
    'class="disclose note note-greyedout"',
    'class="disclose marginal"',
    'class="disclose box boxed"',
    'class="disclose float float-figure"',
    'class="disclose float float-table"',
    'class="disclose wrap',
    'class="disclose branch"',
    'class="disclose ert"',
    'class="disclose phantom"',
    'class="disclose index-marker"',
    'class="disclose nomencl"',
    'class="disclose argument"',
    'class="disclose argument short-title"',
  ];
  for (const needle of mustDisclose) {
    assertStringIncludes(html, needle);
  }
  assertStringIncludes(html, ">Float: Figure</summary>");
  assertStringIncludes(html, ">Float: Table</summary>");
  assertStringIncludes(html, ">Wrap: Figure</summary>");
  assertStringIncludes(html, "Greyedout stays visible");
  assertStringIncludes(html, "ShortTitle");
  assertStringIncludes(html, ">Short Title</summary>");
  assertStringIncludes(html, ">NomSymbol</summary>");
  assertStringIncludes(html, ">IndexTerm</summary>");
  assertStringIncludes(html, ">Branch: Demo</summary>");
  assertStringIncludes(html, ">Margin</summary>");
  assertStringIncludes(html, ">Box</summary>");
  assertStringIncludes(html, "\\textbf{chip}");
  assertStringIncludes(html, "phantom body");
  assertStringIncludes(html, ">Argument</summary>");
  assertStringIncludes(html, "Nom description");
  assert(!html.includes("NomSymbol — Nom description"), "Nomenclature must not flatten symbol+description into one marker body");
  assertStringIncludes(html, "IndexTerm");
  assertStringIncludes(html, "NomSymbol");
  assertStringIncludes(html, "Nom description");
  // Non-chip catalog samples present for Live vs GUI comparison.
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "live-figure.png");
  assertStringIncludes(html, "print(&quot;hello&quot;)");
  assertStringIncludes(html, 'class="preview"');
  assert(!html.includes("preview-label"), "Preview box must not add an extra Preview label");
  assertStringIncludes(html, 'class="lyx-pagebreak"');
  assertStringIncludes(html, 'class="lyx-separator"');
  assertStringIncludes(html, 'class="lyx-vspace"');
  assertStringIncludes(html, "<sup>");
  assertStringIncludes(html, "<sub>");
  assertStringIncludes(html, 'href="https://www.lyx.org/"');
  // Charstyle Flex / URL must remain inline — not disclosure chips.
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_emph"');
  assertStringIncludes(html, 'class="flex_strong"');
  assertStringIncludes(html, 'class="noun"'); // Flex Noun → span.noun
  assertStringIncludes(html, 'class="flex_url"');
  assert(!/class="disclose[^"]*url/i.test(html), "Flex URL must stay inline, not a disclosure chip");
  const codeIdx = html.indexOf('class="flex_code"');
  assert(codeIdx !== -1);
  assert(
    !html.slice(Math.max(0, codeIdx - 80), codeIdx).includes("<details"),
    "Flex Code must not sit inside a preceding details opener",
  );
});

Deno.test("Live renderer - title, author, abstract, and math", async () => {
  const { html } = await renderFile("front_matter_math.lyx");
  assertStringIncludes(html, '<h1 class="title">Title</h1>');
  assertStringIncludes(html, '<div class="author">My name');
  assertStringIncludes(html, 'class="disclose foot foot_intitle"');
  assertStringIncludes(html, 'class="foot_intitle_label">*</summary>');
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
  assertStringIncludes(html, '<a class="ref" href="#sec_Section_label">1</a>');
  assertStringIncludes(html, '<a class="ref" href="#subsec_subsec_label">1.1</a>');
  assertStringIncludes(html, 'id="sec_Section_label"');
  assert(!html.includes("sec:Section_label"), "refs must resolve to numbers, not raw keys");
  assertStringIncludes(html, "<h4>1.1.1 Subsubsection");
  assertStringIncludes(html, 'class="float-table"');
  assertStringIncludes(html, "Table 1: Table caption");
  assertStringIncludes(html, ">A Appendix");
  assertStringIncludes(html, 'href="#LyXCite-Abernethy2003"');
  assertStringIncludes(html, "Abernethy et al.");
  assertStringIncludes(html, "Abernethy, Colin D. et al. (2003)");
  assertStringIncludes(html, "In: <i>J. Am. Chem. Soc.</i>");
  assertStringIncludes(html, "doi: 10.1021/ja0276321");
  assertStringIncludes(html, "References");
  assertStringIncludes(html, '<span class="bibtexlabel">1</span>');
  assertStringIncludes(html, "colspan=");
  assertStringIncludes(html, "border-top:");
  assert(!html.includes('<div class="date">'), "preamble \\date is LaTeX-only; native XHTML omits it");
  assertStringIncludes(html, "data-filename=\"beamer-g4.jpg\"");
  assertStringIncludes(html, "data-filepath=");
  const fig = html.slice(html.indexOf("<figure"), html.indexOf("</figure>") + 9);
  const capAt = fig.indexOf("<figcaption");
  const tableAt = fig.indexOf("<table");
  assert(capAt !== -1 && tableAt !== -1 && capAt < tableAt, "figure caption must appear above the figure body");
  assertStringIncludes(fig, "Figure 1: Figure caption");
  assertStringIncludes(fig, 'class="float-caption-Standard"');
  assert(!/<figcaption[^>]*>Figure 1: <div/.test(fig), "figure number and caption must be one line");
});

Deno.test({
  name: "Live renderer - every Help/*.lyx renders",
  timeout: 120000,
  fn: async () => {
    const names = await listHelpLyx();
    const failures: string[] = [];
    for (const name of names) {
      const filePath = join(HELP_DIR, name);
      try {
        const text = await Deno.readTextFile(filePath);
        const { html } = await renderLiveHtml(parse(text), { filePath });
        if (!html.includes('<article class="lyx-live">')) {
          failures.push(`${name}: missing article wrapper`);
        }
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assertEquals(failures, [], failures.join("\n"));
  },
});

Deno.test("Live renderer - dialog-toggle Info icons use icon.aliases (dialog-show_*)", async () => {
  const { html } = await renderFile("info_icon_shortcut.lyx");
  // data-info-icon is only set on resolved <img> (glyph fallback has aria-label only).
  assertStringIncludes(html, 'data-info-icon="dialog-toggle findreplace"');
  assertStringIncludes(html, 'data-info-icon="dialog-toggle toc"');
  assert(
    /<img\b[^>]*data-info-icon="dialog-toggle findreplace"/.test(html),
    "dialog-toggle findreplace must resolve via icon.aliases → dialog-show_findreplace",
  );
  assert(
    /<img\b[^>]*data-info-icon="dialog-toggle toc"/.test(html),
    "dialog-toggle toc must resolve via icon.aliases → dialog-show_toc",
  );
});

Deno.test("Live renderer - Help Math.lyx Phantom chips; no math-mode UNKNOWN dump", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Math.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  // DL131: Phantom is a Live-only plain-text chip (native XHTML still drops it).
  assert(!html.includes("unknown-inset"), "Phantom must not fall back to unknown-inset");
  assertStringIncludes(html, 'class="disclose phantom"');
  assertStringIncludes(html, "<kbd");
  assert(!html.includes('<span class="info">math-mode</span>'), "Info shortcuts must not dump the raw LFUN name as body text");
  // When system bind files are present, resolve LFUN → key chord (keep LFUN in title).
  if (html.includes('title="math-mode"')) {
    assertStringIncludes(html, "Ctrl+M");
    assert(!html.includes(">math-mode</kbd>"), "resolved shortcuts must show the key, not the LFUN body");
  }
  // DL130 J4: classic PNG when LyX images are on disk; else glyph fallback.
  if (html.includes('data-info-icon="math-mode"')) {
    assertStringIncludes(html, '<img class="info-icon"');
    assertStringIncludes(html, "data:image/png;base64,");
  } else {
    assertStringIncludes(html, 'aria-label="math-mode"');
  }
  assertStringIncludes(html, "class=\"typewriter\"");
  assertStringIncludes(html, "class=\"sans\"");
  assertStringIncludes(html, "\u2423");
  assertStringIncludes(html, "<mo>↓</mo>");
  assertStringIncludes(html, "<mfrac>");
  assertStringIncludes(html, "<mtable>");
  assertStringIncludes(html, "<mi>A</mi>");
  assertStringIncludes(html, "<mo>≈</mo>");
  assertStringIncludes(html, "<mo>←</mo>");
  assertStringIncludes(html, "<mphantom>");
  assertStringIncludes(html, "mmultiscripts");
  assertStringIncludes(html, "⏞");
  // DL130 Step 5: chem bonds + preamble aliases must not dump as <mi>\cmd</mi>.
  assert(!html.includes("<mi>\\dbond</mi>"));
  assert(!html.includes("<mi>\\tbond</mi>"));
  assert(!html.includes("<mi>\\hyphen</mi>"));
  assert(!html.includes("<mi>\\gr</mi>"));
  assert(!html.includes("<mi>\\us</mi>"));
  assert(!html.includes("<mi>\\cb</mi>"));
  assert(!html.includes("<mi>\\fb</mi>"));
  assertStringIncludes(html, "⟹"); // \gr → \Longrightarrow via preamble newcommand
  // Info icon with LFUN args: spaces → underscores in LyX images/classic/.
  assertStringIncludes(html, 'data-info-icon="math-macro newmacroname_newcommand"');
  assert(
    html.includes('data-info-icon="math-macro newmacroname_newcommand"') &&
      html.includes("data:image/png;base64,"),
    "math-macro toolbar Info icon must resolve classic PNG (not missing/glyph-only)",
  );
  assert(!html.includes('encoding="application/x-tex">$\\begin{cases}'), "multi-line cases must include the body, not only the first line");
  assert(
    !html.includes('encoding="application/x-tex">\\newcommand{\\qG}'),
    "FormulaMacro must not be rendered as a formula",
  );
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "color:#A0A0A0");
  assertStringIncludes(html, 'mathbackground="yellow"');
  assertStringIncludes(html, 'voffset="2mm"');
  assertStringIncludes(html, 'mathcolor="red"');
  assertStringIncludes(html, "\\int A\\,\\mathrm{d}x");
  assert(
    !html.includes("<mtext></mtext><annotation encoding=\"application/x-tex\"></annotation>"),
    "display formulas whose body starts with \\int must not collapse to empty MathML",
  );
  assertStringIncludes(html, "(something)");
  assertStringIncludes(html, "<mo>⟨</mo>");
  assertStringIncludes(html, "updiagonalstrike");
  assertStringIncludes(html, "mod ");
  assertStringIncludes(html, "<munderover>");
  assertStringIncludes(html, "<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>");
  const cdAt = html.indexOf("<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>");
  const cdChunk = html.slice(cdAt, html.indexOf("</math>", cdAt) + 7);
  assert(!cdChunk.includes('class="eqno"'), "amscd \\[ \\] diagrams must not get equation numbers");
  const cfracAt = html.indexOf("\\cfrac[l]{A}");
  assert(cfracAt !== -1, "Math.lyx \\[ cfrac display missing");
  const cfracEnd = html.indexOf("</math>", cfracAt);
  const cfracAfter = html.slice(cfracEnd, cfracEnd + 80);
  assert(!cfracAfter.includes('class="eqno"'), "\\[ display math must not get an equation number");
  const redAt = html.indexOf("\\textcolor{red}{\\int A=B}");
  assert(redAt !== -1, "Math.lyx numbered textcolor integral missing");
  const redEnd = html.indexOf("</math>", redAt);
  const redAfter = html.slice(redEnd, redEnd + 80);
  assert(redAfter.includes('class="eqno">(2)</span>'), `equation env after the first numbered formula should be (2), got ${redAfter}`);
  assertStringIncludes(html, 'class="eqno">(1)</span>');
  assertStringIncludes(html, 'class="eqno">(something)</span>');
  assertStringIncludes(html, 'class="eqno">something</span>');
  const gatherProse = html.indexOf("Every line can be numbered");
  assert(gatherProse !== -1, "Math.lyx gather section missing");
  const gatherBlock = html.slice(gatherProse, gatherProse + 2500);
  assert(
    (gatherBlock.match(/class="formula-row"/g) ?? []).length >= 2,
    "gather A=1 and X=-1 must be separate rows",
  );
  assert(gatherBlock.includes('class="eqno">'), "gather lines are numbered");
  const gatherNos = [...gatherBlock.matchAll(/class="eqno">\(([^)]*)\)/g)].map((m) => m[1]);
  assert(gatherNos.length >= 2, `gather should number both lines, got ${gatherNos.join(",")}`);
  assertEquals((html.match(/class="eqno"/g) ?? []).length, 36, "per-line gather/align/eqnarray numbers plus \\tag/\\tag*");
  assertStringIncludes(html, 'class="subequations"');
  const subref = html.match(/href="#eq_b">\(([^)]+)\)/);
  assert(subref !== null && /a$/.test(subref[1]), `subequation ref should be like (Na), got ${subref?.[1]}`);
  assertStringIncludes(html, 'mathsize="75%"');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, "„"); // Quotes gld German
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "<h3>Command Scheme</h3>"); // Subsection* unnumbered
  assertStringIncludes(html, "<h4>Advice for Integrals</h4>"); // Subsubsection*
  assertStringIncludes(html, 'class="Boxed"');
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, 'class="index"');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, '<blockquote class="quote">');
});

Deno.test("Live renderer - Help Additional.lyx numbering, TOC, and SpecialChar", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const text = await Deno.readTextFile(filePath);
  const { html, diagnostics } = await renderLiveHtml(parse(text), { filePath });
  assertStringIncludes(html, "Additional LyX");
  assertStringIncludes(html, "the LyX");
  assertStringIncludes(html, "⇒");
  assert(!html.includes("<h1 class=\"title\">Additional \\SpecialChar"), "title SpecialChar must expand");
  assertStringIncludes(html, "User&#39;s Guide.");
  assertStringIncludes(html, ">2.1 How LyX Uses LaTeX</");
  assertStringIncludes(html, 'id="sec-2-1"');
  assertStringIncludes(html, "<nav class=\"toc\">");
  assertStringIncludes(html, "href=\"#sec-2-1\"");
  assertStringIncludes(html, "2.1 How LyX Uses LaTeX");
  const labeling = html.indexOf("The final output contains no page numbers");
  assert(labeling !== -1, "Additional.lyx Labeling example missing");
  const labelingBefore = html.slice(Math.max(0, labeling - 160), labeling);
  assert(
    labelingBefore.includes("<ol") || labelingBefore.includes("<li"),
    `Labeling should use HTMLTag ol, got: …${labelingBefore.slice(-80)}`,
  );
  assert(!labelingBefore.includes('class="labeling"'), "Labeling must not fall back to a generic div");
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'href="https://www.ams.org/publications/authors/tex/amslatex"');
  assertStringIncludes(html, 'class="flex_code"');
  assert(!html.includes("<code><div"), "Flex Code must stay inline");
  assertStringIncludes(html, '<dl class="description">');
  assertStringIncludes(html, "<dt>Address</dt>");
  assertStringIncludes(html, "<dt>Current");
  assertStringIncludes(html, "Current\u00a0Address</dt>");
  assertStringIncludes(html, 'class="Frameless"');
  assertStringIncludes(html, '<span class="noun">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertStringIncludes(html, "4.10.1.4 List Spacing");
  assert(!html.includes("List SpacingLists"), "Index inset must not leak into heading/TOC text");
  assertStringIncludes(html, "\u201c");
  assertStringIncludes(html, "\u201d");
  assertStringIncludes(html, "<li>resumed</li>");
  assert(!html.includes('class="enumerate_resume"'), "Enumerate-Resume must not fall back to a generic div");
  assert(!html.includes("status collapsed"), "inset status lines must not leak into heading/TOC text");
  assertStringIncludes(html, '<span class="layout-label">Theorem 1.</span>');
  assertStringIncludes(html, "This is typically used for the statements of major results.");
  assertStringIncludes(html, '<span class="layout-label">Corollary.</span>');
  assertStringIncludes(html, '<span class="layout-label">Lemma 2.</span>');
  assertStringIncludes(html, 'class="hanging"');
  assertStringIncludes(html, "all but the first line of the paragraph is indented");
  assertStringIncludes(html, '<span class="dropcap">T</span>');
  assertStringIncludes(html, '<span class="dropcap-rest">his</span>');
  assertStringIncludes(html, "module adds a drop capitals paragraph style");
  assertStringIncludes(html, 'class="flex_rotatebox"');
  assertStringIncludes(html, "rotate(30deg)");
  assertStringIncludes(html, "Great Western Railway");
  assertStringIncludes(html, 'class="flex_multiple_columns"');
  assertStringIncludes(html, "column-count: 2");
  assertStringIncludes(html, "The Adventure of the Empty House");
  assert(!html.includes("{100.125}"), "non-LyX include (.tex) must be omitted like native XHTML");
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, 'class="Shadowbox"');
  assertStringIncludes(html, '<pre class="lyx_code">');
  // Shaped paragraphs + extended theorem-like layouts
  assertStringIncludes(html, 'class="heart"');
  assertStringIncludes(html, 'class="nut"');
  assertStringIncludes(html, 'class="proof"');
  assertStringIncludes(html, '<span class="layout-label">Proof.</span>');
  assertStringIncludes(html, '<span class="layout-label">Proposition');
  assertStringIncludes(html, '<span class="layout-label">Remark');
  assertStringIncludes(html, '<span class="layout-label">Algorithm.');
  assertStringIncludes(html, '<span class="layout-label">Definition.');
  assertStringIncludes(html, '<span class="layout-label">Example.');
  assertStringIncludes(html, 'class="index"');
  // Inline SpecialChar (inline-properties pass)
  assertStringIncludes(html, "\u2026"); // ldots
  assertStringIncludes(html, "\u00ad"); // softhyphen
  assertStringIncludes(html, "\u2044"); // breakableslash
  assertStringIncludes(html, "LaTeX2\u03b5");
});

Deno.test("Live renderer - Help UserGuide.lyx script, line, nomencl, Flex Emph", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/UserGuide.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertStringIncludes(html, "<sup>a, b</sup>");
  assertStringIncludes(html, "<sub>3x</sub>");
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, '<em class="flex_emph">Emph</em>');
  assertStringIncludes(html, '<strong class="flex_strong">Strong</strong>');
  assertStringIncludes(html, '<div class="nomencl">');
  assertStringIncludes(html, ">Tab</a></dt>");
  assertStringIncludes(html, "<dd>Tabulator key</dd>");
  assert(!html.includes("UNKNOWN_INSET"), "UserGuide must not dump unknown-inset fallbacks");
  assertStringIncludes(html, ">A The User Interface");
  assertStringIncludes(html, ">A.1 The File Menu");
  assert(!html.includes(">7 The User Interface"), "appendix chapters must not continue arabic numbering");
  const phantomAt = html.indexOf("What is correct English");
  assert(phantomAt !== -1, "UserGuide phantom example missing");
  const phantomChunk = html.slice(phantomAt, phantomAt + 500);
  assertStringIncludes(phantomChunk, "has to be jumped");
  assertStringIncludes(phantomChunk, "jumps");
  assertStringIncludes(phantomChunk, 'class="disclose phantom"');
  assert(
    !phantomChunk.includes("\u200b"),
    "Phantom chip must not emit a zero-width space placeholder",
  );
  // Branches: Question selected; Answer not — only inverted Answer inset prints.
  assertStringIncludes(html, "Who was the first physics Nobel prize winner?");
  assertStringIncludes(html, "No answer:");
  assertStringIncludes(html, "branch is deactivated");
  assert(
    !html.includes("Wilhelm Conrad"),
    "inactive non-inverted Answer branch must omit like native XHTML",
  );
  // customHeadersFooters page chrome is not reader body (Live omits Header/Footer).
  // Prose may still mention “Magic code:” inside Description; the layout class must not appear.
  assert(!html.includes('class="center_footer"'), "Center Footer page chrome must omit");
  assert(!html.includes('class="left_header"'), "Left Header page chrome must omit");
  assert(!html.includes('class="right_footer"'), "Right Footer page chrome must omit");
  // Already-handled smoke promotions
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, 'href="lyx-docs@lists.lyx.org"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "\u00a0"); // protected space
  assertStringIncludes(html, "“"); // Quotes eld
  assertStringIncludes(html, "”"); // Quotes erd
  assertStringIncludes(html, '<pre class="verbatim">');
  assertStringIncludes(html, "This is Verbatim.");
  assertStringIncludes(html, '<blockquote class="verse">');
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, '<blockquote class="quotation">');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, "#include");
  assertStringIncludes(html, 'class="right_address"');
  assertStringIncludes(html, 'class="Doublebox"');
  assertStringIncludes(html, "with rotated");
  assertStringIncludes(html, "This is a line");
  assertStringIncludes(html, 'class="preview"');
  const prevAt = html.indexOf('class="preview"');
  assert(prevAt !== -1 && html.slice(prevAt, prevAt + 200).includes("This is a line"), "Preview wraps demo line");
  assertStringIncludes(html, 'class="Frameless"');
  assertStringIncludes(html, "disclose marginal");
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'class="noun"');
  // Quote-style table: multiple language marks (not only English eld/erd)
  assertStringIncludes(html, "«");
  assertStringIncludes(html, "»");
  assertStringIncludes(html, "„");
  assertStringIncludes(html, "「");
  assertStringIncludes(html, "『");
  assertStringIncludes(html, "《");
  assertStringIncludes(html, "‹");
  assertStringIncludes(html, "›");
  const helloLi = html.indexOf("<li>Hello");
  assert(helloLi !== -1, "UserGuide 3.4.6 Hello item missing");
  const helloAt = html.lastIndexOf("<ol", helloLi);
  const nest = html.slice(helloAt, html.indexOf("<li>Hi"));
  assertStringIncludes(nest, 'class="enumi"');
  assertStringIncludes(nest, 'class="enumii"');
  assertStringIncludes(nest, 'class="enumiii"');
  assertStringIncludes(nest, "<li>this is an");
  assertStringIncludes(nest, "<li>enumeration</li>");
  assertStringIncludes(nest, "<li>itemize list</li>");
  const itemizeAt = nest.indexOf("<li>itemize list</li>");
  const enumEnd = nest.indexOf("<li>enumeration</li>");
  assert(itemizeAt > enumEnd, "itemize must follow the inner enumeration");
  assert(
    nest.slice(0, itemizeAt).includes("enumiii") && nest.includes("</ol><ul>"),
    "itemize must stay nested beside the inner enumeration, not restart at the top level",
  );
  assert(
    html.includes('<h2 class="bibliography">References</h2>') ||
      html.includes('<h2 class="bibliography">Bibliography</h2>'),
    "Bibliography environment must emit a References/Bibliography heading",
  );
  assertStringIncludes(html, 'id="LyXCite-lyxcredit"');
  assertStringIncludes(html, '<span class="bibitemlabel">Credits</span>');
  assertStringIncludes(html, "The LaTeX Companion Second Edition");
  assertStringIncludes(html, 'class="bibtex"');
  assertStringIncludes(html, 'id="LyXCite-Mittelbach"');
  assertStringIncludes(html, '<span class="bibtexlabel">1</span>');
  assertStringIncludes(html, "The LaTeX Companion");
  assertStringIncludes(html, '<dt><a class="nomencl" href="#nomencl-');
  assertStringIncludes(html, 'id="nomencl-');
  assertStringIncludes(html, '<a href="#idx-');
  assertStringIncludes(html, 'id="idx-');
  assertStringIncludes(html, 'style="text-align: right"');
  assertStringIncludes(html, 'mathvariant="double-struck"');
  assertStringIncludes(html, "<mo>↻</mo>");
  assertStringIncludes(html, 'class="wline"');
  assertStringIncludes(html, "This is text with Wavy underlining on.");
  assertStringIncludes(html, 'class="dline"');
  assertStringIncludes(html, "This is text with Double underlining on.");
  assertStringIncludes(html, 'font-size: x-small');
  assertStringIncludes(html, "This is the");
  assertStringIncludes(html, 'font-style: oblique'); // shape slanted (native FT_SLANTED)
  assertStringIncludes(html, "This is the Slanted font shape");
  assertStringIncludes(html, "font-variant: small-caps"); // shape smallcaps
  assertStringIncludes(html, "This is the Small caps font shape");
  assertStringIncludes(html, "<s>"); // strikeout
  assertStringIncludes(html, 'style="color: blue"');
  assertStringIncludes(html, 'style="color: red"');
  assertStringIncludes(html, 'style="color: green"');
  assertStringIncludes(html, "\u2044"); // breakableslash
  assertStringIncludes(html, "\u200b"); // allowbreak
  assertStringIncludes(html, "This paragraph is right aligned");
  assertStringIncludes(html, 'style="text-align: center"');
  assertStringIncludes(html, "this one is centered");
  assertStringIncludes(html, 'style="text-align: left"');
  assertStringIncludes(html, "this one is left aligned");
  assertStringIncludes(html, "<dt>Vector\u00a0fonts");
  assert(!html.includes("fontsrange"), "Index params must not leak into Description labels");
  assert(!html.includes("status collapsedFonts"), "Index status must not leak into Description");
  assertStringIncludes(html, '<div class="index">');
  assertStringIncludes(html, '<h2 class="index">Index</h2>');
  assertStringIncludes(html, "<li>Font, Types");
  assertStringIncludes(html, ">3.3.4.4 Short Titles</");
  assert(!html.includes("HeadingsShort Titles"), "short-title Argument must not concatenate onto the long heading in the TOC");
});

Deno.test("Live renderer - Help EmbeddedObjects.lyx margin notes, wrap, listings", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertStringIncludes(html, 'class="disclose marginal"');
  assertStringIncludes(html, "This is a margin note.");
  assertStringIncludes(html, 'class="wrap wrap-left"');
  assertStringIncludes(html, "width: 40%");
  assertStringIncludes(html, "<figcaption");
  assertStringIncludes(html, "Figure 6.1: ");
  assertStringIncludes(html, 'class="float-caption-Standard"');
  assertStringIncludes(html, "This is a wrapped figure float.");
  assertStringIncludes(html, 'href="#fig_This_is_a">6.1</a>');
  assertStringIncludes(html, 'data-filename="2D-intensity-plot.pdf"');
  assertStringIncludes(html, "width: 100%");
  assertStringIncludes(html, 'data-filename="Star-structure.pdf"');
  assertStringIncludes(html, "width: 50%");
  assert(
    html.includes("data:image/png;base64,") || html.includes("2D-intensity-plot.pdf"),
    "PDF figures must still name the source file",
  );
  assertStringIncludes(html, '<code class="listings C++">');
  assertStringIncludes(html, "int a=5;");
  assertStringIncludes(html, '<div class="float-listings">');
  assertStringIncludes(html, "listings-caption");
  assertStringIncludes(html, "Listing 8.1: ");
  assertStringIncludes(html, "Example Listing float");
  assertStringIncludes(html, 'href="#lst_Example_Listing">8.1</a>');
  assertStringIncludes(html, 'href="#lst_file_listing">8.2</a>');
  assertStringIncludes(html, "Listing 8.2: ");
  assertStringIncludes(html, "Lines 10 - 15 of this LyX file");
  assertStringIncludes(html, "\\usepackage[figure]{hypcap}");
  assertStringIncludes(html, "Listing 8.3: ");
  assertStringIncludes(html, "def func(param):");
  assertStringIncludes(html, 'data-filename="Abstract.pdf"');
  assertStringIncludes(html, "Algorithm 3.1: ");
  assertStringIncludes(html, "Example Algorithm float");
  assertStringIncludes(html, "This is a small dummy child document");
  assertStringIncludes(html, "External Subsection 1");
  assertStringIncludes(html, '<pre class="include">');
  assert(
    !html.includes("\\end_header"),
    "lstinputlisting of this file must honor firstline/lastline, not dump the whole .lyx source",
  );
  // Caption Below / Unnumbered (native float-caption-{type}; caption* has no number prefix)
  assertStringIncludes(html, 'class="float-caption-Below"');
  assertStringIncludes(html, "A caption marked as being below the table.");
  const belowAt = html.indexOf("A caption marked as being below the table.");
  assert(belowAt !== -1, "Caption Below text missing");
  const belowCap = html.lastIndexOf("<figcaption", belowAt);
  assert(belowCap !== -1 && html.slice(belowCap, belowAt).includes("float-caption-Below"), "Below class on figcaption");
  assert(/Table \d/.test(html.slice(belowCap, belowAt)), "Caption Below keeps Table N: prefix");
  assertStringIncludes(html, 'class="float-caption-Unnumbered"');
  assertStringIncludes(html, "Continued Example Phone List");
  const contAt = html.indexOf("Continued Example Phone List");
  const contSpan = html.lastIndexOf("<span", contAt);
  assert(
    contSpan !== -1 && html.slice(contSpan, contAt).includes("float-caption-Unnumbered"),
    "longtable Caption Unnumbered wraps with float-caption-Unnumbered",
  );
  assert(
    !html.slice(Math.max(0, contAt - 80), contAt).includes("Table "),
    "Caption Unnumbered must not get a Table N: prefix",
  );
  // Boxes: native InsetBox::xhtml is div class="{type}" (+ optional width)
  for (const variant of ["Boxed", "Doublebox", "Framed", "Frameless", "Shaded", "Shadowbox", "ovalbox", "Ovalbox"]) {
    assertStringIncludes(html, `class="${variant}"`);
  }
  assertStringIncludes(html, "Shadow box");
  assertStringIncludes(html, "Shaded background box");
  assertStringIncludes(html, "Oval box, thin");
  assertStringIncludes(html, "Double rectangular box");
  // Flex Minipage (Var. Width): wrap like native MultiPar Flex → div
  assertStringIncludes(html, "flex_minipage");
  const mpAt = html.indexOf("with line break");
  assert(mpAt !== -1, "Minipage body text missing");
  const mpOpen = html.lastIndexOf("flex_minipage", mpAt);
  assert(mpOpen !== -1 && mpOpen > mpAt - 200, "Minipage content must sit inside flex_minipage wrapper");
  assertStringIncludes(html.slice(mpOpen, mpAt + 20), "rotated cell");
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, 'class="dropcap"');
  assertStringIncludes(html, 'class="flex_reflectbox"');
  assertStringIncludes(html, 'class="flex_rotatebox"');
  assertStringIncludes(html, 'class="flex_scalebox"');
  assertStringIncludes(html, 'class="flex_resizebox"');
  assertStringIncludes(html, 'class="bibitemlabel"');
  assertStringIncludes(html, 'class="citation"');
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, 'class="index"');
  assertStringIncludes(html, 'style="color: white"');
  assertStringIncludes(html, 'style="color: yellow"');
  assertStringIncludes(html, 'style="color: magenta"');
});

Deno.test("Live renderer - Help Formula-numbering.lyx refs and eqno", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Formula-numbering.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assert((html.match(/class="eqno"/g) ?? []).length >= 8, "Formula-numbering should emit equation numbers");
  assertStringIncludes(html, 'class="ref"');
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "<math");
});

Deno.test("Live renderer - Help Intro.lyx TOC, href, quotes, table", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Intro.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, '<h1 class="title">Introduction to LyX</h1>');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, "lyx-docs@lists.lyx.org");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "”");
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
});

Deno.test("Live renderer - Help Tutorial.lyx TOC, Info, LyX-Code, quotes", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Tutorial.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, "This is an introduction");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, 'class="ref"');
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "<math");
  // Toolbar Info icons (buffer-view) — PNG data URI when classic/ images exist.
  assert(
    html.includes('data-info-icon="buffer-view"') || html.includes('aria-label="buffer-view"'),
    "Tutorial toolbar Info icons must render as img or glyph",
  );
  if (html.includes('data-info-icon="buffer-view"')) {
    assertStringIncludes(html, "data:image/png;base64,");
  }
});

Deno.test("Live renderer - Help Development.lyx multirow cells emit rowspan", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Development.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, 'rowspan="3"');
  const noAt = html.indexOf(">No</td>");
  assert(noAt !== -1, "Development.lyx multirow 'No' cell missing");
  const tdOpen = html.lastIndexOf("<td", noAt);
  assert(html.slice(tdOpen, noAt).includes('rowspan="3"'), "the 'No' cell is the start of a 3-row span");
});

Deno.test("Live renderer - Help Customization.lyx Description Flex Code labels", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Customization.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, '<dt><code class="flex_code">Format</code></dt>');
  assert(!html.includes("status collapsedFormat"), "Flex Code status must not leak into Description labels");
  assert(
    !html.includes("International Keyboard Support"),
    "deselected OutDated branch must omit like native XHTML",
  );
  assert(
    !html.includes("Information from previous versions of this document"),
    "deselected OutDated branch intro must omit",
  );
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, 'class="noun"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'class="Shadowbox"');
  assertStringIncludes(html, '<code class="listings');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
});

Deno.test("Live renderer - Help Development.lyx listings, Flex Code, Paragraph", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Development.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, '<code class="listings');
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "<h5>Suspended tests</h5>");
  assertStringIncludes(html, 'class="bibitemlabel"');
});

Deno.test("Live renderer - IPA / IPADeco are not UNKNOWN_INSET", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Modules/Linguistics.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(
    unknown.filter((d) => /IPA/.test(d.message)).map((d) => d.message),
    [],
    "IPA/IPADeco must be handled",
  );
  assertStringIncludes(html, 'class="ipa"');
  assertStringIncludes(html, "ipa-deco");
  assertStringIncludes(html, "\u035c"); // bottomtiebar combining mark
});

Deno.test("Live renderer - Tufte Flex sidenote and charstyles", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Handouts/Tufte_Handout.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'class="sidenote marginal"');
  assertStringIncludes(html, 'class="marginnote marginal"');
  assertStringIncludes(html, 'class="smallcaps"');
  assertStringIncludes(html, "font-variant: small-caps");
  assertStringIncludes(html, "allcaps");
  assertStringIncludes(html, "text-transform: uppercase");
});

Deno.test("Live renderer - Beamer Alert and Structure Flex", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Presentations/Beamer.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'class="alert"');
  assertStringIncludes(html, "#cc0000");
  assertStringIncludes(html, 'class="structure"');
  assertStringIncludes(html, "#0000aa");
});

Deno.test("Live renderer - Flex Color Box wraps content", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Modules/Fancy_Colored_Boxes.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  assertStringIncludes(html, 'class="color-box"');
  assertStringIncludes(html, "A basic color box.");
});

Deno.test("Live renderer - Chunk, Structure Tree, LilyPond, ChessBoard wrappers", async () => {
  const chunkPath = fromFileUrl(new URL("./fixtures/Modules/Noweb.lyx", import.meta.url));
  const chunk = await renderLiveHtml(parse(await Deno.readTextFile(chunkPath)), { filePath: chunkPath });
  assertStringIncludes(chunk.html, 'class="chunk"');
  assertStringIncludes(chunk.html, "chunk-title");

  const lingPath = fromFileUrl(new URL("./fixtures/Modules/Linguistics.lyx", import.meta.url));
  const ling = await renderLiveHtml(parse(await Deno.readTextFile(lingPath)), { filePath: lingPath });
  assertStringIncludes(ling.html, 'class="structure-tree"');

  const lilyPath = fromFileUrl(new URL("./fixtures/Modules/LilyPond_Book.lyx", import.meta.url));
  const lily = await renderLiveHtml(parse(await Deno.readTextFile(lilyPath)), { filePath: lilyPath });
  assertStringIncludes(lily.html, 'class="lilypond"');

  const chessPath = fromFileUrl(new URL("./fixtures/Modules/Chessboard.lyx", import.meta.url));
  const chess = await renderLiveHtml(parse(await Deno.readTextFile(chessPath)), { filePath: chessPath });
  assertStringIncludes(chess.html, 'class="chessboard"');
});

Deno.test("Live renderer - nameref uses heading and caption titles", async () => {
  const filePath = syntheticPath("nameref_titles.lyx");
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'href="#sec_intro_name">Named Introduction</a>');
  assertStringIncludes(html, 'href="#sec_intro_name">1</a>');
  // Native LyXHTML nameref for floats is "Figure N", not the caption prose.
  assertStringIncludes(html, 'href="#fig_demo_cap">Figure 1</a>');
});

Deno.test("Live renderer - Flex InsetLayout HTMLTag/HTMLClass/Font from LocalLayout", async () => {
  const filePath = syntheticPath("flex_htmltag.lyx");
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  assertStringIncludes(html, '<mark class="probe-mark"');
  assertStringIncludes(html, "color:orange");
  assertStringIncludes(html, "Tagged");
  assert(!html.includes('class="flex probe"'), "layout HTMLClass must win over generic flex slug");
});

Deno.test("Live renderer - hostile layout HTMLTags fall back to classed wrappers (DL132 F2)", async () => {
  const filePath = syntheticPath("flex_hostile_htmltag.lyx");
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  for (const slug of ["hstyle", "hsvg", "hobject", "hlink"]) {
    assertStringIncludes(html, `class="flex ${slug}"`);
  }
  assert(!html.includes("<style"), "layout HTMLTag 'style' must not be emitted");
  assert(!html.includes("<svg"), "layout HTMLTag 'svg' must not be emitted");
  assert(!html.includes("<object"), "layout HTMLTag 'object' must not be emitted");
  assert(!html.includes("<link"), "layout HTMLTag 'link' must not be emitted");
});

Deno.test("Live renderer - duplicate citation keys render once (DL132 P6)", async () => {
  const filePath = syntheticPath("cite_dedup.lyx");
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  const entries = html.match(/class="bibtexentry"/g) ?? [];
  assertEquals(entries.length, 2, "duplicate citation keys must render a single bibliography entry each");
  assertStringIncludes(html, "Author, Alpha");
  assertStringIncludes(html, "Author, Beta");
});

Deno.test("Live renderer - pageref uses target number not elsewhere", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/UserGuide.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assert(!html.includes(">elsewhere</a>"), "pageref/vpageref must not hardcode elsewhere when a target exists");
  assertStringIncludes(html, 'href="#fig_Two_images"');
  assertStringIncludes(html, 'title="page reference');
  assertStringIncludes(html, ">4.2</a>");
});

Deno.test("Live renderer - lang property emits HTML lang spans", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'lang="de"');
  assertStringIncludes(html, 'lang="en"');
});

Deno.test("Live renderer - remaining Flex kinds get classed wrappers (no bare passthrough)", async () => {
  const samples: [string, string[]][] = [
    ["./fixtures/Presentations/Beamer.lyx", ["flex alternative", "flex bold", 'class="flex']],
    ["./fixtures/Articles/Springer_Nature_Journals.lyx", ["data-field=", "flex field"]],
    ["./fixtures/Modules/Linguistics.lyx", ["flex gloss", "groupglossedwords"]],
    ["./fixtures/Modules/Braille.lyx", ["braillebox"]],
    ["./fixtures/Modules/PDF_Form.lyx", ["pdf-form", "checkbox"]],
    ["./fixtures/Curricula_Vitae/Modern_CV.lyx", ["flex column"]],
  ];
  for (const [rel, needles] of samples) {
    const filePath = fromFileUrl(new URL(rel, import.meta.url));
    const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
    for (const n of needles) {
      assertStringIncludes(html.toLowerCase(), n.toLowerCase(), `${rel} missing ${n}`);
    }
  }
});

Deno.test("Live renderer - H-P, PDF comment/form, tablenotemark wrappers", async () => {
  const hpPath = fromFileUrl(new URL("./fixtures/Modules/Hazard_and_Precautionary_Statements.lyx", import.meta.url));
  const hp = await renderLiveHtml(parse(await Deno.readTextFile(hpPath)), { filePath: hpPath });
  assertStringIncludes(hp.html, 'class="hp-number"');
  assertStringIncludes(hp.html, 'class="hp-statement"');

  const pdfPath = fromFileUrl(new URL("./fixtures/Modules/PDF_Comments.lyx", import.meta.url));
  const pdf = await renderLiveHtml(parse(await Deno.readTextFile(pdfPath)), { filePath: pdfPath });
  assertStringIncludes(pdf.html, "pdf-comment");

  const formPath = fromFileUrl(new URL("./fixtures/Modules/PDF_Form.lyx", import.meta.url));
  const form = await renderLiveHtml(parse(await Deno.readTextFile(formPath)), { filePath: formPath });
  assertStringIncludes(form.html, "pdf-form");

  // Filename on disk keeps %28/%29 literally (not decoded parentheses).
  const aasPath = join(
    fromFileUrl(new URL("./fixtures/Articles/", import.meta.url)),
    "American_Astronomical_Society_%28AASTeX_v._6.3.1%29.lyx",
  );
  const aas = await renderLiveHtml(parse(await Deno.readTextFile(aasPath)), { filePath: aasPath });
  assertStringIncludes(aas.html, 'class="tablenotemark"');
});

Deno.test("Live renderer - FloatList emits list of floats", async () => {
  // KOMA example has FloatList insets but no captioned floats → empty (like native).
  const koma = fromFileUrl(new URL("./fixtures/Books/KOMA-Script_Book.lyx", import.meta.url));
  const komaRender = await renderLiveHtml(parse(await Deno.readTextFile(koma)), { filePath: koma });
  assertEquals(
    komaRender.diagnostics.filter((d) => d.code === "UNKNOWN_INSET" && /FloatList/.test(d.message)),
    [],
  );

  const filePath = fromFileUrl(new URL("./fixtures/Modules/Multilingual_Captions.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(
    diagnostics.filter((d) => d.code === "UNKNOWN_INSET" && /FloatList/.test(d.message)).map((d) => d.message),
    [],
  );
  assertStringIncludes(html, 'class="toc toc-floats"');
  assertStringIncludes(html, "List of ");
  assertStringIncludes(html, 'href="#float-');
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
  const src = (await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"))).replaceAll("\r\n", "\n");
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
  const result = await runCliTest(["preview", syntheticPath("hostile.lyx"), "layout"]);
  assertEquals(result.code, "INVALID_FLAG");
});

Deno.test("Live comparison - incidental ids and classes are ignored", () => {
  const a = normalizeReaderHtml(`<div class="standard" id="magicparlabel-9">Hello</div>`);
  const b = normalizeReaderHtml(`<div class="standard">Hello</div>`);
  assert(semanticEqual(a, b), formatSem(a) + "\n---\n" + formatSem(b));
});

Deno.test("Live comparison - DL130 tolerances (pageref text, icon markup, shortcut tag)", () => {
  // J1: pageref link text (figure number vs PDF page) must not break equality when target matches.
  const livePage = normalizeReaderHtml(
    `<a class="ref" href="#fig_Two_images" title="page reference (Live shows target number/name, not a page)">4.2</a>`,
  );
  const nativePage = normalizeReaderHtml(
    `<a class="ref pageref" href="#fig_Two_images">12</a>`,
  );
  assert(semanticEqual(livePage, nativePage), formatSem(livePage) + "\n---\n" + formatSem(nativePage));

  // Non-pageref refs still compare visible text.
  const liveRef = normalizeReaderHtml(`<a class="ref" href="#sec_a">1</a>`);
  const nativeRef = normalizeReaderHtml(`<a class="ref" href="#sec_a">Introduction</a>`);
  assert(!semanticEqual(liveRef, nativeRef), "ordinary ref text must still be compared");

  // J4: glyph vs img — same icon name.
  const glyph = normalizeReaderHtml(
    `<span class="info-icon" title="buffer-view" role="img" aria-label="buffer-view">▣</span>`,
  );
  const png = normalizeReaderHtml(
    `<img class="info-icon" src="data:image/png;base64,aa" alt="buffer-view" aria-label="buffer-view"/>`,
  );
  assert(semanticEqual(glyph, png), formatSem(glyph) + "\n---\n" + formatSem(png));

  // J5: kbd vs native-ish bdo — same chord text.
  const kbd = normalizeReaderHtml(`<kbd class="shortcuts" title="math-mode">Ctrl+M</kbd>`);
  const bdo = normalizeReaderHtml(`<bdo class="shortcuts" dir="ltr">Ctrl+M</bdo>`);
  assert(semanticEqual(kbd, bdo), formatSem(kbd) + "\n---\n" + formatSem(bdo));
});

Deno.test("Live CSP floor - restrictive policy string has no remote sources", () => {
  // script-src may be 'none' or nonce-'…' for outline scroll; still no remote scripts/URLs.
  const cspNone =
    "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const cspNonce =
    "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'nonce-abc'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  for (const csp of [cspNone, cspNonce]) {
    assertStringIncludes(csp, "default-src 'none'");
    assert(/script-src ('none'|'nonce-[^']+')/.test(csp), "script-src must be none or nonce-only");
    assert(!/https?:\/\//.test(csp), "CSP must not allow remote http(s) URLs");
  }
});
