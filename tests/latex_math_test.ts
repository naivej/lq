import { assertEquals, assertStringIncludes } from "@std/assert";
import { latexToMathML, renderFormulaHtml, unwrapLatexSource } from "../src/latex_math.ts";

Deno.test("unwrapLatexSource - dollar, equation, label", () => {
  assertEquals(unwrapLatexSource("$x$"), { display: false, body: "x" });
  assertEquals(unwrapLatexSource("\\begin{equation}\nE=mc^{2}\n\\end{equation}"), {
    display: true,
    body: "E=mc^{2}",
  });
  assertEquals(
    unwrapLatexSource("\\begin{equation}\\ell_{t}(x)\\label{eq:eq_label}\\end{equation}"),
    { display: true, body: "\\ell_{t}(x)" },
  );
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
});

Deno.test("renderFormulaHtml - MathML plus TeX annotation, escaped", () => {
  const html = renderFormulaHtml("$a<b$");
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, 'encoding="application/x-tex"');
  assertStringIncludes(html, "a&lt;b");
  assert(!html.includes("<b>"));
});

Deno.test("latexToMathML - unknown commands stay escaped mtext-like mi", () => {
  const html = latexToMathML("\\unknown{x}");
  if (html.includes("<script")) throw new Error("unknown command must not become a script");
  if (!html.includes("unknown")) throw new Error("unknown command name should remain visible");
});
