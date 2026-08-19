import type { LiveRender } from "./previewSession";

export function liveWebviewCsp(imgSrc = "'none'"): string {
  return `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
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
  error?: string;
  render?: LiveRender;
  imgCsp?: string;
}): string {
  const status = options.error
    ? `<div class="banner error">${escapeHostText(options.error)}</div>`
    : options.pending
      ? `<div class="banner pending">Rendering saved document…</div>`
      : options.stale
        ? `<div class="banner stale">Unsaved edits — save to refresh the Live preview.</div>`
        : "";
  const diagnostics = (options.render?.diagnostics ?? [])
    .map((d) => `<li><code>${escapeHostText(d.code)}</code> ${escapeHostText(d.message)}</li>`)
    .join("");
  const diagBlock = diagnostics
    ? `<aside class="diagnostics"><ul>${diagnostics}</ul></aside>`
    : "";
  const body = options.render?.html ?? "<p class=\"empty\">No Live render yet.</p>";
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${liveWebviewCsp(options.imgCsp ?? "'none'")}">
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
figure.float-figure, figure.float-table { display: block; margin: 1.2em auto; text-align: center; }
figure > figcaption { display: block; text-align: center; margin: 0 0 0.6em; }
figure > .float-body { display: flex; justify-content: center; margin: 0.4em 0; }
figure table { margin-left: auto; margin-right: auto; }
table { border-collapse: collapse; margin: 0.75em 0; }
td, th { border: 1px solid var(--vscode-panel-border); padding: 0.25em 0.5em; }
.foot_label, .foot_intitle_label { font-size: 0.75em; vertical-align: super; cursor: default; }
.foot_inner, .foot_intitle_inner { display: none; }
.foot:hover .foot_inner, .foot:focus-within .foot_inner,
.foot_intitle:hover .foot_intitle_inner, .foot_intitle:focus-within .foot_intitle_inner { display: inline; }
span.formula { }
math { font-family: "Cambria Math", "Latin Modern Math", "STIX Two Math", serif; font-size: 1.05em; }
span.formula:has(math[display="block"]) {
  display: grid;
  grid-template-columns: 4em 1fr 4em;
  align-items: center;
  width: 100%;
  margin: 1.2em 0;
}
span.formula:has(math[display="block"]) > math {
  grid-column: 2;
  justify-self: center;
}
span.formula:has(math[display="block"]) > .eqno {
  grid-column: 3;
  justify-self: end;
}
nav.toc { margin: 1.5em 0 2em; }
h2.toc { font-size: 1.3em; margin-bottom: 0.4em; }
nav.toc ol { list-style: none; padding-left: 1.2em; margin: 0.2em 0; }
nav.toc > ol { padding-left: 0; }
nav.toc a { color: inherit; text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
div.bibliography { margin-top: 2em; }
h2.bibliography { font-size: 1.3em; }
div.bibitem { margin: 0.6em 0 0.6em 1.5em; text-indent: -1.5em; }
span.ref, span.citation { }
img { max-width: 100%; height: auto; }
div.wrap { float: right; margin: 0.4em 0 1em 1em; }
div.wrap.wrap-left { float: left; margin: 0.4em 1em 1em 0; }
div.wrap img { width: 100%; height: auto; display: block; }
div.wrap .plain_layout { margin: 0 0 0.35em; text-align: center; font-size: 0.9em; }
div.marginal {
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
div.marginal .plain_layout { margin: 0; }
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
.diagnostics { font-size: 0.85em; opacity: 0.85; }
</style>
</head>
<body>
${status}
${diagBlock}
${body}
</body>
</html>`;
}
