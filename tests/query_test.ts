import { assertEquals } from "@std/assert";
import { parse } from "../src/parser.ts";
import { query, parseSelector } from "../src/query.ts";
import { TextNode } from "../src/ast.ts";

Deno.test("Selector Parsing", () => {
  const parsed1 = parseSelector("layout[Section]");
  assertEquals(parsed1[0][0].tag, "layout");
  assertEquals(parsed1[0][0].argExact, "Section");
  assertEquals(parsed1[0][0].pseudos, []);

  const parsed2 = parseSelector("layout[name='Section'] inset[Formula]:first");
  assertEquals(parsed2[0][0].tag, "layout");
  assertEquals(parsed2[0][0].argExact, "Section");
  assertEquals(parsed2[0][1].tag, "inset");
  assertEquals(parsed2[0][1].argExact, "Formula");
  assertEquals(parsed2[0][1].pseudos![0].name, "first");

  const parsed3 = parseSelector('layout[Section]:first:contains("hello")');
  assertEquals(parsed3[0][0].pseudos!.length, 2);
  assertEquals(parsed3[0][0].pseudos![0].name, "first");
  assertEquals(parsed3[0][0].pseudos![1].name, "contains");
  assertEquals(parsed3[0][0].pseudos![1].argRaw, '"hello"');

  const parsed4 = parseSelector('layout:contains("[")');
  assertEquals(parsed4[0][0].tag, "layout");
  assertEquals(parsed4[0][0].pseudos![0].name, "contains");
  assertEquals(parsed4[0][0].pseudos![0].argRaw, '"["');

  const parsed5 = parseSelector('layout:nth-child(odd), layout:nth-child( 2n+1 )');
  assertEquals(parsed5[0][0].pseudos![0].name, "nth-child");
  assertEquals(parsed5[0][0].pseudos![0].argRaw, "odd");
  assertEquals(parsed5[1][0].pseudos![0].name, "nth-child");
  assertEquals(parsed5[1][0].pseudos![0].argRaw, "2n+1");

  const parsed6 = parseSelector('layout[Standard]:not(inset[CommandInset bibtex])');
  assertEquals(parsed6[0][0].tag, "layout");
  assertEquals(parsed6[0][0].argExact, "Standard");
  assertEquals(parsed6[0][0].pseudos!.length, 1);
  assertEquals(parsed6[0][0].pseudos![0].name, "not");
  assertEquals(parsed6[0][0].pseudos![0].argRaw, "inset[CommandInset bibtex]");

  // Comma inside :contains() should NOT split into multiple selectors
  const parsed7 = parseSelector("layout:contains('hello, world')");
  assertEquals(parsed7.length, 1); // One selector group, not two
  assertEquals(parsed7[0][0].pseudos![0].argRaw, "'hello, world'");

  // Comma SEPARATOR outside :contains() still splits into groups
  const parsed8 = parseSelector("layout[A], layout[B]");
  assertEquals(parsed8.length, 2);

  // Bare pseudo-classes are rejected
  let bareErr = "";
  try { parseSelector(':contains("text")'); } catch (e) { bareErr = (e as Error).message; }
  assertEquals(bareErr.includes("must follow a tag"), true);

  try { parseSelector(':first'); } catch (e) { bareErr = (e as Error).message; }
  assertEquals(bareErr.includes("must follow a tag"), true);
});

