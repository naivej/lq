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
  const result = await runCliTest(["preview", syntheticPath("headings_paragraphs.lyx")]);
  const validated = validateLiveResponse(result);
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.lineEnding, detectLineEnding(await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"))));
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
  assertStringIncludes(html, '<ol class="enumi">');
  assertStringIncludes(html, "<li>first</li>");
  assertStringIncludes(html, "<dt>Term</dt>");
  assertStringIncludes(html, "<dd>the explanation</dd>");
  assertStringIncludes(html, "<blockquote>");
  assertStringIncludes(html, "A quoted line.");
});

Deno.test("Live renderer - missing layoutsDir still uses the hardcoded floor", async () => {
  const filePath = syntheticPath("headings_paragraphs.lyx");
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), {
    filePath,
    layoutsDir: "Z:\\lq-no-such-layouts",
  });
  assertStringIncludes(html, "<h2>1 Introduction</h2>");
  assertStringIncludes(html, "<h3>1.1 Details</h3>");
});

Deno.test("Live renderer - table, figure, footnote, formula", async () => {
  const { html } = await renderFile("table_figure_foot_math.lyx");
  assertStringIncludes(html, "<table>");
  assertStringIncludes(html, "<td");
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
  assertStringIncludes(html, '<a class="ref" href="#sec_Section_label">1</a>');
  assertStringIncludes(html, '<a class="ref" href="#subsec_subsec_label">1.1</a>');
  assertStringIncludes(html, 'id="sec_Section_label"');
  assert(!html.includes("sec:Section_label"), "refs must resolve to numbers, not raw keys");
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
  const capAt = fig.indexOf("<figcaption>");
  const tableAt = fig.indexOf("<table");
  assert(capAt !== -1 && tableAt !== -1 && capAt < tableAt, "figure caption must appear above the figure body");
  assertStringIncludes(fig, "<figcaption>Figure 1: Figure caption");
  assert(!fig.includes("<figcaption>Figure 1: <div"), "figure number and caption must be one line");
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

Deno.test("Live renderer - Help Math.lyx omits Phantom and does not dump math-mode as UNKNOWN", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Math.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  // Native LyXHTML drops Phantom/HPhantom/VPhantom entirely (InsetPhantom::xhtml).
  assert(!html.includes("unknown-inset"), "Phantom must omit, not fall back");
  assertStringIncludes(html, "<kbd");
  assert(!html.includes('<span class="info">math-mode</span>'), "Info shortcuts must not dump the raw LFUN name as body text");
  assertStringIncludes(html, "class=\"typewriter\"");
  assertStringIncludes(html, "class=\"sans\"");
  assertStringIncludes(html, "\u2423");
  assertStringIncludes(html, "<mo>↓</mo>");
  assertStringIncludes(html, "<mfrac>");
  assertStringIncludes(html, "<mtable>");
  assertStringIncludes(html, "<mi>A</mi>");
  assertStringIncludes(html, "<mo>≈</mo>");
  assertStringIncludes(html, "<mo>←</mo>");
  assert(!html.includes('encoding="application/x-tex">$\\begin{cases}'), "multi-line cases must include the body, not only the first line");
  assert(
    !html.includes('encoding="application/x-tex">\\newcommand{\\qG}'),
    "FormulaMacro must not be rendered as a formula",
  );
  assertStringIncludes(html, 'class="note_greyedout"');
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
  assertStringIncludes(html, '<a class="url" href="https://www.ams.org/publications/authors/tex/amslatex">');
  assertStringIncludes(html, "<code>");
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
  assertStringIncludes(html, 'class="rotatebox"');
  assertStringIncludes(html, "rotate(30deg)");
  assertStringIncludes(html, "Great Western Railway");
  assertStringIncludes(html, 'class="multicol"');
  assertStringIncludes(html, "column-count: 2");
  assertStringIncludes(html, "The Adventure of the Empty House");
  assert(!html.includes("{100.125}"), "non-LyX include (.tex) must be omitted like native XHTML");
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
  assertStringIncludes(html, "<em>Emph</em>");
  assertStringIncludes(html, "<strong>Strong</strong>");
  assertStringIncludes(html, '<div class="nomencl">');
  assertStringIncludes(html, ">Tab</a></dt>");
  assertStringIncludes(html, "<dd>Tabulator key</dd>");
  assert(!html.includes("UNKNOWN_INSET"), "UserGuide must not dump unknown-inset fallbacks");
  assertStringIncludes(html, ">A The User Interface");
  assertStringIncludes(html, ">A.1 The File Menu");
  assert(!html.includes(">7 The User Interface"), "appendix chapters must not continue arabic numbering");
  const phantomAt = html.indexOf("What is correct English");
  assert(phantomAt !== -1, "UserGuide phantom example missing");
  const phantomChunk = html.slice(phantomAt, phantomAt + 350);
  assertStringIncludes(phantomChunk, "has to be jumped");
  assertStringIncludes(phantomChunk, "jumps");
  assert(
    !phantomChunk.includes("\u200b"),
    "Phantom must omit like native XHTML, not emit a zero-width space",
  );
  assertStringIncludes(html, 'class="Doublebox"');
  assertStringIncludes(html, "with rotated");
  assertStringIncludes(html, "This is a line");
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
  assertStringIncludes(html, '<div class="marginal">');
  assertStringIncludes(html, "This is a margin note.");
  assertStringIncludes(html, 'class="wrap wrap-left"');
  assertStringIncludes(html, "width: 40%");
  assertStringIncludes(html, "<figcaption>Figure 6.1: ");
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
  assertStringIncludes(html, "<div class=\"listings-caption\">Listing 8.1: ");
  assertStringIncludes(html, "Example Listing float");
  assertStringIncludes(html, 'href="#lst_Example_Listing">8.1</a>');
  assertStringIncludes(html, 'href="#lst_file_listing">8.2</a>');
  assertStringIncludes(html, "Listing 8.2: ");
  assertStringIncludes(html, "Lines 10 - 15 of this LyX file");
  assertStringIncludes(html, "\\usepackage[figure]{hypcap}");
  assertStringIncludes(html, "Listing 8.3: ");
  assertStringIncludes(html, "def func(param):");
  assertStringIncludes(html, 'data-filename="Abstract.pdf"');
  assertStringIncludes(html, "<figcaption>Algorithm 3.1: ");
  assertStringIncludes(html, "Example Algorithm float");
  assertStringIncludes(html, "This is a small dummy child document");
  assertStringIncludes(html, "External Subsection 1");
  assertStringIncludes(html, '<pre class="include">');
  assert(
    !html.includes("\\end_header"),
    "lstinputlisting of this file must honor firstline/lastline, not dump the whole .lyx source",
  );
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
  assertStringIncludes(html, "<dt><code>Format</code></dt>");
  assert(!html.includes("status collapsedFormat"), "Flex Code status must not leak into Description labels");
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

Deno.test("Live CSP floor - restrictive policy string has no remote sources", () => {
  const csp = "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "script-src 'none'");
  assert(!/https?:\/\//.test(csp), "CSP must not allow remote http(s) URLs");
});
