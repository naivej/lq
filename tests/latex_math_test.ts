import { assert, assertEquals, assertStringIncludes } from "@std/assert";

function assertFalse(cond: boolean, msg: string): void {
  if (cond) throw new Error(msg);
}
import {
  latexToMathML,
  parseNewcommands,
  renderFormulaHtml,
  unwrapLatexSource,
} from "../src/latex_math.ts";

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
  assertStringIncludes(latexToMathML("\\underbar{a}"), 'notation="bottom"');
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

Deno.test("latexToMathML - smashoperator, optional args, brace limits, phantom, sideset, ce", () => {
  const smash = latexToMathML("\\smashoperator{\\sum^{n}_{i=1}}X");
  assertStringIncludes(smash, "∑");
  assertFalse(smash.includes("smashoperator"), "smashoperator must not drop the sum");

  const cfrac = latexToMathML("\\cfrac[l]{A}{B+C}");
  assertStringIncludes(cfrac, "<mfrac>");
  assertStringIncludes(cfrac, "<mi>A</mi>");
  assertFalse(cfrac.includes("<mo>[</mo>"), "cfrac optional [l] must not become atoms");

  const over = latexToMathML("\\overbrace{A+B}^{3}");
  assertStringIncludes(over, "<mover>");
  assertStringIncludes(over, "⏞");
  assertFalse(over.includes("<msup><mover>"), "overbrace limits must not use msup beside the brace");

  const under = latexToMathML("\\underbrace{A+B}_{5}");
  assertStringIncludes(under, "<munder>");
  assertStringIncludes(under, "⏟");
  assertFalse(under.includes("<msub><munder>"), "underbrace limits must not use msub beside the brace");

  const bracket = latexToMathML("\\overbracket[3pt]{A+B}");
  assertStringIncludes(bracket, "<mover>");
  assertStringIncludes(bracket, "<mi>A</mi>");
  assertFalse(bracket.includes("<mn>3</mn>"), "overbracket thickness must not become the body");

  const phant = latexToMathML("^{19}_{\\phantom{1}9}");
  assertStringIncludes(phant, "<mphantom>");
  assertStringIncludes(phant, "<mn>1</mn>");

  const side = latexToMathML("\\sideset{}{'}\\sum^{n}_{k=1}");
  assertStringIncludes(side, "mmultiscripts");
  assertStringIncludes(side, "′");

  const ce = latexToMathML("\\ce{SO4^{2-}}");
  assertStringIncludes(ce, "<msub>");
  assertStringIncludes(ce, "<msup>");
  assertFalse(ce.includes("SO4^{2-}"), "ce must expand scripts, not dump raw tex in one mtext");
  const arrow = latexToMathML("\\ce{A -> B}");
  assertStringIncludes(arrow, "<mo>→</mo>");
  const bonds = latexToMathML("\\ce{A-B\\dbond C\\tbond D}");
  assertStringIncludes(bonds, "<mo>=</mo>");
  assertStringIncludes(bonds, "<mo>≡</mo>");
  assertFalse(bonds.includes("\\dbond"), "ce must expand dbond/tbond");
  const hyphen = latexToMathML("\\ce{\\ensuremath{\\mu\\hyphen}Cl}");
  assertStringIncludes(hyphen, "μ");
  assertFalse(hyphen.includes("\\hyphen"), "ce must expand hyphen");
});

Deno.test("latexToMathML - preamble newcommand macros (Math.lyx aliases)", () => {
  const macros = parseNewcommands(String.raw`
\newcommand{\gr}{\Longrightarrow}
\newcommand{\us}[1]{\underline{#1}}
\newcommand{\fb}[3]{\framebox#1#2{$#3$}}
\newcommand{\cb}[3][white]{\fcolorbox{#2}{#1}{$#3$}}
`);
  assertStringIncludes(latexToMathML("A\\gr B", macros), "⟹");
  assertFalse(latexToMathML("A\\gr B", macros).includes("\\gr"), "gr macro must expand");
  const us = latexToMathML("\\us{ABcd}", macros);
  assertStringIncludes(us, 'notation="bottom"', "underline must span the whole argument");
  assertFalse(us.includes("<mo>_</mo>"), "must not use a short underscore glyph");
  assertFalse(us.includes("\\us"), "us macro must expand");
  const cb = latexToMathML("\\cb{red}{\\int A=B}", macros);
  assertStringIncludes(cb, "border:2px solid red", "cb{red} must paint a red frame");
  assertStringIncludes(cb, "∫");
  assertFalse(cb.includes("\\cb"), "cb macro must expand");
  const cb2 = latexToMathML("\\cb[green]{red}{\\int A=B}", macros);
  assertStringIncludes(cb2, "border:2px solid red");
  assertStringIncludes(cb2, 'mathbackground="green"');
  const fb = latexToMathML("\\fb{[2cm]}{}{\\int A=B}", macros);
  assertStringIncludes(fb, "menclose");
  assertStringIncludes(fb, "∫");
  assertStringIncludes(latexToMathML("\\underline{ABcd}"), 'notation="bottom"');
});