Deno.test("Query Engine on LyX Document", async () => {
  const text = await Deno.readTextFile("tests/fixtures/my_template.lyx");
  const ast = parse(text);

  // Test 1: Query single properties
  const classNode = query(ast, "textclass");
  assertEquals(classNode.length, 1);
  assertEquals(classNode[0].type, "property");
  if (classNode[0].type === "property") {
    assertEquals(classNode[0].value, "article");
  }

  // Test 2: Query standard layouts
  const sections = query(ast, "layout[Section]");
  assertEquals(sections.length, 2); // "Section" and another later maybe? Let's check: Yes, Section and Appendix

  // Test 3: Query deeply nested elements (Formulas inside layouts)
  const formulas = query(ast, "layout inset[Formula]");
  assertEquals(formulas.length, 2); // One display equation, one inline equation

  // Test 4: Pseudo classes
  const firstSection = query(ast, "layout[Section]:first");
  assertEquals(firstSection.length, 1);
  if (firstSection[0].type === "block" && firstSection[0].children[0].type === "text") {
    // Note: the text node inside the section will be "Section "
    assertEquals(firstSection[0].children[0].text, "Section ");
  }

  const secondSection = query(ast, "layout[Section]:nth-child(2)");
  assertEquals(secondSection.length, 1);
  
  const allSections = query(ast, "layout[Section]");
  const oddSections = query(ast, "layout[Section]:nth-child(odd)");
  const evenSections = query(ast, "layout[Section]:nth-child(even)");
  assertEquals(oddSections.length + evenSections.length, allSections.length);
  if (allSections.length >= 2) {
    assertEquals(oddSections[0], allSections[0]);
    assertEquals(evenSections[0], allSections[1]);
  }

  const chainedPseudo = query(ast, 'layout[Section]:first:contains("Section")');
  assertEquals(chainedPseudo.length, 1);

  // Test 5: Multiple selectors (comma separated)
  const headings = query(ast, "layout[Title], layout[Author]");
  assertEquals(headings.length, 2);

  // Test :contains
  const res1 = query(ast, "layout[Section]:first");
  assertEquals(res1.length, 1);
  if (res1[0].type === "block") {
    assertEquals(res1[0].args, "Section");
  }

  const res2 = query(ast, "inset[Formula]");
  assertEquals(res2.length, 2); // There is one display math and one inline math

  const res3 = query(ast, 'layout[Standard]:contains("GDP")');
  assertEquals(res3.length, 0); // GDP is not in the text

  const res4 = query(ast, 'layout[Standard]:contains("tracked changes")');
  assertEquals(res4.length, 1);
  if (res4[0].type === "block") {
    assertEquals(res4[0].tag, "layout");
  }

  // Test :contains with tag (bare contains no longer allowed)
  const res5 = query(ast, 'layout:contains("tracked changes")');
  assertEquals(res5.length, 1); // Only the layout, not body/document

  // Test :contains with parentheses inside string literals
  const res6 = query(ast, 'layout:contains("nickel(0)")');
  assertEquals(res6.length, 0); // Not in the template, but should not throw syntax error
  const res7 = query(ast, 'layout:contains("a)b)c")');
  assertEquals(res7.length, 0); // Not in the template, but should not throw syntax error

  // Test :not() pseudo-class
  // All Standard layouts that do NOT contain a Formula inset
  const stdNoFormula = query(ast, 'layout[Standard]:not(inset[Formula])');
  // There are Standard layouts; some have formulas, some don't.
  // At least one Standard layout should not contain a Formula.
  assertEquals(stdNoFormula.length > 0, true);

  // All Standard layouts: those with Formula + those without should equal total
  const _stdWithFormula = query(ast, 'layout[Standard] inset[Formula]');
  const allStd = query(ast, 'layout[Standard]');
  // Every Standard that has a Formula is excluded by :not()
  // So stdNoFormula + (unique std parents of stdWithFormula) <= allStd
  assertEquals(stdNoFormula.length <= allStd.length, true);

  // :not() with a non-matching inner selector should match everything
  const allStd2 = query(ast, 'layout[Standard]:not(inset[Nonexistent])');
  assertEquals(allStd2.length, allStd.length);

  // Test :adjacent() pseudo-class
  // Layouts immediately following a Section
  const afterSection = query(ast, 'layout[Standard]:adjacent(layout[Section])');
  assertEquals(afterSection.length, 2); // Two Standard layouts follow Sections

  // :adjacent() should return 0 when no preceding sibling matches
  const noMatch = query(ast, 'layout[Section]:adjacent(layout[Title])');
  assertEquals(noMatch.length, 0); // No Section is preceded by a Title

  // :adjacent() skips text/property nodes to find the previous meaningful sibling.
  // The Sections in the fixture are not adjacent to each other (Standard layouts
  // sit between them), so this returns 0 — correct.
  const secAfterSec = query(ast, 'layout[Section]:adjacent(layout[Section])');
  assertEquals(secAfterSec.length, 0);

  // :adjacent() + :first chaining — order matters.
  // :first:adjacent(Section) returns 0 because the first Standard overall
  // (in DFS order) follows an Abstract, not a Section.
  // :adjacent(Section):first takes the 2 Standards after Sections, then keeps the first.
  const firstAdjThenFirst = query(ast, 'layout[Standard]:adjacent(layout[Section]):first');
  assertEquals(firstAdjThenFirst.length, 1);

  // Parse validation: :adjacent() requires an argument
  let adjParseError = false;
  try { parseSelector('layout:adjacent()'); } catch { adjParseError = true; }
  assertEquals(adjParseError, true);

  // :not() with bare pseudo-class in inner selector
  const notContains = query(ast, 'layout:not(:contains("Section"))');
  assertEquals(notContains.length > 0, true); // Should parse and return results

  // :adjacent() with bare pseudo-class in inner selector
  const adjContains = query(ast, 'layout:adjacent(:contains("Section"))');
  assertEquals(adjContains.length > 0, true); // Should parse and return results

  // Combinator test: :not() with inner :contains() and outer tag
  const notInnerContains = query(ast, 'layout[Standard]:not(:contains("tracked changes"))');
  assertEquals(notInnerContains.length > 0, true); // Parses, excludes the one with tracked changes

  // T6: Chained :contains() pseudo-classes work as AND
  // layout[Standard]:contains('writing'):contains('paper') matches only
  // Standard layouts that contain BOTH 'writing' AND 'paper'
  const dualContains = query(ast, "layout[Standard]:contains('writing'):contains('paper')");
  assertEquals(dualContains.length, 1);
  // Individual :contains() queries should match more (superset)
  const onlyWriting = query(ast, "layout[Standard]:contains('writing')");
  const onlyPaper = query(ast, "layout[Standard]:contains('paper')");
  assertEquals(dualContains.length <= onlyWriting.length, true, "AND should not match more than either single filter");
  assertEquals(dualContains.length <= onlyPaper.length, true, "AND should not match more than either single filter");
  // Verify chained :contains() parse produces two pseudos on same selector part
  const dualParsed = parseSelector("layout[Standard]:contains('writing'):contains('paper')");
  assertEquals(dualParsed[0][0].pseudos!.length, 2);
  assertEquals(dualParsed[0][0].pseudos![0].name, "contains");
  assertEquals(dualParsed[0][0].pseudos![1].name, "contains");
});

