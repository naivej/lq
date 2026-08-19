import type { LiveRender } from "./previewSession";

export const WEBVIEW_CSP =
  "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

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
<meta http-equiv="Content-Security-Policy" content="${WEBVIEW_CSP}">
<title>${escapeHostText(options.title)}</title>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 1rem 1.25rem 2rem; }
.banner { padding: 0.4rem 0.6rem; margin-bottom: 0.75rem; border-left: 3px solid var(--vscode-editorWarning-foreground); }
.banner.error { border-left-color: var(--vscode-errorForeground); }
.banner.pending { border-left-color: var(--vscode-editorInfo-foreground); }
article.lyx-live section { margin: 0 0 1rem; }
article.lyx-live h1, article.lyx-live h2, article.lyx-live h3, article.lyx-live h4 { margin: 0.8em 0 0.4em; }
div.standard { margin: 0 0 0.8em; }
blockquote { margin: 0.5em 1.5em; }
table { border-collapse: collapse; margin: 0.75em 0; }
td, th { border: 1px solid var(--vscode-panel-border); padding: 0.25em 0.5em; }
.foot_label { font-size: 0.75em; vertical-align: super; cursor: default; }
.foot_inner { display: none; }
.foot:hover .foot_inner, .foot:focus-within .foot_inner { display: inline; }
.formula { font-family: var(--vscode-editor-font-family); }
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
