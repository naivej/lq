import { assert, assertEquals, assertStringIncludes } from "@std/assert";

function assertFalse(cond: boolean, msg: string): void {
  if (cond) throw new Error(msg);
}
import { latexToMathML, renderFormulaHtml, unwrapLatexSource } from "../src/latex_math.ts";

Deno.test("unwrapLatexSource - dollar, equation, label", () => {
  assertEquals(unwrapLatexSource("$x$"), { display: false, numbered: false, env: "$", body: "x" });
  assertEquals(unwrapLatexSource("\\begin{equation}\nE=mc^{2}\n\\end{equation}"), {
    display: true,
    numbered: true,
    env: "equation",
    body: "E=mc^{2}",
  });
  assertEquals(
    unwrapLatexSource("\\begin{equation}\\ell_{t}(x)\\label{eq:eq_label}\\end{equation}"),
    { display: true, numbered: true, env: "equation", body: "\\ell_{t}(x)" },
  );
  assertEquals(unwrapLatexSource("\\[E=mc^{2}\\]"), {
    display: true,
    numbered: false,
    env: "[",
    body: "E=mc^{2}",
  });
  assertEquals(unwrapLatexSource("\\begin{equation*}x\\end{equation*}"), {
    display: true,
    numbered: false,
    env: "equation*",
    body: "x",
  });
});

Deno.test("latexToMathML - scripts, greek, sum, delimiters", () => {
  assertStringIncludes(latexToMathML("E=mc^{2}"), "<msup><mi>c</mi><mn>2</mn></msup>");
  assertStringIncludes(latexToMathML("\\zeta_{1}(x)"), "<mi>ζ</mi>");
  const display = latexToMathML(
    "\\ell_{t}\\left(x\\right)=\\sum^{K}_{k=1}\\alpha_{k,t}",
  );
  assertStringIncludes(display, "<mi>ℓ</mi>");
  assertStringIncludes(display, "∑");
  assertStringIncludes(display, "munderover");
  assertStringIncludes(display, "<mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow>");
  if (display.includes('stretchy="true"')) throw new Error("fences must not be stretchy");
  assertStringIncludes(latexToMathML("\\downarrow"), "<mo>↓</mo>");
  assertStringIncludes(latexToMathML("\\dfrac{A}{B}"), "<mfrac>");
  assertStringIncludes(latexToMathML("\\nicefrac{1}{18}"), "<mfrac>");
  assertStringIncludes(latexToMathML("\\mathbf{x}"), 'mathvariant="bold"');
});

Deno.test("renderFormulaHtml - MathML plus TeX annotation, escaped", () => {
  const html = renderFormulaHtml("$a<b$");
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, 'encoding="application/x-tex"');
  assertStringIncludes(html, "a&lt;b");
  assertFalse(html.includes("<b>"), "less-than must stay escaped");
});

Deno.test("latexToMathML - cases and pmatrix become mtable", () => {
  const cases = latexToMathML("\\begin{cases}A & B>0\\end{cases}");
  assertStringIncludes(cases, "<mtable>");
  assertStringIncludes(cases, "<mtd>");
  assertStringIncludes(cases, "<mi>A</mi>");
  const pmatrix = latexToMathML("\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}");
  assertStringIncludes(pmatrix, "<mtable>");
  assertStringIncludes(pmatrix, "<mo>(</mo>");
  assertStringIncludes(pmatrix, "<mi>a</mi>");
  assertStringIncludes(pmatrix, "<mi>d</mi>");
});