// --- Dev log 90: :change(current|inserted|deleted) pseudo-class ---

const TRACKED_QUERY_BODY =
  "#LyX 2.5 created this file.\n" +
  "\\begin_document\n" +
  "\\begin_header\n" +
  "\\author 1 \"Alice\"\n" +
  "\\end_header\n" +
  "\\begin_body\n" +
  "\\begin_layout Standard\n" +
  "current words here\n" +
  "\\change_inserted 1 1700000000\n" +
  "inserted words\n" +
  "\\change_unchanged\n" +
  "\\change_deleted 1 1700000001\n" +
  "deleted words\n" +
  "\\change_unchanged\n" +
  "more current\n" +
  "\\end_layout\n" +
  "\\begin_layout Section\n" +
  "plain section text\n" +
  "\\end_layout\n" +
  "\\end_body\n" +
  "\\end_document\n";

Deno.test("DL90 - :change() selects text nodes by region", () => {
  const ast = parse(TRACKED_QUERY_BODY);
  const deleted = query(ast, "text:change(deleted)");
  assertEquals(deleted.length, 1);
  assertEquals((deleted[0] as TextNode).text, "deleted words");
  const inserted = query(ast, "text:change(inserted)");
  assertEquals(inserted.length, 1);
  assertEquals((inserted[0] as TextNode).text, "inserted words");
  // current: the three in-layout text nodes (plus document-level nodes from
  // the fixture header) — assert by content, not a fragile total count.
  const current = query(ast, "text:change(current)");
  const curTexts = current.filter(n => n.type === "text").map(n => (n as TextNode).text);
  assertEquals(curTexts.includes("current words here"), true);
  assertEquals(curTexts.includes("more current"), true);
  assertEquals(curTexts.includes("plain section text"), true);
  assertEquals(curTexts.includes("inserted words"), false);
  assertEquals(curTexts.includes("deleted words"), false);
});

Deno.test("DL90 - :change() on layouts selects region-bearing layouts", () => {
  const ast = parse(TRACKED_QUERY_BODY);
  const delLayouts = query(ast, "layout:change(deleted)");
  assertEquals(delLayouts.length, 1);
  assertEquals((delLayouts[0] as { tag?: string }).tag, "layout");
  const insLayouts = query(ast, "layout:change(inserted)");
  assertEquals(insLayouts.length, 1);
  const curLayouts = query(ast, "layout:change(current)");
  assertEquals(curLayouts.length, 2, "Standard + Section both contain current text");
});

