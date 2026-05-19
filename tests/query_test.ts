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

  const parsed4 = parseSelector(':contains("[")');
  assertEquals(parsed4[0][0].pseudos![0].name, "contains");
  assertEquals(parsed4[0][0].pseudos![0].argRaw, '"["');

  const parsed5 = parseSelector(':nth-child(odd), :nth-child( 2n+1 )');
  assertEquals(parsed5[0][0].pseudos![0].name, "nth-child");
  assertEquals(parsed5[0][0].pseudos![0].argRaw, "odd");
  assertEquals(parsed5[1][0].pseudos![0].name, "nth-child");
  assertEquals(parsed5[1][0].pseudos![0].argRaw, "2n+1");
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

  // Test Standalone :contains
  const res5 = query(ast, ':contains("tracked changes")');
  // It should match the document, the body, and the layout Standard because it is recursive now.
  assertEquals(res5.length, 3);

  // Test :contains with parentheses inside string literals
  const res6 = query(ast, ':contains("nickel(0)")');
  assertEquals(res6.length, 0); // Not in the template, but should not throw syntax error
  const res7 = query(ast, ':contains("a)b)c")');
  assertEquals(res7.length, 0); // Not in the template, but should not throw syntax error
});
