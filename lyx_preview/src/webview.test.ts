import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWebviewHtml } from "./webview";

function render(mode?: "original" | "tracked" | "clean"): string {
  return renderWebviewHtml({
    title: "LyX Preview: a.lyx",
    stale: false,
    pending: false,
    mode,
    render: {
      contract: "lyx-preview/live-1",
      projection: "live",
      html: "<article class=\"lyx-live\">x</article>",
      source: {
        path: "C:/tmp/a.lyx",
        hashAlgorithm: "sha256",
        hashInput: "raw-file-bytes",
        diskHash: "a".repeat(64),
        lineEnding: "lf",
        lineCount: 2,
        fresh: true,
      },
      capabilities: {
        review: false,
        mapping: true,
        outline: true,
        editing: false,
        sourceReveal: false,
      },
      diagnostics: [],
      outline: [],
      navigate: {
        figures: [],
        tables: [],
        equations: [],
        labels: [],
        listings: [],
        algorithms: [],
      },
      changes: [],
      tokens: [],
    },
    imgCsp: "'none'",
    scriptCsp: "'nonce-test123'",
    scriptNonce: "test123",
  });
}

describe("renderWebviewHtml change views", () => {
  it("bakes the default Tracked mode on body", () => {
    assert.match(render(), /<body data-mode="tracked">/);
  });

  it("bakes an explicit mode", () => {
    assert.match(render("clean"), /<body data-mode="clean">/);
    assert.match(render("original"), /<body data-mode="original">/);
  });

  it("keeps the CSP script nonce and has no remote content", () => {
    const html = render("tracked");
    assert.match(html, /script-src 'nonce-test123'/);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it("ships the setMode allowlist and changeFocus script", () => {
    const html = render("tracked");
    assert.match(html, /msg\.mode === "original" \|\| msg\.mode === "tracked" \|\| msg\.mode === "clean"/);
    assert.match(html, /vscode\.postMessage\(\{ type: "changeFocus"/);
    assert.match(html, /closest\("ins\.change-inserted, del\.change-deleted"\)/);
    assert.match(html, /closest\("\[data-ref\]"\)/);
    assert.match(html, /type: "select"/);
    assert.match(html, /window\.addEventListener\("blur"/);
    assert.doesNotMatch(html, /addEventListener\("blur"[\s\S]*type: "select"/);
    assert.match(html, /if \(!owner\) return/);
    assert.match(html, /userSelect === "none"/);
    assert.match(html, /removeAllRanges\(\)/);
    assert.match(html, /clickHitsGlyph/);
    assert.match(html, /suppressSelectUntil/);
    assert.match(html, /selectGestureFromGlyph/);
    assert.match(html, /type: "select", id: null/);
    assert.doesNotMatch(html, /document\.hasFocus\(\)/);
  });

  it("ships the three-view CSS", () => {
    const html = render("tracked");
    assert.match(html, /body\[data-mode="original"\] ins\.change-inserted/);
    assert.match(html, /body\[data-mode="clean"\] del\.change-deleted/);
    assert.match(html, /body\[data-mode="clean"\] div\.change-deleted/);
    assert.match(html, /ins\.change-author-0, del\.change-author-0/);
    assert.match(html, /ins\.change-author-1, del\.change-author-1/);
  });

  it("ships DL145 chrome non-select CSS (J6)", () => {
    const html = render("tracked");
    assert.match(html, /span\.heading-number/);
    assert.match(html, /nav\.toc/);
    assert.match(html, /div\.bibtexentry/);
    assert.match(html, /user-select:\s*none/);
    // Chip summaries are NOT in the non-select list (object-select / rebuild inset).
    const cssStart = html.indexOf("/* DL145 J6");
    const cssEnd = html.indexOf("span.ref, span.citation", cssStart);
    const block = html.slice(cssStart, cssEnd);
    assert.match(block, /span\.heading-number/);
    assert.match(block, /span\.float-caption-prefix/);
    assert.match(block, /span\.layout-label/);
    assert.match(block, /span\.eqno/);
    assert.match(block, /span\.abstract_label/);
    assert.match(block, /span\.appendix-label/);
    assert.match(block, /div\.nomencl/);
    assert.match(block, /div\.index/);
    assert.equal(block.includes("details.disclose > summary"), false);
  });

  it("posts object select on disclosure summary click (rebuild inset)", () => {
    const html = render("tracked");
    assert.match(html, /closest\("details\.disclose"\)/);
    assert.match(html, /selectedText: ""/);
  });

  it("open inset boxes hug content and cap at the page, not a fixed em width", () => {
    const html = render("tracked");
    const cssStart = html.indexOf("details.disclose[open] {");
    assert.notEqual(cssStart, -1);
    const bodyRule = html.indexOf("details.disclose[open] > .disclose-body {", cssStart);
    assert.notEqual(bodyRule, -1);
    const openBlock = html.slice(cssStart, bodyRule);
    assert.match(openBlock, /width:\s*max-content/);
    assert.match(openBlock, /max-width:\s*100%/);
    assert.equal(openBlock.includes("36em"), false);
    assert.equal(openBlock.includes("28em"), false);
    const bodyEnd = html.indexOf("details.disclose.wrap[open]", bodyRule);
    assert.notEqual(bodyEnd, -1);
    const bodyBlock = html.slice(bodyRule, bodyEnd);
    assert.match(bodyBlock, /width:\s*max-content/);
    assert.match(bodyBlock, /max-width:\s*100%/);
    assert.equal(bodyBlock.includes("36em"), false);
    const boxRule = html.indexOf("div.Boxed, div.Framed");
    assert.notEqual(boxRule, -1);
    const boxBlock = html.slice(boxRule, html.indexOf("div.Frameless", boxRule));
    assert.match(boxBlock, /width:\s*max-content/);
    assert.match(boxBlock, /max-width:\s*100%/);
    assert.match(html, /details\.disclose\.box-full\[open\]/);
    // Kind-specific open rules must not reintroduce a fixed em cap.
    assert.doesNotMatch(html, /details\.disclose[^{]*\[open\][^{]*\{[^}]*min\(\d+em/);
    assert.doesNotMatch(html, /details\.disclose[^{]*\[open\][^{]*\{[^}]*max-width:\s*min\(\d+em/);
  });

  it("paragraph first-line indent does not leak into chip interiors (DL045)", () => {
    const html = render("tracked");
    const start = html.indexOf("details.disclose {");
    assert.notEqual(start, -1);
    const block = html.slice(start, html.indexOf("details.disclose > summary {", start));
    assert.match(block, /text-indent:\s*0/);
  });

  it("open float chips hug content; open wrap floats at stored width (DL043/DL045)", () => {
    const html = render("tracked");
    const wrapStart = html.indexOf("details.disclose.wrap[open] {");
    assert.notEqual(wrapStart, -1);
    const wrapBlock = html.slice(
      wrapStart,
      html.indexOf("details.disclose.wrap[open] > .disclose-body {", wrapStart),
    );
    assert.match(wrapBlock, /width:\s*var\(--wrap-width/);
    assert.doesNotMatch(wrapBlock, /^\s*width:\s*100%/m);
    assert.match(html, /details\.disclose\.wrap\.wrap-left\[open\]\s*\{[^}]*float:\s*left/);
    assert.match(html, /details\.disclose\.wrap\.wrap-right\[open\]\s*\{[^}]*float:\s*right/);
    assert.doesNotMatch(
      html,
      /details\.disclose\.float\[open\],\s*details\.disclose\.wrap\[open\]/,
    );
    const floatWidth = html.match(
      /details\.disclose\.float\[open\]\s*\{[^}]*width:\s*100%/,
    );
    assert.equal(floatWidth, null);
  });

  it("figure float-body is a block so a note with inline math is not two columns", () => {
    const html = render("tracked");
    assert.match(html, /figure > \.float-body \{ display: block/);
    assert.doesNotMatch(html, /figure > \.float-body \{ display: flex/);
  });

  it("table cells use a dashed off-grid; fills and newlines are chrome", () => {
    const html = render("tracked");
    assert.match(html, /td\.lyx-trim-top/);
    assert.match(
      html,
      /lyx-trim-top\.lyx-trim-l::before[\s\S]*?background: var\(--vscode-editor-background/,
    );
    assert.match(html, /td, th \{ border: none/);
    assert.match(html, /span\.newline \{/);
    assert.match(html, /span\.newline\.linebreak \{/);
    assert.match(html, /span\.hfill \{/);
    assert.match(
      html,
      /span\.hfill \{[\s\S]*?repeating-linear-gradient\(to right, brown/,
    );
    assert.match(html, /div\.standard:has\(\.hfill\)/);
    assert.match(html, /blockquote > div:has\(\.hfill\)/);
    assert.match(html, /li:has\(\.hfill\)/);
    assert.match(html, /flex-wrap:\s*nowrap/);
    assert.match(
      html,
      /div\.lyx-vspace \{[\s\S]*?justify-content:\s*center/,
    );
    assert.match(
      html,
      /span\.hfill\.leftarrowfill,\s*span\.hfill\.rightarrowfill \{[\s\S]*?border-left:\s*none/,
    );
    assert.match(html, /span\.space-mark \{/);
    assert.match(html, /span\.space-mark\.thin \{/);
    assert.match(html, /span\.space-mark\.latex \{[\s\S]*?#8b0000/);
    assert.match(html, /span\.space-mark\.special \{[\s\S]*?royalblue/);
    assert.match(html, /span\.space-mark\.arrow \{/);
    assert.doesNotMatch(html, /lyx-trim-heavy/);
    assert.doesNotMatch(html, /span\.newline::after \{ content: "↵/);
    assert.doesNotMatch(html, /span\.newline\.linebreak::after \{ content: "↵↵/);
  });

  it("inline tables sit on the text baseline (top / middle / bottom)", () => {
    const html = render("tracked");
    assert.match(html, /span\.lyx-tabular \{ display: inline-block/);
    assert.match(html, /span\.lyx-tabular-top \{ vertical-align: baseline/);
    assert.match(html, /span\.lyx-tabular-middle \{ vertical-align: middle/);
    assert.match(html, /span\.lyx-tabular-bottom \{ vertical-align: baseline/);
    assert.match(html, /span\.lyx-tabular-strut \{/);
  });

  it("appendix frame is a top-and-sides border with an unselectable label (DL152)", () => {
    const html = render("tracked");
    assert.match(html, /div\.appendix-frame \{/);
    const start = html.indexOf("div.appendix-frame {");
    const block = html.slice(start, html.indexOf("span.appendix-label", start));
    assert.match(block, /border-top:/);
    assert.match(block, /border-left:/);
    assert.match(block, /border-right:/);
    assert.match(block, /border-bottom:\s*none/);
    assert.match(html, /span\.appendix-label \{/);
  });

  it("marks whole-inset disclosures: inserted underline, deleted label strike + open diagonal", () => {
    const html = render("tracked");
    assert.match(html, /ins\.change-inserted details\.disclose > \*/);
    assert.match(html, /del\.change-deleted details\.disclose > summary/);
    assert.match(html, /del\.change-deleted details\.disclose\[open\] > span::after/);
    assert.match(html, /linear-gradient\(\s*to top left/);
    assert.match(html, /body\[data-mode="tracked"\] del\.change-deleted details\.disclose > summary/);
    assert.match(html, /body\[data-mode="original"\] del\.change-deleted details\.disclose > summary/);
    assert.match(html, /body\[data-mode="original"\] del\.change-deleted details\.disclose\[open\] > span::after/);
    assert.match(html, /body\[data-mode="clean"\] ins\.change-inserted details\.disclose > \*/);
  });
});
