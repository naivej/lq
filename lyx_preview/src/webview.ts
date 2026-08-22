import type { LiveRender } from "./previewSession";

export function liveWebviewCsp(imgSrc = "'none'", scriptSrc = "'none'"): string {
  return `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src ${scriptSrc}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

export const WEBVIEW_CSP = liveWebviewCsp("'none'");

export function escapeHostText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderWebviewHtml(options: {
  title: string;
  stale: boolean;
  pending: boolean;
  /** DL133 view mode (Original/Tracked/Clean); default Tracked. */
  mode?: "original" | "tracked" | "clean";
  error?: string;
  render?: LiveRender;
  imgCsp?: string;
  /** CSP script-src token(s); default none. Pass nonce-'…' for Explorer-outline scroll helper. */
  scriptCsp?: string;
  scriptNonce?: string;
}): string {
  const status = options.error
    ? `<div id="lyx-banner" class="banner error">${escapeHostText(options.error)}</div>`
    : options.pending
      ? `<div id="lyx-banner" class="banner pending">Rendering…</div>`
      : options.stale
        ? `<div id="lyx-banner" class="banner stale">Unsaved edits — save to refresh the Live preview.</div>`
        : "";
  const diagnostics = (options.render?.diagnostics ?? [])
    .map((d) => `<li><code>${escapeHostText(d.code)}</code> ${escapeHostText(d.message)}</li>`)
    .join("");
  const diagBlock = diagnostics
    ? `<aside class="diagnostics"><ul>${diagnostics}</ul></aside>`
    : "";
  const body = options.render?.html
    ?? (options.pending ? "" : "<p class=\"empty\">No Live render yet.</p>");
  const mode = options.mode ?? "tracked";
  const scriptSrc = options.scriptCsp ?? "'none'";
  const nonce = options.scriptNonce;
  // Host posts { type: "scrollToId", id } from Explorer "LyX Navigate".
  // Figures/tables live inside collapsed <details>; open ancestors before scrolling.
  const scrollScript = nonce
    ? `<script nonce="${escapeHostText(nonce)}">
(function () {
  var vscode = acquireVsCodeApi();
  vscode.postMessage({ type: "ready" });
  function setStaleBanner() {
    var b = document.getElementById("lyx-banner");
    var text = "Unsaved edits — save to refresh the Live preview.";
    if (b) {
      b.className = "banner stale";
      b.textContent = text;
    } else {
      b = document.createElement("div");
      b.id = "lyx-banner";
      b.className = "banner stale";
      b.textContent = text;
      document.body.prepend(b);
    }
  }
  function openAncestorDetails(el) {
    var n = el;
    while (n) {
      if (n.tagName === "DETAILS") n.open = true;
      n = n.parentElement;
    }
  }
  function scrollToId(id) {
    var el = document.getElementById(id);
    if (!el) return;
    openAncestorDetails(el);
    // Reveal the disclosure chrome when the target is buried in .disclose-body.
    var chip = el.closest && el.closest("details.disclose");
    var target = chip || el;
    requestAnimationFrame(function () {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  window.addEventListener("message", function (e) {
    var msg = e.data;
    if (!msg) return;
    if (
      msg.type === "setMode" &&
      (msg.mode === "original" || msg.mode === "tracked" || msg.mode === "clean")
    ) {
      document.body.setAttribute("data-mode", msg.mode);
      return;
    }
    if (msg.type === "stale") {
      setStaleBanner();
      return;
    }
    if (msg.type !== "scrollToId" || !msg.id) return;
    scrollToId(msg.id);
  });
  function postChangeFocus(id) {
    vscode.postMessage({ type: "changeFocus", id: id || null });
  }
  document.addEventListener("selectionchange", function () {
    var sel = window.getSelection();
    if (!sel || !sel.anchorNode) {
      postChangeFocus(null);
      return;
    }
    var node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    var el = node && node.closest ? node.closest("ins.change-inserted, del.change-deleted") : null;
    postChangeFocus(el && el.id ? el.id : null);
  });
  window.addEventListener("blur", function () {
    postChangeFocus(null);
  });
})();
</script>`
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${liveWebviewCsp(options.imgCsp ?? "'none'", scriptSrc)}">
<title>${escapeHostText(options.title)}</title>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 1rem 1.25rem 2rem; }
.banner { padding: 0.4rem 0.6rem; margin-bottom: 0.75rem; border-left: 3px solid var(--vscode-editorWarning-foreground); }
.banner.error { border-left-color: var(--vscode-errorForeground); }
.banner.pending { border-left-color: var(--vscode-editorInfo-foreground); }
article.lyx-live { max-width: 100%; margin: 0 auto; line-height: 1.45; }
article.lyx-live section { margin: 0 0 1rem; }
article.lyx-live h1, article.lyx-live h2, article.lyx-live h3, article.lyx-live h4 { margin: 0.8em 0 0.4em; }
h1.title { font-size: 1.85em; text-align: center; font-weight: bold; margin: 0.4em 0 0.6em; }
div.author { font-size: 1.15em; text-align: center; margin: 0.35em 0 1em; }
div.date { text-align: center; margin: 0.35em 0 1em; }
div.abstract { margin: 1.5em 2.5em 2em; }
.abstract_label { display: block; font-weight: bold; text-align: center; margin-bottom: 0.6em; }
.abstract_item { font-size: 0.95em; margin: 0.4em 0; }
div.standard { margin: 0 0 0.8em; }
div.subtitle { font-size: 1.2em; text-align: center; margin: 0.2em 0 0.8em; }
blockquote { margin: 0.5em 1.5em; }
dl.description dt { font-weight: bold; }
ol.enumi { list-style-type: decimal; }
ol.enumii { list-style-type: lower-alpha; }
ol.enumiii { list-style-type: lower-roman; }
ol.enumiv { list-style-type: upper-alpha; }
figure.float-figure, figure.float-table { display: block; margin: 1.2em auto; text-align: center; }
figure > figcaption { display: block; text-align: center; margin: 0 0 0.6em; }
figure > .float-body { display: flex; justify-content: center; margin: 0.4em 0; }
figure table { margin-left: auto; margin-right: auto; }
table { border-collapse: collapse; margin: 0.75em 0; }
td, th { border: 1px solid var(--vscode-panel-border); padding: 0.25em 0.5em; }
/*
 * DL131 disclosure: click summary to expand/collapse (no hover).
 * Closed = tight colored chip around the label only; open = body below.
 * Do NOT force .disclose-body { display: … } when closed — that kept bodies visible.
 */
details.disclose {
  display: inline-block;
  vertical-align: baseline;
  margin: 0 0.12em;
  padding: 0;
  border: none;
  max-width: 100%;
}
details.disclose > summary {
  cursor: pointer;
  list-style: none;
  display: inline-block;
  vertical-align: baseline;
  font-weight: 600;
  font-size: 0.85em;
  line-height: 1.25;
  padding: 0.05em 0.4em;
  margin: 0;
  border: 1px solid #888;
  border-radius: 3px;
  background: #f0f0f0;
  color: #222;
}
details.disclose > summary::-webkit-details-marker { display: none; }
details.disclose[open] {
  display: inline-block;
  vertical-align: top;
  width: fit-content;
  max-width: min(36em, 100%);
  margin: 0.35em 0.12em;
}
details.disclose[open] > summary {
  margin-bottom: 0.25em;
}
details.disclose[open] > .disclose-body {
  display: block;
  width: fit-content;
  max-width: min(36em, 100%);
  box-sizing: border-box;
  margin: 0.15em 0 0.25em;
  padding: 0.35em 0.5em;
  border: 1px solid #888;
  border-radius: 3px;
  background: var(--vscode-editor-background, #fff);
}
/* Wide media (figures/tables) need the full column when open — including
 * wraps nested inside a Standard <p>, not only section/article children. */
details.disclose.float[open],
details.disclose.wrap[open] {
  display: block;
  width: 100%;
  max-width: 100%;
}
details.disclose.float[open] > .disclose-body,
details.disclose.wrap[open] > .disclose-body {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
/* Footnotes: red number chip; open body uses a note-like content box (not parentheses). */
details.disclose.foot,
details.disclose.foot_intitle {
  vertical-align: super;
}
details.disclose.foot > summary,
details.disclose.foot_intitle > summary {
  font-size: 0.75em;
  vertical-align: super;
  background: #ffd0d0;
  border-color: #c44;
  color: #800;
}
details.disclose.foot[open],
details.disclose.foot_intitle[open] {
  display: inline-block;
  vertical-align: baseline;
  margin: 0.15em 0.12em;
  max-width: min(28em, 100%);
}
details.disclose.foot[open] > summary,
details.disclose.foot_intitle[open] > summary {
  margin-bottom: 0.2em;
  vertical-align: super;
}
details.disclose.foot[open] > .foot_inner,
details.disclose.foot_intitle[open] > .foot_intitle_inner {
  display: block;
  margin: 0;
  padding: 0.4em 0.5em;
  border: 1px solid #c44;
  border-radius: 3px;
  background: #fff5f5;
  font-size: 0.95em;
  color: inherit;
}
/* LyX-ish inset label colors */
details.disclose.note-note > summary {
  background: #fff3a0;
  border-color: #c9a000;
  color: #5a4800;
}
details.disclose.note-comment > summary {
  background: #e4e4ff;
  border-color: #5555aa;
  color: #303070;
}
details.disclose.note-greyedout > summary {
  background: #e8e8e8;
  border-color: #888;
  color: #555;
}
details.disclose.note[open] {
  width: fit-content;
  max-width: min(28em, 100%);
}
details.disclose.note-note[open] > .disclose-body,
details.disclose.note-comment[open] > .disclose-body {
  width: fit-content;
  max-width: min(28em, 100%);
  border-color: #c9a000;
  background: #fffceb;
}
details.disclose.note-comment[open] > .disclose-body {
  border-color: #5555aa;
  background: #f7f7ff;
}
/* Greyedout: hug content — avoid 28em-wide empty box from block .plain_layout. */
details.disclose.note-greyedout[open] {
  width: max-content;
  max-width: min(28em, 100%);
}
details.disclose.note-greyedout[open] > .disclose-body {
  width: max-content;
  max-width: min(28em, 100%);
  border-color: #888;
  background: #f4f4f4;
  color: #A0A0A0;
  padding: 0.25em 0.4em;
}
details.disclose.note-greyedout[open] .plain_layout,
details.disclose.note-greyedout[open] .note_greyedout {
  display: inline;
  margin: 0;
  padding: 0;
}
details.disclose.argument.short-title > summary {
  background: #efe6d6;
  border-color: #8a7040;
  color: #5a4010;
}
details.disclose.float-figure > summary,
details.disclose.wrap.wrap-figure > summary {
  background: #d4efd4;
  border-color: #2a8a2a;
  color: #145214;
}
details.disclose.float-table > summary,
details.disclose.wrap.wrap-table > summary {
  background: #d6e4ff;
  border-color: #2a5aaa;
  color: #1a3560;
}
details.disclose.float-figure[open] > .disclose-body,
details.disclose.wrap.wrap-figure[open] > .disclose-body {
  border-color: #2a8a2a;
}
details.disclose.float-table[open] > .disclose-body,
details.disclose.wrap.wrap-table[open] > .disclose-body {
  border-color: #2a5aaa;
}
/* Contain floated wrap content inside the open disclosure box.
 * Closed chip stays inline; when open, kill the page-level float so the
 * figure/table stays inside the bordered .disclose-body (not beside it). */
details.disclose.wrap[open] > .disclose-body {
  overflow: auto;
  display: flow-root;
}
details.disclose.wrap[open] .wrap {
  float: none !important;
  margin: 0 !important;
  width: 100% !important;
  max-width: 100%;
}
details.disclose.wrap[open] .wrap figure {
  width: 100%;
  max-width: 100%;
}
details.disclose.box > summary {
  background: #ececec;
  border-color: #666;
}
details.disclose.marginal > summary {
  background: #f3e6ff;
  border-color: #7a4aaa;
  color: #402060;
}
details.disclose.branch > summary {
  background: #ffe6cc;
  border-color: #cc7700;
}
details.disclose.flex-container > summary {
  background: #e8f4f8;
  border-color: #3a7a8a;
}
/* Denylist plain-text markers (Live-only; native XHTML omits these). */
details.disclose.ert > summary,
details.disclose.phantom > summary,
details.disclose.index-marker > summary,
details.disclose.nomencl-marker > summary {
  background: #f0f0f0;
  border-color: #777;
  color: #333;
  font-family: ui-monospace, Consolas, monospace;
  font-weight: 600;
}
details.disclose.ert[open] > .disclose-body,
details.disclose.phantom[open] > .disclose-body,
details.disclose.index-marker[open] > .disclose-body,
details.disclose.nomencl-marker[open] > .disclose-body {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.9em;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: min(40em, 100%);
}
code.marker-body,
code.ert-body {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  padding: 0;
}
/* Block-level floats/wraps (sole content of a layout, promoted out of Standard). */
section > details.disclose.float,
section > details.disclose.wrap,
article > details.disclose.float,
article > details.disclose.wrap {
  display: block;
  margin: 0.6em 0;
}
span.formula { }
math { font-family: "Cambria Math", "Latin Modern Math", "STIX Two Math", serif; font-size: 1.05em; }
span.formula:has(> math[display="block"]),
span.formula-row {
  display: grid;
  grid-template-columns: 4em 1fr 4em;
  align-items: center;
  width: 100%;
  margin: 1.2em 0;
}
span.formula:has(> .formula-row) {
  display: block;
  width: 100%;
  margin: 1.2em 0;
}
span.formula-row { margin: 0.35em 0; }
span.formula:has(> math[display="block"]) > math,
span.formula-row > math {
  grid-column: 2;
  justify-self: center;
}
span.formula:has(> math[display="block"]) > .eqno,
span.formula-row > .eqno {
  grid-column: 3;
  justify-self: end;
}
nav.toc { margin: 1.5em 0 2em; }
h2.toc { font-size: 1.3em; margin-bottom: 0.4em; }
nav.toc ol { list-style: none; padding-left: 1.2em; margin: 0.2em 0; }
nav.toc > ol { padding-left: 0; }
nav.toc a { color: inherit; text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
div.bibliography, div.bibtex { margin-top: 2em; }
h2.bibliography, h2.bibtex { font-size: 1.3em; }
div.bibitem, div.bibtexentry { margin: 0.6em 0 0.6em 2em; text-indent: -2em; }
span.bibitemlabel:before, span.bibtexlabel:before { content: "["; }
span.bibitemlabel:after, span.bibtexlabel:after { content: "] "; }
span.ref, span.citation { }
img { max-width: 100%; height: auto; }
div.wrap { float: right; margin: 0.4em 0 1em 1em; }
div.wrap.wrap-left { float: left; margin: 0.4em 1em 1em 0; }
div.wrap img { width: 100%; height: auto; display: block; }
div.wrap .plain_layout { margin: 0 0 0.35em; text-align: center; font-size: 0.9em; }
div.marginal, aside.marginal {
  float: right;
  clear: right;
  width: 12em;
  max-width: 35%;
  margin: 0 0 1em 1em;
  padding: 0.7em 0.8em;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
  font-size: 0.85em;
}
div.marginal .plain_layout, aside.marginal .plain_layout { margin: 0; }
div.color-box {
  margin: 0.6em 0;
  padding: 0.6em 0.8em;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background));
}
span.alert { font-weight: 600; }
span.smallcaps { font-variant: small-caps; }
div.chunk, pre.structure-tree, pre.lilypond, div.chessboard, div.landscape-slide {
  margin: 0.6em 0;
  padding: 0.5em 0.7em;
  border: 1px dashed var(--vscode-panel-border);
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em;
  white-space: pre-wrap;
  overflow-x: auto;
}
div.chunk-title { font-weight: 600; margin-bottom: 0.35em; font-family: inherit; }
pre.chunk-body { margin: 0; padding: 0; border: none; background: transparent; white-space: pre-wrap; }
aside.pdf-comment {
  margin: 0.5em 0;
  padding: 0.45em 0.7em;
  border-left: 3px solid var(--vscode-focusBorder);
  background: var(--vscode-editorWidget-background);
  font-size: 0.9em;
}
span.pdf-form {
  display: inline-block;
  margin: 0.15em 0.25em;
  padding: 0.15em 0.4em;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  background: var(--vscode-input-background, transparent);
}
span.hp-number { font-weight: 700; margin-right: 0.35em; }
span.hp-statement { font-size: 0.95em; }
sup.tablenotemark { font-size: 0.75em; }
span.flex.field { display: inline-block; margin-right: 0.35em; }
div.flex.gloss {
  margin: 0.4em 0;
  padding: 0.35em 0.5em;
  border-left: 2px solid var(--vscode-panel-border);
  font-size: 0.95em;
}
mark.flex.highlight { background: #fff3a0; color: inherit; }
span.flex.overlay { }
div.flex.column { display: inline-block; vertical-align: top; margin: 0 0.5em; }
div.Boxed, div.Framed, div.Doublebox, div.Shadowbox, div.ovalbox, div.Ovalbox, div.Shaded {
  display: block;
  box-sizing: border-box;
  margin: 0.4em 0;
  text-align: center;
}
div.Boxed, div.Framed { border: solid thick currentColor; padding: 0.5ex; }
div.Doublebox { border: double thick currentColor; padding: 0.5ex; }
div.Shadowbox {
  border: solid medium gray;
  border-bottom: solid 0.6em currentColor;
  border-right: solid 0.6em currentColor;
  padding: 0.5ex;
}
div.ovalbox { border: groove medium currentColor; padding: 0.5ex; border-radius: 1em; }
div.Ovalbox { border: ridge thick currentColor; padding: 0.5ex; border-radius: 1em; }
div.Shaded { background: color-mix(in srgb, currentColor 12%, transparent); padding: 0.5ex; }
div.Frameless { margin: 1em 0; }
div.float-listings {
  margin: 0.8em 0;
  width: fit-content;
  max-width: 100%;
}
div.listings-caption { margin: 0 0 0.35em; }
code.listings, pre.include {
  display: block;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
  white-space: pre-wrap;
  font-family: ui-monospace, Consolas, "Courier New", monospace;
  font-size: 0.92em;
  margin: 0;
  padding: 0.6em 0.75em;
  background: color-mix(in srgb, currentColor 6%, transparent);
  overflow-x: auto;
}
div.right_address { text-align: right; }
div.hanging { text-indent: -2em; padding-left: 2em; }
div.initial { margin: 0.8em 0; }
span.dropcap {
  float: left;
  font-size: 2.8em;
  line-height: 0.85;
  font-weight: bold;
  padding-right: 0.12em;
}
div.multicol { column-gap: 1.4em; margin: 0.8em 0; }
div.theorem, div.lemma, div.proposition, div.conjecture, div.corollary,
div.claim, div.fact, div.remark, div.proof, div.assumption, div.axiom,
div.criterion, div.condition, div.notation, div.summary, div.conclusion {
  font-style: italic;
  margin: 0.8em 0;
}
div.definition, div.example, div.problem, div.exercise, div.question, div.note, div.algorithm {
  margin: 0.8em 0;
}
.layout-label { font-style: normal; font-weight: bold; }
span.noun { font-variant: small-caps; }
u.dline { text-decoration-style: double; }
u.wline { text-decoration-style: wavy; }
span.note_greyedout, aside.note-greyedout {
  display: inline;
  color: #A0A0A0;
  padding: 0 1ex;
}
/* Preview: non-click chrome box (not <details>); inline in the sentence. */
div.preview {
  display: inline-block;
  vertical-align: baseline;
  width: fit-content;
  max-width: 100%;
  margin: 0 0.15em;
  padding: 0.15em 0.4em;
  border: 1px dashed #6a7a8a;
  border-radius: 3px;
  background: #f7fafc;
  box-sizing: border-box;
}
div.preview > .standard,
div.preview > .plain_layout {
  display: inline;
  margin: 0;
}
/* Info toolbar icons: don't inherit figure img max-width sizing. */
img.info-icon {
  width: 1.15em;
  height: 1.15em;
  max-width: none;
  vertical-align: text-bottom;
  display: inline;
}
/* Quiet break / spacing chrome (Live vs GUI). */
div.lyx-pagebreak {
  display: block;
  margin: 1.1em 0;
  border: none;
  border-top: 2px dashed #999;
  text-align: center;
  line-height: 0;
}
div.lyx-pagebreak > .lyx-break-label {
  display: inline-block;
  line-height: 1.2;
  padding: 0 0.5em;
  background: var(--vscode-editor-background, #fff);
  color: #777;
  font-size: 0.7em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
div.lyx-separator {
  display: block;
  margin: 0.7em 0;
  border-top: 1px solid #bbb;
  height: 0;
}
div.lyx-vspace {
  display: block;
  margin: 0.55em 0;
  min-height: 0.6em;
  border-left: 3px solid #ccc;
  padding-left: 0.45em;
  color: #888;
  font-size: 0.7em;
  font-weight: 600;
}
div.lyx-vspace > .lyx-break-label {
  opacity: 0.85;
}
/* DL133 tracked-change views over one change-aware render (default: Tracked). */
ins.change-inserted {
  text-decoration: underline;
}
del.change-deleted {
  text-decoration: line-through;
}
/* <details> chips are atomic inline boxes and disclosure bodies are block
 * boxes, so a parent <del> line-through cannot reach inside them; strike
 * deleted disclosures (e.g. footnote 1) explicitly. */
del.change-deleted details.disclose > * {
  text-decoration: line-through;
}
/* Author-distinct palette: color = who, underline/strike = what happened. */
ins.change-author-0, del.change-author-0 { color: #1a7f37; }
ins.change-author-1, del.change-author-1 { color: #0969da; }
ins.change-author-2, del.change-author-2 { color: #bc4c00; }
ins.change-author-3, del.change-author-3 { color: #8250df; }
ins.change-author-4, del.change-author-4 { color: #087e8b; }
ins.change-author-5, del.change-author-5 { color: #a40e4c; }
ins.change-author-6, del.change-author-6 { color: #8b6914; }
ins.change-author-7, del.change-author-7 { color: #cf222e; }
/* Original: reject all — show deletions unstruck, hide insertions. */
body[data-mode="original"] ins.change-inserted {
  display: none;
}
body[data-mode="original"] del.change-deleted {
  text-decoration: none;
  color: inherit;
}
body[data-mode="original"] del.change-deleted details.disclose > * {
  text-decoration: none;
}
/* Clean: accept all — show insertions plain, hide deletions and whole-deleted
 * containers (J3: no empty-shell gap). */
body[data-mode="clean"] ins.change-inserted {
  text-decoration: none;
  color: inherit;
}
body[data-mode="clean"] del.change-deleted {
  display: none;
}
body[data-mode="clean"] div.change-deleted {
  display: none;
}
.diagnostics { font-size: 0.85em; opacity: 0.85; }
</style>
</head>
<body data-mode="${escapeHostText(mode)}">
${status}
${diagBlock}
${body}
${scrollScript}
</body>
</html>`;
}
