import { assertEquals } from "@std/assert";
import { parse } from "../src/parser.ts";
import { query, parseSelector } from "../src/query.ts";

Deno.test("Selector Parsing", () => {
  const parsed1 = parseSelector("layout[Section]");
  assertEquals(parsed1[0][0].tag, "layout");
  assertEquals(parsed1[0][0].argExact, "Section");

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