Deno.test("DL90 - :change() rejects invalid or missing arguments", () => {
  const ast = parse(TRACKED_QUERY_BODY);
  let err = "";
  try { query(ast, "text:change(bogus)"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("Invalid :change() argument"), true, err);
  err = "";
  try { query(ast, "text:change()"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("requires an argument"), true, err);
});

Deno.test("DL91 - text[arg] hard-errors instead of silently matching all", () => {
  const ast = parse(TRACKED_QUERY_BODY);
  let directErr = "";
  try { parseSelector("text[foo]"); } catch (e) { directErr = (e as Error).message; }
  assertEquals(directErr.includes("text nodes have no [args]"), true, directErr);

  let nestedErr = "";
  try { parseSelector("layout:not(text[foo])"); } catch (e) { nestedErr = (e as Error).message; }
  assertEquals(nestedErr.includes("Invalid selector inside :not()"), true, nestedErr);

  for (const sel of ["text[changeStatus=inserted]", "text[foo]"]) {
    let err = "";
    try { query(ast, sel); } catch (e) { err = (e as Error).message; }
    assertEquals(err.includes("text nodes have no [args]"), true, `${sel} -> ${err}`);
    assertEquals(err.includes("text:contains"), true, `${sel} points to content selection`);
    assertEquals(err.includes("text:change"), true, `${sel} points to region selection`);
  }
  // Bare `text` (no args) is still valid — only text[...] is rejected.
  const t = query(ast, "text");
  assertEquals(t.length > 0, true, "bare 'text' selector still matches");
});

// --- Dev log 92 phase A: :property(key[=value]) predicate + :change() block fix ---

const STYLE_QUERY_BODY =
  "#LyX 2.5 created this file.\n" +
  "\\begin_document\n" +
  "\\begin_header\n" +
  "\\textclass article\n" +
  "\\end_header\n" +
  "\\begin_body\n" +
  "\\begin_layout Standard\n" +
  "This is \n" +
  "\\emph on\n" +
  "emphasized text\n" +
  "\\emph default\n" +
  "and \n" +
  "\\series bold\n" +
  "bold text\n" +
  "\\series default\n" +
  "here.\n" +
  "\\end_layout\n" +
  "\\begin_layout Section\n" +
  "plain section\n" +
  "\\end_layout\n" +
  "\\end_body\n" +
  "\\end_document\n";

Deno.test("DL92 - :property() selects text by active inline style", () => {
  const ast = parse(STYLE_QUERY_BODY);
  const emph = query(ast, "text:property(emph)");
  assertEquals(emph.length, 1);
  assertEquals((emph[0] as TextNode).text, "emphasized text");
  const bold = query(ast, "text:property(series=bold)");
  assertEquals(bold.length, 1);
  assertEquals((bold[0] as TextNode).text, "bold text");
  // Case-insensitive VALUE (LyX lowercases values on read — FontInfo.cpp ascii_lowercase); keys stay exact.
  const upper = query(ast, "text:property(series=BOLD)");
  assertEquals(upper.length, 1);
  assertEquals((upper[0] as TextNode).text, "bold text");
  // Explicit default is NOT "active" for the bare-key form...
  const active = query(ast, "text:property(emph)");
  const texts = active.filter(n => n.type === "text").map(n => (n as TextNode).text);
  assertEquals(texts.includes("and "), false, "emph=default must not match :property(emph)");
  // ...but :property(key=default) matches the explicit reset explicitly.
  const explicitDefault = query(ast, "text:property(emph=default)");
  const defTexts = explicitDefault.filter(n => n.type === "text").map(n => (n as TextNode).text);
  assertEquals(defTexts.includes("and "), true);
  assertEquals(defTexts.includes("here."), true);
});

Deno.test("DL92 - :property() on blocks selects containers of styled text", () => {
  const ast = parse(STYLE_QUERY_BODY);
  const layouts = query(ast, "layout:property(emph)");
  assertEquals(layouts.length, 1);
  assertEquals((layouts[0] as { tag?: string }).tag, "layout");
  const section = query(ast, "layout[Section]:property(emph)");
  assertEquals(section.length, 0, "Section has no emphasized text");
});

Deno.test("DL92 - :property() validation rejects missing/unknown/change keys", () => {
  const ast = parse(STYLE_QUERY_BODY);
  let err = "";
  try { query(ast, "text:property()"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("requires an argument"), true, err);
  err = "";
  try { query(ast, "text:property(bogus)"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("Invalid :property() key: 'bogus'"), true, err);
  assertEquals(err.includes("Valid inline style keys are"), true, err);
  err = "";
  try { query(ast, "text:property(change_deleted)"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("Invalid :property() key: 'change_deleted'"), true, err);
  assertEquals(err.includes(":change(current|inserted|deleted)"), true, err);
});

const INSET_STYLE_BODY =
  "#LyX 2.5 created this file.\n" +
  "\\begin_document\n" +
  "\\begin_header\n" +
  "\\textclass article\n" +
  "\\end_header\n" +
  "\\begin_body\n" +
  "\\begin_layout Standard\n" +
  "\\emph on\n" +
  "before \n" +
  "\\begin_inset Foot\n" +
  "status open\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "foot content\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  " after\n" +
  "\\emph default\n" +
  "\\end_layout\n" +
  "\\end_body\n" +
  "\\end_document\n";

Deno.test("DL92 - :property() on a block sitting inside a parent style span matches (inset in emph run)", () => {
  const ast = parse(INSET_STYLE_BODY);
  const insets = query(ast, "inset:property(emph)");
  assertEquals(insets.length, 1);
  assertEquals((insets[0] as { tag?: string }).tag, "inset");
});

const TRACKED_STYLE_BODY =
  "#LyX 2.5 created this file.\n" +
  "\\begin_document\n" +
  "\\begin_header\n" +
  "\\textclass article\n" +
  "\\author 1 \"Alice\"\n" +
  "\\end_header\n" +
  "\\begin_body\n" +
  "\\begin_layout Standard\n" +
  "\\emph on\n" +
  "\\change_deleted 1 1700000000\n" +
  "rejected emph\n" +
  "\\change_unchanged\n" +
  "\\change_inserted 1 1700000001\n" +
  "accepted\n" +
  "\\change_unchanged\n" +
  "\\emph default\n" +
  "current plain\n" +
  "\\end_layout\n" +
  "\\end_body\n" +
  "\\end_document\n";

Deno.test("DL92 - :property() chains with :change() as a conjunction", () => {
  const ast = parse(TRACKED_STYLE_BODY);
  const both = query(ast, "text:property(emph):change(deleted)");
  assertEquals(both.length, 1);
  assertEquals((both[0] as TextNode).text, "rejected emph");
  const onlyEmph = query(ast, "text:property(emph)");
  const emphTexts = onlyEmph.filter(n => n.type === "text").map(n => (n as TextNode).text);
  assertEquals(emphTexts.includes("rejected emph"), true);
  assertEquals(emphTexts.includes("accepted"), true);
});

const INSET_DELETED_BODY =
  "#LyX 2.5 created this file.\n" +
  "\\begin_document\n" +
  "\\begin_header\n" +
  "\\textclass article\n" +
  "\\author 1 \"Alice\"\n" +
  "\\end_header\n" +
  "\\begin_body\n" +
  "\\begin_layout Standard\n" +
  "\\change_deleted 1 1700000000\n" +
  "rejected \n" +
  "\\begin_inset Foot\n" +
  "status open\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "foot body\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\change_unchanged\n" +
  "current\n" +
  "\\end_layout\n" +
  "\\end_body\n" +
  "\\end_document\n";

Deno.test("DL92 - :change() block matches an inset sitting inside a deleted region (§2.1)", () => {
  const ast = parse(INSET_DELETED_BODY);
  const insets = query(ast, "inset:change(deleted)");
  assertEquals(insets.length, 1);
  assertEquals((insets[0] as { tag?: string }).tag, "inset");
  const nestedText = query(ast, "text:change(deleted)");
  assertEquals(nestedText.some(n => n.type === "text" && n.text === "foot body"), true);
  const nestedLayouts = query(ast, "layout[Plain Layout]:change(deleted)");
  assertEquals(nestedLayouts.length, 1);
  // Both the outer paragraph and nested Plain Layout carry deleted text.
  const layouts = query(ast, "layout:change(deleted)");
  assertEquals(layouts.length, 2);
});

Deno.test("Report 42 F2 - inherited style state reaches nested inset prose", () => {
  const ast = parse(INSET_STYLE_BODY);
  const nestedText = query(ast, "text:property(emph)");
  assertEquals(nestedText.some(n => n.type === "text" && n.text === "foot content"), true);
  const nestedLayouts = query(ast, "layout[Plain Layout]:property(emph)");
  assertEquals(nestedLayouts.length, 1);
});

// --- DL99 F2: notes visibility (dev log 99) ---

const DL99_BODY =
  "\\begin_layout Section\n" +
  "Section One\n" +
  "\\end_layout\n" +
  "\n" +
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
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "\\begin_inset Note Comment\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "COMMENT SECRET\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "\\begin_inset Note Greyedout\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "GREY VISIBLE\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n";

function dl99Ast() {
  return parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    DL99_BODY +
    "\\end_body\n\\end_document\n",
  );
}

function dl99Text(nodes: { type: string; text?: string }[]): string {
  return nodes.filter(n => n.type === "text").map(n => n.text ?? "").join("|");
}

Deno.test("DL99 - bare :contains excludes private note prose (Note + Comment)", () => {
  const ast = dl99Ast();
  assertEquals(query(ast, "layout:contains('PRIVATE SECRET')").length, 0);
  assertEquals(query(ast, "layout:contains('COMMENT SECRET')").length, 0);
});

Deno.test("DL99 - :note and explicit note path reach note prose", () => {
  const ast = dl99Ast();
  assertEquals(query(ast, "layout:note:contains('PRIVATE SECRET')").length, 1);
  assertEquals(query(ast, "inset[Note Note] layout[Plain Layout]:contains('PRIVATE SECRET')").length, 1);
  assertEquals(query(ast, "inset[Note Note] layout[Plain Layout]:contains('COMMENT SECRET')").length, 0);
});

Deno.test("DL99 - bare text excludes notes; :note and explicit path include them", () => {
  const ast = dl99Ast();
  const bare = dl99Text(query(ast, "text"));
  assertEquals(bare.includes("PRIVATE SECRET"), false);
  assertEquals(bare.includes("COMMENT SECRET"), false);
  const noteText = dl99Text(query(ast, "text:note"));
  assertEquals(noteText.includes("PRIVATE SECRET"), true);
  assertEquals(noteText.includes("COMMENT SECRET"), true);
  assertEquals(noteText.includes("GREY VISIBLE"), false);
  // Descendant from a visible layout excludes note text; explicit note path includes it.
  const descendant = dl99Text(query(ast, "layout[Standard] text"));
  assertEquals(descendant.includes("PRIVATE SECRET"), false);
  const explicit = dl99Text(query(ast, "layout[Standard] inset[Note Note] text"));
  assertEquals(explicit.includes("PRIVATE SECRET"), true);
});

Deno.test("DL99 - ',' union is per-group (visible + note text, no overlap)", () => {
  const ast = dl99Ast();
  const bareCount = query(ast, "text").length;
  const noteCount = query(ast, "text:note").length;
  const union = query(ast, "text, text:note");
  assertEquals(union.length, bareCount + noteCount);
});

Deno.test("DL99 - state axis still sees note prose (diff view, DL93)", () => {
  const ast = parse(
    "#LyX 2.5 created this file.\n\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    "\\begin_layout Standard\n" +
    "\\change_deleted 1 1700000000\n" +
    "deleted visible\n" +
    "\\begin_inset Note Note\n" +
    "status collapsed\n" +
    "\n" +
    "\\begin_layout Plain Layout\n" +
    "DELETED NOTE SECRET\n" +
    "\\end_layout\n" +
    "\n" +
    "\\end_inset\n" +
    "\\change_unchanged\n" +
    "\\end_layout\n" +
    "\\end_body\n\\end_document\n",
  );
  const del = dl99Text(query(ast, "text:change(deleted)"));
  assertEquals(del.includes("DELETED NOTE SECRET"), true);
  const noteDel = dl99Text(query(ast, "text:note:change(deleted)"));
  assertEquals(noteDel.includes("DELETED NOTE SECRET"), true);
  assertEquals(noteDel.includes("deleted visible"), false);
  const deletedLayouts = query(ast, "layout:change(deleted)");
  assertEquals(deletedLayouts.some(n => (n as { args?: string }).args === "Plain Layout"), true);
});

Deno.test("DL99 - :not(inset[Note Note]) and :not(:note) still work", () => {
  const ast = dl99Ast();
  // Standards containing a Note Note are excluded (Comment + Greyedout remain).
  assertEquals(query(ast, "layout[Standard]:not(inset[Note Note])").length, 2);
  // :not(:note) parses and returns layouts with no note descendant.
  assertEquals(query(ast, "layout:not(:note)").length > 0, true);
});

Deno.test("DL99 - Greyedout stays visible; :note(Greyedout) errors; :note(Comment) selects", () => {
  const ast = dl99Ast();
  assertEquals(query(ast, "layout[Plain Layout]:contains('GREY VISIBLE')").length, 1);
  let err = "";
  try { query(ast, "layout:note(Greyedout)"); } catch (e) { err = (e as Error).message; }
  assertEquals(err.includes("Invalid :note() argument"), true);
  assertEquals(query(ast, "layout:note(Comment)").length >= 1, true);
});

Deno.test("DL99 - ~ sibling with a note in a following sibling's descendants", () => {
  const ast = dl99Ast();
  const sibText = dl99Text(query(ast, "layout[Section] ~ layout[Standard] text"));
  assertEquals(sibText.includes("PRIVATE SECRET"), false);
  assertEquals(sibText.includes("Visible alpha"), true);
});

// --- DL104 (dev log 104): :until() boundary exclusivity. The sibling range
// must stop BEFORE the next node matching the inner selector — the boundary
// node itself and every descendant of following siblings are excluded.

const DL104_BODY =
  "\\begin_layout Section\n" +
  "First Section\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "Before one\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Subsection\n" +
  "First Subsection\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "Before two\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Subsection\n" +
  "Second Subsection\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "After subsection\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Section\n" +
  "Second Section\n" +
  "\\begin_inset Float table\n" +
  "status open\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "Inside table\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "After boundary\n" +
  "\\end_layout\n";

function dl104Ast() {
  return parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    DL104_BODY +
    "\\end_body\n\\end_document\n",
  );
}

function dl104Args(nodes: { type: string; args?: string }[]): string[] {
  return nodes.filter(n => n.type === "block").map(n => n.args ?? "");
}

Deno.test("DL104 - bare ~ layout:until(layout[Section]) excludes boundary node and its descendants", () => {
  const ast = dl104Ast();
  const res = query(ast, "layout[Section]:first ~ layout:until(layout[Section])");
  const args = dl104Args(res);
  // The next Section heading itself is the boundary — excluded.
  assertEquals(args.filter(a => a === "Section").length, 0, "boundary Section must be excluded");
  // Descendants of the next Section (its table's Plain Layout) are excluded.
  assertEquals(args.filter(a => a === "Plain Layout").length, 0, "descendants of boundary must be excluded");
  // Everything before the boundary survives: Before one, First Subsection,
  // Before two, Second Subsection, After subsection.
  assertEquals(args.length, 5, "only nodes before the next Section survive");
  assertEquals(args.filter(a => a === "Standard").length, 3);
  assertEquals(args.filter(a => a === "Subsection").length, 2);
});

Deno.test("DL104 - scoped ~ layout[Standard]:until(layout[Section]) counts unchanged", () => {
  const ast = dl104Ast();
  const res = query(ast, "layout[Section]:first ~ layout[Standard]:until(layout[Section])");
  const args = dl104Args(res);
  // Before one, Before two and After subsection survive; After boundary is
  // rejected because the next Section sits between it and the anchor.
  assertEquals(args.length, 3);
  assertEquals(args[0], "Standard");
  assertEquals(args[1], "Standard");
  assertEquals(args[2], "Standard");
});

Deno.test("DL104 - multi-hop ~ layout[Subsection] ~ layout[Standard]:until(layout[Subsection]) unchanged", () => {
  const ast = dl104Ast();
  const res = query(ast, "layout[Section]:first ~ layout[Subsection] ~ layout[Standard]:until(layout[Subsection])");
  const args = dl104Args(res);
  // From the First Subsection anchor, only Before two survives (the Second
  // Subsection is the boundary). From the Second Subsection anchor, After
  // subsection and After boundary survive.
  assertEquals(args.length, 3);
  assertEquals(args[0], "Standard"); // Before two
  assertEquals(args[1], "Standard"); // After subsection
  assertEquals(args[2], "Standard"); // After boundary
});

Deno.test("DL104 - :until(layout:contains(...)) boundary found via descendant text", () => {
  const ast = dl104Ast();
  const res = query(ast, "layout[Section]:first ~ layout[Standard]:until(layout:contains('Inside table'))");
  const args = dl104Args(res);
  // Before one, Before two, After subsection survive (all before the Section
  // whose table contains "Inside table"); After boundary is rejected.
  assertEquals(args.length, 3);
});

Deno.test("DL104 - :until without ~ is a no-op (DL55 path unchanged)", () => {
  const ast = dl104Ast();
  const all = query(ast, "layout[Standard]").length;
  const res = query(ast, "layout[Standard]:until(layout[Section])");
  assertEquals(res.length, all);
});

// --- DL105 (dev log 105) F1: the :until() span scan must be bounded by the
// candidate in document order. A descendant candidate that PRECEDES a tag
// boundary inside the same top-level sibling must be kept (the span scan used
// to continue past the nested target and reject it). A recursive :contains
// inner that matches the top-level sibling still rejects its descendants —
// that behavior is design-consistent and must not regress.

Deno.test("DL105 F1 - candidate before a nested Formula boundary is kept", () => {
  const ast = parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    "\\begin_layout Section\nFirst Section\n\\end_layout\n\n" +
    "\\begin_layout Standard\nContainer\n" +
    "\\begin_inset Float table\nstatus open\n\n" +
    "\\begin_layout Plain Layout\nCell before\n\\end_layout\n\n" +
    "\\end_inset\n\n" +
    "\\begin_inset Formula\nx^2\n\\end_inset\n" +
    "\\end_layout\n\n" +
    "\\begin_layout Standard\nAfter container\n\\end_layout\n" +
    "\\end_body\n\\end_document\n",
  );
  // "Cell before" precedes the Formula inside the Container — it must survive.
  const res = query(ast, "layout[Section]:first ~ layout[Plain Layout]:until(inset[Formula])");
  const args = dl104Args(res);
  assertEquals(args.length, 1, "candidate before the nested boundary must be kept");
  assertEquals(args[0], "Plain Layout");
});

Deno.test("DL105 F1 - guard: :contains inner matching the container still rejects its descendants", () => {
  const ast = parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    "\\begin_layout Section\nFirst Section\n\\end_layout\n\n" +
    "\\begin_layout Standard\nContainer\n" +
    "\\begin_inset Float table\nstatus open\n\n" +
    "\\begin_layout Plain Layout\nCell A\n\\end_layout\n\n" +
    "\\begin_layout Plain Layout\nCell B with X\n\\end_layout\n\n" +
    "\\end_inset\n\\end_layout\n\n" +
    "\\begin_layout Standard\nAfter\n\\end_layout\n" +
    "\\end_body\n\\end_document\n",
  );
  // The Container matches layout:contains('X') (its subtree holds Cell B), so
  // every descendant of Container is at/after the boundary — design-consistent.
  const res = query(ast, "layout[Section]:first ~ layout[Plain Layout]:until(layout:contains('X'))");
  assertEquals(res.length, 0);
});

Deno.test("DL99 - parser: :note without tag errors; bare :note in :not() parses", () => {
  let e1 = "";
  try { parseSelector(":note"); } catch (e) { e1 = (e as Error).message; }
  assertEquals(e1.includes("must follow a tag"), true);
  parseSelector("layout:not(:note)"); // must not throw
});

// --- DL101 (test report 46 F1): GUI-only `status` lines are excluded from
// --- content-axis `text` matching; identical content is NOT (first-child rule).

const DL101_BODY =
  "\\begin_layout Standard\n" +
  "status open in layout\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "\\begin_inset Note Note\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "status open content in note\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "\\begin_inset Foot\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "status open content in foot\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n" +
  "\n" +
  "\\begin_layout Standard\n" +
  "\\begin_inset ERT\n" +
  "status collapsed\n" +
  "\n" +
  "status open\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n";

function dl101Ast() {
  return parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    DL101_BODY +
    "\\end_body\n\\end_document\n",
  );
}