Deno.test("latexToMathML - common symbols, accents, and left-array", () => {
  assertStringIncludes(latexToMathML("\\approx"), "≈");
  assertStringIncludes(latexToMathML("\\gets"), "←");
  assertStringIncludes(latexToMathML("\\le"), "≤");
  assertStringIncludes(latexToMathML("\\varepsilon"), "ε");
  assertStringIncludes(latexToMathML("\\overrightarrow{a}"), "<mover>");
  assertStringIncludes(latexToMathML("\\overrightarrow{a}"), "<mi>a</mi>");
  const arr = latexToMathML("\\left[\\begin{array}{cc}a & b\\\\c & d\\end{array}\\right]");
  assertStringIncludes(arr, "<mtable>");
  assertStringIncludes(arr, "<mi>a</mi>");
  assertStringIncludes(arr, "<mi>d</mi>");
  const raised = latexToMathML("H\\raisebox{2mm}{al}lo");
  assertStringIncludes(raised, 'voffset="2mm"');
  assertStringIncludes(raised, "<mi>a</mi>");
  const boxed = latexToMathML("\\colorbox{yellow}{A=B}");
  assertStringIncludes(boxed, 'mathbackground="yellow"');
  assertStringIncludes(boxed, "<mi>A</mi>");
  const tinted = latexToMathML("\\textcolor{red}{\\int A=B}");
  assertStringIncludes(tinted, 'mathcolor="red"');
  assertStringIncludes(tinted, "∫");
  const brack = latexToMathML("{A \\brack B}");
  assertStringIncludes(brack, "<mfrac");
  assertStringIncludes(brack, "<mo>[</mo>");
  assertStringIncludes(latexToMathML("a\\pmod b"), "mod");
  assertStringIncludes(latexToMathML("\\Bra{\\psi}"), "⟨");
  assertStringIncludes(latexToMathML("\\cancel{x}"), "updiagonalstrike");
  assertStringIncludes(latexToMathML("\\underbar{a}"), "<munder>");
  const aligned = latexToMathML("\\begin{aligned}A&=B\\\\C&=D\\end{aligned}");
  assertStringIncludes(aligned, "<mtable>");
  assertStringIncludes(aligned, "<mi>C</mi>");
  const tagged = renderFormulaHtml("\\begin{equation}A+B=C\\tag{something}\\end{equation}", 9);
  assertStringIncludes(tagged, "(something)");
  assertFalse(tagged.includes("(9)"), "\\tag replaces the sequential equation number");
  const unnumbered = renderFormulaHtml("\\[E=mc^{2}\\]", 5);
  assertStringIncludes(unnumbered, 'display="block"');
  assertFalse(unnumbered.includes("(5)"), "\\[ \\] display math is not numbered");
  const numbered = renderFormulaHtml("\\begin{equation}E=mc^{2}\\end{equation}", 3);
  assertStringIncludes(numbered, "(3)");
  const gather = renderFormulaHtml("\\begin{gather}A=1\\\\ X=\\textrm{-}1\\end{gather}", ["8", "9"]);
  assertEquals([...gather.matchAll(/class="formula-row"/g)].length, 2);
  assertEquals([...gather.matchAll(/display="block"/g)].length, 2);
  assertStringIncludes(gather, "(8)");
  assertStringIncludes(gather, "(9)");
  assert(gather.indexOf("(8)") < gather.indexOf("(9)"), "gather lines keep source order");
  assertStringIncludes(gather, "<mi>A</mi>");
  assertStringIncludes(gather, "<mn>1</mn>");
  const eqnarray = renderFormulaHtml(
    "\\begin{eqnarray}A&=&B\\\\ C&=&D\\nonumber \\\\ E&=&F\\end{eqnarray}",
    ["1", undefined, "2"],
  );
  assertEquals([...eqnarray.matchAll(/class="formula-row"/g)].length, 3);
  assertStringIncludes(eqnarray, "(1)");
  assertStringIncludes(eqnarray, "(2)");
  assertEquals([...eqnarray.matchAll(/class="eqno"/g)].length, 2, "\\nonumber row is not numbered");
  const multline = renderFormulaHtml("\\begin{multline}A\\\\ B\\\\ C\\end{multline}", [undefined, undefined, "4"]);
  assertEquals([...multline.matchAll(/class="formula-row"/g)].length, 3);
  assertStringIncludes(multline, "(4)");
  assertEquals([...multline.matchAll(/class="eqno"/g)].length, 1, "multline numbers only the last line");
  const xl = latexToMathML("F(a)\\xleftarrow[x>0]{x=a}F(x)");
  assertStringIncludes(xl, "<munderover>");
  assertStringIncludes(xl, "<mi>x</mi>");
  const cd = latexToMathML("\\begin{CD}A@>>>B@>>>C\\\\@AAA@.@VVV\\\\F@<<<E@<<<D\\end{CD}");
  assertStringIncludes(cd, "<mtable");
  assertStringIncludes(cd, "<mi>A</mi>");
  assertStringIncludes(cd, "<mi>F</mi>");
  assertStringIncludes(cd, "→");
  assertStringIncludes(cd, "↑");
  const script = latexToMathML("{\\scriptstyle E=mc^{2}}");
  assertStringIncludes(script, 'mathsize="75%"');
  assertStringIncludes(script, "<mi>E</mi>");
  const gf = latexToMathML("\\genfrac{(}{)}{0pt}{1}{A}{B}");
  assertStringIncludes(gf, 'linethickness="0"');
  assertStringIncludes(gf, "<mo>(</mo>");
});

Deno.test("latexToMathML - unknown commands stay escaped mtext-like mi", () => {
  const html = latexToMathML("\\unknown{x}");
  if (html.includes("<script")) throw new Error("unknown command must not become a script");
  if (!html.includes("unknown")) throw new Error("unknown command name should remain visible");
});