function dl101Texts(sel: string): string[] {
  return query(dl101Ast(), sel)
    .filter(n => n.type === "text")
    .map(n => (n as { text?: string }).text ?? "");
}

Deno.test("DL101 F1 - text:note returns only note prose, no status line", () => {
  const noteText = dl101Texts("text:note");
  assertEquals(noteText.includes("status collapsed"), false, "GUI status line must be excluded");
  assertEquals(noteText.includes("status open content in note"), true, "note prose must remain");
  // ERT is not a note — its payload must not appear in text:note.
  assertEquals(noteText.includes("status open"), false);
});

Deno.test("DL101 - bare text excludes all status lines but keeps identical content", () => {
  const bare = dl101Texts("text");
  assertEquals(bare.includes("status collapsed"), false, "no GUI status lines anywhere");
  assertEquals(bare.includes("status open in layout"), true, "layout prose kept (case 6)");
  // Note prose is excluded from bare `text` by the DL99 visibility rule (case 8 control).
  assertEquals(bare.includes("status open content in note"), false, "note prose is private (DL99)");
  assertEquals(bare.includes("status open content in foot"), true, "footnote prose kept");
  assertEquals(bare.includes("status open"), true, "ERT payload line kept (case 7 — over-exclusion guard)");
});

Deno.test("DL101 - ',' union stays consistent (no status in either arm)", () => {
  const bare = dl101Texts("text");
  const note = dl101Texts("text:note");
  assertEquals(bare.includes("status collapsed"), false);
  assertEquals(note.includes("status collapsed"), false);
  assertEquals(query(dl101Ast(), "text, text:note").length, query(dl101Ast(), "text").length + query(dl101Ast(), "text:note").length);
});

Deno.test("DL101 - state axis does not leak status lines (already opaque, DL93)", () => {
  assertEquals(dl101Texts("text:change(current)").includes("status collapsed"), false);
});

Deno.test("DL101 - explicit structural selection still sees the raw status node", () => {
  const note = query(dl101Ast(), "inset[Note Note]")[0] as { children?: { type: string; text?: string }[] };
  assertEquals(note.children?.[0]?.text, "status collapsed");
});

// Float writes its params BEFORE the status line (InsetFloat.cpp:313) — the
// status line is still pre-content prologue and must be excluded, while the
// params stay visible (they are document data, DL101 §3).
const DL101_FLOAT_BODY =
  "\\begin_layout Standard\n" +
  "\\begin_inset Float figure\n" +
  "placement document\n" +
  "alignment document\n" +
  "wide false\n" +
  "sideways false\n" +
  "status collapsed\n" +
  "\n" +
  "\\begin_layout Plain Layout\n" +
  "float caption text\n" +
  "\\end_layout\n" +
  "\n" +
  "\\end_inset\n" +
  "\n" +
  "\\end_layout\n";

Deno.test("DL101 - Float: params-before-status status excluded, params + caption kept", () => {
  const ast = parse(
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\textclass article\n\\end_header\n\\begin_body\n" +
    DL101_FLOAT_BODY +
    "\\end_body\n\\end_document\n",
  );
  const texts = query(ast, "text")
    .filter(n => n.type === "text")
    .map(n => (n as { text?: string }).text ?? "");
  assertEquals(texts.includes("status collapsed"), false, "Float status is GUI state — excluded");
  assertEquals(texts.includes("placement document"), true, "Float params stay (document data)");
  assertEquals(texts.includes("sideways false"), true, "Float params stay (document data)");
  assertEquals(texts.includes("float caption text"), true, "caption prose stays");
});
